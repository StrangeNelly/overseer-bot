import { and, eq, gte, inArray, isNotNull, isNull, max, ne, sql } from 'drizzle-orm';
import { alerts, groups, snapshots, tokens, watches, type Db } from '@groupie/db';
import type { AlertSettings, AlertType } from '@groupie/shared';
import { publish } from '../events.js';
import {
  alertMessage,
  alertSettingsOf,
  evaluateAlerts,
  tokenLabel,
  underCooldown,
  type AlertSnapshot,
} from './alertLogic.js';

/**
 * The watchlist alert pass: runs at the end of every poller tick (and right
 * after an immediate poll of a watched token), judges each active watch against
 * its group's settings, and fires at most one alert per (token, type, cooldown).
 *
 * Sending is NOT done here — the pass publishes `alert_fired` and index.ts's
 * subscriber owns Telegram, so a slow or failing send can never stall the tick.
 */

const MINUTE_MS = 60_000;

interface WatchRow {
  watchId: number;
  groupId: number;
  groupSettings: unknown;
  tokenId: number;
  symbol: string | null;
  address: string;
  mcapUsd: number | null;
  liquidityUsd: number | null;
  /** watches.mcap_at_watch — the buy-opp baseline, null until measured. */
  mcapAtWatch: number | null;
  /** watches.buy_opp_armed — whether this fall may still fire (round 19). */
  buyOppArmed: boolean;
}

// db.execute bypasses Drizzle's column decoders, so postgres-js hands these
// back as strings (timestamptz, double precision) — coerce at the read site.
type SeriesRow = {
  token_id: number | string;
  at: Date | string;
  mcap_usd: number | string | null;
} & Record<string, unknown>;

type BaselineRow = {
  group_id: number | string;
  token_id: number | string;
  mcap_at_watch: number | string | null;
} & Record<string, unknown>;

/** A watch, identified the way the alert pass carries it: group AND token. */
function baselineKey(groupId: number, tokenId: number): string {
  return `${groupId}:${tokenId}`;
}

async function loadWatches(db: Db, tokenIds?: number[]): Promise<WatchRow[]> {
  return db
    .select({
      watchId: watches.id,
      groupId: watches.groupId,
      groupSettings: groups.settings,
      tokenId: tokens.id,
      symbol: tokens.symbol,
      address: tokens.address,
      mcapUsd: tokens.mcapUsd,
      liquidityUsd: tokens.liquidityUsd,
      mcapAtWatch: watches.mcapAtWatch,
      buyOppArmed: watches.buyOppArmed,
    })
    .from(watches)
    .innerJoin(tokens, eq(tokens.id, watches.tokenId))
    .innerJoin(groups, eq(groups.id, watches.groupId))
    .where(
      and(
        eq(watches.active, true),
        // A dead coin cannot nuke or set up: death detection owns it, and the
        // died board says so without a chat message.
        ne(tokens.phase, 'dead'),
        eq(groups.status, 'active'),
        tokenIds === undefined ? undefined : inArray(tokens.id, tokenIds),
      ),
    );
}

/**
 * One query for every watched token: the RAW snapshots inside the series window
 * (speed matters, so the nuke rule never sees averaged data). Round 19 left the
 * nuke rule as the only reader — buy-opp is judged against the watch baseline
 * and its armed flag, not against the series — so the window is exactly the
 * widest nuke window in play.
 */
async function loadSeries(
  db: Db,
  tokenIds: number[],
  sinceMs: number,
): Promise<Map<number, AlertSnapshot[]>> {
  const byToken = new Map<number, AlertSnapshot[]>();
  if (tokenIds.length === 0) return byToken;

  const where = and(
    inArray(snapshots.tokenId, tokenIds),
    gte(snapshots.at, new Date(sinceMs)),
    isNotNull(snapshots.mcapUsd),
  );

  const rows = await db.execute<SeriesRow>(sql`
    select ${snapshots.tokenId} as token_id,
           ${snapshots.at} as at,
           ${snapshots.mcapUsd} as mcap_usd
    from ${snapshots}
    where ${where}
    order by token_id, at
  `);

  for (const row of rows) {
    if (row.mcap_usd === null) continue;
    const mcapUsd = Number(row.mcap_usd);
    const atMs = new Date(row.at).getTime();
    const tokenId = Number(row.token_id);
    if (!Number.isFinite(mcapUsd) || !Number.isFinite(atMs) || !Number.isFinite(tokenId)) continue;
    const list = byToken.get(tokenId) ?? [];
    list.push({ atMs, mcapUsd });
    byToken.set(tokenId, list);
  }
  return byToken;
}

/**
 * Fill in the buy-opp baseline for watches that were taken before we had a
 * market cap for the coin (round 19): the mcap of the FIRST snapshot at or
 * after the watch was activated — the same honesty as mcap-at-call, and the
 * closest measurement to the moment the member asked for the coin.
 *
 * ONE statement, and idempotent by construction: `mcap_at_watch is null` means
 * a stamped baseline is never rewritten, so a watch keeps the number it was
 * taken at however often this runs. A watch with no reading yet simply matches
 * no row and stays null until the poller writes one.
 *
 * Returns what it filled, keyed `group:token`, so this pass can judge the watch
 * it just stamped instead of waiting for the next one.
 *
 * Exported for tests: the guarantees are in the statement it builds.
 */
export async function backfillBaselines(db: Db, tokenIds: number[]): Promise<Map<string, number>> {
  const filled = new Map<string, number>();
  if (tokenIds.length === 0) return filled;
  const scope = and(
    eq(watches.active, true),
    isNull(watches.mcapAtWatch),
    inArray(watches.tokenId, tokenIds),
  );
  // A correlated scalar subquery, NOT a FROM/LATERAL join: Postgres hides the
  // UPDATE target from subqueries in the FROM list, so `watches` may only be
  // named from SET and WHERE. The EXISTS repeats it because a scalar subquery
  // that finds nothing yields NULL, which would "fill" the baseline with null
  // and return a row saying so.
  const firstReading = sql`(
      select ${snapshots.mcapUsd}
      from ${snapshots}
      where ${snapshots.tokenId} = ${watches.tokenId}
        and ${snapshots.at} >= ${watches.addedAt}
        and ${snapshots.mcapUsd} is not null
        and ${snapshots.mcapUsd} > 0
      order by ${snapshots.at}
      limit 1
    )`;
  const rows = await db.execute<BaselineRow>(sql`
    update ${watches}
    set mcap_at_watch = ${firstReading}
    where ${scope}
      and exists ${firstReading}
    returning ${watches.groupId} as group_id,
              ${watches.tokenId} as token_id,
              ${watches.mcapAtWatch} as mcap_at_watch
  `);
  for (const row of rows) {
    const mcapUsd = Number(row.mcap_at_watch);
    const key = baselineKey(Number(row.group_id), Number(row.token_id));
    if (Number.isFinite(mcapUsd) && mcapUsd > 0) filled.set(key, mcapUsd);
  }
  return filled;
}

function cooldownKey(groupId: number, tokenId: number, type: AlertType): string {
  return `${groupId}:${tokenId}:${type}`;
}

/** Newest fire per (group, token, type) within the widest cooldown in play. */
async function loadLastFired(
  db: Db,
  groupIds: number[],
  tokenIds: number[],
  sinceMs: number,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (groupIds.length === 0 || tokenIds.length === 0) return out;
  const rows = await db
    .select({
      groupId: alerts.groupId,
      tokenId: alerts.tokenId,
      type: alerts.type,
      lastFiredAt: max(alerts.firedAt),
    })
    .from(alerts)
    .where(
      and(
        inArray(alerts.groupId, groupIds),
        inArray(alerts.tokenId, tokenIds),
        gte(alerts.firedAt, new Date(sinceMs)),
      ),
    )
    .groupBy(alerts.groupId, alerts.tokenId, alerts.type);
  for (const row of rows) {
    if (!row.lastFiredAt) continue;
    out.set(cooldownKey(row.groupId, row.tokenId, row.type), row.lastFiredAt.getTime());
  }
  return out;
}

interface AlertInsert {
  groupId: number;
  tokenId: number;
  type: AlertType;
  mcapUsd: number;
  cooldownMin: number;
  details: Record<string, unknown>;
}

/**
 * Insert guarded by its own cooldown in ONE statement: the JS check upstream
 * avoids the round-trip, this makes the decision atomic, so two overlapping
 * passes (a tick and an immediate poll, or two deploy-overlap instances) cannot
 * both post the same alert. No row inserted = nothing delivered.
 */
async function insertAlert(db: Db, row: AlertInsert, nowMs: number): Promise<boolean> {
  const notFiredRecently = sql`not exists (
    select 1 from ${alerts}
    where ${and(
      eq(alerts.groupId, row.groupId),
      eq(alerts.tokenId, row.tokenId),
      eq(alerts.type, row.type),
      gte(alerts.firedAt, new Date(nowMs - row.cooldownMin * MINUTE_MS)),
    )}
  )`;
  // Every value is cast explicitly: parameters in an INSERT ... SELECT are not
  // resolved from the target columns, so an uncast one arrives as text.
  const inserted = await db.execute<{ id: number | string }>(sql`
    insert into ${alerts} (group_id, token_id, type, mcap_usd, details)
    select ${row.groupId}::int,
           ${row.tokenId}::int,
           ${row.type}::text,
           ${row.mcapUsd}::double precision,
           ${JSON.stringify(row.details)}::jsonb
    where ${notFiredRecently}
    returning id
  `);
  return inserted.length > 0;
}

/**
 * Persist the buy-opp armed flags this pass changed: one statement per value,
 * for every watch that moved to it. The WHERE guard makes each write a no-op
 * when the row is already there, so two overlapping passes reaching the same
 * verdict cost one update between them; the per-(group, token, type) cooldown
 * stays the backstop for anything the flags cannot serialize.
 */
async function persistArmed(db: Db, transitions: Map<boolean, number[]>): Promise<void> {
  for (const [armed, watchIds] of transitions) {
    if (watchIds.length === 0) continue;
    await db
      .update(watches)
      .set({ buyOppArmed: armed })
      .where(and(inArray(watches.id, watchIds), ne(watches.buyOppArmed, armed)));
  }
}

/**
 * Evaluate every active watch (optionally narrowed to `tokenIds`) and fire the
 * alerts that clear their cooldown. Returns how many fired.
 */
export async function runAlertPass(db: Db, tokenIds?: number[]): Promise<number> {
  const watchRows = await loadWatches(db, tokenIds);
  if (watchRows.length === 0) return 0;

  // A watch taken on a coin we had no price for yet gets its baseline from the
  // first reading after it (round 19). Only asked when something actually needs
  // one, and the filled values come back with the write so this pass can judge
  // the watch it just stamped.
  const unbaselined = [
    ...new Set(watchRows.filter((r) => r.mcapAtWatch === null).map((r) => r.tokenId)),
  ];
  if (unbaselined.length > 0) {
    const filled = await backfillBaselines(db, unbaselined);
    for (const row of watchRows) {
      if (row.mcapAtWatch !== null) continue;
      row.mcapAtWatch = filled.get(baselineKey(row.groupId, row.tokenId)) ?? null;
    }
  }

  const nowMs = Date.now();
  const settingsByGroup = new Map<number, AlertSettings>();
  for (const row of watchRows) {
    if (!settingsByGroup.has(row.groupId)) {
      settingsByGroup.set(row.groupId, alertSettingsOf(row.groupSettings));
    }
  }
  const inPlay = [...settingsByGroup.values()];
  // One series load covers every group's window, so it must span the widest of
  // each: a stricter group simply ignores the extra history.
  const windowMinutes = Math.max(...inPlay.map((s) => s.nukeWindowMin));
  const sinceMs = nowMs - windowMinutes * MINUTE_MS;

  const watchedTokenIds = [...new Set(watchRows.map((r) => r.tokenId))];
  const series = await loadSeries(db, watchedTokenIds, sinceMs);

  interface Pending extends AlertInsert {
    message: string;
  }
  const pending: Pending[] = [];
  // Watch ids whose armed flag this pass changed, by the value it changed to.
  const armedTransitions = new Map<boolean, number[]>();
  for (const row of watchRows) {
    const settings = settingsByGroup.get(row.groupId);
    if (!settings) continue;
    const verdict = evaluateAlerts({
      nowMs,
      currentMcapUsd: row.mcapUsd,
      recentSnapshots: series.get(row.tokenId) ?? [],
      settings,
      mcapAtWatch: row.mcapAtWatch,
      buyOppArmed: row.buyOppArmed,
    });
    if (verdict.buyOppArmed !== row.buyOppArmed) {
      const ids = armedTransitions.get(verdict.buyOppArmed) ?? [];
      ids.push(row.watchId);
      armedTransitions.set(verdict.buyOppArmed, ids);
    }
    for (const candidate of verdict.candidates) {
      // evaluateAlerts only returns candidates with a usable current mcap.
      const currentMcapUsd = row.mcapUsd ?? 0;
      // What the drop is measured from, and the evidence stored with it: a nuke
      // points at the window peak it fell from, a buy-opp at the watch baseline
      // (round 19 — the peak fields are gone from buy_opp rows entirely).
      const evidence =
        candidate.type === 'nuke'
          ? {
              fromMcapUsd: candidate.peakMcapUsd,
              peakAtMs: candidate.peakAtMs,
              details: {
                peakMcapUsd: candidate.peakMcapUsd,
                peakAt: new Date(candidate.peakAtMs).toISOString(),
              },
            }
          : {
              fromMcapUsd: candidate.mcapAtWatch,
              peakAtMs: undefined,
              details: { mcapAtWatch: candidate.mcapAtWatch },
            };
      const message = alertMessage(candidate.type, {
        label: tokenLabel(row.symbol, row.address),
        dropPct: candidate.dropPct,
        fromMcapUsd: evidence.fromMcapUsd,
        currentMcapUsd,
        peakAtMs: evidence.peakAtMs,
        nowMs,
        liquidityUsd: row.liquidityUsd,
      });
      pending.push({
        groupId: row.groupId,
        tokenId: row.tokenId,
        type: candidate.type,
        mcapUsd: currentMcapUsd,
        cooldownMin: settings.cooldownMin,
        message,
        details: {
          dropPct: candidate.dropPct,
          ...evidence.details,
          liquidityUsd: row.liquidityUsd,
          message,
        },
      });
    }
  }
  await persistArmed(db, armedTransitions);
  if (pending.length === 0) return 0;

  const widestCooldownMin = Math.max(...inPlay.map((s) => s.cooldownMin));
  const lastFired = await loadLastFired(
    db,
    [...new Set(pending.map((p) => p.groupId))],
    [...new Set(pending.map((p) => p.tokenId))],
    nowMs - widestCooldownMin * MINUTE_MS,
  );

  let fired = 0;
  for (const alert of pending) {
    const last = lastFired.get(cooldownKey(alert.groupId, alert.tokenId, alert.type)) ?? null;
    if (underCooldown(last, nowMs, alert.cooldownMin)) continue;
    if (!(await insertAlert(db, alert, nowMs))) continue;
    fired += 1;
    publish({
      type: 'alert_fired',
      groupId: alert.groupId,
      tokenId: alert.tokenId,
      alertType: alert.type,
      message: alert.message,
    });
    console.log(`alert ${alert.type} group ${alert.groupId}: ${alert.message}`);
  }
  return fired;
}
