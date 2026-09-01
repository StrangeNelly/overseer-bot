import { THRESHOLDS, type BoardCard, type BoardResponse } from '@groupie/shared';

/**
 * Retraced = it WAS a runner (peak >= 3x call), has since given back 40-85% of
 * that peak, and is still a live market. Death is a separate section, so only
 * active calls reach here — a retraced card is explicitly "pulled back but NOT
 * dying", which round 10 made the code say as well as the docs:
 *
 * - past 85% off peak is collapse territory, and rug probation's job. HDFI was
 *   -99% at $8,249 and the board billed it "Retraced 0.03x";
 * - a pool under the dust line is not something anyone could trade out of,
 *   whatever the chart says.
 *
 * Volume is deliberately NOT a liveness signal here: rug day IS the volume
 * (HDFI printed $1.4M while dying).
 *
 * A card that fails these clauses is not exiled — it stays in fresh, and in
 * runners if it still qualifies there.
 */
function isRetraced(card: BoardCard): boolean {
  if (card.peakMultiple === null || card.peakMultiple < THRESHOLDS.runnerMultiple) return false;
  if (card.liquidityUsd === null || card.liquidityUsd < THRESHOLDS.dustLiquidityUsd) return false;
  // board.ts derives this from the same mcap/peak pair, clamped to 0-100, and
  // it is what the section sorts by — so the rule and the sort never disagree.
  const off = card.retraceFromPeakPct;
  return (
    off !== null &&
    off >= THRESHOLDS.retraceFromPeakRatio * 100 &&
    off <= THRESHOLDS.retraceMaxFromPeakRatio * 100
  );
}

/** Runner = still up 3x+ on the call right now, and not sitting in a retrace. */
function isRunner(card: BoardCard): boolean {
  return (
    card.multiple !== null && card.multiple >= THRESHOLDS.runnerMultiple && !isRetraced(card)
  );
}

/** Descending, nulls last (an unknown value is never "the biggest"). */
function byNumberDesc(value: (card: BoardCard) => number | null) {
  return (a: BoardCard, b: BoardCard) => {
    const left = value(a);
    const right = value(b);
    if (left === null) return right === null ? 0 : 1;
    if (right === null) return -1;
    return right - left;
  };
}

function timeMs(iso: string | null): number | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** How long a survived rug probation wears the Reviving badge (round 6). */
const REVIVING_WINDOW_MS = 24 * 3_600_000;

/**
 * Came back from rug probation recently enough to still be spotlighted
 * (docs/decisions.md round 6). The stamp is never cleared on a timer — the
 * window is applied here, so a stale badge simply stops mattering.
 */
function isReviving(card: BoardCard, nowMs: number): boolean {
  const at = timeMs(card.revivingAt);
  return at !== null && nowMs - at < REVIVING_WINDOW_MS;
}

/**
 * Split the window's cards into board sections (packages/shared/src/api.ts).
 * A card intentionally appears in BOTH fresh and runners/retraced/reviving:
 * fresh is "everything active with recent activity", the others are highlights
 * of it.
 *
 * Hidden tokens never get here at all — board.ts and range.ts filter them out
 * in SQL (a token-level `rug_hidden_at is null` on the join), because probation
 * has to hold for every section including died, which this function does not
 * gate on `active`.
 */
export function classifySections(
  cards: BoardCard[],
  nowMs: number = Date.now(),
): BoardResponse['sections'] {
  const active = cards.filter((card) => card.callStatus === 'active');
  return {
    fresh: [...active].sort(byNumberDesc((card) => timeMs(card.lastMentionAt))),
    runners: active.filter(isRunner).sort(byNumberDesc((card) => card.multiple)),
    retraced: active.filter(isRetraced).sort(byNumberDesc((card) => card.retraceFromPeakPct)),
    // Active only, like every other spotlight: a coin that came back and then
    // died is answered by the Died section, and billing a corpse as "Reviving"
    // would be a lie the badge cannot walk back.
    reviving: active
      .filter((card) => isReviving(card, nowMs))
      .sort(byNumberDesc((card) => timeMs(card.revivingAt))),
    died: cards
      .filter((card) => card.callStatus === 'died')
      .sort(byNumberDesc((card) => timeMs(card.diedAt))),
  };
}
