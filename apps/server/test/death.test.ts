import { describe, expect, it } from 'vitest';
import { tokens } from '@groupie/db';
import { POLL_TIERS, THRESHOLDS } from '@groupie/shared';
import type { DsPair } from '../src/market/dexscreener.js';
import {
  callLiquidityDeath,
  classifyTokenDeath,
  isRevived,
  MAX_LIQUIDITY_READING_AGE_MS,
  type LiquidityReading,
} from '../src/poller/death.js';
import { deadPollSeconds, isSuspiciousPair } from '../src/poller/scheduler.js';

const NOW = Date.UTC(2026, 8, 2, 12, 0, 0);
const MINUTE = 60_000;

/** Old enough that round 11's newborn grace is long over. */
const MATURE_HOURS = 100;
const NEWBORN_HOURS = 20 / 60;

const snap = (
  over: Partial<{
    priceUsd: number | null;
    mcapUsd: number | null;
    liquidityUsd: number | null;
    vol24Usd: number | null;
  }> = {},
) => ({
  priceUsd: null,
  mcapUsd: null,
  liquidityUsd: null,
  vol24Usd: null,
  ...over,
});

/**
 * `count` readings ending at NOW and evenly spread over `spanMin` minutes,
 * oldest first — the shape scheduler.ts hands these functions (window + the
 * live reading last).
 */
function readings(
  count: number,
  liquidityUsd: number | null,
  spanMin: number,
  endMs = NOW,
): LiquidityReading[] {
  const step = count > 1 ? (spanMin * MINUTE) / (count - 1) : 0;
  const out: LiquidityReading[] = [];
  for (let i = count - 1; i >= 0; i--) out.push({ atMs: endMs - i * step, liquidityUsd });
  return out;
}

/** A sustained drain: comfortably past both round-11 hurdles. */
const DRAINED = readings(4, 12, 12);

/**
 * The armed curve floor is RETIRED (docs/decisions.md round 6): a curve token
 * at the floor is now hidden into rug probation by the sweep, which gives it a
 * comeback path, instead of being killed on one reading. Nothing about a curve
 * token's market state is death evidence here any more — only the 48h rule is.
 */
describe('classifyTokenDeath — curve phase', () => {
  it('a fresh launch is ALIVE (launches start ~$5k)', () => {
    expect(classifyTokenDeath({ phase: 'curve', ageHours: 0.1 }, [], NOW)).toBeNull();
  });
  it('a curve pool reading ZERO liquidity is still not a death — probation owns it', () => {
    // The bonding pool's reserve tracks the curve's own float, so it is never
    // the liquidity signal the graduated rule reads.
    expect(classifyTokenDeath({ phase: 'curve', ageHours: 1 }, DRAINED, NOW)).toBeNull();
    expect(classifyTokenDeath({ phase: 'curve', ageHours: 47.9 }, DRAINED, NOW)).toBeNull();
  });
  it('dies after 48h without graduating', () => {
    expect(classifyTokenDeath({ phase: 'curve', ageHours: 49 }, [], NOW)).toBe('never_graduated');
  });
  it('the 48h rule is a mcap/graduation fact: the newborn grace never touches it', () => {
    // Not reachable for a curve token at 20 minutes old, but the ordering that
    // guarantees it is: the grace lives inside the graduated branch only.
    expect(classifyTokenDeath({ phase: 'curve', ageHours: NEWBORN_HOURS }, DRAINED, NOW)).toBeNull();
    expect(classifyTokenDeath({ phase: 'unresolved', ageHours: 49 }, DRAINED, NOW)).toBe(
      'never_graduated',
    );
  });
});

/**
 * Round 11 (live case OMNI): a 6-minute-old pool was called at 19:02:11 and
 * declared dead three seconds later off a single liquidity=$0 first reading,
 * while the chart traded on to $132k. A liquidity death is now a claim about a
 * sustained window, never about one snapshot.
 */
describe('classifyTokenDeath — graduated phase, liquidity persistence', () => {
  it('a SINGLE low reading on a mature token is NOT a death (the OMNI case)', () => {
    expect(
      classifyTokenDeath({ phase: 'graduated', ageHours: MATURE_HOURS }, readings(1, 0, 0), NOW),
    ).toBeNull();
  });
  it('12 minutes across 4 readings below the floor IS a death', () => {
    expect(classifyTokenDeath({ phase: 'graduated', ageHours: MATURE_HOURS }, DRAINED, NOW)).toBe(
      'liquidity_floor',
    );
  });
  it('2 readings 12 minutes apart is not enough readings', () => {
    expect(
      classifyTokenDeath({ phase: 'graduated', ageHours: MATURE_HOURS }, readings(2, 12, 12), NOW),
    ).toBeNull();
  });
  it('4 readings inside 5 minutes is not a long enough span', () => {
    expect(
      classifyTokenDeath({ phase: 'graduated', ageHours: MATURE_HOURS }, readings(4, 12, 5), NOW),
    ).toBeNull();
  });
  it('the exact boundary (3 readings, 10 minutes) qualifies', () => {
    expect(
      classifyTokenDeath(
        { phase: 'graduated', ageHours: MATURE_HOURS },
        readings(THRESHOLDS.liquidityDeathMinReadings, 12, THRESHOLDS.liquidityDeathMinMinutes),
        NOW,
      ),
    ).toBe('liquidity_floor');
  });
  it('one reading short, or one minute short, does not', () => {
    expect(
      classifyTokenDeath(
        { phase: 'graduated', ageHours: MATURE_HOURS },
        readings(THRESHOLDS.liquidityDeathMinReadings - 1, 12, THRESHOLDS.liquidityDeathMinMinutes),
        NOW,
      ),
    ).toBeNull();
    expect(
      classifyTokenDeath(
        { phase: 'graduated', ageHours: MATURE_HOURS },
        readings(THRESHOLDS.liquidityDeathMinReadings, 12, THRESHOLDS.liquidityDeathMinMinutes - 1),
        NOW,
      ),
    ).toBeNull();
  });
  it('the NEWEST reading must satisfy it: one refill ends the matter', () => {
    const refilled = [...DRAINED.slice(0, -1), { atMs: NOW, liquidityUsd: 40_000 }];
    expect(
      classifyTokenDeath({ phase: 'graduated', ageHours: MATURE_HOURS }, refilled, NOW),
    ).toBeNull();
  });
  it('a break in the middle restarts the run', () => {
    const broken: LiquidityReading[] = [
      { atMs: NOW - 14 * MINUTE, liquidityUsd: 12 },
      { atMs: NOW - 10 * MINUTE, liquidityUsd: 30_000 },
      { atMs: NOW - 5 * MINUTE, liquidityUsd: 12 },
      { atMs: NOW, liquidityUsd: 12 },
    ];
    expect(
      classifyTokenDeath({ phase: 'graduated', ageHours: MATURE_HOURS }, broken, NOW),
    ).toBeNull();
  });
  it('unmeasurable liquidity is not death evidence, newest or mid-run', () => {
    const nullNewest = [...DRAINED.slice(0, -1), { atMs: NOW, liquidityUsd: null }];
    expect(
      classifyTokenDeath({ phase: 'graduated', ageHours: MATURE_HOURS }, nullNewest, NOW),
    ).toBeNull();
    const nullMid: LiquidityReading[] = [
      { atMs: NOW - 12 * MINUTE, liquidityUsd: 12 },
      { atMs: NOW - 8 * MINUTE, liquidityUsd: null },
      { atMs: NOW - 4 * MINUTE, liquidityUsd: 12 },
      { atMs: NOW, liquidityUsd: 12 },
    ];
    expect(classifyTokenDeath({ phase: 'graduated', ageHours: MATURE_HOURS }, nullMid, NOW)).toBeNull();
    expect(classifyTokenDeath({ phase: 'graduated', ageHours: MATURE_HOURS }, [], NOW)).toBeNull();
  });
  it('a stale window never kills on its own', () => {
    const stale = readings(4, 12, 12, NOW - MAX_LIQUIDITY_READING_AGE_MS - MINUTE);
    expect(classifyTokenDeath({ phase: 'graduated', ageHours: MATURE_HOURS }, stale, NOW)).toBeNull();
  });
  it('at the floor is not under it, and quiet-but-liquid is not dead', () => {
    expect(
      classifyTokenDeath(
        { phase: 'graduated', ageHours: MATURE_HOURS },
        readings(4, THRESHOLDS.deadLiquidityUsd, 12),
        NOW,
      ),
    ).toBeNull();
    expect(
      classifyTokenDeath({ phase: 'graduated', ageHours: MATURE_HOURS }, readings(6, 7_753, 20), NOW),
    ).toBeNull();
  });
  it('the 48h rule does not apply once graduated', () => {
    expect(
      classifyTokenDeath({ phase: 'graduated', ageHours: 49 }, readings(4, 50_000, 12), NOW),
    ).toBeNull();
  });
});

describe('classifyTokenDeath — round 11 newborn grace', () => {
  it('a 20-minute-old token with sustained ZERO liquidity does not die', () => {
    expect(
      classifyTokenDeath({ phase: 'graduated', ageHours: NEWBORN_HOURS }, readings(4, 0, 12), NOW),
    ).toBeNull();
  });
  it('the same token at 40 minutes is eligible again', () => {
    expect(
      classifyTokenDeath({ phase: 'graduated', ageHours: 40 / 60 }, readings(4, 0, 12), NOW),
    ).toBe('liquidity_floor');
  });
  it('the grace boundary is the constant itself', () => {
    const justInside = (THRESHOLDS.newbornGraceMinutes - 1) / 60;
    const atTheEdge = THRESHOLDS.newbornGraceMinutes / 60;
    expect(
      classifyTokenDeath({ phase: 'graduated', ageHours: justInside }, readings(4, 0, 12), NOW),
    ).toBeNull();
    expect(
      classifyTokenDeath({ phase: 'graduated', ageHours: atTheEdge }, readings(4, 0, 12), NOW),
    ).toBe('liquidity_floor');
  });
});

describe('classifyTokenDeath — unresolved', () => {
  it('never indexed anywhere for 48h = never launched = dead', () => {
    expect(classifyTokenDeath({ phase: 'unresolved', ageHours: 49 }, [], NOW)).toBe(
      'never_graduated',
    );
    expect(classifyTokenDeath({ phase: 'unresolved', ageHours: 2 }, [], NOW)).toBeNull();
  });
});

/**
 * The per-call rule keeps its 5% ratio (round 13 looked at it and left it: locked
 * LP blunts the observable drop, and the mcap machinery carries that weight) and
 * gains round 11's persistence and grace, exactly like the token floor.
 */
describe('callLiquidityDeath', () => {
  const atCall = 100_000;
  it('a sustained >95% collapse dies', () => {
    expect(callLiquidityDeath(atCall, readings(4, 4_000, 12), NOW, MATURE_HOURS)).toBe(true);
  });
  it('a single collapsed reading does not (the OMNI shape, per call)', () => {
    expect(callLiquidityDeath(atCall, readings(1, 4_000, 0), NOW, MATURE_HOURS)).toBe(false);
  });
  it('same persistence semantics: readings and span both count', () => {
    expect(callLiquidityDeath(atCall, readings(2, 4_000, 12), NOW, MATURE_HOURS)).toBe(false);
    expect(callLiquidityDeath(atCall, readings(4, 4_000, 5), NOW, MATURE_HOURS)).toBe(false);
  });
  it('above the 5% line is not a collapse however long it holds', () => {
    expect(callLiquidityDeath(atCall, readings(6, 6_000, 20), NOW, MATURE_HOURS)).toBe(false);
  });
  it('a refill on the newest reading clears it', () => {
    const refilled = [...readings(4, 4_000, 12).slice(0, -1), { atMs: NOW, liquidityUsd: 80_000 }];
    expect(callLiquidityDeath(atCall, refilled, NOW, MATURE_HOURS)).toBe(false);
  });
  it('no baseline, no readings, or an unmeasurable newest = no verdict', () => {
    expect(callLiquidityDeath(null, readings(4, 10, 12), NOW, MATURE_HOURS)).toBe(false);
    expect(callLiquidityDeath(0, readings(4, 10, 12), NOW, MATURE_HOURS)).toBe(false);
    expect(callLiquidityDeath(atCall, [], NOW, MATURE_HOURS)).toBe(false);
    expect(
      callLiquidityDeath(
        atCall,
        [...readings(4, 10, 12).slice(0, -1), { atMs: NOW, liquidityUsd: null }],
        NOW,
        MATURE_HOURS,
      ),
    ).toBe(false);
  });
  it('the newborn grace covers the per-call rule too', () => {
    expect(callLiquidityDeath(atCall, readings(4, 0, 12), NOW, NEWBORN_HOURS)).toBe(false);
    expect(callLiquidityDeath(atCall, readings(4, 0, 12), NOW, 40 / 60)).toBe(true);
  });
});

/**
 * Round 13: ONE revival bar, mcap >= $30k, for every death type. PONS fair
 * launches lock LP permanently, so a graduated corpse keeps ~$5-6k of residual
 * liquidity forever — the old $1k liquidity bar would have revived every dead
 * fair launch on the next daily dead-poll and flapped it back to dead.
 */
describe('isRevived', () => {
  it('THE ZOMBIE CASE: graduated death with $3k mcap and $6k residual locked LP is NOT revived', () => {
    expect(isRevived('graduated', snap({ mcapUsd: 3_000, liquidityUsd: 6_000 }), null)).toBe(false);
  });
  it('liquidity is not consulted at all, however healthy it looks', () => {
    expect(isRevived('graduated', snap({ mcapUsd: 1_000, liquidityUsd: 500_000 }), null)).toBe(false);
    expect(isRevived('graduated', snap({ mcapUsd: 31_000, liquidityUsd: 0 }), null)).toBe(true);
  });
  it('graduated: back over the bar = revived', () => {
    expect(isRevived('graduated', snap({ mcapUsd: 31_000 }), null)).toBe(true);
    expect(isRevived('graduated', snap({ mcapUsd: 29_999 }), null)).toBe(false);
  });
  it("the $30,000 boundary is inclusive, and it is probation's own bar", () => {
    expect(THRESHOLDS.revivalMcapUsd).toBe(30_000);
    expect(isRevived('graduated', snap({ mcapUsd: THRESHOLDS.revivalMcapUsd }), null)).toBe(true);
    expect(isRevived('curve', snap({ mcapUsd: THRESHOLDS.revivalMcapUsd }), false)).toBe(true);
  });
  it('curve deaths use the same bar — the old $16k curve bar is gone', () => {
    expect(isRevived('curve', snap({ mcapUsd: 20_000 }), false)).toBe(false);
    expect(isRevived('curve', snap({ mcapUsd: 31_000 }), false)).toBe(true);
  });
  it('curve: completing the curve while dead = revived, whatever the mcap', () => {
    expect(isRevived('curve', snap({ mcapUsd: 6_000, liquidityUsd: 6_000 }), true)).toBe(true);
  });
  it('a graduated corpse is never revived by a graduation flag it cannot have', () => {
    expect(isRevived('graduated', snap({ mcapUsd: 3_000 }), true)).toBe(false);
  });
  it('no data = not revived', () => {
    expect(isRevived('curve', null, null)).toBe(false);
    expect(isRevived('graduated', null, null)).toBe(false);
  });
});

type TokenRow = typeof tokens.$inferSelect;

const token = (over: Partial<TokenRow>): TokenRow =>
  ({ id: 1, poolAddress: '0xpool', mcapUsd: null, liquidityUsd: null, ...over }) as TokenRow;

const pair = (over: Partial<DsPair>): DsPair => ({
  tokenAddress: '0xtoken',
  pairAddress: '0xother',
  dexId: null,
  symbol: null,
  name: null,
  imageUrl: null,
  socials: null,
  priceUsd: null,
  mcapUsd: null,
  liquidityUsd: null,
  vol24Usd: null,
  pairCreatedAt: null,
  ...over,
});

/**
 * Round 11's second half: DexScreener's "best pair" switching to a dust pool we
 * have never seen, while the pool we know held real money, is indexer lag — the
 * poll is skipped and logged rather than snapshotted into a death.
 */
describe('isSuspiciousPair', () => {
  it('round 11: a foreign dust pair while cached liquidity was 10x healthier', () => {
    expect(
      isSuspiciousPair(
        token({ liquidityUsd: 50_000, mcapUsd: 132_000 }),
        pair({ pairAddress: '0xdust', liquidityUsd: 0, mcapUsd: 132_000 }),
      ),
    ).toBe(true);
  });
  it('...regardless of the mcap comparison the old rule needed', () => {
    // Same mcap on both sides: the pre-round-11 guard would have waved it through.
    expect(
      isSuspiciousPair(
        token({ liquidityUsd: 12_000, mcapUsd: 90_000 }),
        pair({ pairAddress: '0xdust', liquidityUsd: 900, mcapUsd: 90_000 }),
      ),
    ).toBe(true);
  });
  it("the token's OWN drained pool always flows through — that is the death signal", () => {
    expect(
      isSuspiciousPair(
        token({ liquidityUsd: 50_000, mcapUsd: 132_000, poolAddress: '0xpool' }),
        pair({ pairAddress: '0xpool', liquidityUsd: 0, mcapUsd: 1_000 }),
      ),
    ).toBe(false);
  });
  it('a foreign pair that is NOT dust is trusted', () => {
    expect(
      isSuspiciousPair(
        token({ liquidityUsd: 500_000, mcapUsd: 100 }),
        pair({ pairAddress: '0xother', liquidityUsd: THRESHOLDS.dustLiquidityUsd, mcapUsd: 1e9 }),
      ),
    ).toBe(false);
  });
  it('a comparable dust pair with a sane price is not suspicious', () => {
    expect(
      isSuspiciousPair(
        token({ liquidityUsd: 800, mcapUsd: 20_000 }),
        pair({ pairAddress: '0xother', liquidityUsd: 500, mcapUsd: 21_000 }),
      ),
    ).toBe(false);
  });
  it('the original parasite rule still fires on an absurd FDV', () => {
    expect(
      isSuspiciousPair(
        token({ liquidityUsd: null, mcapUsd: 20_000 }),
        pair({ pairAddress: '0xother', liquidityUsd: 5, mcapUsd: 5_000_000 }),
      ),
    ).toBe(true);
  });
  it('nothing cached and nothing absurd = nothing to distrust', () => {
    expect(
      isSuspiciousPair(
        token({ liquidityUsd: null, mcapUsd: null }),
        pair({ pairAddress: '0xother', liquidityUsd: 5 }),
      ),
    ).toBe(false);
  });
});

/**
 * How often a corpse gets re-checked (docs/decisions.md round 15). OMNI was
 * declared dead three seconds after its call and then traded to $132k; under
 * the flat daily cadence the board carried that corpse for a full day. Fresh
 * deaths are the ones most likely to be wrong, so they are checked every 3h for
 * 48h. The revival BAR is untouched — this is only how often we ask.
 */
describe('deadPollSeconds (docs/decisions.md round 15)', () => {
  const HOUR_MS = 3_600_000;
  const ago = (hours: number) => new Date(NOW - hours * HOUR_MS);

  it('checks a death minutes old on the fast cadence', () => {
    expect(deadPollSeconds(ago(0), NOW)).toBe(POLL_TIERS.deadRecentSeconds);
    expect(deadPollSeconds(ago(3), NOW)).toBe(POLL_TIERS.deadRecentSeconds);
  });

  it('holds the fast cadence right up to the 48h boundary', () => {
    expect(deadPollSeconds(ago(POLL_TIERS.deadRecentHours - 0.01), NOW)).toBe(
      POLL_TIERS.deadRecentSeconds,
    );
    // At exactly 48h the window is over — "for the first 48h" is exclusive.
    expect(deadPollSeconds(ago(POLL_TIERS.deadRecentHours), NOW)).toBe(POLL_TIERS.deadSeconds);
  });

  it('drops an old grave to the daily cadence', () => {
    expect(deadPollSeconds(ago(72), NOW)).toBe(POLL_TIERS.deadSeconds);
    expect(deadPollSeconds(ago(24 * 30), NOW)).toBe(POLL_TIERS.deadSeconds);
  });

  it('treats an undatable death as long dead — the cheap answer', () => {
    expect(deadPollSeconds(null, NOW)).toBe(POLL_TIERS.deadSeconds);
    expect(deadPollSeconds(new Date(NaN), NOW)).toBe(POLL_TIERS.deadSeconds);
  });

  it('is not fooled into slowing down by a clock-skewed future stamp', () => {
    expect(deadPollSeconds(new Date(NOW + HOUR_MS), NOW)).toBe(POLL_TIERS.deadRecentSeconds);
  });

  it('is strictly faster than the daily tier it replaces', () => {
    expect(POLL_TIERS.deadRecentSeconds).toBeLessThan(POLL_TIERS.deadSeconds);
    expect(POLL_TIERS.deadRecentSeconds).toBe(3 * 3_600);
    expect(POLL_TIERS.deadRecentHours).toBe(48);
  });
});
