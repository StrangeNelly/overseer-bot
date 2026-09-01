import { and, eq, ne, sql } from 'drizzle-orm';
import { calls, tokens, type Db } from '@groupie/db';
import { publish } from '../events.js';
import type { DeathReason } from './death.js';

type TokenRow = typeof tokens.$inferSelect;

/**
 * The single path that flips a token to dead. It lives in its own module rather
 * than in scheduler.ts because the rug sweep needs it too and scheduler.ts
 * imports the sweep — one owner, no import cycle.
 */
export async function markTokenDead(db: Db, token: TokenRow, reason: DeathReason): Promise<void> {
  const now = new Date();
  // Guarded so a stale candidate row can't re-kill a dead token: that would
  // drift diedAt and publish token_died twice.
  const transitioned = await db
    .update(tokens)
    .set({
      phase: 'dead',
      diedAt: now,
      deathReason: reason,
      // Round 15: the freshest cached mcap at the verdict, read from the
      // token's OWN column rather than the caller's in-memory row — SET
      // expressions see the OLD row. For poll-path deaths that is the reading
      // THIS poll just wrote (applySnapshot runs first). The rug-expiry sweep
      // runs on its own 10-min clock with no preceding write, so there the
      // value is up to a probation-tier interval (~30 min) older than diedAt —
      // still the last thing the market said before the verdict.
      mcapAtDeath: sql`${tokens.mcapUsd}`,
      revivedAt: null,
      lastPolledAt: now,
    })
    .where(and(eq(tokens.id, token.id), ne(tokens.phase, 'dead')))
    .returning({ id: tokens.id, mcapAtDeath: tokens.mcapAtDeath });
  const dead = transitioned[0];
  if (!dead) return;
  // Copy the token's death onto its calls so call-level info is always the
  // authoritative answer to "when/why did this card die". RETURNING gives the
  // NEW row, so the mcap copied here is exactly the one stamped above.
  await db
    .update(calls)
    .set({ status: 'died', diedAt: now, deathReason: reason, mcapAtDeath: dead.mcapAtDeath })
    .where(and(eq(calls.tokenId, token.id), eq(calls.status, 'active')));
  publish({ type: 'token_died', tokenId: token.id, reason });
  console.log(`token ${token.address} died: ${reason}`);
}
