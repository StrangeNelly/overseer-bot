/**
 * The two-tap guard behind MARK DEAD and RESTORE (docs/decisions.md round 21).
 *
 * Both actions are group-wide and instant, and both live on a pill sized like
 * WATCH — a control a thumb reaches by accident. Binning asks with a modal, but
 * a modal on a hover strip is the wrong shape: the strip is gone by the time
 * the dialog paints. So the pill asks in place: one tap arms it ("SURE?"), a
 * second fires, and anything else — four seconds, a tap somewhere else, moving
 * focus away, the action going into flight — puts it back.
 *
 * The whole machine lives here as pure functions, because apps/web runs its
 * tests in Node with no DOM: the rule that protects the group's board would
 * otherwise be the one rule nothing could assert. The component keeps only the
 * timer and the listener that feed these.
 */

/** How long an armed pill waits for the second tap before reverting. */
export const CONFIRM_MS = 4_000;

export type ConfirmState = 'idle' | 'armed';

/**
 * `press` is a tap on the pill itself. The other four all revoke an arming
 * without firing, and are named apart because they are separate wires in the
 * component: the 4s expiry, a capture-phase pointerdown somewhere else, focus
 * leaving the pill, and the request going into flight (which disables it).
 */
export type ConfirmEvent = 'press' | 'timeout' | 'outside' | 'blur' | 'disable';

export interface ConfirmStep {
  state: ConfirmState;
  /** True on exactly the transition that commits the action. */
  fire: boolean;
}

export function confirmStep(state: ConfirmState, event: ConfirmEvent): ConfirmStep {
  if (event === 'press') {
    // The second press is the only thing in this file that can fire.
    return state === 'armed' ? { state: 'idle', fire: true } : { state: 'armed', fire: false };
  }
  // Every other event lands back at rest, from either state: an idle pill that
  // receives one has simply nothing to undo.
  return { state: 'idle', fire: false };
}

/** Anything that can answer "is this node inside me?" — an element, in practice. */
interface ContainsNode {
  contains(node: unknown): boolean;
}

/**
 * Whether a pointerdown disarms the pill.
 *
 * The listener is capture-phase, so it also sees the taps that armed the pill
 * and the second one that fires it — both land INSIDE, and neither may disarm.
 * A target that is not a node under us (or no pill at all, mid-unmount) counts
 * as outside: the safe answer is always to disarm.
 */
export function pressedOutside(pill: ContainsNode | null | undefined, target: unknown): boolean {
  if (!pill || target === null || target === undefined) return true;
  return !pill.contains(target);
}
