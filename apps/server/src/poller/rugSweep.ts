import { and, eq, gte, inArray, isNotNull, isNull, lt, max, ne, sql } from 'drizzle-orm';
import { calls, snapshots, tokens, type Db } from '@groupie/db';
import { THRESHOLDS } from '@groupie/shared';
import { publish } from '../events.js';
import { markTokenDead } from './markDead.js';
import {
  hideVerdict,
  isProbationExpired,
  RUG_BUCKET_MS,
  shouldRevive,
  type HideReason,
  type ReviveBucket,
  type RugBucket,
} from './rugLogic.js';

/**
 * The rug probation sweep (docs/decisions.md round 6, superseding round 5's
 * single 6h auto-removal). One pass runs three transitions in a fixed order:
 *
 *   hide    — under $8k for an hour, OR an hour at <= 10% of peak-since-call
 *             while under $30k (round 10's collapse rule): off every board
 *             section, onto probation;
 *   revive  — back over $30k and holding: into view with the Reviving badge;
 *   expire  — 24h of probation with no comeback: the permanent rug.
 *
 * Round 10 widened only the way IN: probation, its cadence, the revival bar and
 * the expiry are round 6's, untouched.
 *
 * Revival is judged BEFORE expiry on purpose: a token that qualifies for both
 * on the same boundary tick gets the comeback, not the grave.
 *
 * Expiry keeps round 5's mechanics exactly — marked dead (reason 'rug_floor')
 * and system-binned rather than deleted, so a repost un-bins the call (round
 * 2's renewed-attention rule) and a later purge can hard-delete long-binned
 * rows.
 */

type TokenRow = typeof tokens.$inferSelect;

/**
 * Margin on both lookbacks: bucket starts are floored to 5 minutes, so a window
 * of exactly the judged span would leave the span test landing either side of
 * its own boundary by chance (same reasoning as range.ts's LOOKBACK_HOURS). The
 * revival window gets a probation poll interval of it, since that is the
 * resolution its evidence arrives at.
 */
const HIDE_LOOKBACK_MS = THRESHOLDS.rugHideHours * 3_600_000 + 15 * 60_000;
const REVIVE_LOOKBACK_MS = THRESHOLDS.rugReviveHoldHours * 3_600_000 + 30 * 60_000;

/** A bind param here would leave Postgres guessing the divisor's type. */
const BUCKET_SECONDS = sql.raw(String(RUG_BUCKET_MS / 1000));

/** Which extreme a pass reads. A literal union, so sql.raw() sees no input. */
type Aggregate = 'max' | 'min';

// db.execute bypasses Drizzle's column decoders, so postgres-js hands these
// back as strings (bigint, double precision) — coerce at the read site.
type BucketRow = {
  token_id: number | string;
  bucket: number | string;
  mcap: number | string | null;
} & Record<string, unknown>;

interface Bucket {
  bucketStartMs: number;
  mcapUsd: number;
}

/**
 * Cheap prefilter, so only plausible rugs pay for a series query: the cached
 * mcap already says the token is under the widest bar either hide rule uses.
 *
 * That bar is round 10's $30k collapse ceiling rather than round 6's $8k floor,
 * because a collapsed token parks ABOVE the floor by definition. The extra
 * candidates it admits ($8k-$30k) are cheap — the peak lookup and hideVerdict
 * throw out everything that is merely small rather than collapsed.
 *
 * Phase is deliberately NOT a filter beyond 'dead' — a curve token drifting at
 * $3k is exactly the target, and graduated/unresolved tokens rug too. A dead
 * token is excluded because its death (liquidity_floor especially) is already
 * the final answer, and probation would only hide the corpse from the Died
 * section.
 */
async function loadHideCandidates(db: Db): Promise<TokenRow[]> {
  return db
    .select()
    .from(tokens)
    .where(
      and(
        isNull(tokens.rugHiddenAt),
        ne(tokens.phase, 'dead'),
        isNotNull(tokens.mcapUsd),
        lt(tokens.mcapUsd, THRESHOLDS.collapseCeilingUsd),
      ),
    );
}

/**
 * Highest peak-since-call per candidate token, in one grouped query — the
 * denominator of round 10's collapse rule.
 *
 * The MAX across a token's calls, not per call: probation is a token-level
 * state (the card leaves every section), so the collapse has to be judged
 * against the biggest run any caller actually saw. A token with no usable peak
 * is simply absent from the map, which leaves the collapse rule inert for it.
 */
async function loadPeaks(db: Db, tokenIds: number[]): Promise<Map<number, number>> {
  const peaks = new Map<number, number>();
  if (tokenIds.length === 0) return peaks;

  const rows = await db
    .select({ tokenId: calls.tokenId, peak: max(calls.peakMcapSinceCall) })
    .from(calls)
    .where(inArray(calls.tokenId, tokenIds))
    .groupBy(calls.tokenId);
  for (const row of rows) {
    const peak = Number(row.peak);
    if (!Number.isFinite(peak) || peak <= 0) continue;
    peaks.set(row.tokenId, peak);
  }
  return peaks;
}

/** Everything currently on probation — the input to both later passes. */
async function loadHiddenTokens(db: Db): Promise<TokenRow[]> {
  return db.select().from(tokens).where(isNotNull(tokens.rugHiddenAt));
}

/**
 * One statement for every candidate: 5-minute mcap extremes over the lookback
 * window, ascending per token.
 *
 * Which extreme is the whole point, and it differs per pass: a hide reads
 * MAXIMA (one poll that peaked above the floor proves life), a revival reads
 * MINIMA (one poll that dipped breaks the hold). Either way it collapses
 * ~1,900 rows/token/24h down to a few dozen per token here.
 *
 * Grouped rather than alerts.ts's `distinct on`: that form exists there to keep
 * the peak row's timestamp, which a bucket extreme needs nothing of.
 */
async function loadBuckets(
  db: Db,
  tokenIds: number[],
  sinceMs: number,
  aggregate: Aggregate,
): Promise<Map<number, Bucket[]>> {
  const byToken = new Map<number, Bucket[]>();
  if (tokenIds.length === 0) return byToken;

  const rows = await db.execute<BucketRow>(sql`
    select ${snapshots.tokenId} as token_id,
           floor(extract(epoch from ${snapshots.at}) / ${BUCKET_SECONDS})::bigint as bucket,
           ${sql.raw(aggregate)}(${snapshots.mcapUsd}) as mcap
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
    if (row.mcap === null) continue;
    const mcapUsd = Number(row.mcap);
    const bucketStartMs = Number(row.bucket) * RUG_BUCKET_MS;
    const tokenId = Number(row.token_id);
    if (!Number.isFinite(mcapUsd) || !Number.isFinite(bucketStartMs)) continue;
    if (!Number.isFinite(tokenId)) continue;
    const list = byToken.get(tokenId) ?? [];
    list.push({ bucketStartMs, mcapUsd });
    byToken.set(tokenId, list);
  }
  return byToken;
}

function label(token: TokenRow): string {
  return token.symbol ?? token.address;
}

function usd(value: number | null | undefined): string {
  return `$${Math.round(value ?? 0).toLocaleString()}`;
}

/** Why the sweep hid a token, in the words the log line needs. */
function hideNote(reason: HideReason, peakMcapUsd: number | null): string {
  if (reason === 'collapse') {
    const pct = Math.round(THRESHOLDS.collapseFromPeakRatio * 100);
    return `collapsed to <=${pct}% of its ${usd(peakMcapUsd)} peak (under ${usd(THRESHOLDS.collapseCeilingUsd)})`;
  }
  return `under ${usd(THRESHOLDS.rugFloorMcapUsd)}`;
}

/**
 * Hide everything that has sat under the floor — or, since round 10, collapsed
 * to a tenth of its peak under the ceiling — for the hide window. Nothing dies
 * here and no call is binned: the card simply leaves the board while we watch
 * it for a comeback.
 */
async function runHidePass(db: Db, nowMs: number): Promise<number> {
  const candidates = await loadHideCandidates(db);
  if (candidates.length === 0) return 0;

  const tokenIds = candidates.map((t) => t.id);
  const buckets = await loadBuckets(db, tokenIds, nowMs - HIDE_LOOKBACK_MS, 'max');
  const peaks = await loadPeaks(db, tokenIds);

  let hidden = 0;
  for (const token of candidates) {
    const maxima: RugBucket[] = (buckets.get(token.id) ?? []).map((b) => ({
      bucketStartMs: b.bucketStartMs,
      maxMcapUsd: b.mcapUsd,
    }));
    const peak = peaks.get(token.id) ?? null;
    const reason = hideVerdict(maxima, nowMs, peak);
    if (!reason) continue;

    // Guarded on the column this pass is claiming, so a repost that cancelled
    // probation a moment ago is never silently re-hidden by a stale candidate
    // row. A stale badge from an earlier comeback is cleared here: whatever
    // that revival was, it is over.
    const claimed = await db
      .update(tokens)
      .set({ rugHiddenAt: new Date(), revivingAt: null })
      .where(and(eq(tokens.id, token.id), isNull(tokens.rugHiddenAt)))
      .returning({ id: tokens.id });
    if (!claimed[0]) continue;

    hidden += 1;
    // Group-wide effect, exactly like a bin: the card vanishes from every open
    // board instead of lingering until some unrelated poll event.
    publish({ type: 'rug_hidden', tokenId: token.id });
    console.log(
      `rug probation: hid ${label(token)} — mcap ${usd(token.mcapUsd)} ${hideNote(reason, peak)} for ${THRESHOLDS.rugHideHours}h+`,
    );
  }
  return hidden;
}

/**
 * Bring back everything on probation that climbed over the revival mcap and
 * held it. A dead token is skipped: liquidity_floor means a drained pool, and a
 * drained pool cannot revive on mcap (docs/decisions.md round 6).
 */
async function runRevivePass(db: Db, hiddenTokens: TokenRow[], nowMs: number): Promise<number> {
  const candidates = hiddenTokens.filter((t) => t.phase !== 'dead');
  if (candidates.length === 0) return 0;

  const buckets = await loadBuckets(
    db,
    candidates.map((t) => t.id),
    nowMs - REVIVE_LOOKBACK_MS,
    'min',
  );

  let revived = 0;
  for (const token of candidates) {
    const minima: ReviveBucket[] = (buckets.get(token.id) ?? []).map((b) => ({
      bucketStartMs: b.bucketStartMs,
      minMcapUsd: b.mcapUsd,
    }));
    if (!shouldRevive(minima, nowMs)) continue;

    // Same guard as the hide pass: if a repost already cancelled probation the
    // card is back in view on its own merits and needs no comeback badge.
    const claimed = await db
      .update(tokens)
      .set({ rugHiddenAt: null, revivingAt: new Date() })
      .where(and(eq(tokens.id, token.id), isNotNull(tokens.rugHiddenAt)))
      .returning({ id: tokens.id });
    if (!claimed[0]) continue;

    revived += 1;
    publish({ type: 'rug_revived', tokenId: token.id });
    console.log(
      `rug probation: REVIVED ${label(token)} — held ${usd(THRESHOLDS.rugReviveMcapUsd)}+ for ${THRESHOLDS.rugReviveHoldHours}h`,
    );
  }
  return revived;
}

/**
 * Probation ran out: the permanent rug, on round 5's mechanics (dead +
 * system-binned, never deleted).
 *
 * Clearing rug_hidden_at is the CLAIM, taken first and conditionally: a repost
 * that cancelled probation between the load and here wins the race, and the
 * owner's renewed-attention rule says it should.
 */
async function runExpiryPass(db: Db, hiddenTokens: TokenRow[], nowMs: number): Promise<number> {
  let expired = 0;
  for (const token of hiddenTokens) {
    const hiddenAt = token.rugHiddenAt;
    if (!hiddenAt || !isProbationExpired(hiddenAt.getTime(), nowMs)) continue;

    const claimed = await db
      .update(tokens)
      .set({ rugHiddenAt: null })
      .where(and(eq(tokens.id, token.id), isNotNull(tokens.rugHiddenAt)))
      .returning({ id: tokens.id });
    if (!claimed[0]) continue;

    // markTokenDead is guarded against re-killing a token that died of
    // something else during probation; the bin below runs either way, so that
    // token still comes off the board.
    await markTokenDead(db, token, 'rug_floor');
    // binned_by null = the system binned it, not a member (see schema.ts).
    // RETURNING is the affected-id list: selecting the ids first would race the
    // very update it feeds, and could publish a bin that never happened.
    const binned = await db
      .update(calls)
      .set({ status: 'binned', binnedAt: new Date(), binnedBy: null })
      .where(and(eq(calls.tokenId, token.id), ne(calls.status, 'binned')))
      .returning({ id: calls.id });
    for (const call of binned) {
      publish({ type: 'call_binned', tokenId: token.id, callId: call.id });
    }

    expired += 1;
    console.log(
      `rug probation: EXPIRED ${label(token)} — ${THRESHOLDS.rugProbationHours}h without a comeback (${binned.length} call(s) auto-binned)`,
    );
  }
  return expired;
}

export interface ProbationSweepResult {
  hidden: number;
  revived: number;
  expired: number;
}

/**
 * One sweep over every candidate. Idempotent: each transition is claimed with a
 * conditional update on tokens.rug_hidden_at, markTokenDead is guarded against
 * re-killing, and the bin only touches calls that are not binned yet — so a
 * second pass over the same token writes nothing and publishes nothing.
 *
 * The hidden set is read ONCE, before the hide pass: a token hidden by this
 * sweep must serve its probation, not be judged for revival or expiry in the
 * same breath.
 */
export async function runProbationSweep(db: Db): Promise<ProbationSweepResult> {
  const nowMs = Date.now();
  const hiddenTokens = await loadHiddenTokens(db);
  const hidden = await runHidePass(db, nowMs);
  const revived = await runRevivePass(db, hiddenTokens, nowMs);
  const expired = await runExpiryPass(db, hiddenTokens, nowMs);
  return { hidden, revived, expired };
}
