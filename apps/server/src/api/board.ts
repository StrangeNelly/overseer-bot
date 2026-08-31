import { and, eq, gte, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { calls, snapshots, tokens, type Db } from '@groupie/db';
import {
  BOARD_WINDOWS,
  BOARD_WINDOW_HOURS,
  tradingLinks,
  type BoardCard,
  type BoardResponse,
  type BoardWindow,
  type SparkPoint,
} from '@groupie/shared';
import { publish } from '../events.js';
import type { ApiEnv } from './membership.js';
import { classifySections } from './boardLogic.js';

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
 * history that would misdate a later per-call death. Timestamp and reason are
 * taken as one pair so they always describe the same death. Token values are
 * the fallback for calls that died before per-call stamping existed.
 */
function deathOf(call: CallRow, token: TokenRow): { at: Date | null; reason: string | null } {
  if (call.diedAt !== null) return { at: call.diedAt, reason: call.deathReason };
  return { at: token.diedAt, reason: token.deathReason };
}

/** Exported for tests; the board route is the only production caller. */
export function toCard(call: CallRow, token: TokenRow, sparkline: SparkPoint[]): BoardCard {
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
    dataAsOf: token.lastSnapshotAt?.toISOString() ?? null,
    links: tradingLinks(token.address),
    sparkline,
  };
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
 */
async function loadSparklines(db: Db, tokenIds: number[]): Promise<Map<number, SparkPoint[]>> {
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
        ),
      );

    const sparklines = await loadSparklines(db, [...new Set(rows.map((r) => r.token.id))]);
    const cards = rows.map((r) => toCard(r.call, r.token, sparklines.get(r.token.id) ?? []));

    const body: BoardResponse = {
      group: { slug: group.slug, title: group.title },
      window,
      generatedAt: new Date().toISOString(),
      sections: classifySections(cards),
    };
    return c.json(body);
  });

  // Any member may bin, and the effect is group-wide (docs/decisions.md).
  app.post('/api/g/:slug/calls/:callId/bin', async (c) => {
    const group = c.get('group');
    const callId = Number(c.req.param('callId'));
    if (!Number.isSafeInteger(callId) || callId <= 0) {
      return c.json({ error: 'not found' }, 404);
    }

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
      publish({ type: 'call_binned', tokenId: binned[0].tokenId, callId });
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

  return app;
}
