import { describe, expect, it } from 'vitest';
import { THRESHOLDS } from '@groupie/shared';
import { isSustainedRug, MAX_BUCKET_AGE_MS, RUG_BUCKET_MS, type RugBucket } from '../src/poller/rugLogic.js';

const NOW = Date.UTC(2026, 8, 2, 12, 0, 0);
const FLOOR = THRESHOLDS.rugFloorMcapUsd;
/** Well under the floor: an ordinary dead-flat reading. */
const FLAT = 3_000;

/**
 * `count` contiguous buckets ending at `endMs` (the newest bucket's start),
 * oldest first — the shape rugSweep.ts hands to isSustainedRug.
 */
function series(
  count: number,
  mcap: number | ((i: number) => number) = FLAT,
  endMs = NOW,
  stepMs = RUG_BUCKET_MS,
): RugBucket[] {
  const out: RugBucket[] = [];
  for (let i = count - 1; i >= 0; i--) {
    out.push({
      bucketStartMs: endMs - i * stepMs,
      maxMcapUsd: typeof mcap === 'function' ? mcap(count - 1 - i) : mcap,
    });
  }
  return out;
}

/** 73 buckets is the first count whose oldest start is a full 6h behind now. */
const SIX_HOURS_OF_BUCKETS = 73;

describe('isSustainedRug', () => {
  it('rugs a token that has been under the floor for a full 6h', () => {
    expect(isSustainedRug(series(SIX_HOURS_OF_BUCKETS), NOW)).toBe(true);
  });

  it('never rugs on no data at all', () => {
    expect(isSustainedRug([], NOW)).toBe(false);
  });

  it('one bucket that PEAKED above the floor proves life', () => {
    // Maxima, not averages: this token spiked to $20k for a single poll four
    // hours ago, so it was not flat-lined for six.
    const buckets = series(SIX_HOURS_OF_BUCKETS);
    const spike = buckets[SIX_HOURS_OF_BUCKETS - 49]; // 4h before now
    if (!spike) throw new Error('fixture');
    spike.maxMcapUsd = 20_000;
    expect(isSustainedRug(buckets, NOW)).toBe(false);
  });

  it('does not rug a token we have only watched for 2h', () => {
    // Called two hours ago and flat since: real, but not yet six hours of it.
    expect(isSustainedRug(series(25), NOW)).toBe(false);
  });

  it('does not rug on sparse coverage, however long the span', () => {
    // 6h span from 20 buckets: two clusters either side of a polling outage do
    // not get to condemn a coin. 6h needs >= 36.
    const buckets = series(20, FLAT, NOW, (6 * 3_600_000) / 19);
    expect(buckets.length).toBe(20);
    expect(isSustainedRug(buckets, NOW)).toBe(false);
  });

  it('accepts exactly 50% coverage', () => {
    // One bucket every 10 minutes for 6h: 37 rows, the coverage floor is 36.
    expect(isSustainedRug(series(37, FLAT, NOW, 10 * 60_000), NOW)).toBe(true);
  });

  it('does not rug when the newest bucket is stale', () => {
    // Polling stopped 31 minutes ago; silence is not evidence.
    const buckets = series(SIX_HOURS_OF_BUCKETS, FLAT, NOW - MAX_BUCKET_AGE_MS - 60_000);
    expect(isSustainedRug(buckets, NOW)).toBe(false);
  });

  it('tolerates a newest bucket exactly at the freshness limit', () => {
    const buckets = series(SIX_HOURS_OF_BUCKETS, FLAT, NOW - MAX_BUCKET_AGE_MS);
    expect(isSustainedRug(buckets, NOW)).toBe(true);
  });

  it('treats a bucket max of exactly the floor as NOT below it', () => {
    // The owner's rule is "below $8k": at the floor is not below the floor.
    const buckets = series(SIX_HOURS_OF_BUCKETS);
    const edge = buckets[10];
    if (!edge) throw new Error('fixture');
    edge.maxMcapUsd = FLOOR;
    expect(isSustainedRug(buckets, NOW)).toBe(false);
    expect(isSustainedRug(series(SIX_HOURS_OF_BUCKETS, FLOOR), NOW)).toBe(false);
  });

  it('rugs at one dollar below the floor', () => {
    expect(isSustainedRug(series(SIX_HOURS_OF_BUCKETS, FLOOR - 1), NOW)).toBe(true);
  });

  it('a span one bucket short of 6h is not enough', () => {
    expect(isSustainedRug(series(SIX_HOURS_OF_BUCKETS - 1), NOW)).toBe(false);
  });

  it('a non-finite bucket max is never death evidence', () => {
    const buckets = series(SIX_HOURS_OF_BUCKETS);
    const broken = buckets[0];
    if (!broken) throw new Error('fixture');
    broken.maxMcapUsd = NaN;
    expect(isSustainedRug(buckets, NOW)).toBe(false);
  });
});
