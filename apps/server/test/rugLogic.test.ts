import { describe, expect, it } from 'vitest';
import { THRESHOLDS } from '@groupie/shared';
import {
  hideVerdict,
  isProbationExpired,
  MAX_BUCKET_AGE_MS,
  REVIVE_MAX_BUCKET_AGE_MS,
  RUG_BUCKET_MS,
  shouldHide,
  shouldRevive,
  type ReviveBucket,
  type RugBucket,
} from '../src/poller/rugLogic.js';

const NOW = Date.UTC(2026, 8, 2, 12, 0, 0);
const MINUTE = 60_000;
const HOUR = 3_600_000;

const FLOOR = THRESHOLDS.rugFloorMcapUsd;
const BAR = THRESHOLDS.revivalMcapUsd;
/** Well under the floor: an ordinary dead-flat reading. */
const FLAT = 3_000;
/** Comfortably over the revival bar. */
const HIGH = 45_000;

/**
 * `count` contiguous buckets ending at `endMs` (the newest bucket's start),
 * oldest first — the shape rugSweep.ts hands these functions.
 */
function series(
  count: number,
  mcap: number | ((i: number) => number),
  endMs = NOW,
  stepMs = RUG_BUCKET_MS,
): Array<{ bucketStartMs: number; mcapUsd: number }> {
  const out: Array<{ bucketStartMs: number; mcapUsd: number }> = [];
  for (let i = count - 1; i >= 0; i--) {
    out.push({
      bucketStartMs: endMs - i * stepMs,
      mcapUsd: typeof mcap === 'function' ? mcap(count - 1 - i) : mcap,
    });
  }
  return out;
}

const maxima = (...args: Parameters<typeof series>): RugBucket[] =>
  series(...args).map((b) => ({ bucketStartMs: b.bucketStartMs, maxMcapUsd: b.mcapUsd }));

const minima = (...args: Parameters<typeof series>): ReviveBucket[] =>
  series(...args).map((b) => ({ bucketStartMs: b.bucketStartMs, minMcapUsd: b.mcapUsd }));

/** 13 buckets is the first count whose oldest start is a full 1h behind now. */
const HOUR_OF_BUCKETS = 13;

describe('shouldHide — the 1h rug floor (docs/decisions.md round 6)', () => {
  it('hides a token that has been under the floor for a full hour', () => {
    expect(shouldHide(maxima(HOUR_OF_BUCKETS, FLAT), NOW)).toBe(true);
  });

  it('never hides on no data at all', () => {
    expect(shouldHide([], NOW)).toBe(false);
  });

  it('one bucket that PEAKED above the floor proves life', () => {
    // Maxima, not averages: this token spiked to $20k for a single poll half an
    // hour ago, so it was not flat-lined for the hour.
    const buckets = maxima(HOUR_OF_BUCKETS, FLAT);
    const spike = buckets[6];
    if (!spike) throw new Error('fixture');
    spike.maxMcapUsd = 20_000;
    expect(shouldHide(buckets, NOW)).toBe(false);
  });

  it('does not hide a token we have only watched for 20 minutes', () => {
    // Called twenty minutes ago and flat since: real, but not yet an hour of it.
    expect(shouldHide(maxima(5, FLAT), NOW)).toBe(false);
  });

  it('a span one bucket short of the hour is not enough', () => {
    expect(shouldHide(maxima(HOUR_OF_BUCKETS - 1, FLAT), NOW)).toBe(false);
  });

  it('does not hide on sparse coverage, however long the span', () => {
    // 1h span from 5 buckets: two clusters either side of a polling outage do
    // not get to condemn a coin. An hour needs >= 6.
    expect(shouldHide(maxima(5, FLAT, NOW, 15 * MINUTE), NOW)).toBe(false);
  });

  it('accepts exactly 50% coverage', () => {
    // One bucket every 12 minutes for an hour: 6 rows, the coverage floor is 6.
    expect(shouldHide(maxima(6, FLAT, NOW, 12 * MINUTE), NOW)).toBe(true);
  });

  it('does not hide when the newest bucket is stale', () => {
    // Polling stopped 31 minutes ago; silence is not evidence.
    expect(shouldHide(maxima(HOUR_OF_BUCKETS, FLAT, NOW - MAX_BUCKET_AGE_MS - MINUTE), NOW)).toBe(
      false,
    );
  });

  it('tolerates a newest bucket exactly at the freshness limit', () => {
    expect(shouldHide(maxima(HOUR_OF_BUCKETS, FLAT, NOW - MAX_BUCKET_AGE_MS), NOW)).toBe(true);
  });

  it('treats a bucket max of exactly the floor as NOT under it', () => {
    // The owner's rule is "under $8k": at the floor is not under the floor.
    const buckets = maxima(HOUR_OF_BUCKETS, FLAT);
    const edge = buckets[3];
    if (!edge) throw new Error('fixture');
    edge.maxMcapUsd = FLOOR;
    expect(shouldHide(buckets, NOW)).toBe(false);
    expect(shouldHide(maxima(HOUR_OF_BUCKETS, FLOOR), NOW)).toBe(false);
  });

  it('hides at one dollar below the floor', () => {
    expect(shouldHide(maxima(HOUR_OF_BUCKETS, FLOOR - 1), NOW)).toBe(true);
  });

  it('a non-finite bucket max is never rug evidence', () => {
    const buckets = maxima(HOUR_OF_BUCKETS, FLAT);
    const broken = buckets[0];
    if (!broken) throw new Error('fixture');
    broken.maxMcapUsd = NaN;
    expect(shouldHide(buckets, NOW)).toBe(false);
  });

  it('reports WHICH rule hid the token', () => {
    expect(hideVerdict(maxima(HOUR_OF_BUCKETS, FLAT), NOW)).toBe('floor');
    expect(hideVerdict(maxima(HOUR_OF_BUCKETS, 100_000), NOW)).toBeNull();
  });
});

/**
 * The collapse rule (docs/decisions.md round 10). The live case it was written
 * for: HDFI sold off to $8,249 — $249 ABOVE the absolute floor, so round 6's
 * rule never fired — having peaked at $872,124 since the call. -99%, and the
 * board called it "Retraced 0.03x".
 */
describe('shouldHide — the collapse rule (docs/decisions.md round 10)', () => {
  const HDFI_PEAK = 872_124;
  /** The sell-off shelf: just above the $8k floor, nowhere near 10% of the peak. */
  const hdfiShelf = (i: number): number => 8_200 + (i % 5) * 100;

  it('hides the HDFI shape: -99% from peak, parked just above the floor', () => {
    const buckets = maxima(HOUR_OF_BUCKETS, hdfiShelf);
    // The absolute floor alone would have left it on the board forever.
    expect(shouldHide(buckets, NOW)).toBe(false);
    expect(shouldHide(buckets, NOW, HDFI_PEAK)).toBe(true);
    expect(hideVerdict(buckets, NOW, HDFI_PEAK)).toBe('collapse');
  });

  it('never hides a big bleeder — a loss is not a rug', () => {
    // LIGMA-shaped: 0.37x of a $2.68M peak, still a $996k market.
    expect(shouldHide(maxima(HOUR_OF_BUCKETS, 996_000), NOW, 2_680_000)).toBe(false);
  });

  it('holds the $30k ceiling even at 95% off the peak', () => {
    // A $1M coin down to $50k is collapse-shaped by ratio, but $50k is still a
    // market the board has to show. The ceiling is what draws that line.
    expect(shouldHide(maxima(HOUR_OF_BUCKETS, 50_000), NOW, 1_000_000)).toBe(false);
    expect(shouldHide(maxima(HOUR_OF_BUCKETS, THRESHOLDS.collapseCeilingUsd), NOW, 1_000_000)).toBe(
      false,
    );
    expect(
      shouldHide(maxima(HOUR_OF_BUCKETS, THRESHOLDS.collapseCeilingUsd - 1), NOW, 1_000_000),
    ).toBe(true);
  });

  it('is inert without a peak: 10% of nothing hides nothing', () => {
    expect(shouldHide(maxima(HOUR_OF_BUCKETS, hdfiShelf), NOW, null)).toBe(false);
    expect(shouldHide(maxima(HOUR_OF_BUCKETS, hdfiShelf), NOW, 0)).toBe(false);
    expect(shouldHide(maxima(HOUR_OF_BUCKETS, hdfiShelf), NOW, NaN)).toBe(false);
  });

  it('one bucket back above a tenth of the peak proves life', () => {
    // A $200k peak, so the bounce ($20,001) breaks the RATIO alone — it sits
    // well under the $30k ceiling, and every other bucket is a clean collapse.
    const buckets = maxima(HOUR_OF_BUCKETS, 15_000);
    expect(shouldHide(buckets, NOW, 200_000)).toBe(true);
    const bounce = buckets[8];
    if (!bounce) throw new Error('fixture');
    bounce.maxMcapUsd = 20_001;
    expect(shouldHide(buckets, NOW, 200_000)).toBe(false);
  });

  it('qualifies at exactly a tenth of the peak (the rule is "at or below")', () => {
    // $200k peak: the line is $20k, comfortably under the $30k ceiling.
    const line = 200_000 * THRESHOLDS.collapseFromPeakRatio;
    expect(shouldHide(maxima(HOUR_OF_BUCKETS, line), NOW, 200_000)).toBe(true);
    expect(shouldHide(maxima(HOUR_OF_BUCKETS, line + 1), NOW, 200_000)).toBe(false);
  });

  it('clears the same span, coverage and freshness hurdles as the floor rule', () => {
    // 20 minutes of collapse is not an hour of it...
    expect(shouldHide(maxima(5, hdfiShelf), NOW, HDFI_PEAK)).toBe(false);
    // ...two lonely buckets either side of an outage are not an hour of it...
    expect(shouldHide(maxima(5, hdfiShelf, NOW, 15 * MINUTE), NOW, HDFI_PEAK)).toBe(false);
    // ...and neither is an hour that stopped being observed 31 minutes ago.
    const stale = maxima(HOUR_OF_BUCKETS, hdfiShelf, NOW - MAX_BUCKET_AGE_MS - MINUTE);
    expect(shouldHide(stale, NOW, HDFI_PEAK)).toBe(false);
  });

  it('a non-finite bucket max is no more collapse evidence than floor evidence', () => {
    const buckets = maxima(HOUR_OF_BUCKETS, hdfiShelf);
    const broken = buckets[2];
    if (!broken) throw new Error('fixture');
    broken.maxMcapUsd = NaN;
    expect(shouldHide(buckets, NOW, HDFI_PEAK)).toBe(false);
  });

  it('a peak never disqualifies a token the floor rule already condemned', () => {
    // Round 10 only widened the way IN: a $3k coin still hides on the floor
    // rule, however modest the peak it is measured against.
    expect(hideVerdict(maxima(HOUR_OF_BUCKETS, FLAT), NOW, 5_000)).toBe('floor');
  });
});

/**
 * A hidden token is polled every 30 minutes, so its evidence arrives one bucket
 * per half hour: 7 of them span the 3h hold, and coverage is measured against
 * that cadence, not against a 5-minute one.
 */
const PROBATION_STEP = 30 * MINUTE;
const HOLD_BUCKETS = 7;

describe('shouldRevive — >= $30k held for 3h (docs/decisions.md round 6)', () => {
  it('revives a token that has held the bar for the full 3h', () => {
    expect(shouldRevive(minima(HOLD_BUCKETS, HIGH, NOW, PROBATION_STEP), NOW)).toBe(true);
  });

  it('never revives on no data at all', () => {
    expect(shouldRevive([], NOW)).toBe(false);
  });

  it('holds at exactly the bar (the rule is "at or above")', () => {
    expect(shouldRevive(minima(HOLD_BUCKETS, BAR, NOW, PROBATION_STEP), NOW)).toBe(true);
    expect(shouldRevive(minima(HOLD_BUCKETS, BAR - 1, NOW, PROBATION_STEP), NOW)).toBe(false);
  });

  it('a single dip breaks the hold', () => {
    // Minima, not maxima: an hour ago this token touched $29,999 for one poll,
    // and the owner's rule is that every reading must stay at or above the bar.
    const buckets = minima(HOLD_BUCKETS, HIGH, NOW, PROBATION_STEP);
    const dip = buckets[2];
    if (!dip) throw new Error('fixture');
    dip.minMcapUsd = BAR - 1;
    expect(shouldRevive(buckets, NOW)).toBe(false);
  });

  it('a dip restarts the clock rather than disqualifying the token forever', () => {
    // Same dip, but the hold since it is long enough on its own: 7 clean
    // buckets after the break still span 3h.
    const buckets = minima(HOLD_BUCKETS + 1, HIGH, NOW, PROBATION_STEP);
    const dip = buckets[0];
    if (!dip) throw new Error('fixture');
    dip.minMcapUsd = 1_000;
    expect(shouldRevive(buckets, NOW)).toBe(true);
  });

  it('does not revive a token that has already fallen back', () => {
    const buckets = minima(HOLD_BUCKETS, HIGH, NOW, PROBATION_STEP);
    const newest = buckets[buckets.length - 1];
    if (!newest) throw new Error('fixture');
    newest.minMcapUsd = 12_000;
    expect(shouldRevive(buckets, NOW)).toBe(false);
  });

  it('does not revive on a hold shorter than 3h', () => {
    // Five half-hourly buckets: a 2h hold, however clean.
    expect(shouldRevive(minima(5, HIGH, NOW, PROBATION_STEP), NOW)).toBe(false);
  });

  it('does not revive on two lonely readings either side of an outage', () => {
    // 3h05m of claimed hold from 3 buckets. At the probation cadence that span
    // should have produced ~6, so half of it is 3.08 — and 3 is not enough.
    const sparse: ReviveBucket[] = [
      { bucketStartMs: NOW - 185 * MINUTE, minMcapUsd: HIGH },
      { bucketStartMs: NOW - 10 * MINUTE, minMcapUsd: HIGH },
      { bucketStartMs: NOW, minMcapUsd: HIGH },
    ];
    expect(shouldRevive(sparse, NOW)).toBe(false);
    // One more reading in the hole clears the same bar.
    expect(
      shouldRevive([...sparse, { bucketStartMs: NOW - 100 * MINUTE, minMcapUsd: HIGH }].sort(
        (a, b) => a.bucketStartMs - b.bucketStartMs,
      ), NOW),
    ).toBe(true);
  });

  it('does not revive when the newest bucket is stale', () => {
    // Probation polls every 30 minutes, so the freshness limit is wider than
    // the hide rule's — but silence still proves nothing.
    const end = NOW - REVIVE_MAX_BUCKET_AGE_MS - MINUTE;
    expect(shouldRevive(minima(HOLD_BUCKETS, HIGH, end, PROBATION_STEP), NOW)).toBe(false);
  });

  it('tolerates a newest bucket exactly at the freshness limit', () => {
    const end = NOW - REVIVE_MAX_BUCKET_AGE_MS;
    expect(shouldRevive(minima(HOLD_BUCKETS, HIGH, end, PROBATION_STEP), NOW)).toBe(true);
  });

  it('a non-finite minimum breaks the hold like any dip', () => {
    const buckets = minima(HOLD_BUCKETS, HIGH, NOW, PROBATION_STEP);
    const broken = buckets[3];
    if (!broken) throw new Error('fixture');
    broken.minMcapUsd = NaN;
    expect(shouldRevive(buckets, NOW)).toBe(false);
  });
});

describe('isProbationExpired', () => {
  const window = THRESHOLDS.rugProbationHours * HOUR;

  it('expires at exactly 24h of probation', () => {
    expect(isProbationExpired(NOW - window, NOW)).toBe(true);
  });

  it('one millisecond short is still on probation', () => {
    expect(isProbationExpired(NOW - window + 1, NOW)).toBe(false);
  });

  it('a token hidden minutes ago has all its time left', () => {
    expect(isProbationExpired(NOW - 10 * MINUTE, NOW)).toBe(false);
  });

  it('an unreadable stamp never expires anything', () => {
    expect(isProbationExpired(NaN, NOW)).toBe(false);
  });
});
