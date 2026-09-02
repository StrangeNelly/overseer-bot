import { and, eq, gte, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { calls, snapshots, tokens, watches, type Db } from '@groupie/db';
import {
  IDLE_AFTER_HOURS,
  isWrongChainDeath,
  POLL_TIERS,
  ROBINHOOD_SLUG,
  SLEEPERS,
  SNAPSHOT_RETENTION,
  THRESHOLDS,
  wrongChainReason,
} from '@groupie/shared';
import { publish } from '../events.js';
import * as ds from '../market/dexscreener.js';
import * as gt from '../market/geckoterminal.js';
import { mcapAtTimestamp, resolveToken, resolveTokens, type Resolution } from '../market/resolve.js';
import type { MarketSnapshot } from '../market/types.js';
import { runAlertPass } from './alerts.js';
import {
  callLiquidityDeath,
  classifyTokenDeath,
  isRevived,
  type LiquidityReading,
} from './death.js';
import { markTokenDead, releaseWatches } from './markDead.js';
import { runProbationSweep } from './rugSweep.js';
import { runSleeperScan } from './sleeperScan.js';

const TICK_MS = 15_000;
/**
 * Not a budget either (round 17b): resolution is batched through
 * `/tokens/multi`, so this is that endpoint's own ceiling. The whole tier costs
 * at most three calls a tick however many addresses are waiting — the old cap
 * of 6 was a budget, and it bought up to 12 calls.
 */
const MAX_RESOLUTIONS_PER_TICK = gt.TOKENS_MULTI_MAX;
/**
 * Not a budget: the curve tier is batched, so this is the multi-pool endpoint's
 * own ceiling. A token held back is a token polled late by a whole tick.
 */
const MAX_CURVE_TOKENS_PER_TICK = gt.POOLS_MULTI_MAX;
const MAX_DEAD_POLLS_PER_TICK = 4;
const MAX_OHLCV_FILLS_PER_TICK = 5;

const PRUNE_INTERVAL_MS = 3_600_000;
/** Every probation verdict covers hours of history; asking every tick would just re-ask it. */
const RUG_SWEEP_INTERVAL_MS = 600_000;
/** Sleepers is a 3-hourly chain-wide sweep (docs/decisions.md round 9). */
const SLEEPER_SCAN_INTERVAL_MS = SLEEPERS.scanIntervalHours * 3_600_000;

type TokenRow = typeof tokens.$inferSelect;

/** Bot-triggered polls are latency-critical and bypass the per-tick budgets. */
interface PollOpts {
  budgeted: boolean;
}
const TICK_POLL: PollOpts = { budgeted: true };
const IMMEDIATE_POLL: PollOpts = { budgeted: false };

let ohlcvFills = 0;
let lastPruneMs = 0;
let lastRugSweepMs = 0;
/** 0 = never run, so the first tick after boot scans (the board must not sit empty). */
let lastSleeperScanMs = 0;
/** The scan is detached, so it needs its own in-flight guard. */
let sleeperScanRunning = false;

export interface Candidate {
  token: TokenRow;
  lastActivityMs: number;
  reviveRequested: boolean;
  /** Some group has called it — the reason nearly every token is here. */
  called: boolean;
  /** On some group's alert watchlist — alerts are only as fresh as the data. */
  watched: boolean;
}

function isoNow(): string {
  return new Date().toISOString();
}

function ageHours(token: TokenRow): number {
  const born = token.tokenCreatedAt ?? token.firstSeenAt;
  return (Date.now() - born.getTime()) / 3_600_000;
}

/**
 * Round 11: how far back a liquidity death looks for its evidence.
 *
 * The rule itself only needs 10 unbroken minutes, but the window has to be
 * sized to the SLOWEST living tier, not the fastest: an idle token polls hourly,
 * so a 15-minute window would hold at most one of its readings and no idle coin
 * could ever die of a drained pool again. So: one more reading than the rule
 * demands, at the idle cadence — 4h today, and it follows the tier if that ever
 * moves.
 */
const LIQUIDITY_WINDOW_MS =
  (THRESHOLDS.liquidityDeathMinReadings + 1) * POLL_TIERS.idleSeconds * 1_000;

/**
 * ...and the row cap is what keeps that window cheap for the FAST tiers: a
 * fresh token polls every 45 seconds, so 4h of it would be ~320 rows per token
 * per batch. The newest 24 readings are ~18 minutes there — comfortably more
 * than the 10 the rule can use — and the verdict only ever walks back from the
 * newest reading, so older rows could not change an answer anyway.
 */
const LIQUIDITY_MAX_READINGS = sql.raw('24');

// db.execute bypasses Drizzle's column decoders, so postgres-js hands these
// back as strings (timestamptz, double precision) — coerce at the read site.
type LiquidityRow = {
  token_id: number | string;
  at: Date | string;
  liquidity_usd: number | string | null;
} & Record<string, unknown>;

/**
 * Recent liquidity readings per token — the evidence behind every round-11
 * liquidity verdict, in ONE statement for the whole batch (same shape as
 * alerts.ts's loadSeries and rugSweep.ts's loadBuckets).
 *
 * Rows with no liquidity are left out rather than returned as holes: a poll
 * that couldn't measure is not evidence either way, and death.ts's run walk
 * treats a gap and an absent reading identically.
 *
 * Always read BEFORE applySnapshot writes this poll's row — the caller appends
 * the live reading itself (liquiditySeries), so loading afterwards would count
 * it twice.
 */
async function loadLiquidityReadings(
  db: Db,
  tokenIds: number[],
  sinceMs: number,
): Promise<Map<number, LiquidityReading[]>> {
  const byToken = new Map<number, LiquidityReading[]>();
  if (tokenIds.length === 0) return byToken;

  const rows = await db.execute<LiquidityRow>(sql`
    select token_id, at, liquidity_usd
    from (
      select ${snapshots.tokenId} as token_id,
             ${snapshots.at} as at,
             ${snapshots.liquidityUsd} as liquidity_usd,
             row_number() over (
               partition by ${snapshots.tokenId} order by ${snapshots.at} desc
             ) as rn
      from ${snapshots}
      where ${and(
        inArray(snapshots.tokenId, tokenIds),
        gte(snapshots.at, new Date(sinceMs)),
        isNotNull(snapshots.liquidityUsd),
      )}
    ) s
    where rn <= ${LIQUIDITY_MAX_READINGS}
    order by token_id, at
  `);

  for (const row of rows) {
    if (row.liquidity_usd === null) continue;
    const liquidityUsd = Number(row.liquidity_usd);
    const atMs = new Date(row.at).getTime();
    const tokenId = Number(row.token_id);
    if (!Number.isFinite(liquidityUsd) || !Number.isFinite(atMs)) continue;
    if (!Number.isFinite(tokenId)) continue;
    const list = byToken.get(tokenId) ?? [];
    list.push({ atMs, liquidityUsd });
    byToken.set(tokenId, list);
  }
  return byToken;
}

/**
 * The one-token form, for the poll paths that judge a single token. Phases that
 * can never reach a liquidity verdict skip the query entirely: an unresolved
 * token has no pair, and a curve pool's reserve is the curve's own float rather
 * than a market anyone can trade out of.
 */
async function loadTokenLiquidity(
  db: Db,
  tokenId: number,
  phase: TokenRow['phase'],
): Promise<LiquidityReading[]> {
  if (phase !== 'graduated') return [];
  const byToken = await loadLiquidityReadings(db, [tokenId], Date.now() - LIQUIDITY_WINDOW_MS);
  return byToken.get(tokenId) ?? [];
}

/**
 * History plus the reading this poll just took. death.ts judges the LAST entry
 * as "now", so a poll that produced no snapshot (or no liquidity key) appends a
 * null and can never sustain a death on yesterday's numbers.
 */
function liquiditySeries(
  history: LiquidityReading[],
  snap: MarketSnapshot | null,
  nowMs: number,
): LiquidityReading[] {
  return [...history, { atMs: nowMs, liquidityUsd: snap?.liquidityUsd ?? null }];
}

/**
 * The join to calls is a LEFT join, so a watched token that was never called
 * (`/groupie watch <ca>` on a coin nobody posted) is still a candidate; its
 * activity clock falls back to first_seen_at.
 */
async function loadCandidates(db: Db): Promise<Candidate[]> {
  const rows = await db
    .select({
      token: tokens,
      lastActivityEpoch: sql<string | null>`extract(epoch from max(${calls.lastMentionAt}))`,
      reviveRequested: sql<boolean | null>`bool_or(${calls.reviveRequested})`,
      // A correlated EXISTS, not a second join: joining watches as well would
      // multiply rows (calls x watches) under the same group-by.
      watched: sql<boolean>`exists (select 1 from ${watches} where ${watches.tokenId} = ${tokens.id} and ${watches.active})`,
      called: sql<string | number>`count(${calls.id})`,
    })
    .from(tokens)
    .leftJoin(calls, eq(calls.tokenId, tokens.id))
    .groupBy(tokens.id);
  return rows.map((r) => ({
    token: r.token,
    lastActivityMs: r.lastActivityEpoch
      ? Number(r.lastActivityEpoch) * 1000
      : r.token.firstSeenAt.getTime(),
    reviveRequested: r.reviveRequested ?? false,
    // count() is a bigint, which postgres-js hands back as a string.
    called: Number(r.called) > 0,
    watched: r.watched === true,
  }));
}

/**
 * How often to re-check a corpse for a comeback (docs/decisions.md round 15).
 *
 * A death that happened hours ago is the one most likely to be wrong or
 * reversible — OMNI was declared dead three seconds after its call and then
 * traded to $132k — and under the old flat daily cadence the board carried that
 * corpse for a full day. So: every 3h for the first 48h after death, daily
 * afterwards. The REVIVAL BAR is untouched (THRESHOLDS.revivalMcapUsd, round
 * 13); this only changes how often we ask.
 *
 * An unreadable or missing died_at means an old row we cannot date — treated as
 * long dead, which is the conservative (cheaper) answer. Exported for tests.
 */
export function deadPollSeconds(
  diedAt: Date | null,
  nowMs: number,
  deathReason?: string | null,
): number {
  // Round 17b (and its review): a wrong-chain corpse has no market on THIS
  // chain, so nothing a re-read could learn and no comeback to catch — but the
  // dead poll does more than read a market. It sweeps calls created after the
  // death onto the death record, and a call from a second group would otherwise
  // sit in FRESH forever if the bot's immediate poll on it ever failed. So the
  // corpse keeps the CHEAPEST ordinary cadence (daily, never the fresh-death
  // one): pollDead's wrong-chain branch spends no market call at all.
  if (isWrongChainDeath(deathReason)) return POLL_TIERS.deadSeconds;
  const at = diedAt?.getTime();
  if (at === undefined || !Number.isFinite(at)) return POLL_TIERS.deadSeconds;
  const hoursDead = (nowMs - at) / 3_600_000;
  return hoursDead < POLL_TIERS.deadRecentHours
    ? POLL_TIERS.deadRecentSeconds
    : POLL_TIERS.deadSeconds;
}

/**
 * How often to retry an address nothing has indexed yet (docs/decisions.md
 * round 17b), measured from when we FIRST saw it.
 *
 * A resolution attempt is the most expensive poll we make (up to three market
 * calls for the batch it rides in) and the only one that can repeat forever
 * learning nothing: the live case was a Base contract, which could not resolve
 * on Robinhood Chain at any cadence. New PONS launches index within minutes, so
 * only those minutes need the fast tier; after that the retry is a formality
 * until the 48h never_graduated rule ends it.
 *
 * The middle tier is the pre-launch paste's tier (round 17b review): a CA
 * posted hours before its pool opens resolves at whatever cadence is running
 * then, and mcap-at-call is measured from that first reading. Five minutes of
 * that is a baseline worth keeping, so it holds for six hours before the coin
 * drops to hourly.
 *
 * An unreadable first_seen_at is treated as brand new — the fast tier is the
 * conservative answer for a row we cannot date, since the whole point of the
 * fast window is not to miss a launch. Exported for tests.
 */
export function resolveIntervalSeconds(firstSeenAt: Date | null, nowMs: number): number {
  const seen = firstSeenAt?.getTime();
  if (seen === undefined || !Number.isFinite(seen)) return POLL_TIERS.freshSeconds;
  const minutes = (nowMs - seen) / 60_000;
  if (minutes < POLL_TIERS.unresolvedFastMinutes) return POLL_TIERS.freshSeconds;
  if (minutes < POLL_TIERS.unresolvedSlowHours * 60) return POLL_TIERS.activeSeconds;
  return POLL_TIERS.idleSeconds;
}

/**
 * Is this token due a poll? Exported for tests — the tiers are the poller's
 * whole economy, and the orphan rule below is the only one that answers "never".
 *
 * An orphan is a tokens row no group ever called and nobody is watching:
 * watch-by-address upserts the row before the watch, and unwatching leaves it
 * behind (as does a cap refusal that slipped past the pre-check, or any row
 * written before round 15 added one). Nothing on any board renders it and no
 * alert can fire for it, so the old behaviour — activity clock falling back to
 * first_seen_at, hence the 45-second fresh tier for a day — spent the GT budget
 * on a coin nobody asked about. A revive request still wakes it, but that needs
 * a call, so it can only ever be a real coin someone re-posted.
 */
export function isDue(c: Candidate, nowMs: number): boolean {
  if (!c.called && !c.watched && !c.reviveRequested) return false;
  const last = c.token.lastPolledAt?.getTime() ?? 0;
  if (c.token.phase === 'dead') {
    // A wrong-chain corpse is in here too, on the daily tier deadPollSeconds
    // gives it: its poll reads no market (pollDead returns before either
    // source), it only sweeps and stamps. A repost still wakes it for the same
    // reason — the flag has to be consumed, and consuming it is free.
    if (c.reviveRequested) return true;
    return nowMs - last >= deadPollSeconds(c.token.diedAt, nowMs, c.token.deathReason) * 1000;
  }
  if (c.token.phase === 'unresolved') {
    // Round 17b: its own back-off, and deliberately not the activity tiers —
    // a watch or a re-mention cannot make an unindexed address index faster,
    // and there is no market data for either to be fresh about.
    return nowMs - last >= resolveIntervalSeconds(c.token.firstSeenAt, nowMs) * 1000;
  }
  const quietHours = (nowMs - c.lastActivityMs) / 3_600_000;
  // A watch is a standing request for minute-scale alerts, so a watched token
  // stays on the fresh tier however quiet the chat is about it — that beats
  // probation too, since a watched rug is one the group asked to be told about.
  // Probation itself overrides the activity tiers in both directions: a coin
  // called minutes before it tanked must not keep 45-second polling while
  // hidden, and one hidden months later must still be checked for a comeback.
  const seconds = c.watched
    ? POLL_TIERS.freshSeconds
    : c.token.rugHiddenAt !== null
      ? POLL_TIERS.probationSeconds
      : quietHours < 24
        ? POLL_TIERS.freshSeconds
        : quietHours >= IDLE_AFTER_HOURS
          ? POLL_TIERS.idleSeconds
          : POLL_TIERS.activeSeconds;
  return nowMs - last >= seconds * 1000;
}

/**
 * Fill call-time baselines for any call that still lacks them (first poll after
 * the call; late calls get an OHLCV backfill attempt first). Shared with dead
 * tokens, which get baselines but no snapshot row and no peak tracking.
 */
async function fillCallBaselines(
  db: Db,
  token: TokenRow,
  snap: MarketSnapshot,
  opts: PollOpts,
): Promise<void> {
  const unfilled = await db
    .select({ id: calls.id, calledAt: calls.calledAt })
    .from(calls)
    .where(and(eq(calls.tokenId, token.id), isNull(calls.mcapAtCall)));
  for (const call of unfilled) {
    let mcapAtCall = snap.mcapUsd;
    const lateMs = Date.now() - call.calledAt.getTime();
    if (lateMs > 120_000 && token.poolAddress) {
      // The coalesce below makes the first write permanent, so a late call must
      // not settle for the live value: skip over budget and retry next tick.
      if (opts.budgeted && ohlcvFills >= MAX_OHLCV_FILLS_PER_TICK) continue;
      if (opts.budgeted) ohlcvFills += 1;
      mcapAtCall =
        (await mcapAtTimestamp(token.poolAddress, call.calledAt, snap.priceUsd, snap.mcapUsd)) ??
        snap.mcapUsd;
    }
    await db
      .update(calls)
      .set({
        mcapAtCall: sql`coalesce(${calls.mcapAtCall}, ${mcapAtCall})`,
        liquidityAtCall: sql`coalesce(${calls.liquidityAtCall}, ${snap.liquidityUsd})`,
        // The call moment is itself an observation: peak starts there, so a
        // token that only fell since the call never shows peak < at-call.
        peakMcapSinceCall: sql`greatest(coalesce(${calls.peakMcapSinceCall}, 0), coalesce(${calls.mcapAtCall}, ${mcapAtCall}, 0))`,
        peakAt: sql`coalesce(${calls.peakAt}, ${calls.calledAt})`,
      })
      .where(eq(calls.id, call.id));
  }
}

/**
 * Write one poll result: snapshot row, cached market state, peaks, deaths.
 *
 * `history` is the recent liquidity window loaded before this write (empty when
 * the token cannot be judged on liquidity at all — see the poll paths).
 */
async function applySnapshot(
  db: Db,
  token: TokenRow,
  snap: MarketSnapshot,
  opts: PollOpts,
  history: LiquidityReading[],
): Promise<void> {
  await db.insert(snapshots).values({
    tokenId: token.id,
    priceUsd: snap.priceUsd,
    mcapUsd: snap.mcapUsd,
    liquidityUsd: snap.liquidityUsd,
    vol24Usd: snap.vol24Usd,
  });
  const now = new Date();
  await db
    .update(tokens)
    .set({
      priceUsd: snap.priceUsd,
      mcapUsd: snap.mcapUsd,
      liquidityUsd: snap.liquidityUsd,
      vol24Usd: snap.vol24Usd,
      lastPolledAt: now,
      lastSnapshotAt: now,
    })
    .where(eq(tokens.id, token.id));

  await fillCallBaselines(db, token, snap, opts);

  // Peak-since-call: SET expressions see the OLD row, so the peak_at CASE
  // compares against the pre-update peak. Only active calls track peaks.
  if (snap.mcapUsd !== null) {
    await db
      .update(calls)
      .set({
        peakMcapSinceCall: sql`greatest(coalesce(${calls.peakMcapSinceCall}, 0), ${snap.mcapUsd})`,
        peakAt: sql`case when ${snap.mcapUsd} > coalesce(${calls.peakMcapSinceCall}, 0) then ${isoNow()}::timestamptz else ${calls.peakAt} end`,
      })
      .where(and(eq(calls.tokenId, token.id), eq(calls.status, 'active')));
  }

  // Per-call liquidity-collapse death (>95% down from call-time liquidity).
  // Round 11: judged over the persistence window, not this one reading, and
  // skipped entirely inside the newborn grace (callLiquidityDeath owns both).
  const series = liquiditySeries(history, snap, Date.now());
  const age = ageHours(token);
  if (snap.liquidityUsd !== null && token.phase === 'graduated') {
    const collapsed = await db
      .select({ id: calls.id, liquidityAtCall: calls.liquidityAtCall })
      .from(calls)
      .where(and(eq(calls.tokenId, token.id), eq(calls.status, 'active')));
    for (const call of collapsed) {
      if (callLiquidityDeath(call.liquidityAtCall, series, Date.now(), age)) {
        // The token is still alive, so only the call carries this death: stamp
        // it here or the board has no date/reason to show or sort by. The mcap
        // is this poll's reading — the one the verdict was reached on. Guarded
        // on status like every other transition: a bot-triggered pollTokenNow
        // can race this tick onto the same token, and the loser must be a
        // no-op rather than a re-kill that drifts diedAt.
        const killed = await db
          .update(calls)
          .set({
            status: 'died',
            diedAt: new Date(),
            deathReason: 'call_liquidity_collapse',
            mcapAtDeath: snap.mcapUsd,
          })
          .where(and(eq(calls.id, call.id), eq(calls.status, 'active')))
          .returning({ id: calls.id });
        if (killed[0]) {
          console.log(`call ${call.id} (${token.address}) died: call_liquidity_collapse`);
        }
      }
    }
  }

  // Reposts of a call that died on its own liquidity ask for a revive check;
  // the token itself is alive, so pollDead never sees these. Runs after the
  // death pass above so a still-collapsed call isn't flipped and re-killed.
  await applyCallRevivals(db, token, snap, series, age);

  publish({ type: 'price_update', tokenId: token.id, mcapUsd: snap.mcapUsd });
}

async function applyCallRevivals(
  db: Db,
  token: TokenRow,
  snap: MarketSnapshot,
  series: LiquidityReading[],
  age: number,
): Promise<void> {
  const requested = await db
    .select({ id: calls.id, status: calls.status, liquidityAtCall: calls.liquidityAtCall })
    .from(calls)
    .where(and(eq(calls.tokenId, token.id), eq(calls.reviveRequested, true)));
  if (requested.length === 0) return;

  // Consume the request whatever the outcome (mirrors pollDead), so a stale
  // flag can't force a spurious dead-poll if the token dies later.
  await db
    .update(calls)
    .set({ reviveRequested: false })
    .where(and(eq(calls.tokenId, token.id), eq(calls.reviveRequested, true)));

  if (snap.liquidityUsd === null) return; // unknown is never evidence, either way
  for (const call of requested) {
    if (call.status !== 'died') continue;
    // Still collapsed on the same persistence rule that killed it — one healthy
    // reading is enough to break the run, which is exactly the repost's point.
    if (callLiquidityDeath(call.liquidityAtCall, series, Date.now(), age)) continue;
    // diedAt/deathReason stay as the call's last-death record (same convention
    // as tokens.died_at/death_reason); the next death overwrites them.
    await db.update(calls).set({ status: 'active' }).where(eq(calls.id, call.id));
    publish({ type: 'call_revived', tokenId: token.id, callId: call.id });
  }
}

/**
 * Retracing to the curve floor is deliberately NOT here any more
 * (docs/decisions.md round 6) — the rug sweep hides those, with a comeback path
 * — so this no longer needs the token's all-time peak. Round 10's collapse rule
 * is peak-relative and lives there for the same reason: it is a claim about a
 * sustained hour, not about one reading.
 *
 * Since round 11 the liquidity floor is a sustained claim too: `history` plus
 * this poll's reading is the evidence, and 48h-style age rules are the only
 * verdicts one reading can still produce.
 */
async function checkDeath(
  db: Db,
  token: TokenRow,
  snap: MarketSnapshot | null,
  history: LiquidityReading[],
): Promise<void> {
  const nowMs = Date.now();
  const reason = classifyTokenDeath(
    { phase: token.phase, ageHours: ageHours(token) },
    liquiditySeries(history, snap, nowMs),
    nowMs,
  );
  if (reason) await markTokenDead(db, token, reason);
}

/**
 * Is this address simply on the WRONG CHAIN (docs/decisions.md round 17b, as
 * revised by its review)?
 *
 * Asked only when both Robinhood-Chain lookups have already missed, and NEVER
 * before the row is `wrongChainMinMinutes` old: a pool minutes old is a pool
 * GeckoTerminal has not indexed yet (~40s-3min), DexScreener never indexes
 * curve tokens at all, and a CA is often pasted before its pool exists. Judging
 * earlier would kill a same-address multi-chain deploy — the CREATE2/omnichain
 * pattern, i.e. exactly the team most likely to already be trading on Base —
 * permanently, on the strength of an hour the pool had not had yet.
 *
 * After that window the question is asked on EVERY failed attempt rather than
 * once. A verdict ends the asking by itself (the token is dead), so all a retry
 * can cost is one cheap DexScreener call at the back-off's own cadence — and it
 * buys back every token whose single chance would have fallen on a DS blip.
 *
 * Two ways to be silent, both meaning "no verdict": DexScreener knows the
 * address on Robinhood Chain too (so this chain is simply behind), or it knows
 * nothing anywhere (unknown data is never death evidence — the token goes on
 * to the back-off and, eventually, the 48h rule). A failed lookup is not a
 * verdict either; it falls through to the next attempt.
 *
 * An undatable first_seen_at is treated as brand new, the same answer
 * resolveIntervalSeconds gives it: a row we cannot date is not a row to kill.
 */
async function diedOnAnotherChain(db: Db, token: TokenRow): Promise<boolean> {
  const seen = token.firstSeenAt?.getTime();
  if (seen === undefined || !Number.isFinite(seen)) return false;
  if (Date.now() - seen < POLL_TIERS.wrongChainMinMinutes * 60_000) return false;
  let chains: Set<string>;
  try {
    chains = await ds.findChainsFor(token.address);
  } catch (err) {
    console.warn(`any-chain lookup failed for ${token.address}:`, err);
    return false;
  }
  if (chains.size === 0 || chains.has(ROBINHOOD_SLUG)) return false;
  // Several foreign chains is a token deployed on several: the first DexScreener
  // listed is the one named, and the label's job is only to say "not here".
  const chain = [...chains][0]!;
  // Guarded on the EVIDENCE, not merely on "not already dead": the verdict was
  // reached for a row that read as unresolved, and a concurrent poll (the bot's
  // immediate one on the same paste) can have resolved it since. No rows back
  // means someone else got there first — no death, and the caller stamps as it
  // would for any other silent attempt.
  //
  // mcap_at_death lands null on its own: markTokenDead copies the token's
  // cached mcap, and an address that never traded here has never had one.
  const killed = await markTokenDead(db, token, wrongChainReason(chain), {
    requirePhase: 'unresolved',
  });
  if (!killed) return false;
  // A death with no comeback path: nothing here can ever revive, so the watch
  // slots it holds are handed back exactly as a permanent rug's are.
  await releaseWatches(db, token.id);
  console.log(`token ${token.address} is on ${chain}, not Robinhood Chain`);
  return true;
}

/**
 * `pre` is the tick's batched resolution for this address. Absent (the bot's
 * immediate polls) the address is resolved on its own — the same endpoints, one
 * address wide.
 */
async function pollUnresolved(
  db: Db,
  token: TokenRow,
  opts: PollOpts,
  pre?: Resolution,
): Promise<void> {
  const attempt = pre ?? (await resolveToken(token.address));
  const resolved = attempt.token;
  if (!resolved) {
    if (attempt.unknownOnChain && (await diedOnAnotherChain(db, token))) return;
    await db.update(tokens).set({ lastPolledAt: new Date() }).where(eq(tokens.id, token.id));
    // An unresolved token has no liquidity verdict to reach — only the 48h rule.
    await checkDeath(db, token, null, []);
    return;
  }
  await db
    .update(tokens)
    .set({
      symbol: resolved.symbol,
      name: resolved.name,
      imageUrl: resolved.imageUrl,
      socials: resolved.socials,
      launchpad: resolved.launchpad,
      phase: resolved.phase,
      poolAddress: resolved.poolAddress,
      tokenCreatedAt: resolved.tokenCreatedAt,
      // First writer's timestamp sticks, so a concurrent poll can't move it.
      ...(resolved.phase === 'graduated'
        ? { graduatedAt: sql`coalesce(${tokens.graduatedAt}, now())` }
        : {}),
    })
    .where(eq(tokens.id, token.id));
  const fresh = { ...token, ...resolved, phase: resolved.phase } as TokenRow;
  // Normally a token's FIRST successful read, so the window is usually empty —
  // which is precisely why OMNI (dead 3 seconds after the call) cannot repeat.
  const history = await loadTokenLiquidity(db, token.id, resolved.phase);
  await applySnapshot(db, fresh, resolved.snapshot, opts, history);
  await checkDeath(db, fresh, resolved.snapshot, history);
  publish({ type: 'token_resolved', tokenId: token.id, symbol: resolved.symbol });
  console.log(
    `resolved ${resolved.symbol ?? token.address} (${resolved.phase}) mcap=$${Math.round(resolved.snapshot.mcapUsd ?? 0).toLocaleString()}`,
  );
}

/**
 * A curve read we could not take: stamp the clock so the token keeps its tier
 * cadence, and write NOTHING else. An unreadable pool is not a $0 market — no
 * snapshot row, no death check, no peak update.
 */
async function noReading(db: Db, token: TokenRow): Promise<void> {
  await db.update(tokens).set({ lastPolledAt: new Date() }).where(eq(tokens.id, token.id));
}

/**
 * Everything a curve poll does once it HAS its pool. Shared by the single-token
 * path (pollTokenNow, pollCurve) and the batched one, so the two can't drift.
 */
async function applyCurvePool(
  db: Db,
  token: TokenRow,
  pool: gt.GtPoolInfo,
  opts: PollOpts,
): Promise<void> {
  if (pool.graduated === true) {
    // Trading moves to the migrated pool; the curve pool is abandoned and its
    // last candle would poison any later OHLCV backfill.
    const poolAddress = pool.migratedPoolAddress ?? token.poolAddress;
    await db
      .update(tokens)
      .set({
        phase: 'graduated',
        graduatedAt: sql`coalesce(${tokens.graduatedAt}, now())`,
        poolAddress,
      })
      .where(eq(tokens.id, token.id));
    token = { ...token, phase: 'graduated', poolAddress };
    console.log(`token ${token.symbol ?? token.address} graduated`);
  }
  const snap = gt.gtSnapshot(pool);
  // Loaded only when this poll just graduated the token — see loadTokenLiquidity.
  const history = await loadTokenLiquidity(db, token.id, token.phase);
  await applySnapshot(db, token, snap, opts, history);
  await checkDeath(db, token, snap, history);
}

/**
 * One curve token, one GeckoTerminal call. The bot's immediate polls use this;
 * the tick uses pollCurveBatch. Exported so the tests can hold the two against
 * each other.
 */
export async function pollCurve(db: Db, token: TokenRow, opts: PollOpts): Promise<void> {
  if (!token.poolAddress) {
    await pollUnresolved(db, token, opts); // re-resolve to find the pool
    return;
  }
  const pool = await gt.getPool(token.poolAddress);
  if (!pool) {
    await noReading(db, token);
    return;
  }
  await applyCurvePool(db, token, pool, opts);
}

/**
 * The tick's curve tier (docs/decisions.md round 16b): ONE `/pools/multi` call
 * for up to 30 due curve tokens, then exactly pollCurve's per-token handling.
 *
 * A token ABSENT from the response is a token GeckoTerminal has no answer for
 * (it answers 200 with a shorter array, never an error). That is the same
 * "unknown reading" the single-pool 404 produces, and it is handled the same
 * way: stamp the clock, write nothing.
 *
 * Sharing a call must not mean sharing a failure, so BOTH branches below are
 * isolated per token — a readable pool and an unreadable one alike, because the
 * readings are already paid for and one failed stamp must not discard the rest.
 * Only the fetch itself is shared: if THAT throws, the caller's isolate stamps
 * the whole batch, which is what a failed poll has always done.
 */
export async function pollCurveBatch(db: Db, batch: TokenRow[], opts: PollOpts): Promise<void> {
  const withPool = batch.filter((t) => Boolean(t.poolAddress));
  // A curve token with no pool on record can only be re-resolved, one at a time.
  for (const token of batch) {
    if (!token.poolAddress) await isolate(db, [token], () => pollUnresolved(db, token, opts));
  }
  if (withPool.length === 0) return;
  const pools = await gt.getPoolsMulti(withPool.map((t) => t.poolAddress!));
  for (const token of withPool) {
    const pool = pools.get(token.poolAddress!);
    await isolate(db, [token], () =>
      pool ? applyCurvePool(db, token, pool, opts) : noReading(db, token),
    );
  }
}

/**
 * DexScreener returns ONE best pair per token, and for a curve-phase or thinly
 * traded token that can be a parasitic dust pool with an absurd FDV — or, since
 * round 11, an empty shell of the real pool that the indexer has not caught up
 * with. A drained pool at the token's OWN address must still flow through (that
 * is the death signal), so every case below starts from a DIFFERENT, dust-thin
 * pair address.
 *
 * Two ways to distrust it, either one enough:
 *
 * - the pair reprices the token absurdly (>20x the cached mcap): a parasite;
 * - round 11: our cached liquidity was >= 10x what this pair reports. OMNI's
 *   liquidity=$0 first reading is the shape — a best-pair switch to dust while
 *   we already knew a healthier pool is indexer lag, not a rug, and the mcap
 *   comparison never applied to it (the dust pair's mcap looked normal).
 *
 * Exported for tests.
 */
export function isSuspiciousPair(token: TokenRow, pair: ds.DsPair): boolean {
  if (pair.pairAddress === token.poolAddress) return false;
  const pairLiquidityUsd = pair.liquidityUsd ?? 0;
  if (pairLiquidityUsd >= THRESHOLDS.dustLiquidityUsd) return false;
  // Round 11. With a $0 reading any cached liquidity clears "10x healthier",
  // which is the intended reading of the OMNI case: a foreign dust pair is
  // never allowed to be the drain evidence.
  if (token.liquidityUsd !== null && token.liquidityUsd >= 10 * pairLiquidityUsd) return true;
  return token.mcapUsd !== null && (pair.mcapUsd ?? 0) > 20 * token.mcapUsd;
}

async function pollGraduatedBatch(db: Db, batch: TokenRow[], opts: PollOpts): Promise<void> {
  const pairs = await ds.getBestPairs(batch.map((t) => t.address));
  // One statement for the whole batch, read BEFORE any snapshot row is written:
  // every token here is graduated, so every one of them can reach a liquidity
  // verdict and needs its window.
  const history = await loadLiquidityReadings(
    db,
    batch.map((t) => t.id),
    Date.now() - LIQUIDITY_WINDOW_MS,
  );
  for (const token of batch) {
    const pair = pairs.get(token.address);
    if (!pair) {
      // Absent = not indexed there (NOT dead). Rare for graduated tokens.
      await db.update(tokens).set({ lastPolledAt: new Date() }).where(eq(tokens.id, token.id));
      continue;
    }
    if (isSuspiciousPair(token, pair)) {
      console.warn(
        `skipping dust pair ${pair.pairAddress} for ${token.address}: liq=$${Math.round(pair.liquidityUsd ?? 0)} mcap=$${Math.round(pair.mcapUsd ?? 0)} vs cached $${Math.round(token.mcapUsd ?? 0)}`,
      );
      await db.update(tokens).set({ lastPolledAt: new Date() }).where(eq(tokens.id, token.id));
      continue;
    }
    // Backfill metadata DS knows that GT resolution didn't provide.
    if ((!token.socials && pair.socials) || (!token.imageUrl && pair.imageUrl)) {
      await db
        .update(tokens)
        .set({
          ...(token.socials ? {} : { socials: pair.socials }),
          ...(token.imageUrl ? {} : { imageUrl: pair.imageUrl }),
        })
        .where(eq(tokens.id, token.id));
    }
    const snap = ds.dsSnapshot(pair);
    const readings = history.get(token.id) ?? [];
    await applySnapshot(db, token, snap, opts, readings);
    await checkDeath(db, token, snap, readings);
  }
}

/**
 * Which market a corpse is re-read from.
 *
 * 'rug_floor' can kill either phase, so it identifies neither on its own: a
 * token with no graduation on record was still on its curve, and a curve pool
 * is a GeckoTerminal read (its DexScreener "best pair" is dust at best).
 * 'curve_floor' is no longer produced (round 6 retired it), but rows written
 * before that still carry it and must still route to the curve read.
 *
 * Exported so the tick can batch the curve-read corpses into one call.
 */
export function deadReadsCurve(token: TokenRow): boolean {
  return (
    token.deathReason === 'curve_floor' ||
    token.deathReason === 'never_graduated' ||
    (token.deathReason === 'rug_floor' && token.graduatedAt === null)
  );
}

/**
 * `curvePools` is the tick's prefetched `/pools/multi` answer: when it is
 * supplied, a curve-read corpse takes its pool from there instead of spending a
 * call of its own, and an address missing from it is the same unknown reading a
 * null getPool gives. Absent (bot-triggered polls) it falls back to the
 * single-pool call. Exported for tests.
 */
export async function pollDead(
  db: Db,
  token: TokenRow,
  opts: PollOpts,
  curvePools?: Map<string, gt.GtPoolInfo>,
): Promise<void> {
  // Round 17b: a wrong-chain corpse has no market here to re-read, so it asks
  // nothing of either source — the market READ is what it skips, never the
  // sweep. It still runs (daily, per deadPollSeconds, plus the bot's immediate
  // poll on a repost) to do the two things it owes: consume the revive request
  // (never leave one standing) and put any call created after the death onto
  // the token's death record, so no board can show it as live. Without the tick
  // side of that, a first call from ANOTHER group whose immediate poll failed
  // would sit in FRESH forever.
  if (isWrongChainDeath(token.deathReason)) {
    await db
      .update(calls)
      .set({ reviveRequested: false })
      .where(and(eq(calls.tokenId, token.id), eq(calls.reviveRequested, true)));
    await db
      .update(calls)
      .set({
        status: 'died',
        diedAt: token.diedAt ?? new Date(),
        deathReason: token.deathReason,
        mcapAtDeath: token.mcapAtDeath,
      })
      .where(and(eq(calls.tokenId, token.id), eq(calls.status, 'active')));
    await db.update(tokens).set({ lastPolledAt: new Date() }).where(eq(tokens.id, token.id));
    return;
  }

  const wasCurve = deadReadsCurve(token);
  let snap: MarketSnapshot | null = null;
  let pool: gt.GtPoolInfo | null = null;
  if (wasCurve && token.poolAddress) {
    pool = curvePools
      ? (curvePools.get(token.poolAddress) ?? null)
      : await gt.getPool(token.poolAddress);
    if (pool) snap = gt.gtSnapshot(pool);
  } else {
    const pair = (await ds.getBestPairs([token.address])).get(token.address);
    if (pair) snap = ds.dsSnapshot(pair);
  }

  // Consume the revive request whatever the outcome.
  await db
    .update(calls)
    .set({ reviveRequested: false })
    .where(and(eq(calls.tokenId, token.id), eq(calls.reviveRequested, true)));

  // A call posted after the token died is still 'active' — markTokenDead ran
  // before it existed. Sweep first; a revival below flips it back with the rest.
  // It inherits the token's death record (a dead token always has one; the
  // fallback only covers pre-column rows) so the died section can date it.
  await db
    .update(calls)
    .set({
      status: 'died',
      diedAt: token.diedAt ?? new Date(),
      deathReason: token.deathReason,
      // Inherited with the rest of the record: the death being dated here is
      // the TOKEN's, so it must carry the token's mcap-at-death, not today's.
      mcapAtDeath: token.mcapAtDeath,
    })
    .where(and(eq(calls.tokenId, token.id), eq(calls.status, 'active')));

  if (snap && isRevived(wasCurve ? 'curve' : 'graduated', snap, pool?.graduated ?? null)) {
    // Phase comes from the launchpad flag, never from liquidity: a bonding
    // pool's reserve is the curve's own float, so it always looks "liquid".
    const phase = wasCurve ? (pool?.graduated === true ? 'graduated' : 'curve') : 'graduated';
    // Graduating while dead moved trading to the migrated pool; keeping the
    // curve pool would poison later OHLCV backfills (same as pollCurve).
    const migratedPool =
      wasCurve && pool?.graduated === true ? (pool.migratedPoolAddress ?? null) : null;
    const transitioned = await db
      .update(tokens)
      .set({
        phase,
        // diedAt/deathReason stay as the last-death record for the board.
        revivedAt: new Date(),
        ...(phase === 'graduated'
          ? { graduatedAt: sql`coalesce(${tokens.graduatedAt}, now())` }
          : {}),
        ...(migratedPool ? { poolAddress: migratedPool } : {}),
      })
      .where(and(eq(tokens.id, token.id), eq(tokens.phase, 'dead')))
      .returning({ id: tokens.id });
    if (transitioned[0]) {
      // Call-level diedAt/deathReason are kept as last-death history too.
      await db
        .update(calls)
        .set({ status: 'active' })
        .where(and(eq(calls.tokenId, token.id), eq(calls.status, 'died')));
      publish({ type: 'token_revived', tokenId: token.id });
      console.log(`token ${token.symbol ?? token.address} REVIVED`);
    }
    // A dead token writes no snapshots, so this window is all but always empty
    // — loaded anyway so the revived token's first poll is judged like any
    // other graduated poll rather than as a special case.
    const history = await loadTokenLiquidity(db, token.id, phase);
    await applySnapshot(db, { ...token, phase } as TokenRow, snap, opts, history);
  } else {
    // Still dead: no snapshot row and no peak tracking, but a call created
    // after the death still needs its at-call baseline.
    if (snap) await fillCallBaselines(db, token, snap, opts);
    await db.update(tokens).set({ lastPolledAt: new Date() }).where(eq(tokens.id, token.id));
  }
}

const THIN_AGE = sql.raw(`interval '${SNAPSHOT_RETENTION.thinAfterHours} hours'`);
const HARD_AGE = sql.raw(`interval '${SNAPSHOT_RETENTION.hardDeleteDays} days'`);
const THIN_BUCKET = sql.raw(String(SNAPSHOT_RETENTION.thinBucketSeconds));

/** Age-tier retention (docs/plan.md). At most hourly; failures never fail a tick. */
async function pruneSnapshots(db: Db): Promise<void> {
  if (Date.now() - lastPruneMs < PRUNE_INTERVAL_MS) return;
  lastPruneMs = Date.now();
  try {
    await db.execute(sql`
      delete from snapshots
      where at < now() - ${THIN_AGE}
        and id not in (
          select min(id) from snapshots
          where at < now() - ${THIN_AGE}
          group by token_id, floor(extract(epoch from at) / ${THIN_BUCKET})
        )
    `);
    await db.execute(sql`delete from snapshots where at < now() - ${HARD_AGE}`);
  } catch (err) {
    console.error('snapshot prune failed:', err);
  }
}

/**
 * Rug probation (docs/decisions.md round 6): hide, revive, expire. At most
 * every 10 minutes, and isolated like the prune — a failed sweep must never
 * cost us a tick.
 */
async function sweepRugs(db: Db): Promise<void> {
  if (Date.now() - lastRugSweepMs < RUG_SWEEP_INTERVAL_MS) return;
  lastRugSweepMs = Date.now();
  try {
    await runProbationSweep(db);
  } catch (err) {
    console.error('rug probation sweep failed:', err);
  }
}

/**
 * Sleepers: the chain-wide discovery scan (docs/decisions.md round 9). Three
 * hourly, isolated like the sweep and the prune — but DETACHED rather than
 * awaited.
 *
 * The scan paces ~10 GeckoTerminal pages and backs off on a 429, so one run can
 * take minutes; awaiting it here would hold `running` for that whole window and
 * blind the 45-second fresh tier (and the nuke alert that rides on it) every
 * three hours. Detached, its requests simply queue through the shared budgeter
 * alongside the polls, which is exactly what the budgeter is for.
 *
 * Both guards matter: the interval stamp is taken BEFORE the run so a scan that
 * throws does not retry every 15-second tick, and the in-flight flag makes a
 * scan that outlives its own interval impossible to double-start.
 *
 * The boot hold-off exists because a restart is the worst possible moment to
 * scan: every tracked token is overdue at once, the catch-up polls flood the
 * GT budget, and the scan's own pages draw 429s (observed live on the
 * 2026-09-02 deploy — the boot scan aborted). Five minutes lets the burst
 * drain. A failed scan then retries in minutes, not hours: the old rows it
 * leaves behind are already stale, and waiting a full interval to replace
 * them serves nobody.
 */
const SLEEPER_BOOT_HOLDOFF_MS = 5 * 60_000;
const SLEEPER_RETRY_MS = 10 * 60_000;
const processStartMs = Date.now();

function scanSleepers(db: Db): void {
  if (sleeperScanRunning) return;
  if (Date.now() - processStartMs < SLEEPER_BOOT_HOLDOFF_MS) return;
  if (Date.now() - lastSleeperScanMs < SLEEPER_SCAN_INTERVAL_MS) return;
  lastSleeperScanMs = Date.now();
  sleeperScanRunning = true;
  void runSleeperScan(db)
    .catch((err) => {
      console.error('sleeper scan failed:', err);
      lastSleeperScanMs = Date.now() - SLEEPER_SCAN_INTERVAL_MS + SLEEPER_RETRY_MS;
    })
    .finally(() => {
      sleeperScanRunning = false;
    });
}

/**
 * One unit of tick work. A thrown poll must not abort the rest of the tick, and
 * stamping lastPolledAt keeps a poisoned token on its tier cadence instead of
 * letting it re-fail at the head of every tick and starve everything behind it.
 */
async function isolate(db: Db, batch: TokenRow[], run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    console.error(`poll failed for ${batch.map((t) => t.address).join(', ')}:`, err);
    await stampBatch(db, batch);
  }
}

/**
 * Push a whole batch onto its next tier interval. The stamp is what a failed
 * poll owes the budget: without it the same tokens are due again in 15 seconds,
 * at the head of every tick, for as long as the failure lasts.
 *
 * Never throws — it runs on paths that are already handling an error.
 */
async function stampBatch(db: Db, batch: TokenRow[]): Promise<void> {
  if (batch.length === 0) return;
  try {
    await db
      .update(tokens)
      .set({ lastPolledAt: new Date() })
      .where(
        inArray(
          tokens.id,
          batch.map((t) => t.id),
        ),
      );
  } catch (stampErr) {
    console.error('failed to stamp lastPolledAt after poll error:', stampErr);
  }
}

/** One pass over everything due. Exported for one-shot runs and tests. */
export async function runTick(db: Db): Promise<void> {
  ohlcvFills = 0;
  const nowMs = Date.now();
  const due = (await loadCandidates(db)).filter((c) => isDue(c, nowMs));

  // Resolution and curve polls are the budget-capped tiers; a watched token is
  // the one we owe minute-scale alerts, so it takes those slots first.
  const watchedFirst = (a: Candidate, b: Candidate) => Number(b.watched) - Number(a.watched);
  const unresolved = due
    .filter((c) => c.token.phase === 'unresolved')
    .sort(watchedFirst)
    .slice(0, MAX_RESOLUTIONS_PER_TICK);
  const curve = due
    .filter((c) => c.token.phase === 'curve')
    .sort(watchedFirst)
    .slice(0, MAX_CURVE_TOKENS_PER_TICK);
  const graduated = due.filter((c) => c.token.phase === 'graduated');
  // Dead work is the least urgent; drain the backlog oldest-first over ticks
  // rather than letting it monopolize the GT budget in one.
  const dead = due
    .filter((c) => c.token.phase === 'dead')
    .sort((a, b) => {
      if (a.reviveRequested !== b.reviveRequested) return a.reviveRequested ? -1 : 1;
      return (a.token.lastPolledAt?.getTime() ?? 0) - (b.token.lastPolledAt?.getTime() ?? 0);
    })
    .slice(0, MAX_DEAD_POLLS_PER_TICK);

  // Resolution shares ONE `/tokens/multi` call (docs/decisions.md round 17b),
  // and the per-token handling behind it is unchanged.
  //
  // A failed batch defers the whole tier AND stamps it (round 17b review): the
  // realistic throw is the 429 that just parked the budgeter, and an unstamped
  // batch is due again 15 seconds later — so a single dud would buy a GT grant
  // per cooldown cycle for as long as the 429s last. Nothing else is written:
  // the wrong-chain check is not spent by a stamp any more, it simply runs on
  // the next attempt.
  //
  // An address the batch OMITS (a stage of resolveTokens failed under it) is
  // stamped like a failed batch: nothing was learned about it, but retrying at
  // tick rate would spend a fresh /tokens/multi grant every 15s for as long as
  // the failing stage stays down. Its own tier interval is the honest retry.
  if (unresolved.length > 0) {
    const batch = unresolved.map((c) => c.token);
    let resolutions: Map<string, Resolution> | undefined;
    try {
      resolutions = await resolveTokens(batch.map((t) => t.address));
    } catch (err) {
      console.warn('resolution batch failed, deferring:', err);
      await stampBatch(db, batch);
    }
    if (resolutions) {
      const omitted: TokenRow[] = [];
      for (const token of batch) {
        const pre = resolutions.get(token.address);
        if (!pre) {
          omitted.push(token);
          continue;
        }
        await isolate(db, [token], () => pollUnresolved(db, token, TICK_POLL, pre));
      }
      if (omitted.length > 0) {
        console.warn(`resolution: ${omitted.length} address(es) omitted by a failed stage, deferring`);
        await stampBatch(db, omitted);
      }
    }
  }
  if (curve.length > 0) {
    const batch = curve.map((c) => c.token);
    await isolate(db, batch, () => pollCurveBatch(db, batch, TICK_POLL));
  }
  for (let i = 0; i < graduated.length; i += 30) {
    const batch = graduated.slice(i, i + 30).map((c) => c.token);
    await isolate(db, batch, () => pollGraduatedBatch(db, batch, TICK_POLL));
  }
  // The corpses that are read off GeckoTerminal share one call too.
  //
  // The only realistic throw from that call is the 429 that just parked the
  // budgeter for 30s and doubled the gap, so falling back to one read per corpse
  // would hold the tick open for the cooldown plus a gap each — on the LEAST
  // urgent tier. Those corpses are deferred instead — and STAMPED, so the
  // oldest-first slice moves past them next tick rather than re-selecting and
  // re-dropping the same four for as long as the 429 lasts, which would starve
  // every DexScreener-read corpse queued behind them. A repost is the exception,
  // since its revival check is what the member is waiting on.
  let deadCurvePools: Map<string, gt.GtPoolInfo> | undefined;
  let deadBatch = dead;
  const readsCurvePool = (c: Candidate) => deadReadsCurve(c.token) && c.token.poolAddress !== null;
  const deadCurveAddresses = dead.filter(readsCurvePool).map((c) => c.token.poolAddress!);
  if (deadCurveAddresses.length > 0) {
    try {
      deadCurvePools = await gt.getPoolsMulti(deadCurveAddresses);
    } catch (err) {
      console.warn('dead-pool prefetch failed, deferring curve-read corpses:', err);
      deadBatch = dead.filter((c) => !readsCurvePool(c) || c.reviveRequested);
      for (const c of dead.filter((c) => readsCurvePool(c) && !c.reviveRequested)) {
        await isolate(db, [c.token], () => noReading(db, c.token));
      }
    }
  }
  for (const c of deadBatch) {
    await isolate(db, [c.token], () => pollDead(db, c.token, TICK_POLL, deadCurvePools));
  }

  // Judged on the data this tick just wrote. Never let it abort the tick: a
  // failed alert pass must not cost us the prune (or the next tick's cadence).
  try {
    await runAlertPass(db);
  } catch (err) {
    console.error('alert pass failed:', err);
  }

  await sweepRugs(db);
  // Deliberately not awaited — see scanSleepers.
  scanSleepers(db);
  await pruneSnapshots(db);
}

/** Immediate poll of one token — called by the bot on new calls and reposts of died tokens. */
export async function pollTokenNow(db: Db, tokenId: number): Promise<void> {
  const token = (await db.select().from(tokens).where(eq(tokens.id, tokenId)))[0];
  if (!token) return;
  if (token.phase === 'unresolved') await pollUnresolved(db, token, IMMEDIATE_POLL);
  else if (token.phase === 'curve') await pollCurve(db, token, IMMEDIATE_POLL);
  else if (token.phase === 'graduated') await pollGraduatedBatch(db, [token], IMMEDIATE_POLL);
  else await pollDead(db, token, IMMEDIATE_POLL);

  // Fresh data for one token: re-judge it now rather than waiting up to a tick.
  // runAlertPass is a no-op for a token nobody watches (one indexed lookup).
  try {
    await runAlertPass(db, [tokenId]);
  } catch (err) {
    console.error(`alert pass failed for token ${tokenId}:`, err);
  }
}

export function startPoller(db: Db): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await runTick(db);
    } catch (err) {
      console.error('poller tick failed:', err);
    } finally {
      running = false;
    }
  }, TICK_MS);
  console.log(`poller started (tick ${TICK_MS / 1000}s)`);
  return () => clearInterval(timer);
}
