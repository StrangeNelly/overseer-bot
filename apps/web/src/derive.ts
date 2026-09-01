/**
 * Everything the redesign reads off the board payload. Strictly derived — the
 * board API is unchanged by this pass, so nothing here invents a number the
 * server did not send.
 */

import type { BoardCard, BoardResponse } from '@groupie/shared';
import { ageMs } from './format';

/** Market numbers older than this get a visible "as of" hint. */
export const STALE_AFTER_MS = 5 * 60 * 1000;
/** The comeback badge runs for 24h (docs/decisions.md round 6), same as the section. */
export const REVIVING_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Runner threshold: the multiple that earns a (static) glow. */
export const RUNNER_MULTIPLE = 3;

export type StatusEdge = 'up' | 'down' | 'cyan' | 'died' | 'unresolved';

export function isDied(card: BoardCard): boolean {
  return card.callStatus === 'died';
}

/**
 * The server never clears a stale reviving_at (a later hide does), so the 24h
 * window lives on the read side — here and in the server's classifySections.
 */
export function isReviving(card: BoardCard, now: number): boolean {
  const age = ageMs(card.revivingAt, now);
  return age !== null && age < REVIVING_WINDOW_MS;
}

/** No market data yet: the row prints a dim dash, never a hero number. */
export function isUnresolved(card: BoardCard): boolean {
  return card.phase === 'unresolved' || (card.mcapUsd === null && card.multiple === null);
}

export function isStale(card: BoardCard, now: number): boolean {
  const age = ageMs(card.dataAsOf, now);
  return age !== null && age > STALE_AFTER_MS;
}

/** The 2px left edge. Priority: died > unresolved > reviving > live P&L. */
export function statusEdge(card: BoardCard, now: number): StatusEdge {
  if (isDied(card)) return 'died';
  if (isUnresolved(card)) return 'unresolved';
  if (isReviving(card, now)) return 'cyan';
  if (card.multiple === null) return 'unresolved';
  return card.multiple >= 1 ? 'up' : 'down';
}

/**
 * "+38% since revival": how far the mcap has come since the comeback, read off
 * the sparkline the payload already carries. null when the trace does not
 * reach back to the revival instant — better silent than made up.
 */
export function revivalDelta(card: BoardCard): number | null {
  const revivedAt = card.revivingAt === null ? null : Date.parse(card.revivingAt);
  if (revivedAt === null || Number.isNaN(revivedAt)) return null;
  if (typeof card.mcapUsd !== 'number' || !Number.isFinite(card.mcapUsd)) return null;

  // The trace is downsampled to <=30 points over 24h, so "the first point after
  // the revival" can easily BE the current reading — which would report a
  // meaningless 0%. Take the sample nearest the revival instant instead, and
  // say nothing at all when that sample is the current one.
  const usable = card.sparkline.filter(
    (point) => typeof point.mcap === 'number' && Number.isFinite(point.mcap) && point.mcap > 0,
  );
  if (usable.length < 2) return null;

  let nearest = 0;
  for (let i = 1; i < usable.length; i++) {
    if (Math.abs(usable[i]!.t - revivedAt) < Math.abs(usable[nearest]!.t - revivedAt)) nearest = i;
  }
  if (nearest === usable.length - 1) return null;

  const atRevival = usable[nearest]!.mcap;
  return ((card.mcapUsd - atRevival) / atRevival) * 100;
}

export interface PulseData {
  /**
   * Calls made since the reader's local midnight — the server's SQL count over
   * the whole group (docs/decisions.md round 15), not a tally of the cards in
   * this window. A 6h window used to make a 20-call day read as 4.
   */
  calls: number;
  best: { label: string; multiple: number } | null;
  died: number;
  reviving: number;
  bestReviving: { label: string; pct: number } | null;
  /** Age of the payload itself, in ms. */
  asOfMs: number | null;
}

function label(card: BoardCard): string {
  return card.symbol ?? 'unnamed';
}

function startOfDay(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Every distinct call on the board, minus anything optimistically binned. */
export function allCards(board: BoardResponse, hidden: ReadonlySet<number>): BoardCard[] {
  const seen = new Set<number>();
  const out: BoardCard[] = [];
  for (const cards of Object.values(board.sections)) {
    for (const card of cards) {
      if (hidden.has(card.callId) || seen.has(card.callId)) continue;
      seen.add(card.callId);
      out.push(card);
    }
  }
  return out;
}

/**
 * The Pulse band: today's story in one line.
 *
 * The call count comes from the server (board.todayCallCount) because it is a
 * claim about the GROUP's day, which the window truncates and probation hides
 * from. Everything else is a claim about what is on screen — best runner, died,
 * reviving — and stays derived from the payload, where it is honest by
 * construction.
 */
export function derivePulse(
  board: BoardResponse,
  now: number,
  hidden: ReadonlySet<number>,
): PulseData {
  const cards = allCards(board, hidden);
  const dayStart = startOfDay(now);

  const today = cards.filter((card) => {
    const called = Date.parse(card.calledAt);
    return !Number.isNaN(called) && called >= dayStart;
  });

  const pool = today.length > 0 ? today : cards;
  let best: { label: string; multiple: number } | null = null;
  for (const card of pool) {
    if (isDied(card)) continue;
    const multiple = card.multiple;
    if (typeof multiple !== 'number' || !Number.isFinite(multiple)) continue;
    if (!best || multiple > best.multiple) best = { label: label(card), multiple };
  }

  const reviving = (board.sections.reviving ?? []).filter((card) => !hidden.has(card.callId));
  let bestReviving: { label: string; pct: number } | null = null;
  for (const card of reviving) {
    const pct = revivalDelta(card);
    if (pct === null) continue;
    if (!bestReviving || pct > bestReviving.pct) bestReviving = { label: label(card), pct };
  }

  const generated = Date.parse(board.generatedAt);

  return {
    // The server counts the day; the payload only ever knew this window's slice
    // of it (cache.ts drops any blob that predates the field).
    calls: board.todayCallCount,
    best,
    died: (board.sections.died ?? []).filter((card) => !hidden.has(card.callId)).length,
    reviving: reviving.length,
    bestReviving,
    asOfMs: Number.isNaN(generated) ? null : Math.max(0, now - generated),
  };
}
