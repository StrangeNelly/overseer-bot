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
  // Binning is group-wide, so every other member's open board must drop the
  // card without waiting for an unrelated poll event.
  | { type: 'call_binned'; tokenId: number; callId: number }
  // Already persisted in `alerts` and past its cooldown when this fires: the
  // subscriber's only job is delivering `message` to the group's chat.
  | {
      type: 'alert_fired';
      groupId: number;
      tokenId: number;
      alertType: 'nuke' | 'buy_opp';
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
