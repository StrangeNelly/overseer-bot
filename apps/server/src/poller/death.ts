import { THRESHOLDS, type TokenPhase } from '@groupie/shared';
import type { MarketSnapshot } from '../market/types.js';

export interface TokenState {
  phase: TokenPhase;
  /** Oldest of pool-creation / first-seen — the launch clock for 48h rule. */
  ageHours: number;
}

/**
 * 'rug_floor' is the only reason not decided here: it is a claim about a day of
 * probation, so rugSweep.ts owns it (a single snapshot can't see it).
 *
 * 'curve_floor' is RETIRED (docs/decisions.md round 6): retracing to the curve
 * floor now hides the token into rug probation, which has a comeback path,
 * instead of killing it instantly. Nothing produces the reason any more, but
 * rows written before round 6 still carry it — every site that READS
 * deathReason must keep accepting the string (see scheduler.ts's pollDead).
 */
export type DeathReason = 'liquidity_floor' | 'never_graduated' | 'rug_floor';

/**
 * Token-level death (a market fact, group-independent).
 * Rules from decisions.md:
 * - graduated token whose best pair holds < $250 = dead
 * - launchpad token that never graduates within 48h = dead
 * A curve token below the floor is NOT judged here at all: that is the rug
 * sweep's business now, and it hides rather than kills.
 * Unknown values are NEVER death evidence: missing liquidity/mcap means
 * "couldn't measure", not zero (DexScreener omits keys on weird pairs, and
 * absence from an API means "not indexed").
 */
export function classifyTokenDeath(
  state: TokenState,
  snapshot: MarketSnapshot | null,
): DeathReason | null {
  if (state.phase === 'curve') {
    if (state.ageHours >= THRESHOLDS.ungraduatedDeathHours) return 'never_graduated';
    return null;
  }
  if (state.phase === 'graduated') {
    const liq = snapshot?.liquidityUsd;
    if (liq !== null && liq !== undefined && liq < THRESHOLDS.deadLiquidityUsd) {
      return 'liquidity_floor';
    }
    return null;
  }
  if (state.phase === 'unresolved') {
    // Never indexed anywhere and old enough that it clearly never launched.
    if (state.ageHours >= THRESHOLDS.ungraduatedDeathHours) return 'never_graduated';
    return null;
  }
  return null;
}

/**
 * Per-call death: the group's own bar. A call also dies when liquidity has
 * collapsed >95% from what it was at call time, even if it clears the global
 * floor.
 */
export function callLiquidityDeath(
  liquidityAtCall: number | null,
  currentLiquidityUsd: number | null,
): boolean {
  if (liquidityAtCall === null || liquidityAtCall <= 0) return false;
  if (currentLiquidityUsd === null) return false;
  return currentLiquidityUsd < liquidityAtCall * THRESHOLDS.liquidityDropDeathRatio;
}

/**
 * Dead token showing real life again (repost-triggered or daily check).
 * `poolGraduated` is launchpad_details.completed on the token's GT pool, or
 * null when unknown / not a launchpad pool.
 */
export function isRevived(
  phaseBeforeDeath: 'curve' | 'graduated',
  snapshot: MarketSnapshot | null,
  poolGraduated: boolean | null,
): boolean {
  if (phaseBeforeDeath === 'curve') {
    // A bonding pool's reserve_in_usd is the curve's own float (it tracks FDV),
    // so liquidity is never revival evidence here — mcap or graduation is.
    if (poolGraduated === true) return true;
    return (snapshot?.mcapUsd ?? 0) >= THRESHOLDS.reviveCurveMcapUsd;
  }
  return (snapshot?.liquidityUsd ?? 0) >= THRESHOLDS.reviveLiquidityUsd;
}
