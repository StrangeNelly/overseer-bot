import { THRESHOLDS, type BoardCard, type BoardResponse } from '@groupie/shared';

/**
 * Retraced = it WAS a runner (peak >= 3x call) and has since given back at
 * least 40% of that peak. Death is a separate section, so only active calls
 * reach here — a retraced card is explicitly "pulled back but not dying".
 */
function isRetraced(card: BoardCard): boolean {
  return (
    card.peakMultiple !== null &&
    card.peakMultiple >= THRESHOLDS.runnerMultiple &&
    card.mcapUsd !== null &&
    card.peakMcapSinceCall !== null &&
    card.mcapUsd <= (1 - THRESHOLDS.retraceFromPeakRatio) * card.peakMcapSinceCall
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

/**
 * Split the window's cards into board sections (packages/shared/src/api.ts).
 * A card intentionally appears in BOTH fresh and runners/retraced: fresh is
 * "everything active with recent activity", the others are highlights of it.
 */
export function classifySections(cards: BoardCard[]): BoardResponse['sections'] {
  const active = cards.filter((card) => card.callStatus === 'active');
  return {
    fresh: [...active].sort(byNumberDesc((card) => timeMs(card.lastMentionAt))),
    runners: active.filter(isRunner).sort(byNumberDesc((card) => card.multiple)),
    retraced: active.filter(isRetraced).sort(byNumberDesc((card) => card.retraceFromPeakPct)),
    died: cards
      .filter((card) => card.callStatus === 'died')
      .sort(byNumberDesc((card) => timeMs(card.diedAt))),
  };
}
