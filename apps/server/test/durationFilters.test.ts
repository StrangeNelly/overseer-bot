import { describe, expect, it } from 'vitest';
import {
  RANGE_DURATION_HOURS,
  SLEEPER_DURATIONS_HOURS,
  SLEEPER_LONG_ONLY_MIN_HOURS,
  fmtDurationHours,
  rangeHoursAllowed,
  sleeperBandsFor,
} from '@groupie/shared';
import { parseQuery } from '../src/api/range.js';
import { parseMinHours, passesServeAgeCeiling } from '../src/api/sleepers.js';

/**
 * The two duration filters' PARAMETER contracts — Ranging's `hours` (with the
 * small-band gate on 30m/1h) and Sleepers' `minHours` (with the $1M–$3M band
 * gate). Both are parsed from a query string, so both are a place where a
 * hand-typed URL must be answered with a 400 rather than a silent reinterpretation.
 */

/** A query function over a plain object, the shape both parsers read. */
const q =
  (params: Record<string, string>) =>
  (key: string): string | undefined =>
    params[key];

describe('fmtDurationHours', () => {
  it('reads a sub-hour duration in minutes', () => {
    expect(fmtDurationHours(0.5)).toBe('30m');
    expect(fmtDurationHours(0.25)).toBe('15m');
  });

  it('reads an hour or more in hours', () => {
    expect(fmtDurationHours(1)).toBe('1h');
    expect(fmtDurationHours(3)).toBe('3h');
    expect(fmtDurationHours(48)).toBe('48h');
  });

  it('never invents a number for a bad one', () => {
    expect(fmtDurationHours(Number.NaN)).toBe('—');
    expect(fmtDurationHours(-1)).toBe('—');
  });
});

describe('rangeHoursAllowed', () => {
  it('offers the short durations only up to a $500K band high', () => {
    expect(rangeHoursAllowed(0.5, 100_000)).toBe(true);
    // The boundary is inclusive — the third preset (250K–500K) keeps them.
    expect(rangeHoursAllowed(0.5, 500_000)).toBe(true);
    expect(rangeHoursAllowed(0.5, 500_001)).toBe(false);
    expect(rangeHoursAllowed(1, 1_000_000)).toBe(false);
  });

  it('never gates 3h and up', () => {
    for (const hours of RANGE_DURATION_HOURS.filter((h) => h >= 3)) {
      expect(rangeHoursAllowed(hours, 1_000_000_000)).toBe(true);
    }
  });
});

describe('GET /api/g/:slug/range — parameter validation', () => {
  it('defaults to the 50K–100K band at 6h', () => {
    expect(parseQuery(q({}))).toEqual({ loUsd: 50_000, hiUsd: 100_000, hours: 6 });
  });

  it('accepts every duration in the tuple, fractions included', () => {
    for (const hours of RANGE_DURATION_HOURS) {
      expect(parseQuery(q({ lo: '50000', hi: '100000', hours: String(hours) }))).toEqual({
        loUsd: 50_000,
        hiUsd: 100_000,
        hours,
      });
    }
  });

  it('rejects a duration that is not in the tuple', () => {
    expect(parseQuery(q({ hours: '2' }))).toHaveProperty('error');
    expect(parseQuery(q({ hours: '0.25' }))).toHaveProperty('error');
    expect(parseQuery(q({ hours: 'soon' }))).toHaveProperty('error');
  });

  it('rejects 30m against a band whose high is above $500K', () => {
    const result = parseQuery(q({ lo: '300000', hi: '600000', hours: '0.5' }));
    expect(result).toHaveProperty('error');
    expect('error' in result ? result.error : '').toContain('30m');
  });

  it('allows 30m at exactly a $500K high, and refuses one dollar past it', () => {
    expect(parseQuery(q({ lo: '250000', hi: '500000', hours: '0.5' }))).toEqual({
      loUsd: 250_000,
      hiUsd: 500_000,
      hours: 0.5,
    });
    expect(parseQuery(q({ lo: '250000', hi: '500001', hours: '0.5' }))).toHaveProperty('error');
  });

  it('gates 1h the same way, and leaves 3h alone on the same band', () => {
    expect(parseQuery(q({ lo: '500000', hi: '1000000', hours: '1' }))).toHaveProperty('error');
    expect(parseQuery(q({ lo: '500000', hi: '1000000', hours: '3' }))).toEqual({
      loUsd: 500_000,
      hiUsd: 1_000_000,
      hours: 3,
    });
  });

  it('still enforces the band bounds themselves', () => {
    expect(parseQuery(q({ lo: '100', hi: '5000' }))).toHaveProperty('error');
    expect(parseQuery(q({ lo: '100000', hi: '50000' }))).toHaveProperty('error');
    expect(parseQuery(q({ lo: '1.5', hi: '50000' }))).toHaveProperty('error');
  });
});

describe('GET /api/g/:slug/sleepers — minHours validation', () => {
  it('defaults to 3h, the shortest duration', () => {
    expect(parseMinHours(undefined)).toEqual({ minHours: 3 });
    expect(parseMinHours('')).toEqual({ minHours: 3 });
  });

  it('accepts every duration in the tuple', () => {
    for (const hours of SLEEPER_DURATIONS_HOURS) {
      expect(parseMinHours(String(hours))).toEqual({ minHours: hours });
    }
  });

  it('rejects anything outside the tuple rather than clamping to it', () => {
    for (const raw of ['0', '1', '4', '12', '48', '1000', 'week', '3.5', '-3']) {
      expect(parseMinHours(raw)).toHaveProperty('error');
    }
  });
});

describe('passesServeAgeCeiling — round 9 meets round 14', () => {
  const NOW = Date.parse('2026-09-02T12:00:00Z');
  const DAY = 24 * 3_600_000;
  const ageDays = (d: number) => new Date(NOW - d * DAY);

  it('caps short-duration views at 10 days of pool age, inclusive', () => {
    for (const hours of SLEEPER_DURATIONS_HOURS.filter((h) => h < SLEEPER_LONG_ONLY_MIN_HOURS)) {
      expect(passesServeAgeCeiling(ageDays(10), hours, NOW)).toBe(true);
      expect(passesServeAgeCeiling(new Date(NOW - 10 * DAY - 60_000), hours, NOW)).toBe(false);
      expect(passesServeAgeCeiling(ageDays(21), hours, NOW)).toBe(false);
    }
  });

  it('lets the 2w/1m views see pools the short views cannot', () => {
    for (const hours of SLEEPER_DURATIONS_HOURS.filter((h) => h >= SLEEPER_LONG_ONLY_MIN_HOURS)) {
      expect(passesServeAgeCeiling(ageDays(21), hours, NOW)).toBe(true);
      expect(passesServeAgeCeiling(ageDays(35), hours, NOW)).toBe(true);
    }
  });

  it('treats an unknown pool age as too old for the short views', () => {
    expect(passesServeAgeCeiling(null, 3, NOW)).toBe(false);
    expect(passesServeAgeCeiling(null, SLEEPER_LONG_ONLY_MIN_HOURS, NOW)).toBe(true);
  });
});

describe('sleeperBandsFor — the $1M–$3M band gate', () => {
  it('hides the long-only band at every duration below 2w', () => {
    for (const hours of SLEEPER_DURATIONS_HOURS.filter((h) => h < SLEEPER_LONG_ONLY_MIN_HOURS)) {
      const bands = sleeperBandsFor(hours);
      expect(bands).toHaveLength(4);
      expect(bands.some((b) => b.loUsd === 1_000_000)).toBe(false);
    }
  });

  it('unlocks it at 2w and 1m', () => {
    for (const hours of [336, 720]) {
      const bands = sleeperBandsFor(hours);
      expect(bands).toHaveLength(5);
      expect(bands[4]).toMatchObject({ loUsd: 1_000_000, hiUsd: 3_000_000, longOnly: true });
    }
  });

  it('always returns bands in ascending order', () => {
    for (const hours of SLEEPER_DURATIONS_HOURS) {
      const los = sleeperBandsFor(hours).map((b) => b.loUsd);
      expect(los).toEqual([...los].sort((a, b) => a - b));
    }
  });
});
