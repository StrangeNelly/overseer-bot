import { describe, expect, it } from 'vitest';
import { SLEEPER_BANDS, SLEEPERS, requiredVolumeUsd } from '@groupie/shared';
import {
  bandFor,
  carriedResidencyHours,
  computeResidency,
  computeShortResidency,
  dedupeByToken,
  inferSupply,
  needsFullMeasurement,
  qualify,
  selectSleepers,
  type Candle,
  type PoolCandidate,
  type PrevResidency,
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
    // 1e9 supply at $80K — the pair the residency walk infers supply from.
    priceUsd: 0.00008,
    liquidityUsd: 25_000,
    // Comfortably over requiredVolumeUsd(80_000) ≈ $19K.
    vol24Usd: 200_000,
    txns24: 400,
    txns1h: 12,
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
  it('buckets a mcap into the matching SLEEPER_BANDS band', () => {
    expect(bandFor(75_000)).toEqual({ loUsd: 50_000, hiUsd: 100_000 });
    expect(bandFor(180_000)).toEqual({ loUsd: 100_000, hiUsd: 250_000 });
    expect(bandFor(400_000)).toEqual({ loUsd: 250_000, hiUsd: 500_000 });
    expect(bandFor(900_000)).toEqual({ loUsd: 500_000, hiUsd: 1_000_000 });
  });

  it('buckets the three upper bands added in round 17', () => {
    expect(bandFor(1_850_000)).toEqual({ loUsd: 1_000_000, hiUsd: 3_000_000 });
    expect(bandFor(2_999_999)).toEqual({ loUsd: 1_000_000, hiUsd: 3_000_000 });
    expect(bandFor(4_000_000)).toEqual({ loUsd: 3_000_000, hiUsd: 5_000_000 });
    expect(bandFor(6_500_000)).toEqual({ loUsd: 5_000_000, hiUsd: 8_000_000 });
  });

  it('is a partition: a shared endpoint belongs to the upper band only', () => {
    expect(bandFor(100_000)).toEqual({ loUsd: 100_000, hiUsd: 250_000 });
    expect(bandFor(250_000)).toEqual({ loUsd: 250_000, hiUsd: 500_000 });
    expect(bandFor(500_000)).toEqual({ loUsd: 500_000, hiUsd: 1_000_000 });
    expect(bandFor(1_000_000)).toEqual({ loUsd: 1_000_000, hiUsd: 3_000_000 });
    expect(bandFor(3_000_000)).toEqual({ loUsd: 3_000_000, hiUsd: 5_000_000 });
    expect(bandFor(5_000_000)).toEqual({ loUsd: 5_000_000, hiUsd: 8_000_000 });
  });

  it('includes both outer edges but nothing beyond them', () => {
    expect(bandFor(50_000)).toEqual({ loUsd: 50_000, hiUsd: 100_000 });
    // The last band CLOSES, so $8M is the top of the ladder, not a gap.
    expect(bandFor(8_000_000)).toEqual({ loUsd: 5_000_000, hiUsd: 8_000_000 });
    expect(bandFor(49_999)).toBeNull();
    expect(bandFor(8_000_001)).toBeNull();
  });

  it('rejects a non-finite mcap', () => {
    expect(bandFor(Number.NaN)).toBeNull();
    expect(bandFor(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('leaves Ranging alone: SLEEPER_BANDS extends the presets, never replaces them', () => {
    // Round 17: the four Ranging presets plus 1M–3M, 3M–5M and 5M–8M.
    expect(SLEEPER_BANDS).toHaveLength(7);
    expect(SLEEPER_BANDS.at(-1)).toMatchObject({ loUsd: 5_000_000, hiUsd: 8_000_000 });
    // No band is duration-gated any more; the flag survives for a future one.
    expect(SLEEPER_BANDS.filter((b) => b.longOnly)).toEqual([]);
  });

  it('is contiguous: every band starts where the previous one ended', () => {
    for (let i = 1; i < SLEEPER_BANDS.length; i++) {
      expect(SLEEPER_BANDS[i]?.loUsd).toBe(SLEEPER_BANDS[i - 1]?.hiUsd);
    }
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

  it('rejects the FORESKIN shape: $10K+ of crumbs against a $1.85M mcap', () => {
    // The absolute floor alone passed this: $5.4K is under $10K, so raise it to
    // a figure that clears the absolute bar and still fails the ratio (0.6%).
    const pulled = candidate({
      mcapUsd: 1_850_000,
      priceUsd: 0.00185,
      liquidityUsd: 11_000,
      vol24Usd: 900_000,
    });
    expect(qualify(pulled, NOW)).toBeNull();
    // ...and the real FORESKIN reading, which fails both floors.
    expect(qualify({ ...pulled, liquidityUsd: 5_400 }, NOW)).toBeNull();
  });

  it('applies the ratio floor inclusively at exactly 2% of mcap', () => {
    const at = (liquidityUsd: number) =>
      qualify(
        candidate({ mcapUsd: 900_000, priceUsd: 0.0009, liquidityUsd, vol24Usd: 300_000 }),
        NOW,
      );
    // 2% of $900K is $18,000.
    expect(at(18_000)).not.toBeNull();
    expect(at(17_999)).toBeNull();
  });

  it('the two liquidity floors are independent — each rejects on its own', () => {
    // Deep relative to a tiny mcap, but under the absolute $10K bar.
    expect(qualify(candidate({ mcapUsd: 60_000, liquidityUsd: 9_000 }), NOW)).toBeNull();
    // Way over $10K, but thin for a $2M coin (1.5%).
    expect(
      qualify(
        candidate({ mcapUsd: 2_000_000, priceUsd: 0.002, liquidityUsd: 30_000, vol24Usd: 900_000 }),
        NOW,
      ),
    ).toBeNull();
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
    // The scan's ceiling is inBandMaxDays (35d), not maxPoolAgeDays: the 2w/1m
    // views need pools older than 10 days, and the API re-applies the 10-day
    // ceiling for the short-duration views at serve time.
    expect(qualify(candidate({ poolCreatedAt: new Date(NOW - 35 * DAY) }), NOW)).not.toBeNull();
    expect(
      qualify(candidate({ poolCreatedAt: new Date(NOW - 35 * DAY - 60_000) }), NOW),
    ).toBeNull();
  });

  it('accepts a pool between 10 and 35 days old (long-view material)', () => {
    expect(qualify(candidate({ poolCreatedAt: new Date(NOW - 21 * DAY) }), NOW)).not.toBeNull();
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
    // Liquidity is set deep enough to clear BOTH floors, so the band is the
    // only thing left to reject on.
    expect(qualify(candidate({ mcapUsd: 20_000, vol24Usd: 500_000 }), NOW)).toBeNull();
    expect(
      qualify(
        // Above $8M, the top of the round-17 ladder.
        candidate({
          mcapUsd: 9_000_000,
          priceUsd: 0.009,
          liquidityUsd: 900_000,
          vol24Usd: 50_000_000,
        }),
        NOW,
      ),
    ).toBeNull();
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
        // 5% of mcap: comfortably over both liquidity floors at any band.
        liquidityUsd: Math.max(25_000, mcapUsd * 0.05),
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

  it('cuts each band to keepPerBand — 12 since round 14 gave the read side a duration filter', () => {
    expect(SLEEPERS.keepPerBand).toBe(12);
    const picks = selectSleepers(bandOf(20, 80_000, '0xa'), NOW);
    expect(picks).toHaveLength(12);
    expect(picks.map((p) => p.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    // The twelve kept are the twelve best, in order.
    expect(picks.map((p) => p.address)).toEqual(
      Array.from({ length: 12 }, (_, i) => `0xa${i}`),
    );
  });

  it('cuts every band independently and returns them band-ascending', () => {
    const picks = selectSleepers(
      [
        ...bandOf(15, 80_000, '0xa'), // 50K–100K
        ...bandOf(15, 200_000, '0xb'), // 100K–250K
        ...bandOf(2, 400_000, '0xc'), // 250K–500K
        ...bandOf(15, 900_000, '0xd'), // 500K–1M
        ...bandOf(15, 2_000_000, '0xe'), // 1M–3M
        ...bandOf(15, 4_000_000, '0xf'), // 3M–5M, round 17
        ...bandOf(15, 6_000_000, '0xg'), // 5M–8M, round 17
      ],
      NOW,
    );
    const perBand = SLEEPER_BANDS.map(
      (preset) => picks.filter((p) => p.band.loUsd === preset.loUsd).length,
    );
    const keep = SLEEPERS.keepPerBand;
    expect(perBand).toEqual([keep, keep, 2, keep, keep, keep, keep]);
    // Band ascending, and rank restarts at 1 inside each band.
    const bandOrder = picks.map((p) => p.band.loUsd);
    expect(bandOrder).toEqual([...bandOrder].sort((a, b) => a - b));
    expect(picks.filter((p) => p.rank === 1)).toHaveLength(7);
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
        candidate({ address: '0xstale', poolCreatedAt: new Date(NOW - 40 * DAY) }),
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

// ---------------------------------------------------------------------------
// Tokenized stocks (docs/decisions.md round 17)
// ---------------------------------------------------------------------------

describe('qualify — isStock', () => {
  it('reads the issuer suffix off the TOKEN name, not the pool name', () => {
    expect(qualify(candidate({ tokenName: 'Invesco QQQ • Robinhood Token' }), NOW)?.isStock).toBe(
      true,
    );
    expect(qualify(candidate({ poolName: 'QQQ / WETH 1%' }), NOW)?.isStock).toBe(false);
  });

  it('flags leveraged equity products', () => {
    expect(qualify(candidate({ tokenName: 'NVDA 3x Long' }), NOW)?.isStock).toBe(true);
  });

  it('never guesses from an unknown name', () => {
    expect(qualify(candidate({ tokenName: null }), NOW)?.isStock).toBe(false);
    expect(qualify(candidate(), NOW)?.isStock).toBe(false);
  });
});

describe('selectSleepers — the stock/coin keep split', () => {
  /** n coins in one band; `stock` names them as Robinhood equity tokens. */
  function kind(count: number, prefix: string, stock: boolean): PoolCandidate[] {
    return Array.from({ length: count }, (_, i) =>
      candidate({
        address: `${prefix}${i}`,
        poolAddress: `${prefix}pool${i}`,
        // Stocks turn over harder here than every coin, so an unsplit cut would
        // hand them all twelve slots — which is exactly the live shape round 17
        // was written for.
        vol24Usd: 80_000 * (stock ? 9 - i * 0.1 : 4 - i * 0.1),
        tokenName: stock ? `Equity ${i} • Robinhood Token` : `Coin ${i}`,
      }),
    );
  }

  it('gives each kind its own keepPerBand, so stocks cannot crowd out coins', () => {
    const picks = selectSleepers([...kind(15, '0xs', true), ...kind(15, '0xc', false)], NOW);
    const keep = SLEEPERS.keepPerBand;
    expect(picks.filter((p) => p.isStock)).toHaveLength(keep);
    expect(picks.filter((p) => !p.isStock)).toHaveLength(keep);
    // Both cuts keep the best of their kind.
    expect(picks.filter((p) => p.isStock).map((p) => p.address)).toEqual(
      Array.from({ length: keep }, (_, i) => `0xs${i}`),
    );
    expect(picks.filter((p) => !p.isStock).map((p) => p.address)).toEqual(
      Array.from({ length: keep }, (_, i) => `0xc${i}`),
    );
  });

  it('still ranks the band as one list, ascending and gapless', () => {
    const picks = selectSleepers([...kind(15, '0xs', true), ...kind(15, '0xc', false)], NOW);
    expect(picks.map((p) => p.rank)).toEqual(picks.map((_, i) => i + 1));
    // Ranking is by turnover over everything kept: the stocks lead here.
    expect(picks.slice(0, SLEEPERS.keepPerBand).every((p) => p.isStock)).toBe(true);
  });

  it('does not reserve slots: a band of coins alone still keeps twelve', () => {
    const picks = selectSleepers(kind(15, '0xc', false), NOW);
    expect(picks).toHaveLength(SLEEPERS.keepPerBand);
    expect(picks.every((p) => !p.isStock)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Time in band (docs/decisions.md round 14)
// ---------------------------------------------------------------------------

describe('inferSupply', () => {
  it('divides mcap by price — the whole basis for reading a close as a mcap', () => {
    expect(inferSupply(80_000, 0.00008)).toBeCloseTo(1_000_000_000, 0);
  });

  it('is the inverse of the multiplication the walk performs', () => {
    const supply = inferSupply(1_850_000, 0.00185);
    expect(supply).not.toBeNull();
    // A close 20% below today's price implies a mcap 20% below today's mcap:
    // proportionality is the claim, and this is it.
    expect((supply ?? 0) * 0.00148).toBeCloseTo(1_480_000, 3);
  });

  it('refuses every pair that cannot produce a supply', () => {
    expect(inferSupply(80_000, null)).toBeNull();
    expect(inferSupply(80_000, 0)).toBeNull();
    expect(inferSupply(80_000, -1)).toBeNull();
    expect(inferSupply(0, 0.001)).toBeNull();
    expect(inferSupply(Number.NaN, 0.001)).toBeNull();
    expect(inferSupply(80_000, Number.NaN)).toBeNull();
  });
});

describe('computeResidency', () => {
  const BAND = { loUsd: 50_000, hiUsd: 100_000 };
  const MCAP = 80_000;
  const PRICE = 0.00008; // => 1e9 supply
  const NOW_SEC = Math.floor(NOW / 1000);

  /** The close that implies `mcap` at the fixture's inferred supply. */
  const closeFor = (mcap: number) => mcap / 1_000_000_000;

  /**
   * `count` hourly candles, newest first, the newest starting `newestAgoH`
   * hours ago. `mcapAt(i)` is the implied mcap of candle i, 0 = newest.
   */
  function hourlyCandles(
    count: number,
    mcapAt: number | ((i: number) => number),
    newestAgoH = 0,
  ): Candle[] {
    return Array.from({ length: count }, (_, i) => ({
      tsSec: NOW_SEC - (i + newestAgoH) * 3_600,
      close: closeFor(typeof mcapAt === 'function' ? mcapAt(i) : mcapAt),
    }));
  }

  /** `count` daily candles, newest first, the newest starting `newestAgoD` days ago. */
  function dailyCandles(count: number, mcapAt: number | ((i: number) => number), newestAgoD = 0) {
    return Array.from({ length: count }, (_, i) => ({
      tsSec: NOW_SEC - (i + newestAgoD) * 86_400,
      close: closeFor(typeof mcapAt === 'function' ? mcapAt(i) : mcapAt),
    }));
  }

  function residency(over: Partial<Parameters<typeof computeResidency>[0]> = {}) {
    return computeResidency({
      band: BAND,
      entryMcapUsd: MCAP,
      entryPriceUsd: PRICE,
      hourly: hourlyCandles(10, 80_000),
      nowMs: NOW,
      ...over,
    });
  }

  it('measures a clean 9h streak, and says the window was not exhausted', () => {
    // Ten in-band hours back, then one that left the band: the streak starts at
    // the tenth candle, nine hours before now.
    const hourly = hourlyCandles(11, (i) => (i <= 9 ? 80_000 : 120_000));
    const result = residency({ hourly });
    expect(result.hours).toBeCloseTo(9, 6);
    expect(result.hourlyExhausted).toBe(false);
  });

  it('breaks mid-window: only the candles since the last exit count', () => {
    // Candles 0-2 in band, candle 3 out, 4+ back in band — the older stretch is
    // NOT residency, it is a different visit.
    const hourly = hourlyCandles(20, (i) => (i === 3 ? 200_000 : 80_000));
    expect(residency({ hourly }).hours).toBeCloseTo(2, 6);
  });

  it('a stale newest candle reports nothing at all', () => {
    // 3h old, past the 2h freshness bar: whatever it did yesterday, we cannot
    // claim the coin is in the band right now.
    expect(SLEEPERS.inBandMaxCandleAgeHours).toBe(2);
    expect(residency({ hourly: hourlyCandles(20, 80_000, 3) }).hours).toBe(0);
    // Exactly at the bar still counts.
    expect(residency({ hourly: hourlyCandles(20, 80_000, 2) }).hours).toBeCloseTo(21, 6);
  });

  it('reports nothing when the newest candle is already out of band', () => {
    const hourly = hourlyCandles(20, (i) => (i === 0 ? 300_000 : 80_000));
    expect(residency({ hourly })).toEqual({ hours: 0, hourlyExhausted: false });
  });

  it('reports nothing with no candles', () => {
    expect(residency({ hourly: [] })).toEqual({ hours: 0, hourlyExhausted: false });
  });

  it('extends a fully in-band hourly window with daily candles', () => {
    // 100 hourly candles (~4.1 days) all in band, then 10 daily candles that
    // reach further back. The daily candles overlapping the hourly window are
    // skipped, so the streak starts at the oldest in-band DAY.
    const hourly = hourlyCandles(100, 80_000);
    const daily = dailyCandles(10, (i) => (i <= 8 ? 70_000 : 500_000));
    const fromHourly = residency({ hourly });
    expect(fromHourly.hourlyExhausted).toBe(true);
    expect(fromHourly.hours).toBeCloseTo(99, 6);

    const extended = residency({ hourly, daily });
    // Day 8 is the oldest in-band daily candle: 8 days before now.
    expect(extended.hours).toBeCloseTo(8 * 24, 6);
  });

  it('never extends a window that already broke', () => {
    const hourly = hourlyCandles(100, (i) => (i === 5 ? 10_000 : 80_000));
    const daily = dailyCandles(30, 80_000);
    expect(residency({ hourly, daily }).hours).toBeCloseTo(4, 6);
  });

  it('caps the report at 35 days however deep the daily history runs', () => {
    const hourly = hourlyCandles(100, 80_000);
    const daily = dailyCandles(60, 80_000);
    expect(SLEEPERS.inBandMaxDays).toBe(35);
    expect(residency({ hourly, daily }).hours).toBe(35 * 24);
  });

  it('reads closes as mcaps through the inferred supply, not as mcaps', () => {
    // Same close series, two different supplies. At 1e9 supply the coin sits at
    // $80K (in band); at 1e10 it sits at $800K (nowhere near this band).
    const hourly = hourlyCandles(10, 80_000);
    expect(residency({ hourly }).hours).toBeGreaterThan(0);
    expect(residency({ hourly, entryMcapUsd: 800_000, entryPriceUsd: 0.00008 }).hours).toBe(0);
  });

  it('falls back to the newest close when the listing had no price', () => {
    // No price means no ratio — anchoring on the newest candle makes the newest
    // implied mcap exactly the listing's mcap, which keeps the walk possible.
    const hourly = hourlyCandles(10, 80_000);
    expect(residency({ hourly, entryPriceUsd: null }).hours).toBeCloseTo(9, 6);
  });

  it('treats the band edges as in band', () => {
    expect(residency({ hourly: hourlyCandles(10, BAND.loUsd) }).hours).toBeCloseTo(9, 6);
    expect(residency({ hourly: hourlyCandles(10, BAND.hiUsd) }).hours).toBeCloseTo(9, 6);
  });

  it('sorts defensively — an out-of-order feed measures the same streak', () => {
    const hourly = hourlyCandles(11, (i) => (i <= 9 ? 80_000 : 120_000));
    const shuffled = [...hourly].reverse();
    expect(residency({ hourly: shuffled }).hours).toBeCloseTo(9, 6);
  });

  it('measures a span, not a candle count: a no-trade gap is still residency', () => {
    // Hours 3-6 have no candle at all (nobody traded). The coin did not leave.
    const hourly = hourlyCandles(10, 80_000).filter((_, i) => i < 3 || i > 6);
    expect(residency({ hourly }).hours).toBeCloseTo(9, 6);
  });

  it('refuses a future-stamped candle rather than reading it as fresh', () => {
    const hourly = hourlyCandles(10, 80_000).map((c) => ({ ...c, tsSec: c.tsSec + 4 * 3_600 }));
    expect(residency({ hourly }).hours).toBe(0);
  });
});

/* ---------------------------------------------- short holds (round 17) */

describe('computeShortResidency', () => {
  const BAND = { loUsd: 50_000, hiUsd: 100_000 };
  const MCAP = 80_000;
  const PRICE = 0.00008; // => 1e9 supply
  const NOW_SEC = Math.floor(NOW / 1000);
  const QUARTER = 15 * 60;
  const closeFor = (mcap: number) => mcap / 1_000_000_000;

  /**
   * `count` 15-minute candles, newest first, the newest STARTING
   * `newestAgoMin` minutes ago. `mcapAt(i)` is candle i's implied mcap.
   */
  function quarters(
    count: number,
    mcapAt: number | ((i: number) => number),
    newestAgoMin = 0,
  ): Candle[] {
    return Array.from({ length: count }, (_, i) => ({
      tsSec: NOW_SEC - newestAgoMin * 60 - i * QUARTER,
      close: closeFor(typeof mcapAt === 'function' ? mcapAt(i) : mcapAt),
    }));
  }

  function short(over: Partial<Parameters<typeof computeShortResidency>[0]> = {}) {
    return computeShortResidency({
      band: BAND,
      entryMcapUsd: MCAP,
      entryPriceUsd: PRICE,
      minutes: quarters(12, 80_000),
      nowMs: NOW,
      ...over,
    });
  }

  it('counts closes, a quarter hour each: 2 is 30m and 4 is 1h', () => {
    expect(short({ minutes: quarters(2, 80_000) })).toBeCloseTo(0.5, 6);
    expect(short({ minutes: quarters(4, 80_000) })).toBeCloseTo(1, 6);
    expect(short({ minutes: quarters(1, 80_000) })).toBeCloseTo(0.25, 6);
  });

  it('stays a candle below the hourly threshold even on a full window', () => {
    // A full 12 closes would read as exactly shortHoldMaxHours, but the newest
    // bucket is in progress and the hourly walk already declined to establish
    // that many hours — so the figure can never reach the 3h chip.
    const full = short({ minutes: quarters(12, 80_000) });
    expect(full).toBeCloseTo(SLEEPERS.shortHoldMaxHours - 0.25, 6);
    expect(full).toBeLessThan(SLEEPERS.shortHoldMaxHours);
  });

  it('stops at the first close outside the band', () => {
    // Newest three in band, the fourth out: the older stretch is another visit.
    expect(short({ minutes: quarters(12, (i) => (i === 3 ? 200_000 : 80_000)) })).toBeCloseTo(
      0.75,
      6,
    );
  });

  it('reads 0 — a real reading — when the coin has already left the band', () => {
    expect(short({ minutes: quarters(12, (i) => (i === 0 ? 200_000 : 80_000)) })).toBe(0);
  });

  it('accepts a newest candle up to 30 minutes old and reads 0 past that', () => {
    expect(short({ minutes: quarters(4, 80_000, 30) })).toBeCloseTo(1, 6);
    // Stale, not absent: the window says this coin is not holding a band NOW.
    expect(short({ minutes: quarters(4, 80_000, 31) })).toBe(0);
    expect(short({ minutes: quarters(4, 80_000, 120) })).toBe(0);
  });

  it('reports NO READING, not a zero, off data it cannot use', () => {
    // null and 0 are different claims: the caller keeps the hourly figure on a
    // null and lets a 0 replace it.
    expect(short({ minutes: [] })).toBeNull();
    // No price and no mcap: supply cannot be inferred, so no close is a mcap.
    expect(short({ entryPriceUsd: null, entryMcapUsd: 0 })).toBeNull();
    // A future stamp is a bad clock, not evidence the coin left the band.
    expect(short({ minutes: quarters(4, 80_000, -60) })).toBeNull();
  });

  it('sorts defensively rather than trusting the upstream order', () => {
    const ascending = [...quarters(4, 80_000)].reverse();
    expect(short({ minutes: ascending })).toBeCloseTo(1, 6);
  });
});

/* --------------------------- carrying residency between scans (round 16b) */

describe('needsFullMeasurement', () => {
  const BAND_A = { loUsd: 50_000, hiUsd: 100_000 };
  const BAND_B = { loUsd: 100_000, hiUsd: 250_000 };
  const SCAN_GAP = SLEEPERS.scanIntervalHours * HOUR;

  /** A previous entry that is carryable: same band, real hours, just measured. */
  function prev(over: Partial<PrevResidency> = {}): PrevResidency {
    return {
      band: BAND_A,
      inBandHours: 12,
      scanAtMs: NOW - SCAN_GAP,
      measuredAtMs: NOW - SCAN_GAP,
      ...over,
    };
  }

  it('a new entry always pays for candles', () => {
    expect(needsFullMeasurement(undefined, { band: BAND_A }, NOW)).toBe(true);
  });

  it('the same band with a measured figure is carried, not re-read', () => {
    expect(needsFullMeasurement(prev(), { band: BAND_A }, NOW)).toBe(false);
  });

  it('a band change re-measures — the old streak ended whatever else is true', () => {
    expect(needsFullMeasurement(prev(), { band: BAND_B }, NOW)).toBe(true);
    // Same low, different high is still a different band.
    expect(needsFullMeasurement(prev(), { band: { loUsd: 50_000, hiUsd: 120_000 } }, NOW)).toBe(true);
  });

  it('a previous 0 is a failed or out-of-band read, never a base to add to', () => {
    expect(needsFullMeasurement(prev({ inBandHours: 0 }), { band: BAND_A }, NOW)).toBe(true);
    expect(needsFullMeasurement(prev({ inBandHours: Number.NaN }), { band: BAND_A }, NOW)).toBe(true);
  });

  it('an unstamped figure (pre-column rows, failed reads) re-measures', () => {
    expect(needsFullMeasurement(prev({ measuredAtMs: null }), { band: BAND_A }, NOW)).toBe(true);
  });

  it('re-verifies once the measurement is a day old, and not before', () => {
    const stale = SLEEPERS.residencyReverifyHours * HOUR;
    expect(needsFullMeasurement(prev({ measuredAtMs: NOW - stale + 1 }), { band: BAND_A }, NOW)).toBe(false);
    expect(needsFullMeasurement(prev({ measuredAtMs: NOW - stale }), { band: BAND_A }, NOW)).toBe(true);
    expect(needsFullMeasurement(prev({ measuredAtMs: NOW - 2 * stale }), { band: BAND_A }, NOW)).toBe(true);
  });

  it('refuses to carry a coin that has stopped trading', () => {
    // The listing's volume and txn figures are trailing 24h ones, so a coin that
    // stopped trading an hour ago still qualifies and still buckets into the same
    // band — and would accrue residency it is not earning until the daily
    // re-verification. Zero trades in the last hour is that coin.
    expect(needsFullMeasurement(prev(), { band: BAND_A, txns1h: 0 }, NOW)).toBe(true);
  });

  it('...but an UNKNOWN hourly count is not a stopped coin', () => {
    // Absence of the h1 block says nothing; only a measured zero refuses.
    expect(needsFullMeasurement(prev(), { band: BAND_A, txns1h: null }, NOW)).toBe(false);
    expect(needsFullMeasurement(prev(), { band: BAND_A }, NOW)).toBe(false);
    expect(needsFullMeasurement(prev(), { band: BAND_A, txns1h: 1 }, NOW)).toBe(false);
  });

  it('refuses to carry off a nonsense clock', () => {
    expect(needsFullMeasurement(prev({ scanAtMs: NOW + HOUR }), { band: BAND_A }, NOW)).toBe(true);
    expect(needsFullMeasurement(prev({ measuredAtMs: NOW + HOUR }), { band: BAND_A }, NOW)).toBe(true);
  });
});

describe('carriedResidencyHours', () => {
  const base: PrevResidency = {
    band: { loUsd: 50_000, hiUsd: 100_000 },
    inBandHours: 12,
    scanAtMs: NOW - 3 * HOUR,
    measuredAtMs: NOW - 3 * HOUR,
  };

  it('adds the time since the scan that measured it', () => {
    expect(carriedResidencyHours(base, NOW)).toBeCloseTo(15, 6);
  });

  it('caps exactly where a measured value would', () => {
    const cap = SLEEPERS.inBandMaxDays * 24;
    expect(carriedResidencyHours({ ...base, inBandHours: cap - 1 }, NOW)).toBe(cap);
  });

  it('never runs backwards on a clock that did', () => {
    expect(carriedResidencyHours({ ...base, scanAtMs: NOW + HOUR }, NOW)).toBe(12);
  });
});
