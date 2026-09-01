import { describe, expect, it } from 'vitest';
import { RANGE_PRESETS, SLEEPERS, requiredVolumeUsd } from '@groupie/shared';
import {
  bandFor,
  dedupeByToken,
  qualify,
  selectSleepers,
  type PoolCandidate,
} from '../src/poller/sleeperLogic.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 8, 2, 12, 0, 0);

/** A candidate that clears every floor; overrides break exactly one thing. */
function candidate(over: Partial<PoolCandidate> = {}): PoolCandidate {
  return {
    address: '0xaaa',
    poolAddress: '0xpool',
    poolName: 'SLEEP / WETH 1%',
    mcapUsd: 80_000,
    liquidityUsd: 25_000,
    // Comfortably over requiredVolumeUsd(80_000) ≈ $19K.
    vol24Usd: 200_000,
    txns24: 400,
    poolCreatedAt: new Date(NOW - 2 * DAY),
    ...over,
  };
}

describe('requiredVolumeUsd', () => {
  it('hits the owner’s $20K -> $10K anchor', () => {
    expect(requiredVolumeUsd(20_000)).toBeGreaterThan(9_500);
    expect(requiredVolumeUsd(20_000)).toBeLessThan(10_500);
  });

  it('hits the owner’s $1M -> $50K anchor', () => {
    expect(requiredVolumeUsd(1_000_000)).toBeGreaterThan(48_000);
    expect(requiredVolumeUsd(1_000_000)).toBeLessThan(52_000);
  });

  it('is strictly increasing in mcap', () => {
    let previous = 0;
    for (const mcap of [10_000, 50_000, 100_000, 250_000, 500_000, 1_000_000, 5_000_000]) {
      const required = requiredVolumeUsd(mcap);
      expect(required).toBeGreaterThan(previous);
      previous = required;
    }
  });

  it('tapers: the required turnover PERCENTAGE falls as mcap rises', () => {
    const pct = (mcap: number) => requiredVolumeUsd(mcap) / mcap;
    // ~50% at $20K down to ~5% at $1M — the whole point of the exponent.
    expect(pct(20_000)).toBeGreaterThan(0.45);
    expect(pct(1_000_000)).toBeLessThan(0.06);
    for (const [lo, hi] of [
      [20_000, 50_000],
      [50_000, 100_000],
      [100_000, 500_000],
      [500_000, 1_000_000],
    ] as const) {
      expect(pct(hi)).toBeLessThan(pct(lo));
    }
  });

  it('never passes a bad mcap', () => {
    expect(requiredVolumeUsd(0)).toBe(Number.POSITIVE_INFINITY);
    expect(requiredVolumeUsd(-1)).toBe(Number.POSITIVE_INFINITY);
    expect(requiredVolumeUsd(Number.NaN)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('bandFor', () => {
  it('buckets a mcap into the matching RANGE_PRESETS band', () => {
    expect(bandFor(75_000)).toEqual({ loUsd: 50_000, hiUsd: 100_000 });
    expect(bandFor(180_000)).toEqual({ loUsd: 100_000, hiUsd: 250_000 });
    expect(bandFor(400_000)).toEqual({ loUsd: 250_000, hiUsd: 500_000 });
    expect(bandFor(900_000)).toEqual({ loUsd: 500_000, hiUsd: 1_000_000 });
  });

  it('is a partition: a shared endpoint belongs to the upper band only', () => {
    expect(bandFor(100_000)).toEqual({ loUsd: 100_000, hiUsd: 250_000 });
    expect(bandFor(250_000)).toEqual({ loUsd: 250_000, hiUsd: 500_000 });
    expect(bandFor(500_000)).toEqual({ loUsd: 500_000, hiUsd: 1_000_000 });
  });

  it('includes both outer edges but nothing beyond them', () => {
    expect(bandFor(50_000)).toEqual({ loUsd: 50_000, hiUsd: 100_000 });
    expect(bandFor(1_000_000)).toEqual({ loUsd: 500_000, hiUsd: 1_000_000 });
    expect(bandFor(49_999)).toBeNull();
    expect(bandFor(1_000_001)).toBeNull();
  });

  it('rejects a non-finite mcap', () => {
    expect(bandFor(Number.NaN)).toBeNull();
    expect(bandFor(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('qualify — floors', () => {
  it('passes a healthy candidate and derives band + turnover', () => {
    const result = qualify(candidate(), NOW);
    expect(result).not.toBeNull();
    expect(result?.band).toEqual({ loUsd: 50_000, hiUsd: 100_000 });
    expect(result?.turnover).toBeCloseTo(200_000 / 80_000, 10);
  });

  it('rejects thin liquidity, and accepts exactly the floor', () => {
    expect(qualify(candidate({ liquidityUsd: SLEEPERS.minLiquidityUsd - 1 }), NOW)).toBeNull();
    expect(qualify(candidate({ liquidityUsd: SLEEPERS.minLiquidityUsd }), NOW)).not.toBeNull();
  });

  it('rejects a negative reserve (GeckoTerminal really does report these)', () => {
    expect(qualify(candidate({ liquidityUsd: -545_308 }), NOW)).toBeNull();
  });

  it('rejects too few trades, and accepts exactly the floor', () => {
    expect(qualify(candidate({ txns24: SLEEPERS.minTxns24 - 1 }), NOW)).toBeNull();
    expect(qualify(candidate({ txns24: SLEEPERS.minTxns24 }), NOW)).not.toBeNull();
  });

  it('rejects a pool younger than the age window', () => {
    expect(qualify(candidate({ poolCreatedAt: new Date(NOW - 59 * 60_000) }), NOW)).toBeNull();
  });

  it('accepts a pool exactly at the young edge', () => {
    expect(qualify(candidate({ poolCreatedAt: new Date(NOW - HOUR) }), NOW)).not.toBeNull();
  });

  it('accepts a pool exactly at the old edge and rejects one minute past it', () => {
    expect(qualify(candidate({ poolCreatedAt: new Date(NOW - 10 * DAY) }), NOW)).not.toBeNull();
    expect(
      qualify(candidate({ poolCreatedAt: new Date(NOW - 10 * DAY - 60_000) }), NOW),
    ).toBeNull();
  });

  it('rejects a pool timestamped in the future (a bad reading, not a new coin)', () => {
    expect(qualify(candidate({ poolCreatedAt: new Date(NOW + HOUR) }), NOW)).toBeNull();
  });

  it('applies the tapering volume requirement at both ends of the curve', () => {
    // $60K mcap needs ~$16K; $20K of volume clears it, $10K does not.
    const small = (vol: number) => candidate({ mcapUsd: 60_000, vol24Usd: vol });
    expect(qualify(small(20_000), NOW)).not.toBeNull();
    expect(qualify(small(10_000), NOW)).toBeNull();
    // The same $20K is nowhere near enough at $900K mcap (~$48K required).
    const large = (vol: number) => candidate({ mcapUsd: 900_000, vol24Usd: vol });
    expect(qualify(large(20_000), NOW)).toBeNull();
    expect(qualify(large(60_000), NOW)).not.toBeNull();
  });

  it('accepts volume exactly at the requirement', () => {
    const mcap = 120_000;
    expect(qualify(candidate({ mcapUsd: mcap, vol24Usd: requiredVolumeUsd(mcap) }), NOW)).not.toBeNull();
  });

  it('rejects a mcap outside every band however well it trades', () => {
    expect(qualify(candidate({ mcapUsd: 20_000, vol24Usd: 500_000 }), NOW)).toBeNull();
    expect(qualify(candidate({ mcapUsd: 5_000_000, vol24Usd: 50_000_000 }), NOW)).toBeNull();
  });

  it('treats every missing figure as a failure, never as a pass', () => {
    for (const missing of [
      { mcapUsd: null },
      { liquidityUsd: null },
      { vol24Usd: null },
      { txns24: null },
      { poolCreatedAt: null },
    ] as Partial<PoolCandidate>[]) {
      expect(qualify(candidate(missing), NOW)).toBeNull();
    }
  });
});

describe('dedupeByToken', () => {
  it('keeps one entry per token — the highest-volume pool', () => {
    const pools = [
      candidate({ address: '0xa', poolAddress: '0xlow', vol24Usd: 100_000 }),
      candidate({ address: '0xa', poolAddress: '0xhigh', vol24Usd: 900_000 }),
      candidate({ address: '0xa', poolAddress: '0xmid', vol24Usd: 400_000 }),
      candidate({ address: '0xb', poolAddress: '0xother', vol24Usd: 50_000 }),
    ];
    const out = dedupeByToken(pools);
    expect(out).toHaveLength(2);
    expect(out.find((p) => p.address === '0xa')?.poolAddress).toBe('0xhigh');
    expect(out.find((p) => p.address === '0xb')?.poolAddress).toBe('0xother');
  });

  it('a null-volume pool never beats a real one, in either order', () => {
    const withVolume = candidate({ address: '0xa', poolAddress: '0xreal', vol24Usd: 10 });
    const withoutVolume = candidate({ address: '0xa', poolAddress: '0xnull', vol24Usd: null });
    expect(dedupeByToken([withVolume, withoutVolume])[0]?.poolAddress).toBe('0xreal');
    expect(dedupeByToken([withoutVolume, withVolume])[0]?.poolAddress).toBe('0xreal');
  });

  it('is a no-op on an empty list', () => {
    expect(dedupeByToken([])).toEqual([]);
  });
});

describe('selectSleepers', () => {
  /** n qualifying coins in one band, with descending turnover by index. */
  function bandOf(count: number, mcapUsd: number, prefix: string): PoolCandidate[] {
    return Array.from({ length: count }, (_, i) =>
      candidate({
        address: `${prefix}${i}`,
        poolAddress: `${prefix}pool${i}`,
        mcapUsd,
        // Highest volume first, so index 0 should always rank 1.
        vol24Usd: mcapUsd * (5 - i * 0.2),
      }),
    );
  }

  it('ranks a band by turnover desc and numbers the ranks from 1', () => {
    // Shuffled input: ranking must come from turnover, not arrival order.
    const picks = selectSleepers(
      [
        candidate({ address: '0xslow', mcapUsd: 80_000, vol24Usd: 100_000 }),
        candidate({ address: '0xfast', mcapUsd: 80_000, vol24Usd: 800_000 }),
        candidate({ address: '0xmid', mcapUsd: 80_000, vol24Usd: 400_000 }),
      ],
      NOW,
    );
    expect(picks.map((p) => p.address)).toEqual(['0xfast', '0xmid', '0xslow']);
    expect(picks.map((p) => p.rank)).toEqual([1, 2, 3]);
  });

  it('turnover, not raw volume, decides the ranking', () => {
    const picks = selectSleepers(
      [
        // Bigger coin, bigger volume, worse turnover.
        candidate({ address: '0xbig', mcapUsd: 900_000, vol24Usd: 900_000 }),
        candidate({ address: '0xsmall', mcapUsd: 60_000, vol24Usd: 300_000 }),
      ],
      NOW,
    );
    // Different bands, so band order decides the array; check the figures.
    const small = picks.find((p) => p.address === '0xsmall');
    const big = picks.find((p) => p.address === '0xbig');
    expect(small?.turnover).toBeGreaterThan(big?.turnover ?? 0);
    expect(picks.map((p) => p.address)).toEqual(['0xsmall', '0xbig']);
  });

  it('cuts each band to keepPerBand', () => {
    const picks = selectSleepers(bandOf(10, 80_000, '0xa'), NOW);
    expect(picks).toHaveLength(SLEEPERS.keepPerBand);
    expect(picks.map((p) => p.rank)).toEqual([1, 2, 3, 4, 5, 6]);
    // The six kept are the six best, in order.
    expect(picks.map((p) => p.address)).toEqual(['0xa0', '0xa1', '0xa2', '0xa3', '0xa4', '0xa5']);
  });

  it('cuts every band independently and returns them band-ascending', () => {
    const picks = selectSleepers(
      [
        ...bandOf(8, 80_000, '0xa'), // 50K–100K
        ...bandOf(8, 200_000, '0xb'), // 100K–250K
        ...bandOf(2, 400_000, '0xc'), // 250K–500K
        ...bandOf(8, 900_000, '0xd'), // 500K–1M
      ],
      NOW,
    );
    const perBand = RANGE_PRESETS.map(
      (preset) => picks.filter((p) => p.band.loUsd === preset.loUsd).length,
    );
    expect(perBand).toEqual([SLEEPERS.keepPerBand, SLEEPERS.keepPerBand, 2, SLEEPERS.keepPerBand]);
    // Band ascending, and rank restarts at 1 inside each band.
    const bandOrder = picks.map((p) => p.band.loUsd);
    expect(bandOrder).toEqual([...bandOrder].sort((a, b) => a - b));
    expect(picks.filter((p) => p.rank === 1)).toHaveLength(4);
  });

  it('dedupes before ranking, so one coin cannot fill a band with its own pools', () => {
    const picks = selectSleepers(
      [
        candidate({ address: '0xa', poolAddress: '0xp1', mcapUsd: 80_000, vol24Usd: 300_000 }),
        candidate({ address: '0xa', poolAddress: '0xp2', mcapUsd: 80_000, vol24Usd: 800_000 }),
        candidate({ address: '0xa', poolAddress: '0xp3', mcapUsd: 80_000, vol24Usd: 200_000 }),
        candidate({ address: '0xb', poolAddress: '0xp4', mcapUsd: 80_000, vol24Usd: 400_000 }),
      ],
      NOW,
    );
    expect(picks).toHaveLength(2);
    expect(picks[0]?.address).toBe('0xa');
    expect(picks[0]?.poolAddress).toBe('0xp2');
    expect(picks[1]?.address).toBe('0xb');
  });

  it('drops everything that fails a floor before ranking', () => {
    const picks = selectSleepers(
      [
        candidate({ address: '0xgood' }),
        candidate({ address: '0xthin', liquidityUsd: 500 }),
        candidate({ address: '0xquiet', txns24: 3 }),
        candidate({ address: '0xfresh', poolCreatedAt: new Date(NOW - 10 * 60_000) }),
        candidate({ address: '0xstale', poolCreatedAt: new Date(NOW - 30 * DAY) }),
        candidate({ address: '0xdull', vol24Usd: 100 }),
        candidate({ address: '0xtiny', mcapUsd: 9_000 }),
      ],
      NOW,
    );
    expect(picks.map((p) => p.address)).toEqual(['0xgood']);
  });

  it('returns nothing when nothing qualifies', () => {
    expect(selectSleepers([], NOW)).toEqual([]);
    expect(selectSleepers([candidate({ liquidityUsd: 0 })], NOW)).toEqual([]);
  });
});
