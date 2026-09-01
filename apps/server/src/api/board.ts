import { and, eq, gte, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { calls, snapshots, tokens, watches, type Db } from '@groupie/db';
import {
  BOARD_WINDOWS,
  BOARD_WINDOW_HOURS,
  tradingLinks,
  twitterUrlFrom,
  watchCapMessage,
  websiteUrlFrom,
  type BoardCard,
  type BoardResponse,
  type BoardWindow,
  type SparkPoint,
} from '@groupie/shared';
import { publish } from '../events.js';
import { addWatch, findGroupToken, removeWatch } from '../watchlist.js';
import type { ApiEnv } from './membership.js';
import { classifySections, parseTzOffsetMin, startOfLocalDayMs } from './boardLogic.js';

/** Contract: sparklines cover the last 24h regardless of the board window. */
const SPARKLINE_HOURS = 24;
const MAX_SPARK_POINTS = 30;

type CallRow = typeof calls.$inferSelect;
type TokenRow = typeof tokens.$inferSelect;

function parseWindow(raw: string | undefined): BoardWindow | null {
  if (raw === undefined || raw === '') return '24h';
  return (BOARD_WINDOWS as readonly string[]).includes(raw) ? (raw as BoardWindow) : null;
}

/** Evenly spaced sample that always keeps the first and last point. */
function downsample(points: SparkPoint[]): SparkPoint[] {
  if (points.length <= MAX_SPARK_POINTS) return points;
  const step = (points.length - 1) / (MAX_SPARK_POINTS - 1);
  const out: SparkPoint[] = [];
  for (let i = 0; i < MAX_SPARK_POINTS; i++) {
    const point = points[Math.round(i * step)];
    if (point) out.push(point);
  }
  return out;
}

/**
 * Death info is call-level first: a call can die on its own liquidity collapse
 * while the token still trades, and a revived token keeps stale token-level
 * history that would misdate a later per-call death. Timestamp, reason and
 * mcap-at-death are taken as one TRIPLE so they always describe the same death
 * — round 15 added the mcap, and a mixed pair would be worse than none. Token
 * values are the fallback for calls that died before per-call stamping existed.
 */
function deathOf(
  call: CallRow,
  token: TokenRow,
): { at: Date | null; reason: string | null; mcapUsd: number | null } {
  if (call.diedAt !== null) {
    return { at: call.diedAt, reason: call.deathReason, mcapUsd: call.mcapAtDeath };
  }
  return { at: token.diedAt, reason: token.deathReason, mcapUsd: token.mcapAtDeath };
}

/** Shared by the board and ranging routes (and the tests) — one card shape. */
export function toCard(
  call: CallRow,
  token: TokenRow,
  sparkline: SparkPoint[],
  watched: boolean,
  watchedByMe = false,
): BoardCard {
  // A zero/negative at-call mcap is a bad reading, not a 0x baseline.
  const base = call.mcapAtCall !== null && call.mcapAtCall > 0 ? call.mcapAtCall : null;
  const death = deathOf(call, token);
  const peak = call.peakMcapSinceCall;
  const retraceFromPeakPct =
    token.mcapUsd !== null && peak !== null && peak > 0
      ? Math.min(100, Math.max(0, (1 - token.mcapUsd / peak) * 100))
      : null;
  return {
    callId: call.id,
    tokenId: token.id,
    address: token.address,
    symbol: token.symbol,
    name: token.name,
    imageUrl: token.imageUrl,
    // tokens.socials is untyped jsonb (DexScreener-shaped when we have it), so
    // the URL is proved rather than assumed (docs/decisions.md round 9).
    twitterUrl: twitterUrlFrom(token.socials),
    // Same defensive read, same blob (docs/decisions.md round 15: a coin with a
    // stored website gets a link everywhere links render).
    websiteUrl: websiteUrlFrom(token.socials),
    phase: token.phase,
    callStatus: call.status,
    mcapUsd: token.mcapUsd,
    liquidityUsd: token.liquidityUsd,
    vol24Usd: token.vol24Usd,
    mcapAtCall: call.mcapAtCall,
    multiple: base !== null && token.mcapUsd !== null ? token.mcapUsd / base : null,
    peakMcapSinceCall: peak,
    peakMultiple: base !== null && peak !== null ? peak / base : null,
    retraceFromPeakPct,
    calledAt: call.calledAt.toISOString(),
    callerName: call.callerName,
    mentionsCount: call.mentionsCount,
    lastMentionAt: call.lastMentionAt.toISOString(),
    revived: token.revivedAt !== null,
    diedAt: death.at?.toISOString() ?? null,
    deathReason: death.reason,
    mcapAtDeath: death.mcapUsd,
    dataAsOf: token.lastSnapshotAt?.toISOString() ?? null,
    watched,
    watchedByMe,
    // Raw, not windowed: classifySections owns the 24h badge window, so the
    // two can never disagree about which cards are in the Reviving section.
    revivingAt: token.revivingAt?.toISOString() ?? null,
    links: tradingLinks(token.address),
    sparkline,
  };
}

/**
 * The group's active watchlist — token id -> who added the watch — in one query
 * for a whole board (no per-card lookup). Shared with the ranging route.
 * `.has()` answers "is the group watching", `.get() === userId` answers "is it
 * the reader's slot" (round 15 review: the cap is per member, so the board has
 * to be able to say which pills are yours).
 */
export async function loadWatchedTokenIds(
  db: Db,
  groupId: number,
  tokenIds: number[],
): Promise<Map<number, number>> {
  if (tokenIds.length === 0) return new Map();
  const rows = await db
    .select({ tokenId: watches.tokenId, addedBy: watches.addedBy })
    .from(watches)
    .where(
      and(
        eq(watches.groupId, groupId),
        eq(watches.active, true),
        inArray(watches.tokenId, tokenIds),
      ),
    );
  return new Map(rows.map((r) => [r.tokenId, r.addedBy]));
}

/** count(*) is a bigint, which postgres-js hands back as a string. */
function countOf(rows: Array<{ n: string | number | null }>): number {
  const n = Number(rows[0]?.n ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Every call this group made since the member's own local midnight, counted in
 * SQL (docs/decisions.md round 15).
 *
 * Every status counts, binned included: "N calls today" is a fact about the
 * chat, not about what the board is currently willing to show. The old
 * payload-derived number was both window-truncated and silently missing
 * anything hidden or binned.
 */
async function loadTodayCallCount(db: Db, groupId: number, dayStartMs: number): Promise<number> {
  const rows = await db
    .select({ n: sql<string | number>`count(*)` })
    .from(calls)
    .where(and(eq(calls.groupId, groupId), gte(calls.calledAt, new Date(dayStartMs))));
  return countOf(rows);
}

/**
 * This group's non-binned calls whose token is on rug probation right now
 * (docs/decisions.md round 15) — the cards the board is deliberately hiding.
 *
 * Counted over tokens, not calls: probation is a token-level state, and one
 * group has at most one call per token anyway. Not windowed — see the field's
 * contract note in packages/shared/src/api.ts.
 */
async function loadHiddenProbationCount(db: Db, groupId: number): Promise<number> {
  const rows = await db
    .select({ n: sql<string | number>`count(distinct ${calls.tokenId})` })
    .from(calls)
    .innerJoin(tokens, eq(tokens.id, calls.tokenId))
    .where(
      and(eq(calls.groupId, groupId), ne(calls.status, 'binned'), isNotNull(tokens.rugHiddenAt)),
    );
  return countOf(rows);
}

/** 24h / 30 points: one bucket per sparkline sample. */
const SPARK_BUCKET_SECONDS = sql.raw(String(Math.round((SPARKLINE_HOURS * 3600) / MAX_SPARK_POINTS)));

// db.execute bypasses Drizzle's column decoders, so postgres-js hands these
// back as strings (timestamptz, double precision) — coerce at the read site.
type SparkRow = {
  token_id: number | string;
  at: Date | string;
  mcap_usd: number | string | null;
} & Record<string, unknown>;

/**
 * Downsample in SQL, not in JS: a fresh token is snapshotted every 45s (~1,900
 * rows/24h) and the board refetches on every price_update, so shipping raw rows
 * for every card dominated egress and endpoint latency.
 *
 * One row per token per bucket (the earliest in each), UNIONed with each
 * token's true latest reading — bucket-firsts alone would drop the freshest
 * point, which is the one a live board is for. Both branches ride
 * snapshots_token_at_idx; downsample() below stays as a cap.
 *
 * Exported for the ranging board, which needs the same sparkline on its cards.
 */
export async function loadSparklines(db: Db, tokenIds: number[]): Promise<Map<number, SparkPoint[]>> {
  const byToken = new Map<number, SparkPoint[]>();
  if (tokenIds.length === 0) return byToken;
  const since = new Date(Date.now() - SPARKLINE_HOURS * 3_600_000);
  const inWindow = and(
    inArray(snapshots.tokenId, tokenIds),
    gte(snapshots.at, since),
    isNotNull(snapshots.mcapUsd),
  );
  const rows = await db.execute<SparkRow>(sql`
    with pts as (
      select distinct on (token_id, bucket) token_id, at, mcap_usd
      from (
        select ${snapshots.tokenId} as token_id,
               ${snapshots.at} as at,
               ${snapshots.mcapUsd} as mcap_usd,
               floor(extract(epoch from ${snapshots.at}) / ${SPARK_BUCKET_SECONDS})::bigint as bucket
        from ${snapshots}
        where ${inWindow}
      ) s
      order by token_id, bucket, at
    ),
    latest as (
      select distinct on (${snapshots.tokenId})
             ${snapshots.tokenId} as token_id,
             ${snapshots.at} as at,
             ${snapshots.mcapUsd} as mcap_usd
      from ${snapshots}
      where ${inWindow}
      order by ${snapshots.tokenId}, ${snapshots.at} desc
    )
    select token_id, at, mcap_usd from pts
    union
    select token_id, at, mcap_usd from latest
    order by at asc
  `);
  for (const row of rows) {
    if (row.mcap_usd === null) continue;
    const mcap = Number(row.mcap_usd);
    const t = new Date(row.at).getTime();
    if (!Number.isFinite(mcap) || !Number.isFinite(t)) continue;
    const tokenId = Number(row.token_id);
    const points = byToken.get(tokenId) ?? [];
    points.push({ t, mcap });
    byToken.set(tokenId, points);
  }
  for (const [tokenId, points] of byToken) byToken.set(tokenId, downsample(points));
  return byToken;
}

export function createBoardRoutes(db: Db): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  app.get('/api/g/:slug/board', async (c) => {
    const group = c.get('group');
    const window = parseWindow(c.req.query('window'));
    if (window === null) {
      return c.json({ error: `window must be one of ${BOARD_WINDOWS.join(', ')}` }, 400);
    }

    const since = new Date(Date.now() - BOARD_WINDOW_HOURS[window] * 3_600_000);
    const rows = await db
      .select({ call: calls, token: tokens })
      .from(calls)
      .innerJoin(tokens, eq(tokens.id, calls.tokenId))
      .where(
        and(
          eq(calls.groupId, group.id),
          ne(calls.status, 'binned'),
          gte(calls.lastMentionAt, since),
          // Rug probation hides the card from EVERY section, died included
          // (docs/decisions.md round 6). Filtered here rather than in
          // classifySections so no section can ever leak a hidden token.
          isNull(tokens.rugHiddenAt),
        ),
      );

    const tokenIds = [...new Set(rows.map((r) => r.token.id))];
    // The client's own midnight: the server has no idea what day it is where
    // the member is, and a UTC day would report the wrong number for most of
    // the group's evening. An absent/junk offset falls back to UTC.
    const dayStartMs = startOfLocalDayMs(Date.now(), parseTzOffsetMin(c.req.query('tz')));
    const [sparklines, watchedIds, todayCallCount, hiddenProbationCount] = await Promise.all([
      loadSparklines(db, tokenIds),
      loadWatchedTokenIds(db, group.id, tokenIds),
      loadTodayCallCount(db, group.id, dayStartMs),
      loadHiddenProbationCount(db, group.id),
    ]);
    const userId = c.get('userId');
    const cards = rows.map((r) =>
      toCard(
        r.call,
        r.token,
        sparklines.get(r.token.id) ?? [],
        watchedIds.has(r.token.id),
        watchedIds.get(r.token.id) === userId,
      ),
    );

    const body: BoardResponse = {
      group: { slug: group.slug, title: group.title },
      window,
      generatedAt: new Date().toISOString(),
      todayCallCount,
      hiddenProbationCount,
      sections: classifySections(cards),
    };
    return c.json(body);
  });

  // Any member may bin, and the effect is group-wide (docs/decisions.md).
  app.post('/api/g/:slug/calls/:callId/bin', async (c) => {
    const group = c.get('group');
    const callId = parsePathId(c.req.param('callId'));
    if (callId === null) return c.json({ error: 'not found' }, 404);

    // Conditional update: the status check and the write are one statement, so
    // two members binning at once can't race into a double-bin.
    const binned = await db
      .update(calls)
      .set({ status: 'binned', binnedBy: c.get('userId'), binnedAt: new Date() })
      .where(and(eq(calls.id, callId), eq(calls.groupId, group.id), eq(calls.status, 'died')))
      .returning({ id: calls.id, tokenId: calls.tokenId });
    if (binned[0]) {
      // Group-wide effect: tell every other open board to refetch instead of
      // leaving the binned card on screen until some unrelated poll event.
      publish({ type: 'call_binned', tokenId: binned[0].tokenId, callId, groupId: group.id });
      return c.body(null, 204);
    }

    const existing = (
      await db
        .select({ status: calls.status })
        .from(calls)
        .where(and(eq(calls.id, callId), eq(calls.groupId, group.id)))
    )[0];
    if (!existing) return c.json({ error: 'not found' }, 404);
    return c.json({ error: `only died calls can be binned (status: ${existing.status})` }, 409);
  });

  /**
   * The watch button (docs/decisions.md round 15). "Watching" means exactly
   * what `/overseer watch` means — the group's nuke/buy-opp alerts for that
   * coin, posted into the chat — so both paths go through watchlist.ts and
   * share the cap. The member is the session's, never the request body's.
   */
  app.post('/api/g/:slug/tokens/:tokenId/watch', async (c) => {
    const group = c.get('group');
    const tokenId = parsePathId(c.req.param('tokenId'));
    if (tokenId === null) return c.json({ error: 'not found' }, 404);
    // Group-scoped, like the bin route: the button only renders on this
    // group's cards, and a global lookup would make the 404/204 split an
    // existence oracle over other groups' token ids (round 15 review).
    if (!(await findGroupToken(db, group.id, tokenId))) return c.json({ error: 'not found' }, 404);

    const outcome = await addWatch(db, group.id, tokenId, c.get('userId'));
    // 409, not 403: nothing is forbidden, the member's three slots are full.
    // The message is the one the bot sends, so the two surfaces read alike.
    if (!outcome.ok) return c.json({ error: watchCapMessage(outcome.cap), cap: outcome.cap }, 409);
    return c.body(null, 204);
  });

  /**
   * Any member may stop a watch, whoever added it — the same group-wide rule
   * binning has (docs/decisions.md round 2). Idempotent: unwatching a coin
   * nobody is watching is a 204, not an error.
   */
  app.delete('/api/g/:slug/tokens/:tokenId/watch', async (c) => {
    const group = c.get('group');
    const tokenId = parsePathId(c.req.param('tokenId'));
    if (tokenId === null) return c.json({ error: 'not found' }, 404);
    await removeWatch(db, group.id, tokenId);
    return c.body(null, 204);
  });

  return app;
}

/** The columns these ids compare against are int4. */
const PG_INT4_MAX = 2_147_483_647;

/**
 * Path ids are strings; anything that is not a positive int4 is a 404. The
 * upper bound matters: a bigger number would reach Postgres, fail int4
 * coercion, and turn into a 500 instead of the honest not-found (round 15
 * review).
 */
export function parsePathId(raw: string | undefined): number | null {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 && value <= PG_INT4_MAX ? value : null;
}
