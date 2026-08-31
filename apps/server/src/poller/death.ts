import { THRESHOLDS, type TokenPhase } from '@groupie/shared';
import type { MarketSnapshot } from '../market/types.js';

export interface TokenState {
  phase: TokenPhase;
  /** Oldest of pool-creation / first-seen — the launch clock for 48h rule. */
  ageHours: number;
  /** Highest mcap ever observed across this token's calls; arms the curve floor. */
  peakMcapUsd: number | null;
}

export type DeathReason = 'curve_floor' | 'liquidity_floor' | 'never_graduated';

/**
 * Token-level death (a market fact, group-independent).
 * Rules from decisions.md:
 * - curve token that RETRACED to at/below the ~$8k curve floor = dead
 * - graduated token whose best pair holds < $250 = dead
 * - launchpad token that never graduates within 48h = dead
 * Unknown values are NEVER death evidence: missing liquidity/mcap means
 * "couldn't measure", not zero (DexScreener omits keys on weird pairs, and
 * absence from an API means "not indexed").
 */
export function classifyTokenDeath(
  state: TokenState,
  snapshot: MarketSnapshot | null,
): DeathReason | null {
  if (state.phase === 'curve') {
    // Launches start BELOW the floor (~$5k), so the floor is only evidence of
    // a retrace once the token has actually traded above the arming mcap.
    const armed =
      state.peakMcapUsd !== null && state.peakMcapUsd >= THRESHOLDS.curveFloorArmMcapUsd;
    if (armed && snapshot?.mcapUsd !== null && snapshot?.mcapUsd !== undefined) {
      if (snapshot.mcapUsd <= THRESHOLDS.curveFloorMcapUsd) return 'curve_floor';
    }
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
