import { and, eq, or, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { calls, tokens, watches, type Db } from '@groupie/db';
import { subscribe, type GroupieEvent } from '../events.js';
import type { ApiEnv } from './membership.js';

const HEARTBEAT_MS = 25_000;
/** Events fire per token; this cache answers "does this group care?" cheaply. */
const RELEVANCE_TTL_MS = 60_000;
const RELEVANCE_MAX_ENTRIES = 5_000;

const relevance = new Map<string, { relevant: boolean; at: number }>();

function pruneRelevance(now: number): void {
  for (const [key, entry] of relevance) {
    if (now - entry.at >= RELEVANCE_TTL_MS) relevance.delete(key);
  }
}

/**
 * Event types that can make a token newly relevant to a group. A cached
 * 'false' (written when some other group's price_update passed through this
 * stream) would otherwise swallow the very event the immediate-poll path
 * exists to deliver, plus every price_update behind it, for up to the TTL.
 *
 * watch_changed joined them in round 16: a watch is now a relevance source of
 * its own, so the negative cached before it would swallow every price_update
 * the new ON WATCH row depends on. Exported for tests.
 */
export function changesRelevance(event: GroupieEvent): boolean {
  return (
    event.type === 'new_call' ||
    event.type === 'call_revived' ||
    event.type === 'watch_changed'
  );
}

/** What this stream does with an event, decided before any query. */
export type Relevance = 'write' | 'skip' | 'ask';

/**
 * A group-scoped event (a bin, a watch, an alert) names the group it belongs
 * to: another group's is none of this stream's business, and this group's is
 * relevant BY CONSTRUCTION. Asking the database about it was the round-16 bug
 * — a watch set from the chat or from a Sleepers row has no call to find, so
 * every watch_changed for the coins the ON WATCH zone exists to show was
 * dropped. Everything else carries a token id only, and has to be asked about.
 */
export function relevanceOf(event: GroupieEvent, groupId: number): Relevance {
  if ('groupId' in event) return event.groupId === groupId ? 'write' : 'skip';
  return 'ask';
}

/**
 * Does this group care about a token an event named without a group? A call is
 * one reason; since round 16 an active watch is the other, and it stands alone
 * — a watched coin the group never called still has an ON WATCH row whose
 * numbers only move when these price updates get through.
 */
async function isGroupToken(db: Db, groupId: number, tokenId: number): Promise<boolean> {
  const key = `${groupId}:${tokenId}`;
  const now = Date.now();
  const cached = relevance.get(key);
  if (cached && now - cached.at < RELEVANCE_TTL_MS) return cached.relevant;

  const found = await db
    .select({ id: tokens.id })
    .from(tokens)
    .where(
      and(
        eq(tokens.id, tokenId),
        or(
          sql`exists (select 1 from ${calls} where ${calls.tokenId} = ${tokens.id} and ${calls.groupId} = ${groupId})`,
          sql`exists (select 1 from ${watches} where ${watches.tokenId} = ${tokens.id} and ${watches.groupId} = ${groupId} and ${watches.active})`,
        ),
      ),
    )
    .limit(1);
  const relevant = found.length > 0;
  if (relevance.size >= RELEVANCE_MAX_ENTRIES) pruneRelevance(now);
  relevance.set(key, { relevant, at: now });
  return relevant;
}

/**
 * One multiplexed stream per open board. The client treats any 'update' as
 * "refetch the board" — no per-event patching — so the payload is only there
 * for debugging and future selective refresh.
 */
export function createSseRoutes(db: Db): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  app.get('/api/g/:slug/events', (c) => {
    const group = c.get('group');
    return streamSSE(c, async (stream) => {
      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let unsubscribe: (() => void) | undefined;
      let onClosed: () => void = () => {};
      const finished = new Promise<void>((resolve) => {
        onClosed = resolve;
      });

      function close(): void {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe?.();
        onClosed();
      }

      // subscribe() fires synchronously and writes are async: chain them so two
      // events can never interleave halfway through an SSE frame.
      let queue: Promise<void> = Promise.resolve();
      function enqueue(write: () => Promise<unknown>): void {
        queue = queue.then(async () => {
          if (closed) return;
          await write();
        });
        // A dead client makes every write throw; stop the stream instead of
        // looping on the failure.
        queue = queue.catch(() => close());
      }

      heartbeat = setInterval(() => enqueue(() => stream.write(': ping\n\n')), HEARTBEAT_MS);

      unsubscribe = subscribe((event: GroupieEvent) => {
        if (closed) return;
        const decision = relevanceOf(event, group.id);
        if (decision === 'skip') return;
        enqueue(async () => {
          // Force a fresh lookup (and re-cache) for this group only: a positive
          // written here would mark the token relevant for every group with an
          // open stream.
          if (changesRelevance(event)) relevance.delete(`${group.id}:${event.tokenId}`);
          if (decision === 'ask' && !(await isGroupToken(db, group.id, event.tokenId))) return;
          await stream.writeSSE({ event: 'update', data: JSON.stringify(event) });
        });
      });

      stream.onAbort(close);
      // onAbort never fires for an abort that already happened, so a client
      // that hung up during setup would otherwise leak the interval.
      if (stream.aborted || stream.closed) close();
      // Flushes headers immediately, so the client's EventSource opens even
      // when nothing has happened in the group yet.
      await stream.write(': connected\n\n').catch(() => close());
      await finished;
    });
  });

  return app;
}
