import { and, eq, gte, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { calls, snapshots, tokens, type Db } from '@groupie/db';
import {
  RANGE_DURATION_HOURS,
  type RangeBoardResponse,
  type RangeCard,
  type RangeDurationHours,
  type RangeInfo,
} from '@groupie/shared';
import { loadSparklines, toCard } from './board.js';
import type { ApiEnv } from './membership.js';
import { computeInRange, qualifies, RANGE_BUCKET_MS, type McapBucket } from './rangeLogic.js';

type CallRow = typeof calls.$inferSelect;
type TokenRow = typeof tokens.$inferSelect;

/** The longest filter is 48h, so nothing older can change a verdict. */
const LOOKBACK_HOURS = Math.max(...RANGE_DURATION_HOURS);

const DEFAULT_LO_USD = 50_000;
const DEFAULT_HI_USD = 100_000;
const DEFAULT_HOURS: RangeDurationHours = 6;
/** Below this a "market cap" is noise; above it, nothing on this chain ranges. */
const MIN_LO_USD = 1_000;
const MAX_HI_USD = 1_000_000_000;

interface RangeQuery {
  loUsd: number;
  hiUsd: number;
  hours: RangeDurationHours;
}

/** Whole USD only — the band is a slider, not a precision instrument. */
function parseUsd(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function parseHours(raw: string | undefined): RangeDurationHours | null {
  if (raw === undefined || raw === '') return DEFAULT_HOURS;
  const value = Number(raw);
  return (RANGE_DURATION_HOURS as readonly number[]).includes(value)
    ? (value as RangeDurationHours)
    : null;
}

/** Returns the parsed query, or the message to send back with a 400. */
function parseQuery(query: (key: string) => string | undefined): RangeQuery | { error: string } {
  const loUsd = parseUsd(query('lo'), DEFAULT_LO_USD);
  const hiUsd = parseUsd(query('hi'), DEFAULT_HI_USD);
  if (loUsd === null || hiUsd === null) return { error: 'lo and hi must be whole USD numbers' };
  if (loUsd < MIN_LO_USD) return { error: `lo must be at least ${MIN_LO_USD}` };
  if (hiUsd > MAX_HI_USD) return { error: `hi must be at most ${MAX_HI_USD}` };
  if (loUsd >= hiUsd) return { error: 'lo must be below hi' };

  const hours = parseHours(query('hours'));
  if (hours === null) return { error: `hours must be one of ${RANGE_DURATION_HOURS.join(', ')}` };
  return { loUsd, hiUsd, hours };
}

/** A bind param here would leave Postgres guessing the divisor's type. */
const BUCKET_SECONDS = sql.raw(String(RANGE_BUCKET_MS / 1000));

// db.execute bypasses Drizzle's column decoders, so postgres-js hands these
// back as strings (bigint, double precision) — coerce at the read site.
type BucketRow = {
  token_id: number | string;
  bucket: number | string;
  avg_mcap: number | string | null;
} & Record<string, unknown>;

/**
 * One statement for every candidate token: 5-minute mcap averages over the
 * lookback window, ascending per token. Averaging inside SQL is what makes a
 * single-poll wick unable to reset a token's clock — and it collapses ~1,900
 * rows/token/24h down to at most 576.
 */
async function loadBuckets(
  db: Db,
  tokenIds: number[],
  sinceMs: number,
): Promise<Map<number, McapBucket[]>> {
  const byToken = new Map<number, McapBucket[]>();
  if (tokenIds.length === 0) return byToken;

  const rows = await db.execute<BucketRow>(sql`
    select ${snapshots.tokenId} as token_id,
           floor(extract(epoch from ${snapshots.at}) / ${BUCKET_SECONDS})::bigint as bucket,
           avg(${snapshots.mcapUsd}) as avg_mcap
    from ${snapshots}
    where ${and(
      inArray(snapshots.tokenId, tokenIds),
      gte(snapshots.at, new Date(sinceMs)),
      isNotNull(snapshots.mcapUsd),
    )}
    group by 1, 2
    order by 1, 2
  `);

  for (const row of rows) {
    if (row.avg_mcap === null) continue;
    const avgMcapUsd = Number(row.avg_mcap);
    const bucketStartMs = Number(row.bucket) * RANGE_BUCKET_MS;
    const tokenId = Number(row.token_id);
    if (!Number.isFinite(avgMcapUsd) || !Number.isFinite(bucketStartMs)) continue;
    if (!Number.isFinite(tokenId)) continue;
    const list = byToken.get(tokenId) ?? [];
    list.push({ bucketStartMs, avgMcapUsd });
    byToken.set(tokenId, list);
  }
  return byToken;
}

export function createRangeRoutes(db: Db): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  app.get('/api/g/:slug/range', async (c) => {
    const group = c.get('group');
    const parsed = parseQuery((key) => c.req.query(key));
    if ('error' in parsed) return c.json({ error: parsed.error }, 400);
    const { loUsd, hiUsd, hours } = parsed;

    // Active calls on tokens that still trade: a died/binned call is answered by
    // the Died section, and a dead token cannot be accumulating.
    const rows = await db
      .select({ call: calls, token: tokens })
      .from(calls)
      .innerJoin(tokens, eq(tokens.id, calls.tokenId))
      .where(
        and(eq(calls.groupId, group.id), eq(calls.status, 'active'), ne(tokens.phase, 'dead')),
      );

    const nowMs = Date.now();
    const buckets = await loadBuckets(
      db,
      [...new Set(rows.map((r) => r.token.id))],
      nowMs - LOOKBACK_HOURS * 3_600_000,
    );

    const matches: Array<{ call: CallRow; token: TokenRow; range: RangeInfo }> = [];
    for (const row of rows) {
      const series = buckets.get(row.token.id);
      const oldest = series?.[0];
      if (!series || !oldest) continue;
      const range = computeInRange(series, loUsd, hiUsd, nowMs);
      if (range === null) continue;
      // Data span is measured from the oldest bucket we hold, not from the call:
      // it is what we actually observed, which is the claim being made.
      const dataSpanHours = (nowMs - oldest.bucketStartMs) / 3_600_000;
      if (!qualifies(range, hours, dataSpanHours)) continue;
      matches.push({ call: row.call, token: row.token, range });
    }

    const sparklines = await loadSparklines(db, matches.map((m) => m.token.id));
    const cards: RangeCard[] = matches
      .map((m) => ({
        ...toCard(m.call, m.token, sparklines.get(m.token.id) ?? []),
        range: m.range,
      }))
      .sort((a, b) => b.range.inRangeHours - a.range.inRangeHours);

    const body: RangeBoardResponse = {
      group: { slug: group.slug, title: group.title },
      loUsd,
      hiUsd,
      minHours: hours,
      generatedAt: new Date(nowMs).toISOString(),
      cards,
    };
    return c.json(body);
  });

  return app;
}
