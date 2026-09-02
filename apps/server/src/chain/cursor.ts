import { eq, sql } from 'drizzle-orm';
import { chainCursor, type Db } from '@groupie/db';
import { DISCOVERY, ROBINHOOD_SLUG } from '@groupie/shared';

/**
 * How far the listener has read, and what it should read next.
 *
 * The whole point of the cursor is that a restart is boring: it resumes where
 * it stopped, it never replays history, and it never spends an unbounded
 * backfill catching up to a stream nobody can act on any more. Those three are
 * one pure function (`planRange`) so they can be tested without a chain.
 */

/** The cursor row's id — one chain, one row, named after the network. */
export const CURSOR_ID = ROBINHOOD_SLUG;

/** Blocks in DISCOVERY.backfillMaxHours of chain. */
export const MAX_BACKFILL_BLOCKS = Math.round(
  DISCOVERY.backfillMaxHours * 3_600 * DISCOVERY.blocksPerSecond,
);

/** The most blocks one tick will process, across all its ranges. */
export const MAX_BLOCKS_PER_TICK = DISCOVERY.maxBlocksPerRequest * DISCOVERY.maxRangesPerTick;

export interface RangePlan {
  fromBlock: number;
  toBlock: number;
  /**
   * Blocks the backfill bound skipped over — always 0 in steady state. Non-zero
   * means the process was down longer than DISCOVERY.backfillMaxHours and those
   * launches will never be seen. Worth a log line, never worth a stall.
   */
  skippedBlocks: number;
  /** True when the head is further ahead than one tick can cover. */
  behind: boolean;
}

/**
 * The block range this tick should read, or null when there is nothing to do.
 *
 * A null cursor means "first ever tick": start AT the head. Reading history on
 * a fresh install would post launches that happened before the feature existed.
 *
 * The range STOPS SHORT of the head by DISCOVERY.headLagBlocks. A block at the
 * tip can still be re-orged away, and the cursor is written to the block
 * actually read — so without the lag a tick could record a launch out of an
 * orphaned block and then never re-read the block that replaced it.
 */
export function planRange(cursorBlock: number | null, headBlock: number): RangePlan | null {
  if (!Number.isFinite(headBlock) || headBlock <= 0) return null;
  if (cursorBlock === null || !Number.isFinite(cursorBlock)) return null;
  const safeHead = headBlock - DISCOVERY.headLagBlocks;
  if (safeHead <= 0) return null;
  if (cursorBlock >= safeHead) return null;
  const earliest = Math.max(1, safeHead - MAX_BACKFILL_BLOCKS);
  const wanted = cursorBlock + 1;
  const fromBlock = Math.max(wanted, earliest);
  const toBlock = Math.min(safeHead, fromBlock + MAX_BLOCKS_PER_TICK - 1);
  return {
    fromBlock,
    toBlock,
    skippedBlocks: Math.max(0, fromBlock - wanted),
    behind: toBlock < safeHead,
  };
}

/** A plan split into provider-sized ranges, in order (see requestBlocksFor). */
export function splitRanges(
  plan: RangePlan,
  requestBlocks: number = DISCOVERY.maxBlocksPerRequest,
): Array<{ fromBlock: number; toBlock: number }> {
  const out: Array<{ fromBlock: number; toBlock: number }> = [];
  const step = Math.max(1, Math.min(DISCOVERY.maxBlocksPerRequest, Math.floor(requestBlocks)));
  for (let from = plan.fromBlock; from <= plan.toBlock; from += step) {
    out.push({
      fromBlock: from,
      toBlock: Math.min(plan.toBlock, from + step - 1),
    });
  }
  return out;
}

/**
 * How many blocks one request may span on THIS provider: the configured
 * ceiling, or — once the client has learned a smaller per-query cap from a
 * refusal — the most that cap allows within one query's chunk budget. A
 * request sized any larger would be refused whole, tick after tick, and the
 * cursor behind it would never move again.
 */
export function requestBlocksFor(learnedMaxLogRange: number | null | undefined): number {
  if (learnedMaxLogRange === null || learnedMaxLogRange === undefined) {
    return DISCOVERY.maxBlocksPerRequest;
  }
  return Math.max(
    1,
    Math.min(DISCOVERY.maxBlocksPerRequest, learnedMaxLogRange * DISCOVERY.maxLogChunksPerQuery),
  );
}

/** The stored cursor, or null when this deployment has never read a block. */
export async function readCursor(db: Db): Promise<number | null> {
  const rows = await db
    .select({ lastBlock: chainCursor.lastBlock })
    .from(chainCursor)
    .where(eq(chainCursor.id, CURSOR_ID));
  const value = rows[0]?.lastBlock;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Move the cursor forward. Guarded so the BLOCK can only ever advance: two
 * overlapping ticks (a slow one and the next) must not rewind the stream and
 * re-post launches that were already delivered.
 *
 * `updated_at` is NOT guarded the same way — it is the listener's heartbeat, and
 * it is stamped on every successful tick even when the block did not move (a
 * quiet chain, or a tick the head lag left nothing to read). That is what lets
 * the board tell "no launches happened" apart from "nobody has read a block in
 * two hours", which is the difference between a quiet feed and a dead one.
 */
export async function writeCursor(db: Db, lastBlock: number): Promise<void> {
  await db
    .insert(chainCursor)
    .values({ id: CURSOR_ID, lastBlock, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: chainCursor.id,
      set: {
        lastBlock: sql`greatest(${chainCursor.lastBlock}, ${lastBlock})`,
        updatedAt: new Date(),
      },
    });
}

/**
 * Stamp the heartbeat without touching the block — for a tick that read a range
 * of nothing, or one the head lag left with no range at all. `greatest` keeps
 * the stored block wherever it was.
 */
export async function touchCursor(db: Db): Promise<void> {
  await db
    .update(chainCursor)
    .set({ updatedAt: new Date() })
    .where(eq(chainCursor.id, CURSOR_ID));
}

/**
 * When the listener last completed a tick, or null before the first one — what
 * `DiscoveryResponse.lastTickAt` serves so a client can print a STALLED feed
 * rather than an empty one.
 */
export async function readLastTickAt(db: Db): Promise<Date | null> {
  const rows = await db
    .select({ updatedAt: chainCursor.updatedAt })
    .from(chainCursor)
    .where(eq(chainCursor.id, CURSOR_ID));
  const value = rows[0]?.updatedAt;
  return value instanceof Date ? value : null;
}
