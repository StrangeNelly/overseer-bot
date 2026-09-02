import { and, eq, gte, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { alerts, discoveryAlertDecisions, discoveryEvents, groups, type Db } from '@groupie/db';
import { DISCOVERY, DISCOVERY_DEFAULTS, type DiscoveryAlertType } from '@groupie/shared';
import { publish } from '../events.js';
import { tokenLabel } from '../poller/alertLogic.js';
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
