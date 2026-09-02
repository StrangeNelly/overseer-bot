/**
 * The member verdict, wired to a surface (docs/decisions.md round 21).
 *
 * MARK DEAD is the group's answer to a coin the rules cannot kill: $VLR dumped
 * 0.4x on intact liquidity, so nothing in the death machinery had anything to
 * fire on. Any member can pronounce it, group-wide, exactly as any member can
 * bin — and only a member can take it back (RESTORE), because a rule that
 * revived a verdict at $30K would resurrect $VLR inside three hours.
 *
 * Shaped like watch.ts: the board hands every surface one set of callbacks plus
 * the in-flight ids, and each card resolves its own pill from the card it
 * already holds. Keyed by callId rather than address — this is a verdict on ONE
 * call, not on a coin, and a second group's call on the same token is untouched.
 */

import type { BoardCard } from '@groupie/shared';
import { isDied, isMemberDeath } from './derive';
import { shortAddress } from './format';

export interface DeadProps {
  onMarkDead: (card: BoardCard) => void;
  onRestore: (card: BoardCard) => void;
  /** Call ids whose verdict is in flight. */
  pending: ReadonlySet<number>;
}

export interface DeadControl {
  /** 'mark' on a live call, 'restore' on a member-marked death. */
  mode: 'mark' | 'restore';
  pending: boolean;
  /** `$VLR`, or the short address when the coin has no symbol yet. */
  label: string;
  onFire: () => void;
}

/**
 * The pill this card gets, or none at all.
 *
 * Liveness of the CALL is the only scope (round 21 amendment (e)): never on a
 * card that is already dead, never on a binned one — and offered on a call with
 * no market data yet, because the Base dud is exactly the case a member has to
 * be able to end. The board says "not indexed yet" for as long as it likes; the
 * group is allowed to know better.
 *
 * RESTORE is offered on member deaths alone; a rule-driven death is the
 * poller's to reverse, and the server answers 409 either way.
 */
export function deadForCard(
  card: BoardCard,
  props: DeadProps | undefined,
): DeadControl | undefined {
  if (!props) return undefined;
  const label = card.symbol ? `$${card.symbol}` : shortAddress(card.address);
  const pending = props.pending.has(card.callId);
  if (isMemberDeath(card)) {
    return { mode: 'restore', pending, label, onFire: () => props.onRestore(card) };
  }
  if (isDied(card)) return undefined;
  if (card.callStatus !== 'active') return undefined;
  return { mode: 'mark', pending, label, onFire: () => props.onMarkDead(card) };
}

/** The two optimistic overlays a board load may hand over to the payload. */
export interface Verdicts {
  markedDead: ReadonlyMap<number, string>;
  restored: ReadonlySet<number>;
}

/**
 * Which optimistic verdicts a fresh board payload settles.
 *
 * A load used to clear both overlays wholesale, which is right for a verdict the
 * server has already answered and wrong for one still in flight: a background
 * refetch (SSE, focus, another card's watch toggle) landing mid-request would
 * put the card back where it was, and the reader would watch their own MARK DEAD
 * undo itself for a second. So a call whose request is still open keeps its
 * overlay; every settled one hands over to the payload, which is the truth by
 * then — including whose name is on the death.
 */
export function settleVerdicts(
  markedDead: ReadonlyMap<number, string>,
  restored: ReadonlySet<number>,
  pending: ReadonlySet<number>,
): Verdicts {
  return { markedDead: keepPending(markedDead, pending), restored: keepPendingIds(restored, pending) };
}

function keepPending(
  marks: ReadonlyMap<number, string>,
  pending: ReadonlySet<number>,
): ReadonlyMap<number, string> {
  if (marks.size === 0) return marks;
  const next = new Map<number, string>();
  for (const [callId, at] of marks) if (pending.has(callId)) next.set(callId, at);
  // Identity is what keeps the board from re-rendering on every silent refetch.
  return next.size === marks.size ? marks : next;
}

function keepPendingIds(
  ids: ReadonlySet<number>,
  pending: ReadonlySet<number>,
): ReadonlySet<number> {
  if (ids.size === 0) return ids;
  const next = new Set<number>();
  for (const callId of ids) if (pending.has(callId)) next.add(callId);
  return next.size === ids.size ? ids : next;
}
