import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { calls, mentions, tokens, type Db, type DbLike } from '@groupie/db';
import { extractEvmAddresses, ROBINHOOD_CHAIN_ID, THRESHOLDS } from '@groupie/shared';

export interface IngestInput {
  /** Internal groups.id (NOT the Telegram chat id). */
  groupId: number;
  messageId: number;
  userId: number;
  userName: string;
  at: Date;
  /** Message text, caption, and any entity URLs (text_link etc.). */
  texts: Array<string | undefined>;
}

export interface IngestEntry {
  address: string;
  tokenId: number;
  isNew: boolean;
  /** Repost hit a died call — the caller should trigger an immediate re-poll. */
  wasDied: boolean;
  /** Repost un-binned the call — re-poll too, the token may have died meanwhile. */
  wasBinned: boolean;
  /** Repost cancelled rug probation — re-poll, the card is back in view. */
  wasHidden: boolean;
  /**
   * The sighting was recorded but changed nothing else (docs/decisions.md
   * round 6 item 5a): a re-mention of a coin already under the inert floor is
   * someone pointing at the corpse, not renewed attention. Callers must not
   * trigger an immediate poll for it.
   */
  inert: boolean;
}

export interface IngestResult {
  entries: IngestEntry[];
  newCalls: string[];
  reposts: string[];
  failures: string[];
}

/**
 * Core M1 pipeline: turn one group message into calls/mentions.
 * First sighting of a CA in a group creates the call; every later sighting is
 * a mention that bumps activity. Reposts un-bin binned calls and flag died
 * calls for a revive re-poll (consumed by the M2 poller).
 *
 * Idempotent under Telegram's at-least-once update redelivery: each address
 * commits atomically, and the unique (call_id, message_id) on mentions makes a
 * replayed update a no-op.
 */
export async function ingestMessage(db: Db, input: IngestInput): Promise<IngestResult> {
  const addresses = extractEvmAddresses(...input.texts);
  const result: IngestResult = { entries: [], newCalls: [], reposts: [], failures: [] };

  for (const address of addresses) {
    try {
      const entry = await db.transaction(async (tx) => {
        const token = await upsertToken(tx, address);
        const outcome = await recordCallOrMention(tx, token, input);
        return { address, tokenId: token.id, ...outcome };
      });
      result.entries.push(entry);
      (entry.isNew ? result.newCalls : result.reposts).push(address);
    } catch (err) {
      // One bad address must not drop the remaining CAs in the same message.
      console.error(`ingest failed for ${address} in group ${input.groupId}:`, err);
      result.failures.push(address);
    }
  }
  return result;
}

/** What the caller needs about the token a sighting landed on. */
export interface UpsertedToken {
  id: number;
  symbol: string | null;
  /** Cached market cap — the inert-remention test reads it (round 6 item 5a). */
  mcapUsd: number | null;
}

/**
 * Find-or-create the token row for an address. Exported because a watch is the
 * other way a token enters the system (`/groupie watch <ca>` on a coin nobody
 * has called yet) and must go through exactly this path.
 */
export async function upsertToken(tx: DbLike, address: string): Promise<UpsertedToken> {
  const inserted = await tx
    .insert(tokens)
    .values({ chainId: ROBINHOOD_CHAIN_ID, address })
    .onConflictDoNothing()
    .returning({ id: tokens.id, symbol: tokens.symbol, mcapUsd: tokens.mcapUsd });
  if (inserted[0]) return inserted[0];

  const existing = await tx
    .select({ id: tokens.id, symbol: tokens.symbol, mcapUsd: tokens.mcapUsd })
    .from(tokens)
    .where(and(eq(tokens.chainId, ROBINHOOD_CHAIN_ID), eq(tokens.address, address)));
  if (!existing[0]) throw new Error(`token upsert failed for ${address}`);
  return existing[0];
}

/**
 * Is a RE-mention of this token inert (docs/decisions.md round 6 item 5a)?
 *
 * Members repost rugged CAs to show the chart or point at the corpse; treating
 * that as renewed attention resurfaces dead coins and cancels probation on the
 * exact tokens probation exists for. So a re-mention of a coin whose cached
 * mcap is already under the inert floor is recorded and nothing more.
 *
 * A null mcap is an unresolved token, not a cheap one: "we have never measured
 * it" is never evidence, here as everywhere else, so those behave normally.
 * First calls are never inert — the group has not seen that coin here yet.
 */
export function isInertRemention(cachedMcapUsd: number | null): boolean {
  return cachedMcapUsd !== null && cachedMcapUsd < THRESHOLDS.inertRementionMcapUsd;
}

/**
 * Renewed attention cancels rug probation (docs/decisions.md round 6): the card
 * goes straight back into view, and if the coin tanks again it starts a fresh
 * hide clock. Conditional so it reports whether it actually cancelled anything.
 *
 * reviving_at is deliberately left alone: a repost is not a comeback, so it
 * must not light up the Reviving spotlight.
 */
async function cancelProbation(tx: DbLike, tokenId: number): Promise<boolean> {
  const cleared = await tx
    .update(tokens)
    .set({ rugHiddenAt: null })
    .where(and(eq(tokens.id, tokenId), isNotNull(tokens.rugHiddenAt)))
    .returning({ id: tokens.id });
  return cleared.length > 0;
}

type MentionOutcome = Omit<IngestEntry, 'address' | 'tokenId'>;

/** Records the sighting; reports whether it was a new call and its prior status. */
async function recordCallOrMention(
  tx: DbLike,
  token: UpsertedToken,
  input: IngestInput,
): Promise<MentionOutcome> {
  const insertedCall = await tx
    .insert(calls)
    .values({
      groupId: input.groupId,
      tokenId: token.id,
      callerUserId: input.userId,
      callerName: input.userName,
      messageId: input.messageId,
      calledAt: input.at,
      lastMentionAt: input.at,
    })
    .onConflictDoNothing({ target: [calls.groupId, calls.tokenId] })
    .returning({ id: calls.id });

  if (insertedCall[0]) {
    // First call: record the founding mention too, so mentions is complete.
    await tx
      .insert(mentions)
      .values({
        callId: insertedCall[0].id,
        userId: input.userId,
        userName: input.userName,
        messageId: input.messageId,
        at: input.at,
      })
      .onConflictDoNothing({ target: [mentions.callId, mentions.messageId] });
    // A first call in THIS group can still land on a token another group hid,
    // and a board must never open on a card that is invisible by construction.
    const wasHidden = await cancelProbation(tx, token.id);
    return { isNew: true, wasDied: false, wasBinned: false, wasHidden, inert: false };
  }

  // Repost (or a redelivered update for an existing call).
  const existing = await tx
    .select({ id: calls.id, status: calls.status })
    .from(calls)
    .where(and(eq(calls.groupId, input.groupId), eq(calls.tokenId, token.id)));
  const call = existing[0];
  if (!call) {
    throw new Error(`call lookup failed for token ${token.id} in group ${input.groupId}`);
  }

  const insertedMention = await tx
    .insert(mentions)
    .values({
      callId: call.id,
      userId: input.userId,
      userName: input.userName,
      messageId: input.messageId,
      at: input.at,
    })
    .onConflictDoNothing({ target: [mentions.callId, mentions.messageId] })
    .returning({ id: mentions.id });

  // Conflict means this exact sighting was already processed (redelivery):
  // skip all count/status mutations so replay is a no-op.
  if (!insertedMention[0]) {
    return { isNew: false, wasDied: false, wasBinned: false, wasHidden: false, inert: false };
  }

  // An inert re-mention still counts as history — who said what, and how often
  // — it just does not move the card, the status, or probation.
  if (isInertRemention(token.mcapUsd)) {
    await tx
      .update(calls)
      .set({ mentionsCount: sql`${calls.mentionsCount} + 1` })
      .where(eq(calls.id, call.id));
    return { isNew: false, wasDied: false, wasBinned: false, wasHidden: false, inert: true };
  }

  // Status transitions evaluate in SQL against the current row, so concurrent
  // writers (M2 poller, M3 web bin actions) are never clobbered by a stale read.
  await tx
    .update(calls)
    .set({
      mentionsCount: sql`${calls.mentionsCount} + 1`,
      // NOTE: a bare Date in a raw sql template is NOT encoded by the
      // postgres-js driver and crashes at bind time — keep the ISO string + cast.
      lastMentionAt: sql`greatest(${calls.lastMentionAt}, ${input.at.toISOString()}::timestamptz)`,
      // Renewed attention un-bins for the whole group (decisions.md round 2).
      status: sql`case when ${calls.status} = 'binned' then 'active' else ${calls.status} end`,
      binnedBy: sql`case when ${calls.status} = 'binned' then null else ${calls.binnedBy} end`,
      binnedAt: sql`case when ${calls.status} = 'binned' then null else ${calls.binnedAt} end`,
      // Died calls get an immediate re-poll; M2 decides if it's a revival.
      reviveRequested: sql`${calls.reviveRequested} or ${calls.status} = 'died'`,
    })
    .where(eq(calls.id, call.id));

  const wasHidden = await cancelProbation(tx, token.id);
  return {
    isNew: false,
    wasDied: call.status === 'died',
    wasBinned: call.status === 'binned',
    wasHidden,
    inert: false,
  };
}
