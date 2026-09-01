import type { RangeInfo } from '@groupie/shared';

/**
 * Ranging = accumulation detection (docs/decisions.md). A coin that 10-20x's
 * usually sits in a band for hours first, so the question is "how long has this
 * token's mcap held inside lo..hi, continuously, up to right now?".
 *
 * Everything here is pure: range.ts loads the buckets, this file judges them.
 */

/** Snapshot buckets are 5-minute mcap averages — see range.ts's SQL. */
export const RANGE_BUCKET_MS = 300_000;

/**
 * A hole this large between two consecutive streak buckets ends the streak.
 * Polling tiers vary (a quiet token drops to slow polling, a dead-ish one stops
 * entirely), and time we never observed is not evidence the token stayed in the
 * band — it must not be silently claimed as in-range.
 */
export const MAX_BUCKET_GAP_MS = 30 * 60_000;

/** 5-minute buckets: 12 per hour if polling never missed a beat. */
const BUCKETS_PER_HOUR = 3_600_000 / RANGE_BUCKET_MS;
/** Half the theoretical buckets must actually exist before we trust a verdict. */
const MIN_COVERAGE_RATIO = 0.5;

const HOUR_MS = 3_600_000;

export interface McapBucket {
  /** Unix ms at the start of the 5-minute bucket. */
  bucketStartMs: number;
  avgMcapUsd: number;
}

/** Bounds are inclusive: a band's edge is part of the band. */
function inBand(bucket: McapBucket, loUsd: number, hiUsd: number): boolean {
  return (
    Number.isFinite(bucket.avgMcapUsd) &&
    bucket.avgMcapUsd >= loUsd &&
    bucket.avgMcapUsd <= hiUsd
  );
}

/**
 * Continuous time-in-band ending at the newest bucket.
 *
 * `buckets` are 5-minute averages ascending by time, possibly with gaps. The
 * newest bucket must be in-band — a token that has already left the band is not
 * ranging, however long it sat there yesterday. Averaging is what absorbs a
 * single-poll wick; a bucket whose *average* leaves the band is a real move and
 * bounds the streak.
 *
 * Returns null when there is nothing to report.
 */
export function computeInRange(
  buckets: McapBucket[],
  loUsd: number,
  hiUsd: number,
  nowMs: number,
): RangeInfo | null {
  const newestIdx = buckets.length - 1;
  const newest = buckets[newestIdx];
  if (!newest || !inBand(newest, loUsd, hiUsd)) return null;

  let startIdx = newestIdx;
  let startMs = newest.bucketStartMs;
  let low = newest.avgMcapUsd;
  let high = newest.avgMcapUsd;

  for (let i = newestIdx - 1; i >= 0; i--) {
    const bucket = buckets[i];
    if (!bucket || !inBand(bucket, loUsd, hiUsd)) break;
    if (startMs - bucket.bucketStartMs > MAX_BUCKET_GAP_MS) break;
    startIdx = i;
    startMs = bucket.bucketStartMs;
    if (bucket.avgMcapUsd < low) low = bucket.avgMcapUsd;
    if (bucket.avgMcapUsd > high) high = bucket.avgMcapUsd;
  }

  if (!Number.isFinite(startMs)) return null;
  return {
    inRangeSince: new Date(startMs).toISOString(),
    // Clamped: a bucket stamped in the future would otherwise read as negative.
    inRangeHours: Math.max(0, (nowMs - startMs) / HOUR_MS),
    observedLowUsd: low,
    observedHighUsd: high,
    bucketCount: newestIdx - startIdx + 1,
  };
}

/**
 * Three independent hurdles, all required:
 *
 * 1. the streak is long enough for the filter;
 * 2. we have watched the token that long at all — a token called 2h ago can
 *    never claim a 6h range (docs/decisions.md);
 * 3. the streak is backed by real data, not two lonely buckets either side of a
 *    polling outage: >= 50% of the buckets a 5-minute cadence would produce.
 */
export function qualifies(info: RangeInfo, minHours: number, dataSpanHours: number): boolean {
  return (
    info.inRangeHours >= minHours &&
    dataSpanHours >= minHours &&
    info.bucketCount >= minHours * BUCKETS_PER_HOUR * MIN_COVERAGE_RATIO
  );
}
