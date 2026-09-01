import { and, eq, gte, inArray, isNotNull, lt, max, ne, sql } from 'drizzle-orm';
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
const HOUR_MS = 3_600_000;

/**
 * Older-than-the-nuke-window snapshots are collapsed to 5-minute bucket MAXIMA
 * (see loadSeries). Only the buy-opp peak reads that region, and a max-per-
 * bucket preserves the true peak exactly while cutting ~1,900 rows/token/24h
 * down to ~290 — the pass runs every 15s.
 */
const PEAK_BUCKET_SECONDS = sql.raw('300');

interface WatchRow {
  groupId: number;
  groupSettings: unknown;
  tokenId: number;
  symbol: string | null;
  address: string;
  mcapUsd: number | null;
  liquidityUsd: number | null;
}

// db.execute bypasses Drizzle's column decoders, so postgres-js hands these
// back as strings (timestamptz, double precision) — coerce at the read site.
type SeriesRow = {
  token_id: number | string;
  at: Date | string;
  mcap_usd: number | string | null;
} & Record<string, unknown>;

async function loadWatches(db: Db, tokenIds?: number[]): Promise<WatchRow[]> {
  return db
    .select({
      groupId: watches.groupId,
      groupSettings: groups.settings,
      tokenId: tokens.id,
      symbol: tokens.symbol,
      address: tokens.address,
      mcapUsd: tokens.mcapUsd,
      liquidityUsd: tokens.liquidityUsd,
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
 * One query for every watched token: RAW snapshots inside the widest nuke
 * window (speed matters, so the nuke rule never sees averaged data) plus
 * bucket-peak rows back to the widest buy-opp lookback.
 */
async function loadSeries(
  db: Db,
  tokenIds: number[],
  rawSinceMs: number,
  peakSinceMs: number,
): Promise<Map<number, AlertSnapshot[]>> {
  const byToken = new Map<number, AlertSnapshot[]>();
  if (tokenIds.length === 0) return byToken;

  const recentWhere = and(
    inArray(snapshots.tokenId, tokenIds),
    gte(snapshots.at, new Date(rawSinceMs)),
    isNotNull(snapshots.mcapUsd),
  );
  const olderWhere = and(
    inArray(snapshots.tokenId, tokenIds),
    gte(snapshots.at, new Date(peakSinceMs)),
    lt(snapshots.at, new Date(rawSinceMs)),
    isNotNull(snapshots.mcapUsd),
  );

  const rows = await db.execute<SeriesRow>(sql`
    with recent as (
      select ${snapshots.tokenId} as token_id,
             ${snapshots.at} as at,
             ${snapshots.mcapUsd} as mcap_usd
      from ${snapshots}
      where ${recentWhere}
    ),
    older as (
      select distinct on (token_id, bucket) token_id, at, mcap_usd
      from (
        select ${snapshots.tokenId} as token_id,
               ${snapshots.at} as at,
               ${snapshots.mcapUsd} as mcap_usd,
               floor(extract(epoch from ${snapshots.at}) / ${PEAK_BUCKET_SECONDS})::bigint as bucket
        from ${snapshots}
        where ${olderWhere}
      ) s
      order by token_id, bucket, mcap_usd desc
    )
    select token_id, at, mcap_usd from recent
    union all
    select token_id, at, mcap_usd from older
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
 * Evaluate every active watch (optionally narrowed to `tokenIds`) and fire the
 * alerts that clear their cooldown. Returns how many fired.
 */
export async function runAlertPass(db: Db, tokenIds?: number[]): Promise<number> {
  const watchRows = await loadWatches(db, tokenIds);
  if (watchRows.length === 0) return 0;

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
  const rawSinceMs = nowMs - Math.max(...inPlay.map((s) => s.nukeWindowMin)) * MINUTE_MS;
  const peakSinceMs = nowMs - Math.max(...inPlay.map((s) => s.buyPeakWindowHours)) * HOUR_MS;

  const watchedTokenIds = [...new Set(watchRows.map((r) => r.tokenId))];
  const series = await loadSeries(db, watchedTokenIds, rawSinceMs, peakSinceMs);

  interface Pending extends AlertInsert {
    message: string;
  }
  const pending: Pending[] = [];
  for (const row of watchRows) {
    const settings = settingsByGroup.get(row.groupId);
    if (!settings) continue;
    const candidates = evaluateAlerts({
      nowMs,
      currentMcapUsd: row.mcapUsd,
      recentSnapshots: series.get(row.tokenId) ?? [],
      settings,
    });
    for (const candidate of candidates) {
      // evaluateAlerts only returns candidates with a usable current mcap.
      const currentMcapUsd = row.mcapUsd ?? 0;
      const message = alertMessage(candidate.type, {
        label: tokenLabel(row.symbol, row.address),
        dropPct: candidate.dropPct,
        peakMcapUsd: candidate.peakMcapUsd,
        currentMcapUsd,
        peakAtMs: candidate.peakAtMs,
        nowMs,
        liquidityUsd: row.liquidityUsd,
        peakWindowHours: settings.buyPeakWindowHours,
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
          peakMcapUsd: candidate.peakMcapUsd,
          peakAt: new Date(candidate.peakAtMs).toISOString(),
          liquidityUsd: row.liquidityUsd,
          message,
        },
      });
    }
  }
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
