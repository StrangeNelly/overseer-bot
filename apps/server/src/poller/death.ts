import { THRESHOLDS, type TokenPhase } from '@groupie/shared';
import type { MarketSnapshot } from '../market/types.js';

export interface TokenState {
  phase: TokenPhase;
  /**
   * Oldest of pool-creation / first-seen — the launch clock, used by the 48h
   * rule and by round 11's newborn grace.
   */
  ageHours: number;
}

/**
 * One liquidity observation: a `snapshots` row, or the live reading being
 * judged. Ascending by time, newest LAST — the scheduler loads the window and
 * appends the reading this poll just took (see liquiditySeries there).
 */
export interface LiquidityReading {
  /** Unix ms of the observation. */
  atMs: number;
  /** null = couldn't measure. Never death evidence, and it breaks a run. */
  liquidityUsd: number | null;
}

/**
 * The newest reading must be at most this old to stand for "now". A backstop:
 * the scheduler always appends the live reading, so this only fires if a caller
 * hands over a stale window — which must never kill a token on its own.
 */
export const MAX_LIQUIDITY_READING_AGE_MS = 5 * 60_000;

const MINUTE_MS = 60_000;

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
 * Round 11's newborn grace: no liquidity-based death this soon after the launch
 * clock. Only the liquidity rules are held off — mcap rules see a newborn
 * exactly as they always did.
 */
export function inNewbornGrace(ageHours: number): boolean {
  if (!Number.isFinite(ageHours)) return false;
  return ageHours * 60 < THRESHOLDS.newbornGraceMinutes;
}

/**
 * Round 11's persistence rule, shared by both liquidity verdicts: `test` must
 * hold across an UNBROKEN run of >= liquidityDeathMinReadings readings spanning
 * >= liquidityDeathMinMinutes, and the newest reading must be one of them.
 *
 * Walked back from the newest reading rather than judged over the whole window,
 * for the same reason rugLogic's revival hold is: a token that has just been
 * refilled is not dying, however bad the first half of the window looked.
 *
 * Hurdles, all required:
 *
 * 1. there is a newest reading, it is fresh, and it satisfies `test` — one
 *    healthy reading ends the matter (this is the OMNI fix in one line);
 * 2. the unbroken run reaching back from it is at least minReadings long, so a
 *    single lonely observation is never "sustained";
 * 3. that run spans at least minMinutes of wall clock, so four readings inside
 *    one 45-second poll burst are not ten minutes of evidence either.
 *
 * An unmeasurable (null / non-finite) reading breaks the run: "couldn't
 * measure" is not "measured zero" (death.ts's oldest rule).
 */
function liquidityPersists(
  readings: LiquidityReading[],
  nowMs: number,
  test: (liquidityUsd: number) => boolean,
): boolean {
  const newestIdx = readings.length - 1;
  const newest = readings[newestIdx];
  if (!newest) return false;
  if (nowMs - newest.atMs > MAX_LIQUIDITY_READING_AGE_MS) return false;

  const holds = (reading: LiquidityReading): boolean =>
    reading.liquidityUsd !== null &&
    Number.isFinite(reading.liquidityUsd) &&
    test(reading.liquidityUsd);
  if (!holds(newest)) return false;

  let startMs = newest.atMs;
  let count = 1;
  for (let i = newestIdx - 1; i >= 0; i--) {
    const reading = readings[i];
    if (!reading || !holds(reading)) break;
    startMs = reading.atMs;
    count += 1;
  }

  if (count < THRESHOLDS.liquidityDeathMinReadings) return false;
  return newest.atMs - startMs >= THRESHOLDS.liquidityDeathMinMinutes * MINUTE_MS;
}

/**
 * Token-level death (a market fact, group-independent).
 * Rules from decisions.md:
 * - graduated token whose best pair holds < $250 = dead — since round 11, only
 *   when it has held that for 10 minutes across 3+ readings, and never inside
 *   the 30-minute newborn grace;
 * - launchpad token that never graduates within 48h = dead.
 * A curve token below the floor is NOT judged here at all: that is the rug
 * sweep's business now, and it hides rather than kills.
 *
 * Everything here is pure: scheduler.ts loads the readings, this file judges
 * them. `readings` must end with the reading being judged.
 */
export function classifyTokenDeath(
  state: TokenState,
  readings: LiquidityReading[],
  nowMs: number,
): DeathReason | null {
  if (state.phase === 'curve') {
    if (state.ageHours >= THRESHOLDS.ungraduatedDeathHours) return 'never_graduated';
    return null;
  }
  if (state.phase === 'graduated') {
    // The 48h clock is a mcap/graduation fact and is deliberately unaffected by
    // the grace; this branch is pure liquidity, so the grace owns it entirely.
    if (inNewbornGrace(state.ageHours)) return null;
    if (liquidityPersists(readings, nowMs, (liq) => liq < THRESHOLDS.deadLiquidityUsd)) {
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
 *
 * Round 11 gives this the same persistence and newborn-grace semantics as the
 * token floor above — the 5% ratio itself is untouched (round 13 looked at it,
 * left it: locked LP blunts the rule, but the mcap machinery carries that
 * weight now).
 */
export function callLiquidityDeath(
  liquidityAtCall: number | null,
  readings: LiquidityReading[],
  nowMs: number,
  ageHours: number,
): boolean {
  if (liquidityAtCall === null || liquidityAtCall <= 0) return false;
  if (inNewbornGrace(ageHours)) return false;
  const collapseLine = liquidityAtCall * THRESHOLDS.liquidityDropDeathRatio;
  return liquidityPersists(readings, nowMs, (liq) => liq < collapseLine);
}

/**
 * Dead token showing real life again (repost-triggered or daily check).
 * `poolGraduated` is launchpad_details.completed on the token's GT pool, or
 * null when unknown / not a launchpad pool.
 *
 * Round 13: ONE bar for every phaseBeforeDeath — mcap >= revivalMcapUsd, the
 * same $30k rugLogic's probation revival uses. Liquidity is consulted nowhere:
 * PONS fair launches lock LP permanently, so a graduated corpse keeps ~$5-6k of
 * residual liquidity forever and the old $1k liquidity bar would have revived
 * every dead fair launch on the next daily dead-poll, straight back into
 * probation and back to dead (~25h zombie flap).
 *
 * The curve exception stays: completing the bonding curve while dead is a fact
 * about the token, not a price, and it revives on its own.
 */
export function isRevived(
  phaseBeforeDeath: 'curve' | 'graduated',
  snapshot: MarketSnapshot | null,
  poolGraduated: boolean | null,
): boolean {
  if (phaseBeforeDeath === 'curve' && poolGraduated === true) return true;
  return (snapshot?.mcapUsd ?? 0) >= THRESHOLDS.revivalMcapUsd;
}
