import { and, eq, gte, inArray, isNotNull, lt, ne, or, sql } from 'drizzle-orm';
import { calls, snapshots, tokens, type Db } from '@groupie/db';
import { THRESHOLDS } from '@groupie/shared';
import { publish } from '../events.js';
import { markTokenDead } from './markDead.js';
import { isSustainedRug, RUG_BUCKET_MS, type RugBucket } from './rugLogic.js';

/**
 * Rug auto-removal sweep (docs/decisions.md round 5). A token whose mcap has
 * been below the rug floor continuously for 6h+ is removed from every board
 * view: marked dead (reason 'rug_floor') and system-binned.
 *
 * Removal is a BIN, not a delete: a repost un-bins the call (round 2's
 * renewed-attention rule), so an auto-removal is always recoverable, and a
 * later storage purge can hard-delete long-binned rows.
 */

type TokenRow = typeof tokens.$inferSelect;

/**
 * An hour of margin: bucket starts are floored to 5 minutes, so a window of
 * exactly 6h would leave the span test landing either side of its own boundary
 * by chance (same reasoning as range.ts's LOOKBACK_HOURS).
 */
const LOOKBACK_HOURS = THRESHOLDS.rugFloorHours + 1;

/** A bind param here would leave Postgres guessing the divisor's type. */
const BUCKET_SECONDS = sql.raw(String(RUG_BUCKET_MS / 1000));

// db.execute bypasses Drizzle's column decoders, so postgres-js hands these
// back as strings (bigint, double precision) — coerce at the read site.
type BucketRow = {
  token_id: number | string;
  bucket: number | string;
  max_mcap: number | string | null;
} & Record<string, unknown>;

/**
 * Cheap prefilter, so only plausible rugs pay for a series query: the cached
 * mcap already says the token is under the floor right now.
 *
 * Phase is deliberately NOT a filter — a curve token drifting at $3k that never
 * armed the curve floor is exactly the target, and graduated/unresolved tokens
 * rug too. The one exclusion is a token already fully swept: dead AND with
 * every call binned, which nothing here would change.
 */
async function loadCandidates(db: Db): Promise<TokenRow[]> {
  return db
    .select()
    .from(tokens)
    .where(
      and(
        isNotNull(tokens.mcapUsd),
        lt(tokens.mcapUsd, THRESHOLDS.rugFloorMcapUsd),
        or(
          ne(tokens.phase, 'dead'),
          // A correlated EXISTS, not a join: joining calls would multiply rows.
          sql`exists (select 1 from ${calls} where ${and(eq(calls.tokenId, tokens.id), ne(calls.status, 'binned'))})`,
        ),
      ),
    );
}

/**
 * One statement for every candidate: 5-minute mcap MAXIMA over the lookback
 * window, ascending per token. `max` is the whole point — one poll that peaked
 * above the floor proves life, and averaging could bury it — and it collapses
 * ~1,900 rows/token/24h down to at most 84 per token here.
 *
 * Grouped rather than alerts.ts's `distinct on`: that form exists there to keep
 * the peak row's timestamp, which a bucket max needs nothing of.
 */
async function loadBucketMaxima(
  db: Db,
  tokenIds: number[],
  sinceMs: number,
): Promise<Map<number, RugBucket[]>> {
  const byToken = new Map<number, RugBucket[]>();
  if (tokenIds.length === 0) return byToken;

  const rows = await db.execute<BucketRow>(sql`
    select ${snapshots.tokenId} as token_id,
           floor(extract(epoch from ${snapshots.at}) / ${BUCKET_SECONDS})::bigint as bucket,
           max(${snapshots.mcapUsd}) as max_mcap
    from ${snapshots}
    where ${and(
      inArray(snapshots.tokenId, tokenIds),
      gte(snapshots.at, new Date(sinceMs)),
      isNotNull(snapshots.mcapUsd),
    )}
    group by 1, 2
    order by 1, 2
  `);

  for (const row of rows) {
    if (row.max_mcap === null) continue;
    const maxMcapUsd = Number(row.max_mcap);
    const bucketStartMs = Number(row.bucket) * RUG_BUCKET_MS;
    const tokenId = Number(row.token_id);
    if (!Number.isFinite(maxMcapUsd) || !Number.isFinite(bucketStartMs)) continue;
    if (!Number.isFinite(tokenId)) continue;
    const list = byToken.get(tokenId) ?? [];
    list.push({ bucketStartMs, maxMcapUsd });
    byToken.set(tokenId, list);
  }
  return byToken;
}

/**
 * One sweep over every candidate. Returns how many tokens were rugged.
 *
 * Idempotent: markTokenDead is guarded against re-killing a dead token (so a
 * token that died of something else keeps its original death record), and the
 * bin only touches calls that are not binned yet — a second pass over the same
 * token writes nothing and publishes nothing.
 */
export async function runRugSweep(db: Db): Promise<number> {
  const candidates = await loadCandidates(db);
  if (candidates.length === 0) return 0;

  const nowMs = Date.now();
  const buckets = await loadBucketMaxima(
    db,
    candidates.map((t) => t.id),
    nowMs - LOOKBACK_HOURS * 3_600_000,
  );

  let rugged = 0;
  for (const token of candidates) {
    if (!isSustainedRug(buckets.get(token.id) ?? [], nowMs)) continue;

    await markTokenDead(db, token, 'rug_floor');
    // binned_by null = the system binned it, not a member (see schema.ts).
    // RETURNING is the affected-id list: selecting the ids first would race the
    // very update it feeds, and could publish a bin that never happened.
    const binned = await db
      .update(calls)
      .set({ status: 'binned', binnedAt: new Date(), binnedBy: null })
      .where(and(eq(calls.tokenId, token.id), ne(calls.status, 'binned')))
      .returning({ id: calls.id });
    // Group-wide effect, exactly like a member's bin: every open board refetches
    // instead of leaving the card up until some unrelated poll event.
    for (const call of binned) {
      publish({ type: 'call_binned', tokenId: token.id, callId: call.id });
    }

    rugged += 1;
    console.log(
      `rug swept ${token.symbol ?? token.address}: mcap $${Math.round(token.mcapUsd ?? 0).toLocaleString()} under $${THRESHOLDS.rugFloorMcapUsd.toLocaleString()} for ${THRESHOLDS.rugFloorHours}h+ (${binned.length} call(s) auto-binned)`,
    );
  }
  return rugged;
}
