import { POLL_TIERS, THRESHOLDS } from '@groupie/shared';

/**
 * Rug probation (docs/decisions.md round 6, superseding round 5's 6h sweep).
 * Owner's lifecycle: a token under $8k for an hour is HIDDEN from every board
 * section (not dead, not binned); it is then polled quietly for 24h; getting
 * back over $30k and holding it for 3h REVIVES it into view; 24h of probation
 * without that is the permanent rug.
 *
 * Hiding is cheap to undo, so an hour is enough evidence for it. Reviving and
 * expiring are not, so both keep round 5's conservative posture: span, coverage
 * and freshness hurdles before any verdict.
 *
 * Everything here is pure: rugSweep.ts loads the buckets, this file judges them.
 */

/** Snapshot buckets are 5-minute mcap extremes — see rugSweep.ts's SQL. */
export const RUG_BUCKET_MS = 300_000;

/**
 * The newest bucket must be at least this fresh to hide a token. One that
 * stopped being polled (outage, delisting from both APIs) stops producing
 * evidence, and silence is not proof it stayed flat — so it is never hidden on
 * it.
 */
export const MAX_BUCKET_AGE_MS = 30 * 60_000;

/**
 * The same rule for a revival, but sized to probation's own cadence: a hidden
 * token is polled every 30 minutes, so 30 would fail on ordinary jitter.
 */
export const REVIVE_MAX_BUCKET_AGE_MS = 45 * 60_000;

/** 5-minute buckets: 12 per hour if polling never missed a beat. */
const BUCKETS_PER_HOUR = 3_600_000 / RUG_BUCKET_MS;

/**
 * A hidden token is polled at the probation cadence, so its readings land in
 * one 5-minute bucket every 30 minutes: ~6 per 3h, not 36. Coverage for a
 * revival is measured against THAT, or no hidden token could ever clear it.
 */
const PROBATION_POLL_MS = POLL_TIERS.probationSeconds * 1_000;

/** Half the theoretical buckets must exist before we trust a verdict (rangeLogic's convention). */
const MIN_COVERAGE_RATIO = 0.5;

const HOUR_MS = 3_600_000;

export interface RugBucket {
  /** Unix ms at the start of the 5-minute bucket. */
  bucketStartMs: number;
  /** Highest mcap observed inside the bucket. */
  maxMcapUsd: number;
}

export interface ReviveBucket {
  /** Unix ms at the start of the 5-minute bucket. */
  bucketStartMs: number;
  /** Lowest mcap observed inside the bucket. */
  minMcapUsd: number;
}

/**
 * Has this token been under the rug floor continuously for the full hide
 * window? A true verdict hides it into probation — it does not kill it.
 *
 * `buckets` are 5-minute MAXIMA ascending by time, possibly with gaps. Maxima,
 * not averages: one bucket that PEAKED above the floor proves the token was
 * alive in that window, and an average would let a single flat hour bury it.
 *
 * Four independent hurdles, all required, plus freshness:
 *
 * 1. there is anything to judge at all;
 * 2. the newest bucket is recent (see MAX_BUCKET_AGE_MS);
 * 3. we have watched the token for the whole window — a coin called 20 minutes
 *    ago can never have been under the floor for an hour;
 * 4. the window is backed by real data, not two lonely buckets either side of a
 *    polling outage: >= 50% of the buckets a 5-minute cadence would produce;
 * 5. every bucket max is below the floor.
 */
export function shouldHide(buckets: RugBucket[], nowMs: number): boolean {
  const oldest = buckets[0];
  const newest = buckets[buckets.length - 1];
  if (!oldest || !newest) return false;

  if (nowMs - newest.bucketStartMs > MAX_BUCKET_AGE_MS) return false;
  if (nowMs - oldest.bucketStartMs < THRESHOLDS.rugHideHours * HOUR_MS) return false;
  if (buckets.length < THRESHOLDS.rugHideHours * BUCKETS_PER_HOUR * MIN_COVERAGE_RATIO) {
    return false;
  }

  for (const bucket of buckets) {
    // Strictly below: the owner's rule is "under $8k", so a bucket sitting AT
    // the floor is not under it. An unmeasurable max is never rug evidence
    // either (death.ts's rule), and it must not be silently skipped.
    if (!Number.isFinite(bucket.maxMcapUsd) || bucket.maxMcapUsd >= THRESHOLDS.rugFloorMcapUsd) {
      return false;
    }
  }
  return true;
}

/**
 * Has this hidden token climbed back over the revival mcap and HELD it, every
 * reading, for the full hold window?
 *
 * `buckets` are 5-minute MINIMA ascending by time, possibly with gaps. Minima,
 * because the owner's rule is "every reading at or above $30k — a dip breaks
 * the hold": the lowest reading in a bucket is the one that can break it, and a
 * max (or an average) would hide exactly the dip we are looking for.
 *
 * The hold is walked back from the newest bucket rather than judged over the
 * whole series, so a token that crossed 3h ago qualifies the moment it has held
 * for 3h — it is not made to wait out the wider lookback the query loads.
 *
 * Hurdles, all required:
 *
 * 1. the newest bucket exists, is fresh (REVIVE_MAX_BUCKET_AGE_MS), and is
 *    itself at/above the bar — a token that has already fallen back is not
 *    holding anything, however good yesterday looked;
 * 2. the unbroken run reaches back at least the hold window;
 * 3. that run is backed by real data: >= 50% of the buckets the probation
 *    cadence would produce over it.
 */
export function shouldRevive(buckets: ReviveBucket[], nowMs: number): boolean {
  const newestIdx = buckets.length - 1;
  const newest = buckets[newestIdx];
  if (!newest) return false;
  if (nowMs - newest.bucketStartMs > REVIVE_MAX_BUCKET_AGE_MS) return false;

  // At or above: the owner's rule is ">= $30k". An unmeasurable minimum is not
  // proof the token held, so it breaks the run like any dip would.
  const holds = (bucket: ReviveBucket): boolean =>
    Number.isFinite(bucket.minMcapUsd) && bucket.minMcapUsd >= THRESHOLDS.rugReviveMcapUsd;
  if (!holds(newest)) return false;

  let startMs = newest.bucketStartMs;
  let held = 1;
  for (let i = newestIdx - 1; i >= 0; i--) {
    const bucket = buckets[i];
    if (!bucket || !holds(bucket)) break;
    startMs = bucket.bucketStartMs;
    held += 1;
  }

  const heldMs = nowMs - startMs;
  if (heldMs < THRESHOLDS.rugReviveHoldHours * HOUR_MS) return false;
  // Scaled to the run, not to a fixed 3h: a longer claimed hold has to be
  // backed by proportionally more readings, so two clusters either side of an
  // outage can never add up to a comeback.
  return held >= (heldMs / PROBATION_POLL_MS) * MIN_COVERAGE_RATIO;
}

/**
 * Probation ran its course without a revival: the permanent rug.
 *
 * No data hurdles here — this one is a claim about the clock, not the market,
 * and the token has already cleared the hide rule's hurdles to be on probation
 * at all.
 */
export function isProbationExpired(rugHiddenAtMs: number, nowMs: number): boolean {
  if (!Number.isFinite(rugHiddenAtMs)) return false;
  return nowMs - rugHiddenAtMs >= THRESHOLDS.rugProbationHours * HOUR_MS;
}
