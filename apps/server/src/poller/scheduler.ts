import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { calls, snapshots, tokens, watches, type Db } from '@groupie/db';
import { IDLE_AFTER_HOURS, POLL_TIERS, SNAPSHOT_RETENTION, THRESHOLDS } from '@groupie/shared';
import { publish } from '../events.js';
import * as ds from '../market/dexscreener.js';
import * as gt from '../market/geckoterminal.js';
import { mcapAtTimestamp, resolveToken } from '../market/resolve.js';
import type { MarketSnapshot } from '../market/types.js';
import { runAlertPass } from './alerts.js';
import { callLiquidityDeath, classifyTokenDeath, isRevived } from './death.js';
import { markTokenDead } from './markDead.js';
import { runProbationSweep } from './rugSweep.js';

const TICK_MS = 15_000;
/** Caps per tick, sized to GeckoTerminal's 25-30/min budget. */
const MAX_RESOLUTIONS_PER_TICK = 6;
const MAX_CURVE_POLLS_PER_TICK = 10;
const MAX_DEAD_POLLS_PER_TICK = 4;
const MAX_OHLCV_FILLS_PER_TICK = 5;

const PRUNE_INTERVAL_MS = 3_600_000;
/** Every probation verdict covers hours of history; asking every tick would just re-ask it. */
const RUG_SWEEP_INTERVAL_MS = 600_000;

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

interface Candidate {
  token: TokenRow;
  lastActivityMs: number;
  reviveRequested: boolean;
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
    watched: r.watched === true,
  }));
}

function isDue(c: Candidate, nowMs: number): boolean {
  const last = c.token.lastPolledAt?.getTime() ?? 0;
  if (c.token.phase === 'dead') {
    return c.reviveRequested || nowMs - last >= POLL_TIERS.deadSeconds * 1000;
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

/** Write one poll result: snapshot row, cached market state, peaks, deaths. */
async function applySnapshot(
  db: Db,
  token: TokenRow,
  snap: MarketSnapshot,
  opts: PollOpts,
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
  if (snap.liquidityUsd !== null && token.phase === 'graduated') {
    const collapsed = await db
      .select({ id: calls.id, liquidityAtCall: calls.liquidityAtCall })
      .from(calls)
      .where(and(eq(calls.tokenId, token.id), eq(calls.status, 'active')));
    for (const call of collapsed) {
      if (callLiquidityDeath(call.liquidityAtCall, snap.liquidityUsd)) {
        // The token is still alive, so only the call carries this death: stamp
        // it here or the board has no date/reason to show or sort by.
        await db
          .update(calls)
          .set({ status: 'died', diedAt: new Date(), deathReason: 'call_liquidity_collapse' })
          .where(eq(calls.id, call.id));
      }
    }
  }

  // Reposts of a call that died on its own liquidity ask for a revive check;
  // the token itself is alive, so pollDead never sees these. Runs after the
  // death pass above so a still-collapsed call isn't flipped and re-killed.
  await applyCallRevivals(db, token, snap);

  publish({ type: 'price_update', tokenId: token.id, mcapUsd: snap.mcapUsd });
}

async function applyCallRevivals(db: Db, token: TokenRow, snap: MarketSnapshot): Promise<void> {
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
    if (callLiquidityDeath(call.liquidityAtCall, snap.liquidityUsd)) continue;
    // diedAt/deathReason stay as the call's last-death record (same convention
    // as tokens.died_at/death_reason); the next death overwrites them.
    await db.update(calls).set({ status: 'active' }).where(eq(calls.id, call.id));
    publish({ type: 'call_revived', tokenId: token.id, callId: call.id });
  }
}

/**
 * Instant death from one reading. Retracing to the curve floor is deliberately
 * NOT here any more (docs/decisions.md round 6) — the rug sweep hides those,
 * with a comeback path — so this no longer needs the token's all-time peak.
 */
async function checkDeath(db: Db, token: TokenRow, snap: MarketSnapshot | null): Promise<void> {
  const reason = classifyTokenDeath({ phase: token.phase, ageHours: ageHours(token) }, snap);
  if (reason) await markTokenDead(db, token, reason);
}

async function pollUnresolved(db: Db, token: TokenRow, opts: PollOpts): Promise<void> {
  const resolved = await resolveToken(token.address);
  if (!resolved) {
    await db.update(tokens).set({ lastPolledAt: new Date() }).where(eq(tokens.id, token.id));
    await checkDeath(db, token, null);
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
  await applySnapshot(db, fresh, resolved.snapshot, opts);
  await checkDeath(db, fresh, resolved.snapshot);
  publish({ type: 'token_resolved', tokenId: token.id, symbol: resolved.symbol });
  console.log(
    `resolved ${resolved.symbol ?? token.address} (${resolved.phase}) mcap=$${Math.round(resolved.snapshot.mcapUsd ?? 0).toLocaleString()}`,
  );
}

async function pollCurve(db: Db, token: TokenRow, opts: PollOpts): Promise<void> {
  if (!token.poolAddress) {
    await pollUnresolved(db, token, opts); // re-resolve to find the pool
    return;
  }
  const pool = await gt.getPool(token.poolAddress);
  if (!pool) {
    await db.update(tokens).set({ lastPolledAt: new Date() }).where(eq(tokens.id, token.id));
    return;
  }
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
  await applySnapshot(db, token, snap, opts);
  await checkDeath(db, token, snap);
}

/**
 * DexScreener returns ONE best pair per token, and for a curve-phase or thinly
 * traded token that can be a parasitic dust pool with an absurd FDV. A drained
 * pool at the token's OWN address must still flow through — that is the death
 * signal — so only a different, dust-thin, wildly-repriced pair is rejected.
 */
function isSuspiciousPair(token: TokenRow, pair: ds.DsPair): boolean {
  return (
    pair.pairAddress !== token.poolAddress &&
    (pair.liquidityUsd ?? 0) < THRESHOLDS.dustLiquidityUsd &&
    token.mcapUsd !== null &&
    (pair.mcapUsd ?? 0) > 20 * token.mcapUsd
  );
}

async function pollGraduatedBatch(db: Db, batch: TokenRow[], opts: PollOpts): Promise<void> {
  const pairs = await ds.getBestPairs(batch.map((t) => t.address));
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
    await applySnapshot(db, token, snap, opts);
    await checkDeath(db, token, snap);
  }
}

async function pollDead(db: Db, token: TokenRow, opts: PollOpts): Promise<void> {
  // 'rug_floor' can kill either phase, so it identifies neither on its own: a
  // token with no graduation on record was still on its curve, and a curve
  // pool is a GeckoTerminal read (its DexScreener "best pair" is dust at best).
  // 'curve_floor' is no longer produced (round 6 retired it), but rows written
  // before that still carry it and must still route to the curve read.
  const wasCurve =
    token.deathReason === 'curve_floor' ||
    token.deathReason === 'never_graduated' ||
    (token.deathReason === 'rug_floor' && token.graduatedAt === null);
  let snap: MarketSnapshot | null = null;
  let pool: gt.GtPoolInfo | null = null;
  if (wasCurve && token.poolAddress) {
    pool = await gt.getPool(token.poolAddress);
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
    await applySnapshot(db, { ...token, phase } as TokenRow, snap, opts);
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
 * One unit of tick work. A thrown poll must not abort the rest of the tick, and
 * stamping lastPolledAt keeps a poisoned token on its tier cadence instead of
 * letting it re-fail at the head of every tick and starve everything behind it.
 */
async function isolate(db: Db, batch: TokenRow[], run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    console.error(`poll failed for ${batch.map((t) => t.address).join(', ')}:`, err);
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
    .slice(0, MAX_CURVE_POLLS_PER_TICK);
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

  for (const c of unresolved) {
    await isolate(db, [c.token], () => pollUnresolved(db, c.token, TICK_POLL));
  }
  for (const c of curve) await isolate(db, [c.token], () => pollCurve(db, c.token, TICK_POLL));
  for (let i = 0; i < graduated.length; i += 30) {
    const batch = graduated.slice(i, i + 30).map((c) => c.token);
    await isolate(db, batch, () => pollGraduatedBatch(db, batch, TICK_POLL));
  }
  for (const c of dead) await isolate(db, [c.token], () => pollDead(db, c.token, TICK_POLL));

  // Judged on the data this tick just wrote. Never let it abort the tick: a
  // failed alert pass must not cost us the prune (or the next tick's cadence).
  try {
    await runAlertPass(db);
  } catch (err) {
    console.error('alert pass failed:', err);
  }

  await sweepRugs(db);
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
