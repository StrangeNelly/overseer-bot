import { describe, expect, it } from 'vitest';
import { computeInRange, qualifies, RANGE_BUCKET_MS, type McapBucket } from '../src/api/rangeLogic.js';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 8, 1, 12, 0, 0);
const LO = 50_000;
const HI = 100_000;

/**
 * `count` contiguous 5-minute buckets ending at `endMs` (the newest bucket's
 * start), oldest first — the shape range.ts hands to computeInRange.
 */
function series(count: number, mcap: number | ((i: number) => number), endMs = NOW): McapBucket[] {
  const out: McapBucket[] = [];
  for (let i = count - 1; i >= 0; i--) {
    out.push({
      bucketStartMs: endMs - i * RANGE_BUCKET_MS,
      avgMcapUsd: typeof mcap === 'function' ? mcap(count - 1 - i) : mcap,
    });
  }
  return out;
}

/** 6h of buckets = 72 at 5-minute resolution. */
const SIX_HOURS_OF_BUCKETS = 72;

describe('computeInRange', () => {
  it('returns null with no buckets at all', () => {
    expect(computeInRange([], LO, HI, NOW)).toBeNull();
  });

  it('returns null when the newest bucket is out of band', () => {
    const buckets = series(SIX_HOURS_OF_BUCKETS, 70_000);
    const newest = buckets[buckets.length - 1];
    if (!newest) throw new Error('fixture');
    newest.avgMcapUsd = 180_000;
    expect(computeInRange(buckets, LO, HI, NOW)).toBeNull();
  });

  it('measures a clean 6h streak: hours, extremes and bucket count', () => {
    // 73 buckets spans exactly 6h from the oldest bucket start to now.
    const buckets = series(SIX_HOURS_OF_BUCKETS + 1, (i) => 60_000 + i * 100);
    const info = computeInRange(buckets, LO, HI, NOW);
    expect(info).not.toBeNull();
    if (!info) return;
    expect(info.inRangeHours).toBeCloseTo(6, 10);
    expect(info.bucketCount).toBe(73);
    expect(info.observedLowUsd).toBe(60_000);
    expect(info.observedHighUsd).toBe(60_000 + 72 * 100);
    expect(info.inRangeSince).toBe(new Date(NOW - 6 * HOUR).toISOString());
  });

  it('a mid-history bucket average outside the band bounds the streak', () => {
    // Wicks are absorbed by averaging upstream; a bucket AVERAGE out of band is
    // a real excursion, so the streak may only reach back to it.
    const buckets = series(SIX_HOURS_OF_BUCKETS + 1, 70_000);
    const breaker = buckets[SIX_HOURS_OF_BUCKETS - 24]; // 2h before now
    if (!breaker) throw new Error('fixture');
    breaker.avgMcapUsd = 140_000;
    const info = computeInRange(buckets, LO, HI, NOW);
    expect(info).not.toBeNull();
    if (!info) return;
    expect(info.bucketCount).toBe(24);
    expect(info.inRangeHours).toBeCloseTo(2 - 5 / 60, 10);
  });

  it('a gap longer than 30 minutes breaks the streak', () => {
    // 1h of recent buckets, a 45-minute hole, then hours of older in-band data.
    const recent = series(12, 70_000);
    const older = series(48, 70_000, NOW - HOUR - 45 * 60_000);
    const info = computeInRange([...older, ...recent], LO, HI, NOW);
    expect(info).not.toBeNull();
    if (!info) return;
    expect(info.bucketCount).toBe(12);
    expect(info.inRangeSince).toBe(new Date(NOW - 55 * 60_000).toISOString());
  });

  it('a gap of exactly 30 minutes is tolerated', () => {
    const recent = series(12, 70_000);
    const older = series(12, 70_000, NOW - 55 * 60_000 - 30 * 60_000);
    const info = computeInRange([...older, ...recent], LO, HI, NOW);
    expect(info?.bucketCount).toBe(24);
  });

  it('band bounds are inclusive on both sides', () => {
    const buckets = series(3, (i) => [LO, HI, LO][i] ?? LO);
    const info = computeInRange(buckets, LO, HI, NOW);
    expect(info).not.toBeNull();
    if (!info) return;
    expect(info.bucketCount).toBe(3);
    expect(info.observedLowUsd).toBe(LO);
    expect(info.observedHighUsd).toBe(HI);
  });

  it('a value one dollar outside either bound is out of band', () => {
    expect(computeInRange(series(3, HI + 1), LO, HI, NOW)).toBeNull();
    expect(computeInRange(series(3, LO - 1), LO, HI, NOW)).toBeNull();
  });

  it('a single in-band bucket still reports, with the streak starting there', () => {
    const info = computeInRange(series(1, 70_000), LO, HI, NOW);
    expect(info?.bucketCount).toBe(1);
    expect(info?.inRangeHours).toBe(0);
  });

  it('a non-finite average is treated as out of band', () => {
    expect(computeInRange([{ bucketStartMs: NOW, avgMcapUsd: NaN }], LO, HI, NOW)).toBeNull();
  });
});

describe('qualifies', () => {
  /** Full-coverage info for `hours` of streak — the "everything is fine" input. */
  function info(hours: number, bucketCount = Math.round(hours * 12) + 1) {
    return {
      inRangeSince: new Date(NOW - hours * HOUR).toISOString(),
      inRangeHours: hours,
      observedLowUsd: 60_000,
      observedHighUsd: 80_000,
      bucketCount,
    };
  }

  it('passes when streak, data span and coverage all clear the bar', () => {
    expect(qualifies(info(6), 6, 12)).toBe(true);
  });

  it('fails on a streak shorter than the filter', () => {
    expect(qualifies(info(5.5), 6, 24)).toBe(false);
  });

  it('fails when the token has not been watched long enough', () => {
    // Called 2h ago: it cannot claim a 6h band however good its own numbers look.
    expect(qualifies(info(6, 40), 6, 2)).toBe(false);
    expect(qualifies(info(2), 6, 2)).toBe(false);
  });

  it('fails on sparse coverage even with a long enough streak', () => {
    // 6h needs >= 36 buckets; two lonely buckets either side of an outage do not
    // get to claim six hours of accumulation.
    expect(qualifies(info(6, 20), 6, 12)).toBe(false);
  });

  it('accepts exactly 50% coverage', () => {
    expect(qualifies(info(6, 36), 6, 6)).toBe(true);
  });

  it('accepts a streak and span exactly equal to the filter', () => {
    expect(qualifies(info(48), 48, 48)).toBe(true);
  });

  // The 30-minute filter (owner ask, small bands only) is the first fractional
  // duration: every hurdle here has to scale rather than assume whole hours.
  it('scales the coverage floor to the half-hour filter: 3 of 6 buckets', () => {
    expect(qualifies(info(0.5, 3), 0.5, 1)).toBe(true);
    expect(qualifies(info(0.5, 2), 0.5, 1)).toBe(false);
  });

  it('still enforces streak and data span at the half-hour filter', () => {
    // 25 minutes of streak is not 30.
    expect(qualifies(info(0.4166, 6), 0.5, 4)).toBe(false);
    // Full coverage, but the token has only been watched 15 minutes.
    expect(qualifies(info(0.5, 6), 0.5, 0.25)).toBe(false);
  });

  it('needs 6 of 12 buckets at the one-hour filter', () => {
    expect(qualifies(info(1, 6), 1, 1)).toBe(true);
    expect(qualifies(info(1, 5), 1, 1)).toBe(false);
  });
});
