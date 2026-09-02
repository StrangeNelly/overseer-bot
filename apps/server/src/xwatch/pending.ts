import { and, asc, eq, isNotNull, lte, sql } from 'drizzle-orm';
import { groups, launchCandidates, launchMonitors, type Db } from '@groupie/db';
import { POLL_TIERS, XWATCH } from '@groupie/shared';
import type { ChainClient } from '../chain/client.js';
import { fireLaunch, type FireOutcome } from './alerts.js';
import { summarizeXError } from './client.js';
import { confirmAddress, type ConfirmReason, type Confirmation } from './confirm.js';
import type { MonitorRow } from './monitors.js';
import { xwatchSettingsOf } from './settings.js';

/**
 * PENDING CONFIRMATIONS (docs/decisions.md round 23).
 *
 * A tracked account posts a contract address and the chain has not caught up
 * yet: GeckoTerminal has no pool, the node would not answer, the bytecode is a
 * block away. The first build treated that single miss as the verdict and said
 * nothing, ever — a launch announced four minutes before its pool indexed was
 * lost in silence, which is precisely the thing this feature exists to catch.
 *
 * So an unconfirmed post is a QUEUE ROW, not a shrug: `launch_candidates` of
 * kind 'posted', re-confirmed on the round-17b ladder (45s for fifteen minutes,
 * then five minutes for six hours, then hourly) until the post is older than
 * the launch window. UNKNOWN IS NEVER A VERDICT; only the two DEFINITIVE
 * rejections below leave the queue early.
 */

/** How long until the next confirmation attempt, measured from the POST. */
export function confirmIntervalSeconds(postedAt: Date | null, nowMs: number): number {
  const posted = postedAt?.getTime();
  // A row we cannot date is treated as brand new — the conservative answer, the
  // same one the poller's unresolved ladder gives an unreadable first_seen_at.
  if (posted === undefined || !Number.isFinite(posted)) return POLL_TIERS.freshSeconds;
  const minutes = (nowMs - posted) / 60_000;
  if (minutes < POLL_TIERS.unresolvedFastMinutes) return POLL_TIERS.freshSeconds;
  if (minutes < POLL_TIERS.unresolvedSlowHours * 60) return POLL_TIERS.activeSeconds;
  return POLL_TIERS.idleSeconds;
}

/**
 * Is this rejection worth stopping on?
 *
 * TWO are: a quote token/router/factory/burn address is never a launch, and a
 * token whose earliest evidence is over a day old is not the launch this post
 * announced. Both are statements about what the address IS, and neither can
 * become untrue while the queue is running.
 *
 * EVERYTHING ELSE STAYS. 'no_code' used to end a row a quarter of an hour after
 * the post, which is the one shape this queue exists to catch: a launch
 * announced before the deploy transaction lands reads as no bytecode, and a
 * node serving a stale block reads as no bytecode too. Only the 24h age-out
 * (isAgedOut) stops an address that never becomes a coin — an unreadable node,
 * an unindexed pool and a contract that has not answered `symbol()` yet are all
 * the absence of an answer, and unknown is never a verdict.
 */
export function isDefinitiveRejection(reason: ConfirmReason): boolean {
  return reason === 'known_contract' || reason === 'pool_too_old';
}

/** A post is past the launch window: nothing it announced can still be fresh. */
export function isAgedOut(postedAt: Date | null, nowMs: number): boolean {
  const posted = postedAt?.getTime();
  if (posted === undefined || !Number.isFinite(posted)) return false;
  return nowMs - posted > XWATCH.launchMaxPoolAgeHours * 3_600_000;
}

export type CandidateRow = typeof launchCandidates.$inferSelect;

export interface QueueParams {
  monitorId: number;
  address: string;
  symbol?: string | null;
  post: { id: string; url: string | null; createdAt: Date };
  reason: string;
  nowMs?: number;
}

/**
 * Record a post whose address has not confirmed, and schedule the retry.
 *
 * Upserts on (monitor, token): a Tier-B 'claims' row for the same coin is
 * UPGRADED in place when the account itself posts it — the account speaking is
 * strictly more than a stranger's claim, and two rows for one coin under one
 * project would say the same thing twice.
 */
export async function queuePendingConfirmation(
  db: Db,
  params: QueueParams,
): Promise<void> {
  const nowMs = params.nowMs ?? Date.now();
  const address = params.address.toLowerCase();
  const nextAt = new Date(nowMs + confirmIntervalSeconds(params.post.createdAt, nowMs) * 1000);
  await db
    .insert(launchCandidates)
    .values({
      monitorId: params.monitorId,
      tokenAddress: address,
      symbol: params.symbol ?? null,
      kind: 'posted',
      postId: params.post.id,
      postUrl: params.post.url,
      postedAt: params.post.createdAt,
      attempts: 1,
      nextAttemptAt: nextAt,
      lastReason: params.reason,
    })
    .onConflictDoUpdate({
      target: [launchCandidates.monitorId, launchCandidates.tokenAddress],
      set: {
        kind: 'posted',
        postId: params.post.id,
        postUrl: params.post.url,
        postedAt: params.post.createdAt,
        // The row's own counter, not ours: a second sighting of the same post is
        // still one more attempt against this address.
        attempts: sql`${launchCandidates.attempts} + 1`,
        nextAttemptAt: nextAt,
        lastReason: params.reason,
      },
    });
}

/** The rows due a retry, oldest due first. */
export async function duePendingConfirmations(
  db: Db,
  nowMs: number,
  limit: number = XWATCH.pendingPerPass,
): Promise<CandidateRow[]> {
  return db
    .select()
    .from(launchCandidates)
    .where(
      and(
        eq(launchCandidates.kind, 'posted'),
        isNotNull(launchCandidates.nextAttemptAt),
        lte(launchCandidates.nextAttemptAt, new Date(nowMs)),
      ),
    )
    .orderBy(asc(launchCandidates.nextAttemptAt))
    .limit(limit);
}

/** The instant the next attempt is due, measured from the POST as the ladder is. */
function nextRung(postedAt: Date | null, nowMs: number): Date {
  return new Date(nowMs + confirmIntervalSeconds(postedAt, nowMs) * 1000);
}

/** Stamp an attempt. A null `nextAttemptAt` finishes the row for good. */
async function settle(
  db: Db,
  id: number,
  reason: string,
  nextAttemptAt: Date | null,
): Promise<void> {
  await db
    .update(launchCandidates)
    .set({
      attempts: sql`${launchCandidates.attempts} + 1`,
      lastReason: reason,
      nextAttemptAt,
    })
    .where(eq(launchCandidates.id, id));
}

export interface PendingDeps {
  chain: ChainClient | null;
  nowMs?: number;
  /** Injected for tests; production confirms against the chain and the market. */
  confirm?: (address: string, postedAt: Date) => Promise<Confirmation>;
  /** Injected for tests; production takes the normal fire path. */
  fire?: typeof fireLaunch;
}

export interface PendingPassResult {
  attempted: number;
  fired: number;
  stopped: number;
}

/**
 * One pass of the retry queue: confirm what is due, fire what confirms, and
 * leave what is still unknown scheduled for the next rung of the ladder.
 */
export async function runPendingConfirmations(
  db: Db,
  deps: PendingDeps,
): Promise<PendingPassResult> {
  const nowMs = deps.nowMs ?? Date.now();
  const rows = await duePendingConfirmations(db, nowMs);
  const out: PendingPassResult = { attempted: 0, fired: 0, stopped: 0 };
  const confirm =
    deps.confirm ??
    ((address: string, postedAt: Date) =>
      confirmAddress(address, postedAt, { chain: deps.chain, db, nowMs }));
  const fire = deps.fire ?? fireLaunch;

  for (const row of rows) {
    out.attempted += 1;
    const postedAt = row.postedAt;
    // THE WHOLE ROW IS ISOLATED. Every statement below can fail — the monitor
    // read, the group read, the fire path, the delete — and a throw escaping
    // here would abandon every row still queued behind this one AND take the
    // housekeeping tick with it. One row's bad minute is one row's.
    try {
      if (isAgedOut(postedAt, nowMs)) {
        // Left on the board as a candidate, exactly as it is: the account did
        // post this address, and that stays true whether or not it ever became
        // a coin.
        await settle(db, row.id, 'aged_out', null);
        out.stopped += 1;
        continue;
      }

      const monitor = (
        await db
          .select()
          .from(launchMonitors)
          .where(eq(launchMonitors.id, row.monitorId))
          .limit(1)
      )[0] as MonitorRow | undefined;
      if (!monitor || monitor.status !== 'active') {
        // Untracked, expired, or already launched on another address: there is
        // nothing left for this row to become.
        await settle(db, row.id, 'monitor_inactive', null);
        out.stopped += 1;
        continue;
      }

      let confirmation: Confirmation;
      try {
        confirmation = await confirm(row.tokenAddress, postedAt ?? new Date(nowMs));
      } catch (err) {
        // A thrown read is UNKNOWN, and unknown is retried.
        const detail = err instanceof Error ? err.name : 'error';
        await settle(db, row.id, `error:${detail}`, nextRung(postedAt, nowMs));
        continue;
      }

      if (!confirmation.ok) {
        const reason: ConfirmReason = confirmation.reason;
        if (isDefinitiveRejection(reason)) {
          await settle(db, row.id, reason, null);
          out.stopped += 1;
          continue;
        }
        await settle(db, row.id, reason, nextRung(postedAt, nowMs));
        continue;
      }

      const group = (
        await db
          .select({ settings: groups.settings, status: groups.status })
          .from(groups)
          .where(eq(groups.id, monitor.groupId))
      )[0];
      if (!group || group.status !== 'active') {
        await settle(db, row.id, 'group_inactive', null);
        out.stopped += 1;
        continue;
      }

      const outcome: FireOutcome = await fire(db, {
        monitor,
        token: confirmation.token,
        post: {
          id: row.postId ?? '',
          url: row.postUrl,
          createdAt: postedAt ?? new Date(nowMs),
        },
        settings: xwatchSettingsOf(group.settings),
        nowMs,
      });
      // The launch is the monitor's now — the project row carries it, and a
      // candidate saying the same thing would be the same coin twice.
      await db.delete(launchCandidates).where(eq(launchCandidates.id, row.id));
      out.fired += 1;
      console.log(`xwatch: ${monitor.xHandle} -> ${row.tokenAddress} confirmed on retry (${outcome})`);
    } catch (err) {
      // A LAUNCH POST IS NEVER SILENCED BY A TRANSIENT FAILURE. The row goes
      // back on the ladder with the failure named, so the next rung tries it
      // again; only the age-out and the two definitive rejections end a row.
      console.error(`xwatch: pending row ${row.id} failed: ${summarizeXError(err)}`);
      const detail = err instanceof Error ? err.name : 'error';
      await settle(db, row.id, `error:${detail}`, nextRung(postedAt, nowMs)).catch((settleErr) => {
        // Even the stamp would not write: the row keeps the schedule it has, and
        // the queue moves on to the next one rather than losing the pass.
        console.error(`xwatch: pending row ${row.id} could not be settled: ${summarizeXError(settleErr)}`);
      });
    }
  }
  return out;
}
