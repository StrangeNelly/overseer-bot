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
  | { type: 'call_revived'; tokenId: number; callId: number };

const emitter = new EventEmitter();
emitter.setMaxListeners(100);

export function publish(event: GroupieEvent): void {
  emitter.emit('event', event);
}

export function subscribe(handler: (event: GroupieEvent) => void): () => void {
  emitter.on('event', handler);
  return () => emitter.off('event', handler);
}
