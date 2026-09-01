/**
 * Last-board cache (design README "Performance / loading"): the board paints
 * from localStorage instantly and revalidates behind it.
 *
 * Deliberately narrow: the cache is a PRE-first-response paint only. It never
 * merges with, and never outranks, anything the server has already said in this
 * session — so it cannot resurrect an optimistically binned card or clobber a
 * newer payload. Anything older than MAX_AGE_MS is dropped rather than shown.
 */

import type { BoardResponse, BoardWindow } from '@groupie/shared';

const PREFIX = 'overseer.board';
/** Older than this and the numbers are museum pieces; show the skeleton instead. */
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

function key(slug: string, boardWindow: BoardWindow): string {
  return `${PREFIX}.${slug}.${boardWindow}`;
}

interface Envelope {
  savedAt: number;
  board: BoardResponse;
}

/** Shape-checked just far enough that a corrupt or stale-schema blob cannot render. */
function isBoard(value: unknown): value is BoardResponse {
  if (!value || typeof value !== 'object') return false;
  const board = value as Partial<BoardResponse>;
  if (typeof board.generatedAt !== 'string') return false;
  if (!board.group || typeof board.group !== 'object') return false;
  // Round 15's honesty counts. A blob saved before they existed is dropped
  // rather than painted, so no surface has to invent a number for them — the
  // skeleton for one load is the cheaper honesty.
  if (typeof board.todayCallCount !== 'number') return false;
  if (typeof board.hiddenProbationCount !== 'number') return false;
  // Round 16's watchlist. ON WATCH renders from it — the zone would paint empty
  // off a pre-round-16 blob and tell a member they hold no slots, which is worse
  // than a skeleton for one load.
  if (!Array.isArray(board.watchlist)) return false;
  const sections = board.sections;
  if (!sections || typeof sections !== 'object') return false;
  for (const name of ['fresh', 'runners', 'retraced', 'died', 'reviving'] as const) {
    if (!Array.isArray(sections[name])) return false;
  }
  return true;
}

export function readCachedBoard(slug: string, boardWindow: BoardWindow): BoardResponse | null {
  try {
    const raw = window.localStorage.getItem(key(slug, boardWindow));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const envelope = parsed as Partial<Envelope>;
    if (typeof envelope.savedAt !== 'number') return null;
    if (Date.now() - envelope.savedAt > MAX_AGE_MS) return null;
    return isBoard(envelope.board) ? envelope.board : null;
  } catch {
    // Private mode, disabled storage, or a corrupt blob: no instant paint.
    return null;
  }
}

export function writeCachedBoard(
  slug: string,
  boardWindow: BoardWindow,
  board: BoardResponse,
): void {
  try {
    const envelope: Envelope = { savedAt: Date.now(), board };
    window.localStorage.setItem(key(slug, boardWindow), JSON.stringify(envelope));
  } catch {
    // Quota or private mode: the cache is an optimisation, never a requirement.
  }
}
