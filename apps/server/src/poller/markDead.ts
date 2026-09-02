import { and, eq, ne, sql } from 'drizzle-orm';
import { calls, tokens, watches, type Db } from '@groupie/db';
import { publish } from '../events.js';
import type { DeathReason } from './death.js';

type TokenRow = typeof tokens.$inferSelect;

export interface MarkDeadOpts {
  /**
   * Kill the row only while it is still in this phase — the state the verdict
   * was actually reached on. The wrong-chain death needs it: its evidence is
   * "nothing on this chain has ever heard of the address", which a concurrent
   * poll can have disproved between the candidate load and the verdict.
   */
  requirePhase?: TokenRow['phase'];
}

/**
 * The single path that flips a token to dead. It lives in its own module rather
 * than in scheduler.ts because the rug sweep needs it too and scheduler.ts
 * imports the sweep — one owner, no import cycle.
 *
 * Returns whether THIS call was the one that killed it, so a caller whose
 * follow-up work must happen exactly once (releasing watch slots, logging the
 * verdict) can tell a transition from a no-op.
 */
export async function markTokenDead(
  db: Db,
  token: TokenRow,
  reason: DeathReason,
  opts: MarkDeadOpts = {},
): Promise<boolean> {
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
      // Round 21: a death ends the flatline clock, whatever killed the token.
      // Leaving it set would hand a revived coin a six-hour head start on its
      // next flatline verdict — a clock measured across a period in which it
      // was not even being polled for a tape. The coverage counters go with it:
      // they only ever describe the run the clock was timing.
      flatSince: null,
      flatReadings: 0,
      flatLastAt: null,
      lastPolledAt: now,
    })
    .where(
      and(
        eq(tokens.id, token.id),
        ne(tokens.phase, 'dead'),
        ...(opts.requirePhase ? [eq(tokens.phase, opts.requirePhase)] : []),
      ),
    )
    .returning({ id: tokens.id, mcapAtDeath: tokens.mcapAtDeath });
  const dead = transitioned[0];
  if (!dead) return false;
  // Copy the token's death onto its calls so call-level info is always the
  // authoritative answer to "when/why did this card die". RETURNING gives the
  // NEW row, so the mcap copied here is exactly the one stamped above.
  await db
    .update(calls)
    .set({ status: 'died', diedAt: now, deathReason: reason, mcapAtDeath: dead.mcapAtDeath })
    .where(and(eq(calls.tokenId, token.id), eq(calls.status, 'active')));
  publish({ type: 'token_died', tokenId: token.id, reason });
  console.log(`token ${token.address} died: ${reason}`);
  return true;
}

/**
 * Hand back the watch slots a PERMANENT death holds (round 15 review, extended
 * to wrong-chain deaths in the round 17b review).
 *
 * The alert engine skips dead-phase tokens, so these watches can never fire
 * again — but they would still count against their adders' 3-slot cap, and for
 * a death with no comeback path there is no card left to unwatch them from.
 * Every group's watch goes: the death is a fact about the token, not about one
 * group. A member who believes in a comeback can re-watch after a revival.
 *
 * Only for deaths that cannot reverse: an ordinary corpse is revival-polled, so
 * its watches must survive to fire when it comes back.
 *
 * RETURNING is the affected-group list, so the events published are exactly the
 * watches this statement deactivated.
 */
export async function releaseWatches(db: Db, tokenId: number): Promise<void> {
  const released = await db
    .update(watches)
    .set({ active: false })
    .where(and(eq(watches.tokenId, tokenId), eq(watches.active, true)))
    .returning({ groupId: watches.groupId });
  for (const groupId of new Set(released.map((w) => w.groupId))) {
    publish({ type: 'watch_changed', tokenId, groupId });
  }
}
