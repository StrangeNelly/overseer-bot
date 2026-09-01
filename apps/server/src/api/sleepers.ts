import { asc, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { calls, sleeperEntries, sleeperSeen, tokens, type Db } from '@groupie/db';
import {
  RANGE_PRESETS,
  SLEEPERS,
  tradingLinks,
  type SleeperBand,
  type SleeperEntry,
  type SleepersResponse,
} from '@groupie/shared';
import type { ApiEnv } from './membership.js';

/**
 * GET /api/g/:slug/sleepers?all=0|1 — the chain-wide discovery stream
 * (docs/decisions.md round 9).
 *
 * The scan itself is group-agnostic: one sweep of the chain serves every group.
 * Everything group-specific happens HERE, at read time:
 *   - drop any address this group has already called (it is not a lead any
 *     more — it is on the board);
 *   - default to entries that have an X account, with `all=1` to see the rest;
 *   - cut each band to SLEEPERS.servePerBand after both filters.
 */

type EntryRow = typeof sleeperEntries.$inferSelect;

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

function toEntry(row: EntryRow, onListSinceHours: number): SleeperEntry {
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
    links: tradingLinks(row.address),
  };
}

export function createSleeperRoutes(db: Db): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  app.get('/api/g/:slug/sleepers', async (c) => {
    const group = c.get('group');
    // Anything but an explicit "1" keeps the twitter-required default: this
    // surface leans on an X account being the cheapest way to research a lead.
    const showAll = c.req.query('all') === '1';

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
    const [called, seen] = await Promise.all([
      loadCalledAddresses(db, group.id),
      loadOnListSince(db, [...new Set(rows.map((r) => r.address))], nowMs),
    ]);

    const byBand = new Map<number, SleeperEntry[]>();
    for (const row of rows) {
      const address = row.address.toLowerCase();
      if (called.has(address)) continue;
      if (!showAll && row.twitterUrl === null) continue;
      const list = byBand.get(row.bandLoUsd) ?? [];
      // Rows arrive rank-ascending, so a plain length check is the top-N cut.
      if (list.length >= SLEEPERS.servePerBand) continue;
      list.push(toEntry(row, seen.get(address) ?? 0));
      byBand.set(row.bandLoUsd, list);
    }

    // Every band is always present, empty or not: the tab says so per band
    // rather than silently collapsing to whichever ones had entries.
    const bands: SleeperBand[] = RANGE_PRESETS.map((preset) => ({
      loUsd: preset.loUsd,
      hiUsd: preset.hiUsd,
      entries: byBand.get(preset.loUsd) ?? [],
    }));

    const body: SleepersResponse = {
      refreshedAt: rows[0]?.scanAt.toISOString() ?? null,
      bands,
    };
    return c.json(body);
  });

  return app;
}
