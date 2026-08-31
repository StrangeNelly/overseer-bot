import { and, eq, sql } from 'drizzle-orm';
import { calls, mentions, tokens, type Db, type DbLike } from '@groupie/db';
import { extractEvmAddresses, ROBINHOOD_CHAIN_ID } from '@groupie/shared';

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
        const outcome = await recordCallOrMention(tx, token.id, input);
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

async function upsertToken(tx: DbLike, address: string) {
  const inserted = await tx
    .insert(tokens)
    .values({ chainId: ROBINHOOD_CHAIN_ID, address })
    .onConflictDoNothing()
    .returning({ id: tokens.id });
  if (inserted[0]) return inserted[0];

  const existing = await tx
    .select({ id: tokens.id })
    .from(tokens)
    .where(and(eq(tokens.chainId, ROBINHOOD_CHAIN_ID), eq(tokens.address, address)));
  if (!existing[0]) throw new Error(`token upsert failed for ${address}`);
  return existing[0];
}

/** Records the sighting; reports whether it was a new call and its prior status. */
async function recordCallOrMention(
  tx: DbLike,
  tokenId: number,
  input: IngestInput,
): Promise<{ isNew: boolean; wasDied: boolean; wasBinned: boolean }> {
  const insertedCall = await tx
    .insert(calls)
    .values({
      groupId: input.groupId,
      tokenId,
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
    return { isNew: true, wasDied: false, wasBinned: false };
  }

  // Repost (or a redelivered update for an existing call).
  const existing = await tx
    .select({ id: calls.id, status: calls.status })
    .from(calls)
    .where(and(eq(calls.groupId, input.groupId), eq(calls.tokenId, tokenId)));
  const call = existing[0];
  if (!call) throw new Error(`call lookup failed for token ${tokenId} in group ${input.groupId}`);

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
  if (!insertedMention[0]) return { isNew: false, wasDied: false, wasBinned: false };

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

  return { isNew: false, wasDied: call.status === 'died', wasBinned: call.status === 'binned' };
}
