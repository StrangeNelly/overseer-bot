import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { calls, sleeperEntries, sleeperSeen, tokens, watches, type Db } from '@groupie/db';
import {
  SLEEPER_DURATIONS_HOURS,
  SLEEPER_LONG_ONLY_MIN_HOURS,
  SLEEPERS,
  sleeperBandsFor,
  tradingLinks,
  type SleeperBand,
  type SleeperDurationHours,
  type SleeperEntry,
  type SleepersResponse,
} from '@groupie/shared';
import type { ApiEnv } from './membership.js';

/**
 * GET /api/g/:slug/sleepers?all=0|1&stocks=0|1&minHours=<SLEEPER_DURATIONS_HOURS member>
 * — the chain-wide discovery stream (docs/decisions.md rounds 9, 14 and 17).
 *
 * The scan itself is group-agnostic: one sweep of the chain serves every group.
 * Everything group-specific happens HERE, at read time:
 *   - drop any address this group has already called (it is not a lead any
 *     more — it is on the board);
 *   - drop anything that has not held its band for the requested duration;
 *   - default to entries that have an X account, with `all=1` to see the rest;
 *   - drop tokenized stocks, with `stocks=1` to see them;
 *   - cut each band to SLEEPERS.servePerBand PER KIND after every filter.
 */

type EntryRow = typeof sleeperEntries.$inferSelect;

/** 3h — the shortest duration, and what an unasked query means. */
const DEFAULT_MIN_HOURS: SleeperDurationHours = 3;

/**
 * The duration filter, or the message to answer a 400 with. Membership of the
 * fixed tuple, not a range: the chips are the contract, and an arbitrary number
 * would ask the client to invent a filter the scan cannot back.
 */
export function parseMinHours(
  raw: string | undefined,
): { minHours: SleeperDurationHours } | { error: string } {
  if (raw === undefined || raw === '') return { minHours: DEFAULT_MIN_HOURS };
  const value = Number(raw);
  if (!(SLEEPER_DURATIONS_HOURS as readonly number[]).includes(value)) {
    return { error: `minHours must be one of ${SLEEPER_DURATIONS_HOURS.join(', ')}` };
  }
  return { minHours: value as SleeperDurationHours };
}

/**
 * Whether this request wants tokenized stocks in the payload (round 17).
 * Anything but an explicit "1" excludes them: the toggle ships ON, and a
 * mistyped or absent parameter must land on the default the owner asked for
 * rather than on a board full of equities.
 */
export function parseIncludeStocks(raw: string | undefined): boolean {
  return raw === '1';
}

/**
 * Round 9's 10-day pool-age ceiling, applied only to the short-horizon views.
 * The scan admits pools up to inBandMaxDays so the 2w/1m chips can serve at
 * all (a coin three weeks in band is by definition older than 10 days); this
 * keeps every shorter view exactly what round 9 specced. An entry with no
 * recorded pool age cannot prove it is young enough, so it fails.
 */
export function passesServeAgeCeiling(
  poolCreatedAt: Date | null,
  minHours: SleeperDurationHours,
  nowMs: number,
): boolean {
  if (minHours >= SLEEPER_LONG_ONLY_MIN_HOURS) return true;
  const ageMs = poolCreatedAt ? nowMs - poolCreatedAt.getTime() : Infinity;
  return ageMs <= SLEEPERS.maxPoolAgeDays * 24 * 3_600_000;
}

/**
 * Addresses this group has a call for, in any state. A died or binned call
 * still means the group has seen the coin, so it does not belong on a surface
 * whose whole promise is "things you have NOT looked at".
 */
async function loadCalledAddresses(db: Db, groupId: number): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ address: tokens.address })
    .from(calls)
    .innerJoin(tokens, eq(tokens.id, calls.tokenId))
    .where(eq(calls.groupId, groupId));
  return new Set(rows.map((r) => r.address.toLowerCase()));
}

/**
 * firstListedAt per address, as hours. Only addresses in the payload are asked
 * for, and a missing row (a scan that raced the ledger write) simply reports 0
 * rather than inventing a tenure.
 */
async function loadOnListSince(
  db: Db,
  addresses: string[],
  nowMs: number,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (addresses.length === 0) return out;
  const rows = await db
    .select({ address: sleeperSeen.address, firstListedAt: sleeperSeen.firstListedAt })
    .from(sleeperSeen)
    .where(inArray(sleeperSeen.address, addresses));
  for (const row of rows) {
    const hours = (nowMs - row.firstListedAt.getTime()) / 3_600_000;
    out.set(row.address.toLowerCase(), Number.isFinite(hours) ? Math.max(0, hours) : 0);
  }
  return out;
}

/**
 * The group's active watches keyed by ADDRESS (docs/decisions.md round 16) —
 * one query for the whole payload, never a lookup per row. A sleeper is not one
 * of the group's calls, so there is no token id to join on here; the address is
 * the only thing the two surfaces share, and both sides store it lowercase.
 *
 * The value is the slot holder, so a row can say WATCHING·YOU: the cap is per
 * member, and "unwatch one first" is only actionable when the app says which
 * pills are the reader's own.
 */
async function loadWatchedAddresses(db: Db, groupId: number): Promise<Map<string, number>> {
  const rows = await db
    .select({ address: tokens.address, addedBy: watches.addedBy })
    .from(watches)
    .innerJoin(tokens, eq(tokens.id, watches.tokenId))
    .where(and(eq(watches.groupId, groupId), eq(watches.active, true)));
  return new Map(rows.map((r) => [r.address.toLowerCase(), r.addedBy]));
}

function toEntry(
  row: EntryRow,
  onListSinceHours: number,
  watched: boolean,
  watchedByMe: boolean,
): SleeperEntry {
  return {
    address: row.address,
    symbol: row.symbol,
    name: row.name,
    imageUrl: row.imageUrl,
    twitterUrl: row.twitterUrl,
    websiteUrl: row.websiteUrl,
    mcapUsd: row.mcapUsd,
    vol24Usd: row.vol24Usd,
    liquidityUsd: row.liquidityUsd,
    txns24: row.txns24,
    turnover: row.turnover,
    poolCreatedAt: row.poolCreatedAt?.toISOString() ?? null,
    onListSinceHours,
    inBandHours: row.inBandHours,
    links: tradingLinks(row.address),
    watched,
    watchedByMe,
    isStock: row.isStock,
  };
}

export function createSleeperRoutes(db: Db): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  app.get('/api/g/:slug/sleepers', async (c) => {
    const group = c.get('group');
    // Anything but an explicit "1" keeps the twitter-required default: this
    // surface leans on an X account being the cheapest way to research a lead.
    const showAll = c.req.query('all') === '1';
    const excludeStocks = !parseIncludeStocks(c.req.query('stocks'));
    const parsed = parseMinHours(c.req.query('minHours'));
    if ('error' in parsed) return c.json({ error: parsed.error }, 400);
    const { minHours } = parsed;
    // One sleeperBandsFor call answers both "which bands does this duration
    // show" and "which rows may be served", so the payload's band list and the
    // entries filter cannot disagree about it.
    const bandSpecs = sleeperBandsFor(minHours);
    const visibleBandLos = new Set(bandSpecs.map((band) => band.loUsd));

    // Scoped to the newest scan_at. Only one scan is ever kept, but the
    // replace-style write inserts before it deletes, so a read landing between
    // those two statements would otherwise see both.
    const rows = await db
      .select()
      .from(sleeperEntries)
      .where(
        sql`${sleeperEntries.scanAt} = (select max(${sleeperEntries.scanAt}) from ${sleeperEntries})`,
      )
      .orderBy(asc(sleeperEntries.bandLoUsd), asc(sleeperEntries.rank));

    const nowMs = Date.now();
    const [called, seen, watchedBy] = await Promise.all([
      loadCalledAddresses(db, group.id),
      loadOnListSince(db, [...new Set(rows.map((r) => r.address))], nowMs),
      loadWatchedAddresses(db, group.id),
    ]);
    const userId = c.get('userId');

    // The serve cut is per KIND, like the scan's keep cut: up to servePerBand
    // coins AND up to servePerBand stocks. Ranking is over the whole band, so a
    // band whose top turnover rows are all equities would otherwise serve three
    // stocks and drop the coin underneath — turning the stocks toggle ON would
    // REMOVE a coin the default view showed, which is not what a toggle labelled
    // "with stocks" can mean. Coins lead the band for the same reason.
    const byBand = new Map<number, { coins: SleeperEntry[]; stocks: SleeperEntry[] }>();
    for (const row of rows) {
      const address = row.address.toLowerCase();
      if (!visibleBandLos.has(row.bandLoUsd)) continue;
      if (row.inBandHours < minHours) continue;
      if (!passesServeAgeCeiling(row.poolCreatedAt, minHours, nowMs)) continue;
      if (called.has(address)) continue;
      if (!showAll && row.twitterUrl === null) continue;
      if (excludeStocks && row.isStock) continue;
      const bucket = byBand.get(row.bandLoUsd) ?? { coins: [], stocks: [] };
      const list = row.isStock ? bucket.stocks : bucket.coins;
      // Rows arrive rank-ascending, so a plain length check is the top-N cut.
      if (list.length >= SLEEPERS.servePerBand) continue;
      const slotHolder = watchedBy.get(address);
      list.push(
        toEntry(row, seen.get(address) ?? 0, slotHolder !== undefined, slotHolder === userId),
      );
      byBand.set(row.bandLoUsd, bucket);
    }

    // Every band this duration can see is always present, empty or not: the tab
    // says so per band rather than silently collapsing to whichever ones had
    // entries.
    const bands: SleeperBand[] = bandSpecs.map((preset) => {
      const bucket = byBand.get(preset.loUsd);
      return {
        loUsd: preset.loUsd,
        hiUsd: preset.hiUsd,
        entries: bucket ? [...bucket.coins, ...bucket.stocks] : [],
      };
    });

    const body: SleepersResponse = {
      refreshedAt: rows[0]?.scanAt.toISOString() ?? null,
      minHours,
      excludeStocks,
      xOnly: !showAll,
      bands,
    };
    return c.json(body);
  });

  return app;
}
