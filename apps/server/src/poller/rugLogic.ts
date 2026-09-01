import { THRESHOLDS } from '@groupie/shared';

/**
 * Rug auto-removal (docs/decisions.md round 5). Owner's rule: a token whose
 * mcap has sat below $8k continuously for 6+ hours is a rug and comes off the
 * board. The judgement is deliberately conservative — auto-removal is not a
 * verdict to reach on data we don't have.
 *
 * Everything here is pure: rugSweep.ts loads the buckets, this file judges them.
 */

/** Snapshot buckets are 5-minute mcap MAXIMA — see rugSweep.ts's SQL. */
export const RUG_BUCKET_MS = 300_000;

/**
 * The newest bucket must be at least this fresh. A token that stopped being
 * polled (outage, delisting from both APIs) stops producing evidence, and
 * silence is not proof it stayed flat — so it is never condemned on it.
 */
export const MAX_BUCKET_AGE_MS = 30 * 60_000;

/** 5-minute buckets: 12 per hour if polling never missed a beat. */
const BUCKETS_PER_HOUR = 3_600_000 / RUG_BUCKET_MS;
/** Half the theoretical buckets must exist before we trust a verdict (rangeLogic's convention). */
const MIN_COVERAGE_RATIO = 0.5;

const HOUR_MS = 3_600_000;

export interface RugBucket {
  /** Unix ms at the start of the 5-minute bucket. */
  bucketStartMs: number;
  /** Highest mcap observed inside the bucket. */
  maxMcapUsd: number;
}

/**
 * Has this token been under the rug floor continuously for the full window?
 *
 * `buckets` are 5-minute MAXIMA ascending by time, possibly with gaps. Maxima,
 * not averages: one bucket that PEAKED above the floor proves the token was
 * alive in that window, and an average would let a single flat hour bury it.
 *
 * Four independent hurdles, all required, plus freshness:
 *
 * 1. there is anything to judge at all;
 * 2. the newest bucket is recent (see MAX_BUCKET_AGE_MS);
 * 3. we have watched the token for the whole window — a coin called 2h ago can
 *    never have been under the floor for 6h;
 * 4. the window is backed by real data, not two lonely buckets either side of a
 *    polling outage: >= 50% of the buckets a 5-minute cadence would produce;
 * 5. every bucket max is below the floor.
 */
export function isSustainedRug(buckets: RugBucket[], nowMs: number): boolean {
  const oldest = buckets[0];
  const newest = buckets[buckets.length - 1];
  if (!oldest || !newest) return false;

  if (nowMs - newest.bucketStartMs > MAX_BUCKET_AGE_MS) return false;
  if (nowMs - oldest.bucketStartMs < THRESHOLDS.rugFloorHours * HOUR_MS) return false;
  if (buckets.length < THRESHOLDS.rugFloorHours * BUCKETS_PER_HOUR * MIN_COVERAGE_RATIO) {
    return false;
  }

  for (const bucket of buckets) {
    // Strictly below: the owner's rule is "below $8k", so a bucket sitting AT
    // the floor is not below it. An unmeasurable max is never death evidence
    // either (death.ts's rule), and it must not be silently skipped.
    if (!Number.isFinite(bucket.maxMcapUsd) || bucket.maxMcapUsd >= THRESHOLDS.rugFloorMcapUsd) {
      return false;
    }
  }
  return true;
}
