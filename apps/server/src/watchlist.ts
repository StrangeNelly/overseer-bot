import { and, eq, sql } from 'drizzle-orm';
import { calls, tokens, watches, type Db, type DbLike } from '@groupie/db';
import { ROBINHOOD_CHAIN_ID, WATCH_CAP_PER_MEMBER } from '@groupie/shared';
import { publish } from './events.js';

/**
 * The alert watchlist, in one place (docs/decisions.md round 15).
 *
 * Two surfaces reach it — `/overseer watch` in the chat and the watch button on
 * a card — and they must agree about the cap, about who gets the credit, and
 * about what "already watched" means. So neither of them writes to `watches`
 * directly; both call these.
 *
 * Row semantics are round 4's, unchanged: a watch is the GROUP's opt-in to bot
 * messages about a coin, so there is at most one row per (group, token) and
 * un-watching leaves it behind as an inactive row (the history of who added
 * what). What round 15 adds is the per-member cap, counted by `added_by`.
 */

export type WatchOutcome =
  /** Now watched. `alreadyActive` = the group was already watching it. */
  | { ok: true; alreadyActive: boolean }
  /** Refused: this member already holds `cap` active watches in this group. */
  | { ok: false; reason: 'cap'; cap: number };

/**
 * How many active watches this member is holding in this group. Exported for
 * the bot's watchlist reply and for tests.
 */
export async function activeWatchCount(
  db: DbLike,
  groupId: number,
  userId: number,
): Promise<number> {
  const rows = await db
    .select({ n: sql<string | number>`count(*)` })
    .from(watches)
    .where(
      and(eq(watches.groupId, groupId), eq(watches.addedBy, userId), eq(watches.active, true)),
    );
  // count() comes back as a bigint, which postgres-js hands over as a string.
  const n = Number(rows[0]?.n ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Serialize one member's watch adds inside a group, so the cap cannot be raced
 * past by two clients (chat + board) pressing at the same moment. A transaction
 * advisory lock is the cheapest exact answer: it is taken on a key nobody else
 * uses, held to commit, and never touches a row.
 *
 * hashtext() is int4 and the two-argument lock form takes two int4s, so a
 * Telegram user id (bigint) has to be hashed rather than passed — a collision
 * between two DIFFERENT members would only ever mean one of them waits.
 */
const LOCK_NAMESPACE = sql.raw(String(0x0efb));

/**
 * Add (or re-activate) the group's watch on a token, enforcing the round-15
 * per-member cap.
 *
 * The cap only gates a watch that would actually consume a slot. Pressing watch
 * on a coin the group is ALREADY watching changes nothing at all — round 4's
 * conflict clause keeps the original credit and clock — so it is answered as a
 * success even when the presser is at their cap. Refusing there would be a lie
 * about the state of the board.
 */
export async function addWatch(
  db: Db,
  groupId: number,
  tokenId: number,
  userId: number,
  cap: number = WATCH_CAP_PER_MEMBER,
): Promise<WatchOutcome> {
  const outcome = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_NAMESPACE}, hashtext(${`${groupId}:${userId}`}))`);

    const existing = (
      await tx
        .select({ active: watches.active })
        .from(watches)
        .where(and(eq(watches.groupId, groupId), eq(watches.tokenId, tokenId)))
    )[0];
    if (existing?.active === true) return { ok: true, alreadyActive: true } as const;

    const held = await activeWatchCount(tx, groupId, userId);
    if (held >= cap) return { ok: false, reason: 'cap', cap } as const;

    await tx
      .insert(watches)
      .values({ groupId, tokenId, addedBy: userId })
      .onConflictDoUpdate({
        target: [watches.groupId, watches.tokenId],
        // SET expressions see the OLD row: credit and clock only move when the
        // watch was off, so re-watching an active coin changes nothing. The
        // lock is per MEMBER, so two different members can still race onto the
        // same token — this clause is what makes the loser's insert a no-op
        // that leaves the winner's credit and clock alone, rather than a
        // silent takeover.
        set: {
          active: true,
          addedBy: sql`case when ${watches.active} then ${watches.addedBy} else ${userId} end`,
          addedAt: sql`case when ${watches.active} then ${watches.addedAt} else now() end`,
        },
      });
    return { ok: true, alreadyActive: false } as const;
  });

  // Group-wide state, exactly like a bin: every other open board should show
  // the watch marker without waiting for an unrelated poll event.
  if (outcome.ok && !outcome.alreadyActive) publish({ type: 'watch_changed', tokenId, groupId });
  return outcome;
}

/**
 * Stop the group's watch on a token. Any member may do this, mirroring the
 * "any member can bin" precedent (docs/decisions.md round 2) — the watchlist is
 * the group's, not the adder's. Returns whether it actually stopped one.
 */
export async function removeWatch(db: Db, groupId: number, tokenId: number): Promise<boolean> {
  const stopped = await db
    .update(watches)
    .set({ active: false })
    .where(
      and(eq(watches.groupId, groupId), eq(watches.tokenId, tokenId), eq(watches.active, true)),
    )
    .returning({ id: watches.id });
  if (stopped[0]) publish({ type: 'watch_changed', tokenId, groupId });
  return stopped[0] !== undefined;
}

/** Whether this group is watching a token right now. */
export async function isWatched(db: Db, groupId: number, tokenId: number): Promise<boolean> {
  const rows = await db
    .select({ id: watches.id })
    .from(watches)
    .where(
      and(eq(watches.groupId, groupId), eq(watches.tokenId, tokenId), eq(watches.active, true)),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * The token an ADDRESS names, whatever group called it — or nothing, when we
 * have never seen the coin. Unscoped on purpose, and not the oracle
 * findGroupToken guards against: naming a contract address proves the caller
 * already knows the coin, which is why watching by address has always been
 * allowed for coins nobody here ever called.
 */
export async function findTokenByAddress(
  db: Db,
  address: string,
): Promise<{ id: number; symbol: string | null } | undefined> {
  const rows = await db
    .select({ id: tokens.id, symbol: tokens.symbol })
    .from(tokens)
    .where(and(eq(tokens.chainId, ROBINHOOD_CHAIN_ID), eq(tokens.address, address)))
    .limit(1);
  return rows[0];
}

/**
 * The token a watch action names, IF this group has a call for it — otherwise
 * undefined, indistinguishable from a token that does not exist at all.
 *
 * The scoping is deliberate (round 15 review): the watch button only renders
 * on the group's own cards, and a global id lookup would turn the 404/204
 * split into an existence oracle over every other group's token ids. Watching
 * an uncalled coin stays possible where it always was — `/overseer watch <ca>`
 * names it by address, which proves the caller already knows the coin.
 */
export async function findGroupToken(
  db: Db,
  groupId: number,
  tokenId: number,
): Promise<{ id: number; address: string; symbol: string | null } | undefined> {
  const rows = await db
    .select({ id: tokens.id, address: tokens.address, symbol: tokens.symbol })
    .from(tokens)
    .where(
      and(
        eq(tokens.id, tokenId),
        sql`exists (select 1 from ${calls} where ${calls.tokenId} = ${tokens.id} and ${calls.groupId} = ${groupId})`,
      ),
    )
    .limit(1);
  return rows[0];
}
