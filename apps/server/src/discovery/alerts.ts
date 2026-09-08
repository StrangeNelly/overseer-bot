import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, sql } from 'drizzle-orm';
import {
  alerts,
  deployerWatches,
  discoveryAlertDecisions,
  discoveryEvents,
  groups,
  type Db,
} from '@groupie/db';
import {
  DEPLOYER_WATCH,
  DISCOVERY,
  DISCOVERY_DEFAULTS,
  WATCH_CAP_PER_MEMBER,
  type DeployerWatchStatus,
  type DiscoveryAlertType,
} from '@groupie/shared';
import { summarizeRpcError } from '../chain/client.js';
import { upsertToken } from '../bot/ingest.js';
import { publish } from '../events.js';
import { tokenLabel } from '../poller/alertLogic.js';
import { addWatch } from '../watchlist.js';
import {
  isTerminalRoad,
  markDeployerNotified,
  undeliveredHits,
  type DeployerHit,
  type DeployerWatchRow,
} from './deployerWatch.js';
import { deployerHitMessage } from './deployerMessage.js';
import { passesDiscoveryFilters, passesGraduationFloor } from './filters.js';
import { launchAlertQualifies } from './launchLogic.js';
import { discoveryMessage } from './message.js';
import { discoverySettingsOf } from './settings.js';

/**
 * Discovery chat alerts (docs/decisions.md rounds 18 and 20).
 *
 * A deliberate, capped exception to the near-silent-bot rule, like the watchlist
 * alerts — but a different family: there is no call to reply to, no token row to
 * point at, and no per-coin cooldown. What limits it is a per-hour ceiling
 * across BOTH kinds, so a busy launch hour cannot turn into a busy chat. The
 * overflow is not lost: it stays on the board, and the board says so per group.
 *
 * Every (event, group) considered here gets exactly ONE decision row — sent,
 * capped, filtered or stale. That row is what stops the pass reconsidering the
 * same pair forever, and it is what the board reads to answer "were we told
 * about this?", which is a per-group question the old global stamp could not
 * answer honestly.
 */

/** How many events one pass will consider. */
const PER_PASS = 20;
const HOUR_MS = 3_600_000;

type EventRow = typeof discoveryEvents.$inferSelect;

export type DeliveryOutcome = 'sent' | 'capped' | 'filtered' | 'stale';
export type InsertResult = 'inserted' | 'duplicate' | 'capped';

/**
 * Same lock namespace discipline as watchlist.ts: one member's watch adds are
 * serialized on a key nobody else uses, and one group's discovery sends are
 * serialized on this one. Distinct constant, so a busy chat cannot make a watch
 * button wait.
 */
const LOCK_NAMESPACE = sql.raw(String(0x0efc));

/**
 * Insert the alert, deciding the cap and the duplicate SEPARATELY so the caller
 * can tell "already delivered" from "over the ceiling" — the old boolean
 * conflated them, which meant a duplicate looked like a cap and kept the event
 * alive for another pass.
 *
 * Everything happens inside one transaction under a per-group advisory lock
 * (the watchlist's pattern), so two overlapping passes cannot both read a count
 * of 2 against a cap of 3 and both insert. The partial unique index on
 * (group_id, type, details->>'pool') is the belt to that braces: even a lock
 * that somehow did not hold cannot produce two messages about one pool.
 *
 * `token_id` is null on purpose: a discovery coin is not one of our tracked
 * tokens, and inserting a `tokens` row for it would put the poller to work
 * chasing a coin nobody called. `details.address` carries the coin instead.
 */
export async function insertDiscoveryAlert(
  db: Db,
  params: {
    groupId: number;
    type: DiscoveryAlertType;
    mcapUsd: number | null;
    poolAddress: string;
    alertsPerHour: number;
    details: Record<string, unknown>;
    nowMs: number;
  },
): Promise<InsertResult> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${LOCK_NAMESPACE}, hashtext(${`discovery:${params.groupId}`}))`,
    );

    const already = await tx
      .select({ id: alerts.id })
      .from(alerts)
      .where(
        and(
          eq(alerts.groupId, params.groupId),
          eq(alerts.type, params.type),
          sql`${alerts.details} ->> 'pool' = ${params.poolAddress}`,
        ),
      )
      .limit(1);
    if (already.length > 0) return 'duplicate' as const;

    const counted = await tx
      .select({ n: sql<string | number>`count(*)` })
      .from(alerts)
      .where(
        and(
          eq(alerts.groupId, params.groupId),
          sql`${alerts.type} in ('launch', 'graduation')`,
          gte(alerts.firedAt, new Date(params.nowMs - HOUR_MS)),
        ),
      );
    // count() is a bigint, which postgres-js hands over as a string.
    const fired = Number(counted[0]?.n ?? 0);
    if (!Number.isFinite(fired) || fired >= params.alertsPerHour) return 'capped' as const;

    const written = await tx
      .insert(alerts)
      .values({
        groupId: params.groupId,
        tokenId: null,
        type: params.type,
        mcapUsd: params.mcapUsd,
        details: params.details,
      })
      // The partial unique index decides this, not the SELECT above: a lost
      // race lands here and is reported as the duplicate it is.
      .onConflictDoNothing()
      .returning({ id: alerts.id });
    return written.length > 0 ? ('inserted' as const) : ('duplicate' as const);
  });
}

/** Whether this event, as enriched, earns THIS group a message. */
export function qualifiesForChat(
  row: Pick<
    EventRow,
    | 'kind'
    | 'twitterUrl'
    | 'websiteUrl'
    | 'isStock'
    | 'launchBlockPct'
    | 'initialLiquidityEth'
    | 'mcapUsd'
  >,
  settings: { launchMinEth: number; gradsOn: boolean },
): boolean {
  if (!passesDiscoveryFilters(row, DISCOVERY_DEFAULTS.bundleMaxPct)) return false;
  if (row.kind === 'graduation') {
    // Round 22: a graduation that has fallen back under the floor is not news,
    // and the board is not showing it either. An UNKNOWN reading changes
    // nothing here — it is not evidence of anything, so the group's own
    // graduation switch stays the only question.
    if (!passesGraduationFloor(row)) return false;
    return settings.gradsOn;
  }
  return launchAlertQualifies(row.initialLiquidityEth, settings.launchMinEth);
}

/** File the decision. Idempotent: a pair is decided once and stays decided. */
async function recordDecision(
  db: Db,
  eventId: number,
  groupId: number,
  outcome: DeliveryOutcome,
): Promise<void> {
  await db
    .insert(discoveryAlertDecisions)
    .values({ eventId, groupId, outcome })
    .onConflictDoNothing({
      target: [discoveryAlertDecisions.eventId, discoveryAlertDecisions.groupId],
    });
}

/**
 * One delivery pass. Returns how many chat messages were queued.
 *
 * The candidate set is "enriched, no older than DISCOVERY.maxAlertAgeMinutes,
 * and not yet decided for this group". Fifteen minutes rather than the previous
 * sixty is what keeps a restart's backfill out of the chat — a launch nobody
 * could still act on is not news — and it is the only age gate: graduations are
 * deliberately NOT gated on collection age, because the board wants the whole
 * 24h stream after a restart even though the chat hears about none of it.
 */
export async function deliverDiscoveryAlerts(db: Db): Promise<number> {
  const nowMs = Date.now();
  const activeGroups = await db
    .select({ id: groups.id, settings: groups.settings })
    .from(groups)
    .where(eq(groups.status, 'active'));
  if (activeGroups.length === 0) return 0;

  const groupIds = activeGroups.map((g) => g.id);
  // The id list is built one parameter at a time rather than handed over as an
  // array: this is a raw fragment, and an array bound whole would arrive as a
  // single value rather than as an IN list.
  const groupIdList = sql.join(
    groupIds.map((id) => sql`${id}::int`),
    sql`, `,
  );
  const rows = await db
    .select()
    .from(discoveryEvents)
    .where(
      and(
        isNotNull(discoveryEvents.enrichedAt),
        gte(discoveryEvents.at, new Date(nowMs - DISCOVERY.maxAlertAgeMinutes * 60_000)),
        lte(discoveryEvents.at, new Date(nowMs)),
        // Anything every active group has already been answered about is done.
        sql`(
          select count(*) from ${discoveryAlertDecisions}
          where ${discoveryAlertDecisions.eventId} = ${discoveryEvents.id}
            and ${discoveryAlertDecisions.groupId} in (${groupIdList})
        ) < ${groupIds.length}`,
      ),
    )
    // NEWEST first: "$SYM launched" is worth saying about a pool minutes old and
    // worth nothing about one from the far end of the window. A row that loses
    // its place in a burst is reconsidered next pass, and ages out of the
    // window if it never qualifies.
    .orderBy(sql`${discoveryEvents.at} desc`)
    .limit(PER_PASS);
  if (rows.length === 0) return 0;

  // Which (event, group) pairs are already answered — one query, not one per
  // pair. Rows outside this set are the ones this pass owes a decision.
  const decided = new Set<string>();
  const decisions = await db
    .select({
      eventId: discoveryAlertDecisions.eventId,
      groupId: discoveryAlertDecisions.groupId,
    })
    .from(discoveryAlertDecisions)
    .where(
      and(
        inArray(
          discoveryAlertDecisions.eventId,
          rows.map((r) => r.id),
        ),
        inArray(discoveryAlertDecisions.groupId, groupIds),
      ),
    );
  for (const row of decisions) decided.add(`${row.eventId}:${row.groupId}`);

  let fired = 0;
  let posted = false;
  for (const row of rows) {
    for (const group of activeGroups) {
      if (decided.has(`${row.id}:${group.id}`)) continue;
      const settings = discoverySettingsOf(group.settings);
      if (!qualifiesForChat(row, settings)) {
        await recordDecision(db, row.id, group.id, 'filtered');
        continue;
      }
      // A muted group builds no message at all: the cheapest correct answer to
      // "post nothing" is not to compose it.
      if (!(settings.alertsPerHour > 0)) {
        await recordDecision(db, row.id, group.id, 'capped');
        continue;
      }
      const message = discoveryMessage(row.kind, {
        label: tokenLabel(row.symbol, row.tokenAddress),
        dex: row.dex,
        initialLiquidityEth: row.initialLiquidityEth,
        initialLiquidityUsd: row.initialLiquidityUsd,
        quoteSymbol: row.quoteSymbol,
        mcapUsd: row.mcapUsd,
        liquidityUsd: row.liquidityUsd,
        lpLockedPct: row.lpLockedPct,
        launchBlockPct: row.launchBlockPct,
        launchBlockWallets: row.launchBlockWallets,
        twitterUrl: row.twitterUrl,
        websiteUrl: row.websiteUrl,
      });
      const result = await insertDiscoveryAlert(db, {
        groupId: group.id,
        type: row.kind,
        mcapUsd: row.mcapUsd,
        poolAddress: row.poolAddress,
        alertsPerHour: settings.alertsPerHour,
        details: {
          kind: row.kind,
          pool: row.poolAddress,
          address: row.tokenAddress,
          dex: row.dex,
          initialLiquidityEth: row.initialLiquidityEth,
          // Both figures, because which one was MEASURED depends on the quote:
          // a USDG launch's dollars are the reading and its ETH is derived, so
          // a details blob carrying only ETH would misdescribe half the stream.
          initialLiquidityUsd: row.initialLiquidityUsd,
          quoteSymbol: row.quoteSymbol,
          launchBlockPct: row.launchBlockPct,
          launchBlockWallets: row.launchBlockWallets,
          message,
        },
        nowMs,
      });
      if (result === 'capped') {
        // Over the hourly ceiling. The decision is filed all the same: the
        // event stays on the board saying this group was not told, and a
        // quieter hour never revives an alert nobody can act on any more.
        await recordDecision(db, row.id, group.id, 'capped');
        continue;
      }
      await recordDecision(db, row.id, group.id, 'sent');
      if (result === 'duplicate') continue;
      posted = true;
      fired += 1;
      publish({
        type: 'alert_fired',
        groupId: group.id,
        tokenId: null,
        alertType: row.kind,
        message,
      });
      console.log(`alert ${row.kind} group ${group.id}: ${message}`);
    }
    if (posted) {
      // Operator-facing only (the served flag is per group, off the decisions).
      await db
        .update(discoveryEvents)
        .set({ alertedAt: new Date() })
        .where(and(eq(discoveryEvents.id, row.id), sql`${discoveryEvents.alertedAt} is null`));
      posted = false;
    }
  }
  return fired;
}

/**
 * How far back the stale sweep looks. Anything older than this was retired by an
 * earlier pass — or was never considered at all, during an outage longer than
 * this, and then carries NO decision row. That reads identically on the board
 * (no 'sent' decision means the group was not told), so widening this window
 * would buy nothing and cost a bigger scan every pass.
 */
const STALE_SWEEP_HOURS = 6;

/**
 * Close the books on events that aged out of the alert window without a
 * decision, so the board can say "this group was never told" as a recorded fact
 * rather than as an absence. One insert-select, on the enrichment loop.
 *
 * Not load-bearing for delivery: the 15-minute window in the query above is
 * already what stops an old event being reconsidered.
 */
export async function retireStaleDiscoveryAlerts(db: Db): Promise<void> {
  const nowMs = Date.now();
  // No bare Date inside raw SQL: ISO string plus an explicit cast, so the
  // parameter cannot arrive as text the planner has to guess at.
  const cutoff = new Date(nowMs - DISCOVERY.maxAlertAgeMinutes * 60_000).toISOString();
  const floor = new Date(nowMs - STALE_SWEEP_HOURS * 3_600_000).toISOString();
  await db.execute(sql`
    insert into ${discoveryAlertDecisions} (event_id, group_id, outcome)
    select e.id, g.id, 'stale'
    from ${discoveryEvents} e
    cross join ${groups} g
    where g.status = 'active'
      and e.at < ${cutoff}::timestamptz
      and e.at >= ${floor}::timestamptz
    on conflict (event_id, group_id) do nothing
  `);
}

/* ------------------------------------------- deployer watch (round 26) */

/**
 * The deployer watch's write path and its one chat message (docs/decisions.md
 * round 26). It lives here rather than in bot.ts because BOTH surfaces need it —
 * the chat commands add and remove watches, the board reads the same list — and
 * because this file already owns discovery's "write the alert row first, then
 * say it out loud" discipline, which is exactly what a fire needs.
 *
 * The DETECTION half is discovery/deployerWatch.ts: it owns the four roads (the
 * PONS topic match inside the existing sweep, pool attribution, the CREATE nonce
 * probe, and a registry's TokenSet) and hands this file only the hits it has
 * already WON — the status flip to 'fired' is what claims one, so nothing here
 * re-flips a row or decides whether a hit happened.
 */

/**
 * The alert type this feature writes. In the `alerts` enum since round 26, with
 * the partial unique index (`alerts_deployer_uq` on (group_id, type,
 * details->>'watched', details->>'address', details->>'via')) that makes a
 * second send impossible — see the schema, and the recovery sweep below, which
 * is only safe because of it. The SIGNAL is in that key: a 'create' hit carries
 * the predicted contract as its address, so without `via` the same wallet's
 * later launch of that very contract would be refused as a duplicate and the
 * group would never hear about the launch it was promised.
 */
const DEPLOYER_ALERT_TYPE = 'deployer_launch' satisfies (typeof alerts.$inferInsert)['type'];

/**
 * Statuses that hold one of the group's slots. Only 'active' does: a 'fired'
 * watch has said its piece and a 'removed' one is off the list, and counting
 * either would tell a member their board is full of finished work.
 */
const DEPLOYER_OCCUPYING: readonly DeployerWatchStatus[] = ['active'];

/**
 * Same advisory-lock discipline as watchlist.ts, xwatch/monitors.ts and the
 * discovery sends above, on a namespace nobody else uses: one GROUP's deployer
 * adds are serialised, so two clients cannot both read eleven against a cap of
 * twelve.
 */
const DEPLOYER_LOCK_NAMESPACE = sql.raw(String(0x0eff));

/**
 * Whether this group wants the deployer message in the chat.
 *
 * DEFAULT ON, which no other discovery-family alert is: the owner asked for this
 * feature as "notify me in the telegram group as soon as its launched", so
 * silence by default would ship the opposite of the request. It stays inside the
 * near-silent-bot rule because it is one message per watch, ever, about an
 * address a member typed in themselves. `/overseer set deployerping off` is the
 * way out, and the board keeps the row either way.
 */
export function deployerPingOf(settings: unknown): boolean {
  if (typeof settings !== 'object' || settings === null) return true;
  const branch = (settings as { deployer?: unknown }).deployer;
  if (typeof branch !== 'object' || branch === null) return true;
  const ping = (branch as { ping?: unknown }).ping;
  return typeof ping === 'boolean' ? ping : true;
}

export type DeployerAddOutcome =
  | { ok: true; watch: DeployerWatchRow; heldByMember: number; reactivated: boolean }
  /** Already watched and still live — nothing to do, and nothing broken. */
  | { ok: false; reason: 'duplicate' }
  | { ok: false; reason: 'cap_group'; cap: number }
  | { ok: false; reason: 'cap_member'; cap: number };

export interface AddDeployerParams {
  groupId: number;
  userId: number;
  /** Lowercase 0x-prefixed 40-hex. */
  address: string;
  kind: 'eoa' | 'contract';
  note?: string | null;
  /**
   * The wallet's CURRENT nonce, read once at add time — the high-water mark the
   * CREATE scan probes ABOVE. Null when it could not be read (and always on a
   * contract watch): the first scan takes the mark instead, and until it does
   * nothing can fire on that road. Never defaulted to zero — probing from zero
   * would "find" every contract the wallet has ever deployed and announce them
   * all as launches.
   */
  lastNonce?: number | null;
  nonceCheckedAt?: Date | null;
}

/**
 * Add a watch. Idempotent by (group, address): a live one is reported as the
 * duplicate it is, and a 'removed' or 'fired' row is REUSED — nonce mark
 * re-stamped, launch history cleared — exactly the way trackMonitor reuses a
 * removed monitor. Re-adding a FIRED watch is how a member says "that wallet is
 * going to do it again", and the row that watches for the next coin must not
 * still be carrying the last one's details.
 */
export async function addDeployerWatch(
  db: Db,
  params: AddDeployerParams,
): Promise<DeployerAddOutcome> {
  const address = params.address.toLowerCase();
  const note = params.note?.trim() ? params.note.trim().slice(0, 280) : null;
  const addedAt = new Date();

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${DEPLOYER_LOCK_NAMESPACE}, hashtext(${`deployer:${params.groupId}`}))`,
    );

    const existing = (
      await tx
        .select()
        .from(deployerWatches)
        .where(
          and(
            eq(deployerWatches.groupId, params.groupId),
            sql`lower(${deployerWatches.address}) = ${address}`,
          ),
        )
        .limit(1)
    )[0];
    if (existing && existing.status === 'active') return { ok: false, reason: 'duplicate' } as const;

    const held = await tx
      .select({ addedBy: deployerWatches.addedBy })
      .from(deployerWatches)
      .where(
        and(
          eq(deployerWatches.groupId, params.groupId),
          inArray(deployerWatches.status, [...DEPLOYER_OCCUPYING]),
        ),
      );
    if (held.length >= DEPLOYER_WATCH.capPerGroup) {
      return { ok: false, reason: 'cap_group', cap: DEPLOYER_WATCH.capPerGroup } as const;
    }
    const mine = held.filter((r) => Number(r.addedBy) === params.userId).length;
    if (mine >= DEPLOYER_WATCH.capPerMember) {
      return { ok: false, reason: 'cap_member', cap: DEPLOYER_WATCH.capPerMember } as const;
    }

    const values = {
      groupId: params.groupId,
      address,
      kind: params.kind,
      addedBy: params.userId,
      addedAt,
      note,
      status: 'active' as const,
      lastNonce: params.lastNonce ?? null,
      nonceCheckedAt: params.nonceCheckedAt ?? null,
    };

    if (existing) {
      const updated = await tx
        .update(deployerWatches)
        .set({
          ...values,
          // A fresh watch, not a resumed one: every field describing the LAST
          // launch goes, so the board never shows this watch pointing at a coin
          // it is no longer watching for — `notified_at` among them, because a
          // row that is armed again owes the chat nothing yet and the recovery
          // sweep reads exactly "fired, and never told".
          firedAddress: null,
          firedTokenId: null,
          firedAt: null,
          firedVia: null,
          firedTxHash: null,
          notifiedAt: null,
        })
        .where(eq(deployerWatches.id, existing.id))
        .returning();
      const watch = updated[0];
      if (!watch) return { ok: false, reason: 'duplicate' } as const;
      return { ok: true, watch, heldByMember: mine + 1, reactivated: true } as const;
    }

    const inserted = await tx.insert(deployerWatches).values(values).returning();
    const watch = inserted[0];
    // Lost a race for the same address despite the lock (another process, no
    // lock): the unique index held, and "already watched" is the honest answer.
    if (!watch) return { ok: false, reason: 'duplicate' } as const;
    return { ok: true, watch, heldByMember: mine + 1, reactivated: false } as const;
  });
}

/**
 * Stop watching. Any member may, whoever added it — the same group-wide rule
 * binning, un-watching and untracking follow. Idempotent, and honest about it:
 * a row already removed reports that nothing was stopped.
 */
export async function removeDeployerWatch(
  db: Db,
  groupId: number,
  address: string,
): Promise<DeployerWatchRow | undefined> {
  const stopped = await db
    .update(deployerWatches)
    .set({ status: 'removed' })
    .where(
      and(
        eq(deployerWatches.groupId, groupId),
        sql`lower(${deployerWatches.address}) = ${address.toLowerCase()}`,
        ne(deployerWatches.status, 'removed'),
      ),
    )
    .returning();
  return stopped[0];
}

/** One group's watches, newest activity first (the chat list and the board). */
export async function listDeployerWatches(db: Db, groupId: number): Promise<DeployerWatchRow[]> {
  return db
    .select()
    .from(deployerWatches)
    .where(and(eq(deployerWatches.groupId, groupId), ne(deployerWatches.status, 'removed')))
    .orderBy(
      desc(sql`coalesce(${deployerWatches.firedAt}, ${deployerWatches.addedAt})`),
      desc(deployerWatches.id),
    );
}

/** Slots held on this board, and how many of them are one member's. */
export function countDeployerSlots(
  rows: readonly Pick<DeployerWatchRow, 'status' | 'addedBy'>[],
  userId?: number,
): { used: number; usedByMe: number } {
  let used = 0;
  let usedByMe = 0;
  for (const row of rows) {
    if (!DEPLOYER_OCCUPYING.includes(row.status as DeployerWatchStatus)) continue;
    used += 1;
    if (userId !== undefined && Number(row.addedBy) === userId) usedByMe += 1;
  }
  return { used, usedByMe };
}

/**
 * What we already know about the address that just appeared. A JOIN, never a new
 * market call: the discovery stream has a row for anything that opened a pool
 * recently, and an absent row simply drops the clauses — which is the normal
 * case on the 'create' road, where nothing is tradeable yet.
 */
interface FiredMarket {
  symbol: string | null;
  name: string | null;
  mcapUsd: number | null;
  liquidityUsd: number | null;
  dex: string | null;
  at: Date | null;
}

/** What an unreadable event knows about the market: nothing, and it says so. */
const EMPTY_MARKET: FiredMarket = {
  symbol: null,
  name: null,
  mcapUsd: null,
  liquidityUsd: null,
  dex: null,
  at: null,
};

async function firedMarket(db: Db, address: string): Promise<FiredMarket> {
  const rows = await db
    .select({
      symbol: discoveryEvents.symbol,
      name: discoveryEvents.name,
      mcapUsd: discoveryEvents.mcapUsd,
      liquidityUsd: discoveryEvents.liquidityUsd,
      dex: discoveryEvents.dex,
      at: discoveryEvents.at,
    })
    .from(discoveryEvents)
    .where(eq(discoveryEvents.tokenAddress, address.toLowerCase()))
    .orderBy(desc(discoveryEvents.at))
    .limit(1);
  const row = rows[0];
  return {
    symbol: row?.symbol ?? null,
    name: row?.name ?? null,
    mcapUsd: row?.mcapUsd ?? null,
    liquidityUsd: row?.liquidityUsd ?? null,
    dex: row?.dex ?? null,
    at: row?.at ?? null,
  };
}

/**
 * Point the fired row at the coin, so the board can NAME it.
 *
 * Guarded twice, and both guards are about a re-add landing between the flip
 * and this write: `status = 'fired'` because a re-armed watch is watching for
 * the NEXT coin and must not be labelled with the last one, and
 * `fired_token_id is null` so a re-delivery cannot overwrite a stamp that is
 * already there. A brand-new coin's `tokens` row has no symbol until the poller
 * enriches it — the board fills in on the next read, which is honest rather
 * than instant.
 */
async function stampFiredToken(db: Db, watchId: number, tokenId: number): Promise<void> {
  await db
    .update(deployerWatches)
    .set({ firedTokenId: tokenId })
    .where(
      and(
        eq(deployerWatches.id, watchId),
        eq(deployerWatches.status, 'fired'),
        isNull(deployerWatches.firedTokenId),
      ),
    );
}

export type DeployerDeliveryOutcome =
  | 'sent'
  /** This group turned the message off; the fired row is still on the board. */
  | 'muted'
  /** An alert for this (group, watched address, contract) already exists. */
  | 'duplicate'
  /** The group is gone, or the bot was removed from it. */
  | 'inactive';

/**
 * Tell the chat about hits the detection pass has already won.
 *
 * THE ALERT ROW IS THE AUTHORITY: written FIRST, and published only when the
 * insert actually happened — round 23's rule for round 23's reason. The row is
 * the record that the chat was told, and the partial unique index on (group,
 * type, watched, address, via) is what makes a second send impossible whatever
 * two passes decide.
 *
 * Every hit is isolated: a throw loses that hit's message and nothing else, and
 * no other hit in the batch is implicated.
 *
 * A DEALT-WITH ROW IS STAMPED, whatever the outcome — told, muted, already told
 * or nowhere to post. That stamp is what `undeliveredHits` reads: the flip to
 * 'fired' happens in the detection pass and cannot be re-won, so without a
 * record of the telling a message lost to a throw or a redeploy would be lost
 * for good. A TERMINAL hit that THREW is deliberately left unstamped so the
 * sweep picks it up again.
 *
 * A 'CREATE' THAT THREW IS LOST, and knowingly so: that road claims no row for
 * the sweep to find, and its dedupe is the CREATE scan's nonce mark, which was
 * advanced before delivery and never re-probes an answered nonce. The price of
 * the alternative — holding the mark back until the message lands — is
 * re-probing and re-announcing on every restart, which is a worse failure for
 * the weakest signal in the feature. The launch itself is unaffected: roads 1,
 * 2 and 4 are still watching, and they are the ones the group is waiting on.
 */
export async function deliverDeployerHits(
  db: Db,
  hits: readonly DeployerHit[],
  nowMs: number = Date.now(),
): Promise<number> {
  let sent = 0;
  for (const hit of hits) {
    try {
      if ((await deliverDeployerHit(db, hit, nowMs)) === 'sent') sent += 1;
      // The 'create' road claims no row (deployerWatch.ts), so there is nothing
      // to stamp and nothing for the sweep to recover: its dedupe is the CREATE
      // scan's forward-only nonce mark.
      if (isTerminalRoad(hit.via)) await markDeployerNotified(db, hit.watchId);
    } catch (err) {
      // Summarised, never the raw error: a provider error carries the
      // API-keyed request URL in its message and metaMessages.
      console.error(
        `deployer alert failed for watch ${hit.watchId}: ${summarizeRpcError(err)}`,
      );
    }
  }
  return sent;
}

/**
 * The lost messages, re-sent. Runs on the enrichment loop, off the block path.
 *
 * A watch is CLAIMED inside the block range that found it and told immediately
 * after, but those are two writes: a 429 on the next range, a cursor write that
 * failed, or a redeploy in between leaves a row that says 'fired' and a chat
 * that was never told — and the `status='active'` guard means no later pass can
 * re-win the same evidence. This is the only thing that closes that gap.
 *
 * Safe to re-run by construction: `alerts_deployer_uq` turns a second attempt
 * at the same (group, watched, contract) into 'duplicate', which is stamped and
 * sends nothing.
 */
export async function recoverDeployerHits(db: Db, nowMs: number = Date.now()): Promise<number> {
  const lost = await undeliveredHits(db, nowMs);
  if (lost.length === 0) return 0;
  console.warn(`deployer watch: re-delivering ${lost.length} hit(s) whose message was lost`);
  return deliverDeployerHits(db, lost, nowMs);
}

async function deliverDeployerHit(
  db: Db,
  hit: DeployerHit,
  nowMs: number,
): Promise<DeployerDeliveryOutcome> {
  const group = (
    await db
      .select({ status: groups.status, settings: groups.settings })
      .from(groups)
      .where(eq(groups.id, hit.groupId))
  )[0];
  // Removed from the chat since the watch was added: nowhere to post.
  if (!group || group.status !== 'active') return 'inactive';

  // NULL is a real answer here (deployerWatch.ts): a registry event whose
  // parameter layout we cannot decode still fired, and the chat is told with the
  // transaction hash instead of an address we would have to invent.
  const address = hit.tokenAddress === null ? null : hit.tokenAddress.toLowerCase();
  const watched = hit.watchedAddress.toLowerCase();
  // The token row first, on the roads that have proved there is one: it is what
  // the poller and the board point at, and it exists whether or not the insert
  // below turns out to be the winner. BEFORE the mute check, because a group
  // that reads the board instead of the chat is still owed the coin's name.
  // `isTerminalRoad` is the same question asked once: the three roads that
  // RETIRE a watch are exactly the three that have proved a coin exists. A raw
  // CREATE has not — bytecode at a predicted address is a contract, and the
  // motivating case (the @clubytech registry, `token()` still empty three days
  // after its deploy) is precisely a deployment that is not a token — so it gets
  // the message and nothing else: no `tokens` row for the poller to chase for a
  // day, and no watch slot spent on something nobody can trade. A member who
  // decides it IS the coin pastes it in the chat and it becomes an ordinary call.
  const token =
    address !== null && isTerminalRoad(hit.via) ? await upsertToken(db, address) : null;
  if (token !== null) await stampFiredToken(db, hit.watchId, token.id);

  if (!deployerPingOf(group.settings)) {
    console.log(
      `deployer hit ${hit.watchedAddress} -> ${hit.tokenAddress} (group ${hit.groupId}): board only, ping off`,
    );
    return 'muted';
  }

  const market = address === null ? EMPTY_MARKET : await firedMarket(db, address);
  const note =
    (
      await db
        .select({ note: deployerWatches.note })
        .from(deployerWatches)
        .where(eq(deployerWatches.id, hit.watchId))
    )[0]?.note ?? null;

  const message = deployerHitMessage({
    via: hit.via,
    watchedAddress: watched,
    address,
    symbol: market.symbol ?? token?.symbol ?? null,
    name: market.name,
    mcapUsd: market.mcapUsd ?? token?.mcapUsd ?? null,
    liquidityUsd: market.liquidityUsd,
    tokenCreatedAt: market.at,
    launchpad: market.dex,
    txHash: hit.txHash,
    note,
    nowMs,
  });

  const written = await db
    .insert(alerts)
    .values({
      groupId: hit.groupId,
      // Null on the 'create' road, exactly like a discovery alert: there is no
      // tokens row, because nothing has proved this address is a coin.
      tokenId: token?.id ?? null,
      type: DEPLOYER_ALERT_TYPE,
      mcapUsd: market.mcapUsd,
      details: {
        watched,
        address,
        via: hit.via,
        watchId: hit.watchId,
        txHash: hit.txHash,
        message,
      },
    })
    .onConflictDoNothing()
    .returning({ id: alerts.id });
  if (written.length === 0) {
    // The index refused it: this (group, watched, contract, signal) has been
    // said. Logged rather than returned in silence — a message this feature
    // decided NOT to send is the one thing that is invisible from the chat.
    console.log(
      `deployer hit ${hit.via}: ${watched} -> ${address} (group ${hit.groupId}): already told`,
    );
    return 'duplicate';
  }

  publish({
    type: 'alert_fired',
    groupId: hit.groupId,
    tokenId: token?.id ?? null,
    alertType: 'deployer_launch',
    message,
  });

  // Auto-watch under the ADDER's slot, on the roads that produced a coin. A full
  // slot list is never a reason to withhold the news (round 23's rule), so the
  // refusal is logged and the message stands.
  if (token !== null) {
    const adder = Number(hit.addedBy);
    const outcome = await addWatch(db, hit.groupId, token.id, adder, WATCH_CAP_PER_MEMBER);
    if (!outcome.ok) {
      console.log(
        `deployer hit: ${watched} — auto-watch skipped, member ${adder} holds ${outcome.cap} slots`,
      );
    }
  }
  console.log(`deployer hit ${hit.via}: ${watched} -> ${address} (group ${hit.groupId})`);
  return 'sent';
}
