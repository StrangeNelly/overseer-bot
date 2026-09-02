import { and, desc, eq, sql } from 'drizzle-orm';
import { calls, tokens, type Db } from '@groupie/db';
import {
  extractEvmAddresses,
  isMemberDeath,
  MEMBER_DEATH_REASON,
  ROBINHOOD_CHAIN_ID,
  UNNAMED_MEMBER,
  type CallStatus,
} from '@groupie/shared';
import { publish } from './events.js';
import { removeWatch } from './watchlist.js';

/**
 * The MEMBER VERDICT (docs/decisions.md round 21), in one place.
 *
 * Two surfaces reach it — MARK DEAD / RESTORE on the board and
 * `/overseer dead|undead` in the chat — and they must agree about what dies
 * (the CALL, never the token), who may do it (any member, group-wide, exactly
 * the standing binning has), what it costs (the group's watch slot on the coin)
 * and what it takes back. So neither writes to `calls` directly; both call
 * these, the way both watch surfaces call watchlist.ts.
 *
 * Why it exists at all: $VLR is 0.4x on an intact $19K pool, and no rule in
 * THRESHOLDS can see that as death — the coin was DUMPED, and the residual
 * holders keep the market cap standing. Round 21 gives the group the verdict
 * the rules cannot reach, and (in flatline.ts) a rule for the shape it just
 * learned to recognise.
 */

/** Enough of a call to act on it and to name the coin in a one-line reply. */
export interface GroupCallRef {
  callId: number;
  tokenId: number;
  address: string;
  symbol: string | null;
  status: CallStatus;
  deathReason: string | null;
}

/**
 * The group's call for a `<symbol|CA>` argument, or undefined.
 *
 * An address is matched exactly (lowercased, chain-scoped, like every other
 * address lookup); anything else is treated as a symbol and matched
 * case-insensitively, with a leading `$` stripped because that is how the chat
 * writes them. Newest activity wins when a group has called two coins that
 * share a ticker — symbols are not unique on this chain, and the one the member
 * just watched dump is the one they mean.
 *
 * Group-scoped by construction: a member can only ever name their own group's
 * calls, so this cannot become an existence oracle over another group's coins.
 */
export async function findGroupCall(
  db: Db,
  groupId: number,
  query: string,
): Promise<GroupCallRef | undefined> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return undefined;
  const address = extractEvmAddresses(trimmed)[0];
  const symbol = trimmed.replace(/^\$+/, '');
  if (address === undefined && symbol.length === 0) return undefined;

  const rows = await db
    .select({
      callId: calls.id,
      tokenId: calls.tokenId,
      address: tokens.address,
      symbol: tokens.symbol,
      status: calls.status,
      deathReason: calls.deathReason,
    })
    .from(calls)
    .innerJoin(tokens, eq(tokens.id, calls.tokenId))
    .where(
      and(
        eq(calls.groupId, groupId),
        eq(tokens.chainId, ROBINHOOD_CHAIN_ID),
        address === undefined
          ? sql`lower(${tokens.symbol}) = lower(${symbol})`
          : eq(tokens.address, address),
      ),
    )
    .orderBy(desc(calls.lastMentionAt))
    .limit(1);
  return rows[0];
}

export type MarkDeadResult = 'marked' | 'not_live' | 'not_found';
export type RestoreResult = 'restored' | 'not_member_death' | 'token_dead' | 'not_found';

/**
 * Mark ONE live call dead on a member's say-so.
 *
 * `markedBy` is the marker's display name as the bot would print it, resolved
 * by the caller (membership.memberDisplayName) and stamped into the row rather
 * than looked up later: names change, and the card is a record of who said this
 * at the time. A member we cannot name is stamped UNNAMED_MEMBER — never null,
 * because null on this column is what tells the board a RULE killed the call.
 *
 * The status check and the write are one guarded statement, so two members
 * pressing at once cannot double-stamp (and drift died_at), and a call that
 * died of a rule a second earlier is a 'not_live' rather than an overwrite of
 * the rule's own record.
 *
 * mcap-at-death is read from the token's OWN column inside the statement, the
 * same convention markTokenDead follows: it is the freshest reading the poller
 * cached, and a subquery cannot be raced by the caller's stale in-memory row.
 */
export async function markCallDead(
  db: Db,
  groupId: number,
  callId: number,
  markedBy: string | null,
): Promise<MarkDeadResult> {
  const marked = await db
    .update(calls)
    .set({
      status: 'died',
      diedAt: new Date(),
      deathReason: MEMBER_DEATH_REASON,
      deathMarkedBy: markedBy && markedBy.trim().length > 0 ? markedBy.trim() : UNNAMED_MEMBER,
      mcapAtDeath: sql`(select ${tokens.mcapUsd} from ${tokens} where ${tokens.id} = ${calls.tokenId})`,
    })
    .where(and(eq(calls.id, callId), eq(calls.groupId, groupId), eq(calls.status, 'active')))
    .returning({ id: calls.id, tokenId: calls.tokenId });

  const row = marked[0];
  if (!row) {
    const existing = (
      await db
        .select({ status: calls.status })
        .from(calls)
        .where(and(eq(calls.id, callId), eq(calls.groupId, groupId)))
    )[0];
    return existing ? 'not_live' : 'not_found';
  }

  // The group's watch slot goes back (docs/decisions.md round 21). Not
  // releaseWatches: that hands back EVERY group's slots because the token
  // itself died, and here the token is alive and well — only this group has
  // finished with it. removeWatch is group-scoped and publishes watch_changed
  // itself, so the ON WATCH zone empties the slot on every open board.
  await removeWatch(db, groupId, row.tokenId);
  publish({ type: 'call_marked_dead', tokenId: row.tokenId, callId: row.id, groupId });
  return 'marked';
}

/**
 * Undo a member verdict: the call goes back to live, and the whole death record
 * is erased.
 *
 * Erased rather than kept, which is the opposite of every RULE death (those
 * keep died_at/death_reason as last-death history). The reason is the exemption
 * this feature turns on: a call carrying `death_reason = 'member'` is skipped by
 * every automatic revival, so leaving the reason behind on a restored call
 * would quietly opt it out of the machinery for ever.
 *
 * Guarded on BOTH the reason and the status: only a member verdict may be
 * undone this way (a rule death is not a member's to reverse), and a call
 * binned after the verdict stays binned — binning is its own decision, taken
 * later, and `/overseer undead` is not an un-bin.
 *
 * ...and on the TOKEN still being alive (round 21 amendment d): a coin that a
 * rule has killed since the verdict has nothing left for the call to be
 * restored TO, and a call flipped back to 'active' over a dead token would show
 * as live on every board until the daily dead poll swept it up again. The
 * EXISTS is inside the same statement so the check cannot be raced by the poll
 * that kills it.
 */
export async function restoreCall(
  db: Db,
  groupId: number,
  callId: number,
): Promise<RestoreResult> {
  const restored = await db
    .update(calls)
    .set({
      status: 'active',
      diedAt: null,
      deathReason: null,
      mcapAtDeath: null,
      deathMarkedBy: null,
    })
    .where(
      and(
        eq(calls.id, callId),
        eq(calls.groupId, groupId),
        eq(calls.status, 'died'),
        eq(calls.deathReason, MEMBER_DEATH_REASON),
        sql`exists (select 1 from ${tokens} where ${tokens.id} = ${calls.tokenId} and ${tokens.phase} <> 'dead')`,
      ),
    )
    .returning({ id: calls.id, tokenId: calls.tokenId });

  const row = restored[0];
  if (!row) {
    const existing = (
      await db
        .select({ id: calls.id, status: calls.status, deathReason: calls.deathReason, phase: tokens.phase })
        .from(calls)
        .innerJoin(tokens, eq(tokens.id, calls.tokenId))
        .where(and(eq(calls.id, callId), eq(calls.groupId, groupId)))
    )[0];
    if (!existing) return 'not_found';
    // The verdict is intact and only the coin is gone: a different refusal, and
    // a different sentence — "not a member death" would be a lie about it.
    return isMemberDeadCall(existing) && existing.phase === 'dead' ? 'token_dead' : 'not_member_death';
  }
  publish({ type: 'call_restored', tokenId: row.tokenId, callId: row.id, groupId });
  return 'restored';
}

/**
 * The guard every automatic revival adds to its `calls` update (round 21): a
 * member verdict is never undone by a rule.
 *
 * Written as an explicit NULL branch because SQL's `<>` answers NULL for the
 * rule deaths that predate per-call reasons — `ne()` alone would quietly stop
 * reviving every one of them.
 */
export const notMemberDeath = sql`(${calls.deathReason} is null or ${calls.deathReason} <> ${MEMBER_DEATH_REASON})`;

/** The same rule for a row already in hand. */
export function isMemberDeadCall(row: { status: CallStatus; deathReason: string | null }): boolean {
  return row.status === 'died' && isMemberDeath(row.deathReason);
}
