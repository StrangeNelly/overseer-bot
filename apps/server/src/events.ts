import { EventEmitter } from 'node:events';

/**
 * In-process pub/sub seam between the poller and (M3) the SSE layer. When the
 * poller and web split into separate services, this swaps for Postgres
 * LISTEN/NOTIFY behind the same publish() signature.
 */
export type GroupieEvent =
  | { type: 'new_call'; tokenId: number; address: string }
  | { type: 'token_resolved'; tokenId: number; symbol: string | null }
  | { type: 'price_update'; tokenId: number; mcapUsd: number | null }
  | { type: 'token_died'; tokenId: number; reason: string }
  | { type: 'token_revived'; tokenId: number }
  | { type: 'call_revived'; tokenId: number; callId: number }
  // Rug probation transitions (docs/decisions.md round 6). Both change what
  // EVERY board shows — a hide removes the card from all sections, a revival
  // puts it back with a spotlight — so, exactly like a bin, they must not wait
  // for some unrelated poll event to reach open boards.
  | { type: 'rug_hidden'; tokenId: number }
  | { type: 'rug_revived'; tokenId: number }
  // Binning is group-wide — every other member's open board must drop the
  // card without waiting for an unrelated poll event — and group-SCOPED: the
  // groupId lets the SSE layer deliver it only to that group's boards, rather
  // than to every group that happens to share the token (round 15 review).
  | { type: 'call_binned'; tokenId: number; callId: number; groupId: number }
  // Round 21's member verdict and its reversal. Group-scoped for exactly the
  // reasons a bin is: one member marking a coin dead moves the card into DIED
  // on every open board in that group, the coin itself is untouched (other
  // groups' calls on it stay live), and nobody should have to wait for an
  // unrelated poll event to see it. Both are also raised by the bot, which is
  // why they are events rather than a route-local refetch hint.
  | { type: 'call_marked_dead'; tokenId: number; callId: number; groupId: number }
  | { type: 'call_restored'; tokenId: number; callId: number; groupId: number }
  // So is the watchlist (docs/decisions.md round 15): one member pressing watch
  // turns on alerts for the whole chat, so every open board should show the
  // marker rather than waiting for a poll. Group-scoped for the same reason —
  // a watch is one group's state, not the token's.
  | { type: 'watch_changed'; tokenId: number; groupId: number }
  // Already persisted in `alerts` and past its cooldown (watchlist) or under its
  // hourly cap (discovery) when this fires: the subscriber's only job is
  // delivering `message` to the group's chat.
  //
  // `tokenId` is NULL for the discovery family (docs/decisions.md rounds 18 and
  // 20): a launch or a graduation is about a coin nobody here has called, so
  // there is no token row and no call message to thread the reply onto.
  | {
      type: 'alert_fired';
      groupId: number;
      tokenId: number | null;
      alertType: 'nuke' | 'buy_opp' | 'launch' | 'graduation';
      message: string;
    };

const emitter = new EventEmitter();
emitter.setMaxListeners(100);

export function publish(event: GroupieEvent): void {
  emitter.emit('event', event);
}

export function subscribe(handler: (event: GroupieEvent) => void): () => void {
  emitter.on('event', handler);
  return () => emitter.off('event', handler);
}
