import { and, eq, ne } from 'drizzle-orm';
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
      revivedAt: null,
      lastPolledAt: now,
    })
    .where(and(eq(tokens.id, token.id), ne(tokens.phase, 'dead')))
    .returning({ id: tokens.id });
  if (!transitioned[0]) return;
  // Copy the token's death onto its calls so call-level info is always the
  // authoritative answer to "when/why did this card die".
  await db
    .update(calls)
    .set({ status: 'died', diedAt: now, deathReason: reason })
    .where(and(eq(calls.tokenId, token.id), eq(calls.status, 'active')));
  publish({ type: 'token_died', tokenId: token.id, reason });
  console.log(`token ${token.address} died: ${reason}`);
}
