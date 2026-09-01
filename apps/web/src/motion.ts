/**
 * The motion system from the design handoff (README "Motion"). Ceremony is
 * rationed on purpose: a board that flashes at everything stops meaning
 * anything, so exactly three state changes earn an animation, glow is static
 * everywhere except the top runner, row flashes are throttled per row, and no
 * more than a couple of transient animations ever run at once.
 *
 * Hand-rolled: no animation library, no dependency.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { BoardCard, BoardResponse } from '@groupie/shared';
import { ALERT_DEFAULTS } from '@groupie/shared';
import { moveOneHour } from './derive';
import { fmtSignedPct, shortAddress } from './format';

/** Row background flash: at most one per row per this window. */
const FLASH_THROTTLE_MS = 10_000;
/** Design: <=3 concurrent — one breathing card plus at most two transits. */
const MAX_CONCURRENT_TRANSIENTS = 2;
/** A ceremony announcement sits in the Pulse strip this long. */
export const ANNOUNCEMENT_MS = 8_000;
/** The 3G cyan bloom on the row the announcement named. */
export const WATCH_BLOOM_MS = 600;
/** Multiple that earns the shimmer sweep. */
const TENX = 10;

// ---------------------------------------------------------------- reduced motion

const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia(REDUCED_QUERY).matches;
  } catch {
    return false;
  }
}

/** Live-tracked, because the OS setting can flip while the board is open. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    let mq: MediaQueryList;
    try {
      mq = window.matchMedia(REDUCED_QUERY);
    } catch {
      return;
    }
    const onChange = () => setReduced(mq.matches);
    setReduced(mq.matches);
    // addListener is the Safari <14 spelling; both are harmless to try.
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    }
    mq.addListener?.(onChange);
    return () => mq.removeListener?.(onChange);
  }, []);

  return reduced;
}

// ---------------------------------------------------------------- noise budget

interface Job {
  run: () => void;
  durationMs: number;
}

let running = 0;
const queue: Job[] = [];

function pump(): void {
  while (running < MAX_CONCURRENT_TRANSIENTS && queue.length > 0) {
    const job = queue.shift();
    if (!job) return;
    running += 1;
    job.run();
    window.setTimeout(() => {
      running -= 1;
      pump();
    }, job.durationMs);
  }
}

/**
 * Run a transient animation inside the noise budget. Overflow is queued rather
 * than dropped, so a burst of state changes plays as a sequence instead of a
 * pile-up. Reduced motion runs the callback immediately and untimed — callers
 * are expected to have already swapped in their static fallback.
 */
export function requestMotion(run: () => void, durationMs: number): void {
  if (prefersReducedMotion()) {
    run();
    return;
  }
  queue.push({ run, durationMs });
  pump();
}

/**
 * Whether a transient requested right now would play immediately. A FLIP slide
 * is only meaningful in the frame it was measured in — queued behind a full
 * budget it would replay from stale geometry after the rows were already
 * painted in place — so its caller asks first and drops the slide instead.
 */
export function hasMotionRoom(): boolean {
  return prefersReducedMotion() || (running < MAX_CONCURRENT_TRANSIENTS && queue.length === 0);
}

// ---------------------------------------------------------------- row flashes

const lastFlashAt = new Map<number, number>();

/** Design: row update flash, throttled to 1 per row per 10s. */
export function canFlash(callId: number, now: number = Date.now()): boolean {
  const last = lastFlashAt.get(callId);
  if (last !== undefined && now - last < FLASH_THROTTLE_MS) return false;
  lastFlashAt.set(callId, now);
  return true;
}

// ---------------------------------------------------------------- rank changes

/** Design pass 2: at most one reorder animation per zone per this window. */
const REORDER_THROTTLE_MS = 10_000;
const lastReorderAt = new Map<string, number>();

/**
 * Whether a zone may play its FLIP slide this update. A board that re-ranks on
 * every 6-second refetch would otherwise be in permanent motion, which is the
 * opposite of what ranking by data is for.
 */
export function canReorder(zone: string, now: number = Date.now()): boolean {
  const last = lastReorderAt.get(zone);
  if (last !== undefined && now - last < REORDER_THROTTLE_MS) return false;
  lastReorderAt.set(zone, now);
  return true;
}

// ---------------------------------------------------------------- board diffing

/** The three state changes that earn a ceremony, plus the new-call bloom. */
export type Ceremony = 'death' | 'revival' | 'tenx' | 'new';

/** One line for the Pulse strip's single ceremony slot. */
export interface Announcement {
  /** What the strip prints, e.g. "SABLE is back". */
  text: string;
  /**
   * 3G: the watched coin this line names — the row that blooms cyan once and
   * sorts to the top of ON WATCH while the line holds. Lowercased address,
   * because a watch is addressed by contract, not by call. null for the
   * ceremonies that speak about a card instead.
   */
  address: string | null;
}

export interface BoardChange {
  /** Per-card ceremony for this update; consumed by the rows. */
  ceremonies: ReadonlyMap<number, Ceremony>;
  /**
   * Every line this update earned, in the order they were found. They share one
   * slot in the strip, so the consumer queues them — a second ceremony waits its
   * turn rather than overwriting the first.
   */
  announcements: readonly Announcement[];
  /** Cards that changed section this update — the desktop transit set. */
  moved: ReadonlySet<number>;
}

const NO_ANNOUNCEMENTS: readonly Announcement[] = [];

const NO_CHANGE: BoardChange = {
  ceremonies: new Map(),
  announcements: NO_ANNOUNCEMENTS,
  moved: new Set(),
};

/**
 * The move that earns the board's watch line (3G). The bot's own thresholds are
 * per-group settings the board payload does not carry, so the client uses the
 * shipped default for the slower of the two alerts. It is a display heuristic
 * for a line that is already true — the number is read off the same sparkline
 * the chip prints — and it never claims an alert was sent.
 */
const WATCH_MOVE_PCT = ALERT_DEFAULTS.buyRetracePct;
/** 3G: at most one line (and one bloom) per coin per this window. */
const WATCH_ALERT_THROTTLE_MS = 10 * 60 * 1000;
/**
 * ...and after it has fired, the move has to come back inside this band before
 * the coin can fire again. Without it a coin sitting at the threshold crosses
 * it on every other 6-second refetch and the "crossing" means nothing.
 */
const WATCH_REARM_PCT = 20;

const lastWatchAlertAt = new Map<string, number>();
const watchDisarmed = new Set<string>();

interface WatchMove {
  pct: number;
  symbol: string | null;
  address: string;
}

function watchMoves(board: BoardResponse): Map<string, WatchMove> {
  const out = new Map<string, WatchMove>();
  for (const entry of board.watchlist ?? []) {
    const pct = moveOneHour(entry.sparkline);
    if (pct === null) continue;
    out.set(entry.address.toLowerCase(), { pct, symbol: entry.symbol, address: entry.address });
  }
  return out;
}

interface CardState {
  sections: string;
  died: boolean;
  reviving: boolean;
  multiple: number | null;
  symbol: string | null;
}

function snapshot(board: BoardResponse): Map<number, CardState> {
  const out = new Map<number, CardState>();
  for (const [key, cards] of Object.entries(board.sections)) {
    for (const card of cards as BoardCard[]) {
      const prior = out.get(card.callId);
      if (prior) {
        prior.sections = `${prior.sections}|${key}`;
        continue;
      }
      out.set(card.callId, {
        sections: key,
        died: card.callStatus === 'died',
        reviving: card.revivingAt !== null,
        multiple: card.multiple,
        symbol: card.symbol,
      });
    }
  }
  return out;
}

function label(card: CardState, callId: number): string {
  return card.symbol ? `$${card.symbol}` : `call ${callId}`;
}

const undiffable = new WeakSet<BoardResponse>();

/**
 * Mark a payload whose successor must NOT be diffed. Used for the localStorage
 * cache paint: an hours-old board would otherwise make every current call look
 * new and every current death look like it just happened.
 */
export function suppressDiffAfter(board: BoardResponse): void {
  undiffable.add(board);
}

/**
 * What changed between two board payloads. Only the sanctioned ceremonies come
 * out of here: a death, a revival, a 10x crossing, and the new-call bloom.
 */
export function diffBoards(prev: BoardResponse | null, next: BoardResponse): BoardChange {
  if (!prev || undiffable.has(prev)) return NO_CHANGE;

  const before = snapshot(prev);
  const after = snapshot(next);
  const ceremonies = new Map<number, Ceremony>();
  const moved = new Set<number>();
  const announcements: Announcement[] = [];

  for (const [callId, card] of after) {
    const was = before.get(callId);
    if (!was) {
      ceremonies.set(callId, 'new');
      continue;
    }
    if (was.sections !== card.sections) moved.add(callId);

    if (!was.died && card.died) {
      ceremonies.set(callId, 'death');
      continue;
    }
    if (!was.reviving && card.reviving) {
      ceremonies.set(callId, 'revival');
      announcements.push({ text: `${label(card, callId)} is back`, address: null });
      continue;
    }
    const from = was.multiple;
    const to = card.multiple;
    if (from !== null && to !== null && from < TENX && to >= TENX) {
      ceremonies.set(callId, 'tenx');
      announcements.push({ text: `${label(card, callId)} crossed 10x`, address: null });
    }
  }

  // 3G — a watched coin crossing the move threshold prints on the board too.
  // Only the CROSSING fires: a coin that has been down 40% all afternoon is a
  // standing fact, not an event, and the chat already said it once. A coin
  // whose prior move we have never seen (it just joined the watchlist, or its
  // trace only now reaches back an hour) has not crossed anything either.
  const now = Date.now();
  const movesBefore = watchMoves(prev);
  for (const [key, move] of watchMoves(next)) {
    // Re-arm first, so a coin that came back inside the band can fire again.
    if (Math.abs(move.pct) < WATCH_REARM_PCT) watchDisarmed.delete(key);
    if (Math.abs(move.pct) < WATCH_MOVE_PCT) continue;
    const was = movesBefore.get(key);
    if (!was || Math.abs(was.pct) >= WATCH_MOVE_PCT) continue;
    if (watchDisarmed.has(key)) continue;
    const last = lastWatchAlertAt.get(key);
    if (last !== undefined && now - last < WATCH_ALERT_THROTTLE_MS) continue;
    lastWatchAlertAt.set(key, now);
    watchDisarmed.add(key);
    // Wording law: symbol + signed move + window + "on watch". Never the
    // alert's internal name — "nuke" and "buy-opp" are verdicts.
    const name = move.symbol ?? shortAddress(move.address);
    announcements.push({ text: `${name} ${fmtSignedPct(move.pct)} in 1h — on watch`, address: key });
  }

  return { ceremonies, announcements, moved };
}

/** Diff the board against its predecessor, once per payload. */
export function useBoardChange(board: BoardResponse | null): BoardChange {
  const prevRef = useRef<BoardResponse | null>(null);
  return useMemo(() => {
    if (!board) return NO_CHANGE;
    const change = diffBoards(prevRef.current, board);
    prevRef.current = board;
    return change;
    // generatedAt changes on every payload; that is exactly the cadence wanted.
  }, [board]);
}

/**
 * The Pulse strip's ceremony slot: one line at a time, each held for `ms`.
 *
 * A FIFO rather than "last writer wins" — a revival and a watch crossing in the
 * same payload are two events, and dropping one of them leaves its row blooming
 * with nothing to explain it (design pass 2, 3G: "a second within 6s queues").
 */
export function useAnnouncementQueue(
  incoming: readonly Announcement[],
  ms: number,
): Announcement | null {
  const queue = useRef<Announcement[]>([]);
  const [held, setHeld] = useState<Announcement | null>(null);
  const [arrivals, setArrivals] = useState(0);

  useEffect(() => {
    if (incoming.length === 0) return;
    queue.current.push(...incoming);
    setArrivals((count) => count + 1);
  }, [incoming]);

  // The hold clock depends on the held line ALONE: a payload arriving mid-hold
  // must not restart it, or a board refetching every 6 seconds would keep one
  // line up forever.
  useEffect(() => {
    if (held === null) return;
    const id = window.setTimeout(() => setHeld(null), ms);
    return () => window.clearTimeout(id);
  }, [held, ms]);

  useEffect(() => {
    if (held !== null) return;
    const next = queue.current.shift();
    if (next) setHeld(next);
  }, [held, arrivals]);

  return held;
}

/**
 * The 3G cyan bloom, inside the noise budget. Reduced motion keeps the class on
 * for as long as the announcement holds instead — the row wears a static cyan
 * edge rather than a bloom (3G: "row gets the cyan edge instead").
 */
export function useAlertBloom(alerted: boolean): boolean {
  const reduced = useReducedMotion();
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (!alerted || reduced) return;
    let cancelled = false;
    let timer = 0;
    requestMotion(() => {
      if (cancelled) return;
      setPlaying(true);
      timer = window.setTimeout(() => setPlaying(false), WATCH_BLOOM_MS);
    }, WATCH_BLOOM_MS);
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
      setPlaying(false);
    };
  }, [alerted, reduced]);

  return reduced ? alerted : playing;
}
