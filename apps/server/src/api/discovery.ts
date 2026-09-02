import { and, eq, gte, inArray, sql, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  discoveryAlertDecisions,
  discoveryEvents,
  tokens,
  watches,
  type Db,
} from '@groupie/db';
import {
  DISCOVERY,
  DISCOVERY_DEFAULTS,
  tradingLinks,
  type DiscoveryEntry,
  type DiscoveryFilters,
  type DiscoveryKind,
  type DiscoveryResponse,
} from '@groupie/shared';
import { readLastTickAt } from '../chain/cursor.js';
import { passesGraduationFloor } from '../discovery/filters.js';
import type { ApiEnv } from './membership.js';

/**
 * GET /api/g/:slug/discovery?kind=launch|graduation|all&hours=24&xweb=1&bundles=1&stocks=1
 * — the chain's own stream (docs/decisions.md rounds 18 and 20).
 *
 * Read-time filtered, exactly like Sleepers: one listener serves every group and
 * everything group-specific happens here — the watch pills, whether THIS group
 * was told about an entry, and (in the alert path) the group's own launch
 * threshold.
 *
 * The three filters are three separate flags rather than one `filtered`
 * switch: the UI draws three chips, and a chip whose pressed state cannot be
 * read back off the payload is a chip that will eventually lie about what the
 * list contains. Each defaults ON; anything that is not an explicit "0" is on,
 * so a mistyped parameter lands on the default rather than on the raw stream.
 */

/** Per kind. Deep enough for a day of a busy chain, shallow enough to send. */
const SERVE_LIMIT = 100;

type EventRow = typeof discoveryEvents.$inferSelect;

const KINDS: readonly string[] = ['launch', 'graduation', 'all'];

/** The kind filter, or the message to answer a 400 with. */
export function parseKind(
  raw: string | undefined,
): { kind: DiscoveryKind | 'all' } | { error: string } {
  if (raw === undefined || raw === '') return { kind: 'all' };
  if (!KINDS.includes(raw)) return { error: `kind must be one of ${KINDS.join(', ')}` };
  return { kind: raw as DiscoveryKind | 'all' };
}

/**
 * The window, in hours. A number rather than a fixed tuple (the zones are "last
 * 24h" surfaces, not chip sets), clamped to what retention can actually back:
 * asking for a month of a table pruned at seven days would answer with silence
 * that looks like a quiet month.
 */
export function parseHours(raw: string | undefined): { hours: number } | { error: string } {
  if (raw === undefined || raw === '') return { hours: DISCOVERY.defaultHours };
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return { error: 'hours must be a positive number' };
  return { hours: Math.min(DISCOVERY.maxHours, value) };
}

/** One filter flag: on unless the query says exactly "0". */
export function parseFlag(raw: string | undefined): boolean {
  return raw !== '0';
}

/** The three flags this request asked for. */
export function parseFilters(query: {
  xweb?: string;
  bundles?: string;
  stocks?: string;
}): DiscoveryFilters {
  return {
    xWeb: parseFlag(query.xweb),
    noBundles: parseFlag(query.bundles),
    noStocks: parseFlag(query.stocks),
  };
}

/**
 * The group's active watches keyed by ADDRESS, and the member holding each slot
 * — one query for the payload, the same shape Sleepers uses. A discovery coin
 * is never one of the group's calls, so the address is all the two share.
 */
async function loadWatchedAddresses(db: Db, groupId: number): Promise<Map<string, number>> {
  const rows = await db
    .select({ address: tokens.address, addedBy: watches.addedBy })
    .from(watches)
    .innerJoin(tokens, eq(tokens.id, watches.tokenId))
    .where(and(eq(watches.groupId, groupId), eq(watches.active, true)));
  return new Map(rows.map((r) => [r.address.toLowerCase(), r.addedBy]));
}

/**
 * Which of these events THIS group was actually told about. `alerted` is a
 * per-group fact — one group's threshold posts a launch another group's mutes —
 * and it was being served from a global stamp that said "somebody was told".
 */
async function loadAlertedEventIds(
  db: Db,
  groupId: number,
  eventIds: number[],
): Promise<Set<number>> {
  if (eventIds.length === 0) return new Set();
  const rows = await db
    .select({ eventId: discoveryAlertDecisions.eventId })
    .from(discoveryAlertDecisions)
    .where(
      and(
        eq(discoveryAlertDecisions.groupId, groupId),
        eq(discoveryAlertDecisions.outcome, 'sent'),
        inArray(discoveryAlertDecisions.eventId, eventIds),
      ),
    );
  return new Set(rows.map((r) => r.eventId));
}

function toEntry(
  row: EventRow,
  watched: boolean,
  watchedByMe: boolean,
  alerted: boolean,
): DiscoveryEntry {
  return {
    kind: row.kind,
    address: row.tokenAddress,
    symbol: row.symbol,
    name: row.name,
    imageUrl: row.imageUrl,
    poolAddress: row.poolAddress,
    dex: row.dex,
    at: row.at.toISOString(),
    initialLiquidityUsd: row.initialLiquidityUsd,
    initialLiquidityEth: row.initialLiquidityEth,
    quoteSymbol: row.quoteSymbol,
    mcapUsd: row.mcapUsd,
    liquidityUsd: row.liquidityUsd,
    dataAsOf: row.dataAsOf === null ? null : row.dataAsOf.toISOString(),
    lpLockedPct: row.lpLockedPct,
    twitterUrl: row.twitterUrl,
    websiteUrl: row.websiteUrl,
    launchBlockPct: row.launchBlockPct,
    launchBlockWallets: row.launchBlockWallets,
    isStock: row.isStock,
    alerted,
    watched,
    watchedByMe,
    links: tradingLinks(row.tokenAddress),
  };
}

/**
 * The filters, as SQL rather than as a loop over a fetched page. The old code
 * fetched a shared cap for both kinds and then filtered in JS, so a busy
 * launch hour could push every graduation out of the payload before the filters
 * ran — and a filtered-out row still cost its place in the limit.
 */
function filterConditions(filters: DiscoveryFilters): SQL[] {
  const parts: SQL[] = [];
  if (filters.xWeb) {
    parts.push(sql`${discoveryEvents.twitterUrl} is not null`);
    parts.push(sql`${discoveryEvents.websiteUrl} is not null`);
  }
  if (filters.noStocks) parts.push(sql`${discoveryEvents.isStock} = false`);
  if (filters.noBundles) {
    // UNKNOWN IS NEVER A VERDICT: a launch block we could not read stays
    // visible and is rendered as unknown. Hiding it would let a failed RPC
    // call quietly become an accusation of bundling.
    parts.push(
      sql`(${discoveryEvents.launchBlockPct} is null or ${discoveryEvents.launchBlockPct} < ${DISCOVERY_DEFAULTS.bundleMaxPct})`,
    );
  }
  return parts;
}

/**
 * The round-22 floor, as SQL, for the GRADUATION query only (see
 * discovery/filters.ts for the rule). Kept out of `filterConditions` on
 * purpose: those three are chips a member can turn off, and this one is a floor
 * that survives `xweb=0&bundles=0&stocks=0`. A launch query never gets it.
 */
function graduationFloorCondition(): SQL {
  return sql`(${discoveryEvents.mcapUsd} is null or ${discoveryEvents.mcapUsd} >= ${DISCOVERY.graduationMinMcapUsd})`;
}

export function createDiscoveryRoutes(
  db: Db,
  discovery: { running: boolean },
): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  app.get('/api/g/:slug/discovery', async (c) => {
    const parsedKind = parseKind(c.req.query('kind'));
    if ('error' in parsedKind) return c.json({ error: parsedKind.error }, 400);
    const parsedHours = parseHours(c.req.query('hours'));
    if ('error' in parsedHours) return c.json({ error: parsedHours.error }, 400);
    const filters = parseFilters({
      xweb: c.req.query('xweb'),
      bundles: c.req.query('bundles'),
      stocks: c.req.query('stocks'),
    });
    const { hours } = parsedHours;
    const enabled = discovery.running;

    const body: DiscoveryResponse = {
      enabled,
      lastTickAt: null,
      hours,
      filters,
      bundleMaxPct: DISCOVERY_DEFAULTS.bundleMaxPct,
      launches: [],
      graduations: [],
    };
    // No listener in this process: the zones say "not configured" rather than
    // showing an empty stream that looks like a quiet day.
    if (!enabled) return c.json(body);

    const kinds: DiscoveryKind[] =
      parsedKind.kind === 'all' ? ['launch', 'graduation'] : [parsedKind.kind];
    const since = new Date(Date.now() - hours * 3_600_000);
    const conditions = filterConditions(filters);
    // ONE QUERY PER KIND, each with its own limit. A shared cap let a busy
    // launch hour push every graduation out of the payload before either list
    // was built — and filtering after the fetch spent limit slots on rows the
    // reader was never going to see.
    const perKind = await Promise.all(
      kinds.map((kind) =>
        db
          .select()
          .from(discoveryEvents)
          .where(
            and(
              eq(discoveryEvents.kind, kind),
              gte(discoveryEvents.at, since),
              ...conditions,
              // Round 22: only the graduation query carries the mcap floor.
              ...(kind === 'graduation' ? [graduationFloorCondition()] : []),
            ),
          )
          .orderBy(sql`${discoveryEvents.at} desc`)
          .limit(SERVE_LIMIT),
      ),
    );
    const rows = perKind.flat();

    const groupId = c.get('group').id;
    const [watchedBy, alertedIds, lastTickAt] = await Promise.all([
      loadWatchedAddresses(db, groupId),
      loadAlertedEventIds(
        db,
        groupId,
        rows.map((r) => r.id),
      ),
      readLastTickAt(db),
    ]);
    body.lastTickAt = lastTickAt === null ? null : lastTickAt.toISOString();
    const userId = c.get('userId');

    for (const row of rows) {
      // The WHERE above already excluded these; this is the same rule stated
      // once more where the payload is actually built, so a row that reaches
      // here by any other path still cannot be served under the floor.
      if (!passesGraduationFloor(row)) continue;
      const list = row.kind === 'launch' ? body.launches : body.graduations;
      if (list.length >= SERVE_LIMIT) continue;
      const address = row.tokenAddress.toLowerCase();
      const slotHolder = watchedBy.get(address);
      list.push(
        toEntry(row, slotHolder !== undefined, slotHolder === userId, alertedIds.has(row.id)),
      );
    }
    return c.json(body);
  });

  return app;
}
