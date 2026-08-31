import { describe, expect, it } from 'vitest';
import { callLiquidityDeath, classifyTokenDeath, isRevived } from '../src/poller/death.js';

const snap = (over: Partial<{ priceUsd: number | null; mcapUsd: number | null; liquidityUsd: number | null; vol24Usd: number | null }> = {}) => ({
  priceUsd: null,
  mcapUsd: null,
  liquidityUsd: null,
  vol24Usd: null,
  ...over,
});

describe('classifyTokenDeath — curve phase', () => {
  it('a fresh launch below the floor is ALIVE (launches start ~$5k)', () => {
    expect(
      classifyTokenDeath({ phase: 'curve', ageHours: 0.1, peakMcapUsd: 4_000 }, snap({ mcapUsd: 4_000 })),
    ).toBeNull();
    expect(
      classifyTokenDeath({ phase: 'curve', ageHours: 0.1, peakMcapUsd: null }, snap({ mcapUsd: 4_000 })),
    ).toBeNull();
  });
  it('dies once it RETRACED to the ~$8k curve floor from an armed peak', () => {
    expect(
      classifyTokenDeath({ phase: 'curve', ageHours: 1, peakMcapUsd: 30_000 }, snap({ mcapUsd: 7_000 })),
    ).toBe('curve_floor');
    expect(
      classifyTokenDeath({ phase: 'curve', ageHours: 1, peakMcapUsd: 30_000 }, snap({ mcapUsd: 8_000 })),
    ).toBe('curve_floor');
  });
  it('a peak short of the arming mcap does not arm the floor', () => {
    expect(
      classifyTokenDeath({ phase: 'curve', ageHours: 1, peakMcapUsd: 8_500 }, snap({ mcapUsd: 7_000 })),
    ).toBeNull();
  });
  it('lives above the floor', () => {
    expect(
      classifyTokenDeath({ phase: 'curve', ageHours: 1, peakMcapUsd: 30_000 }, snap({ mcapUsd: 25_000 })),
    ).toBeNull();
  });
  it('unknown mcap is not death evidence', () => {
    expect(classifyTokenDeath({ phase: 'curve', ageHours: 1, peakMcapUsd: 30_000 }, snap())).toBeNull();
    expect(classifyTokenDeath({ phase: 'curve', ageHours: 1, peakMcapUsd: 30_000 }, null)).toBeNull();
  });
  it('dies after 48h without graduating', () => {
    expect(
      classifyTokenDeath({ phase: 'curve', ageHours: 49, peakMcapUsd: 25_000 }, snap({ mcapUsd: 25_000 })),
    ).toBe('never_graduated');
  });
});

describe('classifyTokenDeath — graduated phase', () => {
  it('dies below the $250 liquidity floor', () => {
    expect(
      classifyTokenDeath({ phase: 'graduated', ageHours: 100, peakMcapUsd: null }, snap({ liquidityUsd: 0.12 })),
    ).toBe('liquidity_floor');
  });
  it('quiet but liquid is NOT dead', () => {
    expect(
      classifyTokenDeath(
        { phase: 'graduated', ageHours: 700, peakMcapUsd: null },
        snap({ liquidityUsd: 7_753, vol24Usd: 0.15 }),
      ),
    ).toBeNull();
  });
  it('missing liquidity (unindexed/odd pair) is not death evidence', () => {
    expect(classifyTokenDeath({ phase: 'graduated', ageHours: 100, peakMcapUsd: null }, snap())).toBeNull();
  });
  it('the 48h rule does not apply once graduated', () => {
    expect(
      classifyTokenDeath({ phase: 'graduated', ageHours: 49, peakMcapUsd: null }, snap({ liquidityUsd: 50_000 })),
    ).toBeNull();
  });
});

describe('classifyTokenDeath — unresolved', () => {
  it('never indexed anywhere for 48h = never launched = dead', () => {
    expect(classifyTokenDeath({ phase: 'unresolved', ageHours: 49, peakMcapUsd: null }, null)).toBe(
      'never_graduated',
    );
    expect(classifyTokenDeath({ phase: 'unresolved', ageHours: 2, peakMcapUsd: null }, null)).toBeNull();
  });
});

describe('callLiquidityDeath', () => {
  it('dies on >95% collapse from call-time liquidity', () => {
    expect(callLiquidityDeath(100_000, 4_000)).toBe(true);
    expect(callLiquidityDeath(100_000, 6_000)).toBe(false);
  });
  it('no baseline or no reading = no verdict', () => {
    expect(callLiquidityDeath(null, 10)).toBe(false);
    expect(callLiquidityDeath(0, 10)).toBe(false);
    expect(callLiquidityDeath(100_000, null)).toBe(false);
  });
});

describe('isRevived', () => {
  it('graduated: real liquidity back = revived', () => {
    expect(isRevived('graduated', snap({ liquidityUsd: 1_200 }), null)).toBe(true);
    expect(isRevived('graduated', snap({ liquidityUsd: 400 }), null)).toBe(false);
  });
  it('curve: curve reserve is NOT revival evidence (it tracks FDV)', () => {
    expect(isRevived('curve', snap({ mcapUsd: 6_000, liquidityUsd: 6_000 }), false)).toBe(false);
  });
  it('curve: mcap well above floor = revived', () => {
    expect(isRevived('curve', snap({ mcapUsd: 20_000 }), false)).toBe(true);
    expect(isRevived('curve', snap({ mcapUsd: 9_000 }), false)).toBe(false);
  });
  it('curve: completing the curve while dead = revived', () => {
    expect(isRevived('curve', snap({ mcapUsd: 6_000, liquidityUsd: 6_000 }), true)).toBe(true);
  });
  it('no data = not revived', () => {
    expect(isRevived('curve', null, null)).toBe(false);
    expect(isRevived('graduated', null, null)).toBe(false);
  });
});
