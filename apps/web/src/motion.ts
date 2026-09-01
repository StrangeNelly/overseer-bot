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

/** Row background flash: at most one per row per this window. */
const FLASH_THROTTLE_MS = 10_000;
/** Design: <=3 concurrent — one breathing card plus at most two transits. */
const MAX_CONCURRENT_TRANSIENTS = 2;
/** A ceremony announcement sits in the Pulse strip this long. */
export const ANNOUNCEMENT_MS = 8_000;
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

// ---------------------------------------------------------------- row flashes

const lastFlashAt = new Map<number, number>();

/** Design: row update flash, throttled to 1 per row per 10s. */
export function canFlash(callId: number, now: number = Date.now()): boolean {
  const last = lastFlashAt.get(callId);
  if (last !== undefined && now - last < FLASH_THROTTLE_MS) return false;
  lastFlashAt.set(callId, now);
  return true;
}

// ---------------------------------------------------------------- board diffing

/** The three state changes that earn a ceremony, plus the new-call bloom. */
export type Ceremony = 'death' | 'revival' | 'tenx' | 'new';

export interface BoardChange {
  /** Per-card ceremony for this update; consumed by the rows. */
  ceremonies: ReadonlyMap<number, Ceremony>;
  /** What the Pulse strip prints, e.g. "SABLE is back". */
  announcement: string | null;
  /** Cards that changed section this update — the desktop transit set. */
  moved: ReadonlySet<number>;
}

const NO_CHANGE: BoardChange = {
  ceremonies: new Map(),
  announcement: null,
  moved: new Set(),
};

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
  let announcement: string | null = null;

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
      announcement ??= `${label(card, callId)} is back`;
      continue;
    }
    const from = was.multiple;
    const to = card.multiple;
    if (from !== null && to !== null && from < TENX && to >= TENX) {
      ceremonies.set(callId, 'tenx');
      announcement ??= `${label(card, callId)} crossed 10x`;
    }
  }

  return { ceremonies, announcement, moved };
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
 * Hold a value for `ms` after it last changed to something truthy — how the
 * Pulse strip keeps a ceremony line up briefly and how rows drop their
 * one-shot animation classes.
 */
export function useTransient<T>(value: T | null, ms: number): T | null {
  const [held, setHeld] = useState<T | null>(null);

  useEffect(() => {
    if (value === null || value === undefined) return;
    setHeld(value);
    const id = window.setTimeout(() => setHeld(null), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);

  return held;
}
