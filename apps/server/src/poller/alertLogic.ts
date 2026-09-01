import { ALERT_DEFAULTS, type AlertSettings, type AlertType } from '@groupie/shared';

/**
 * Watchlist alert rules (docs/decisions.md round 4). Two questions, both asked
 * of the same mcap series:
 *
 * - NUKE: did this coin drop hard AND fast? (raw 45s snapshots, minutes-scale)
 * - BUY OPP: has it retraced meaningfully from a peak it left SLOWLY? (hours)
 *
 * Everything here is pure: alerts.ts loads the series and owns cooldowns,
 * inserts and delivery; this file only judges numbers and writes the message.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/**
 * A nuke verdict off one or two readings is a data artefact, not a crash: a
 * single bad poll (dust pair, missing FDV) would otherwise page the group.
 */
const MIN_NUKE_SNAPSHOTS = 3;

/** One polled market cap. `atMs` is unix ms; snapshots arrive oldest-first. */
export interface AlertSnapshot {
  atMs: number;
  mcapUsd: number;
}

export interface AlertCandidate {
  type: AlertType;
  /** How far current sits below the peak, 0-100. */
  dropPct: number;
  peakMcapUsd: number;
  peakAtMs: number;
}

export interface EvaluateAlertsInput {
  nowMs: number;
  currentMcapUsd: number | null;
  recentSnapshots: AlertSnapshot[];
  settings: AlertSettings;
}

interface Peak {
  mcapUsd: number;
  atMs: number;
  count: number;
}

function usable(snapshot: AlertSnapshot): boolean {
  return (
    Number.isFinite(snapshot.atMs) && Number.isFinite(snapshot.mcapUsd) && snapshot.mcapUsd > 0
  );
}

/**
 * Highest mcap at or after `sinceMs`, plus how many readings back it.
 *
 * Ties keep the LATEST occurrence: a coin that sat at its high for an hour
 * started declining when it last left that high, and the buy-opp rule dates the
 * decline from exactly this timestamp.
 */
function peakSince(snapshots: AlertSnapshot[], sinceMs: number): Peak | null {
  let mcapUsd = -Infinity;
  let atMs = 0;
  let count = 0;
  for (const snapshot of snapshots) {
    if (snapshot.atMs < sinceMs) continue;
    count += 1;
    if (snapshot.mcapUsd >= mcapUsd) {
      mcapUsd = snapshot.mcapUsd;
      atMs = snapshot.atMs;
    }
  }
  return count === 0 ? null : { mcapUsd, atMs, count };
}

/** Drop from `peak` down to `current`, as a 0-100 percentage. */
function dropPct(currentMcapUsd: number, peakMcapUsd: number): number {
  return (1 - currentMcapUsd / peakMcapUsd) * 100;
}

function breaches(currentMcapUsd: number, peakMcapUsd: number, thresholdPct: number): boolean {
  return currentMcapUsd <= peakMcapUsd * (1 - thresholdPct / 100);
}

/**
 * Alerts this coin qualifies for right now, given the group's settings.
 *
 * Insufficient data never fires: no current mcap, fewer than three readings in
 * the nuke window, or nothing at all in the peak window each mean "we cannot
 * tell", not "no alert-worthy move happened".
 *
 * A crash in progress is NOT a buy signal, so the nuke condition suppresses
 * buy-opp — and it suppresses on the price condition alone, even when thin data
 * blocks the nuke alert itself. Both types together would mean a coin that
 * nuked in the last 15 minutes off a peak that is hours old; the guard is what
 * makes at most one of them true.
 */
export function evaluateAlerts(input: EvaluateAlertsInput): AlertCandidate[] {
  const { nowMs, currentMcapUsd, settings } = input;
  const out: AlertCandidate[] = [];
  // A zero/negative "market cap" is a bad reading, not a total collapse — death
  // detection owns the collapse case and has real evidence (liquidity) for it.
  if (currentMcapUsd === null || !Number.isFinite(currentMcapUsd) || currentMcapUsd <= 0) {
    return out;
  }
  const snapshots = input.recentSnapshots.filter(usable);

  const nukePeak = peakSince(snapshots, nowMs - settings.nukeWindowMin * MINUTE_MS);
  const nuking =
    nukePeak !== null && breaches(currentMcapUsd, nukePeak.mcapUsd, settings.nukeDropPct);
  if (nukePeak !== null && nuking && nukePeak.count >= MIN_NUKE_SNAPSHOTS) {
    out.push({
      type: 'nuke',
      dropPct: dropPct(currentMcapUsd, nukePeak.mcapUsd),
      peakMcapUsd: nukePeak.mcapUsd,
      peakAtMs: nukePeak.atMs,
    });
  }

  if (!nuking) {
    const buyPeak = peakSince(snapshots, nowMs - settings.buyPeakWindowHours * HOUR_MS);
    const oldEnough =
      buyPeak !== null && nowMs - buyPeak.atMs >= settings.buyMinDeclineHours * HOUR_MS;
    if (buyPeak !== null && oldEnough && breaches(currentMcapUsd, buyPeak.mcapUsd, settings.buyRetracePct)) {
      out.push({
        type: 'buy_opp',
        dropPct: dropPct(currentMcapUsd, buyPeak.mcapUsd),
        peakMcapUsd: buyPeak.mcapUsd,
        peakAtMs: buyPeak.atMs,
      });
    }
  }

  return out;
}

/**
 * Per (group, token, type) rate limit. A future-stamped last-fire (clock skew)
 * reads as "under cooldown": silence is the safe failure here.
 */
export function underCooldown(
  lastFiredAtMs: number | null,
  nowMs: number,
  cooldownMin: number,
): boolean {
  if (lastFiredAtMs === null || !Number.isFinite(lastFiredAtMs)) return false;
  return nowMs - lastFiredAtMs < cooldownMin * MINUTE_MS;
}

/* ------------------------------------------------------------------ settings */

/**
 * Bounds for every setting, enforced on both write (bot `set` commands) and
 * read (a hand-edited or legacy settings blob must never disable alerting or
 * make it fire on every tick).
 */
export const ALERT_LIMITS: Record<keyof AlertSettings, { min: number; max: number }> = {
  nukeDropPct: { min: 5, max: 95 },
  nukeWindowMin: { min: 5, max: 60 },
  buyRetracePct: { min: 5, max: 95 },
  buyPeakWindowHours: { min: 1, max: 48 },
  buyMinDeclineHours: { min: 0, max: 48 },
  cooldownMin: { min: 1, max: 1_440 },
};

/** Clamps into range; a non-finite value falls back to the default. */
export function clampAlertSetting(key: keyof AlertSettings, value: number): number {
  if (!Number.isFinite(value)) return ALERT_DEFAULTS[key];
  const { min, max } = ALERT_LIMITS[key];
  return Math.min(max, Math.max(min, value));
}

/**
 * Defaults with a partial override merged over them. `partial` is untrusted
 * jsonb, so every key is type-checked and clamped individually: one bad key
 * must not discard the group's other settings.
 */
export function mergeAlertSettings(partial: unknown): AlertSettings {
  const overrides =
    typeof partial === 'object' && partial !== null && !Array.isArray(partial)
      ? (partial as Record<string, unknown>)
      : {};
  const out = { ...ALERT_DEFAULTS } as AlertSettings;
  for (const key of Object.keys(ALERT_DEFAULTS) as Array<keyof AlertSettings>) {
    const raw = overrides[key];
    if (typeof raw !== 'number') continue;
    out[key] = clampAlertSetting(key, raw);
  }
  return out;
}

/** Effective settings for a group, from its whole `settings` jsonb. */
export function alertSettingsOf(groupSettings: unknown): AlertSettings {
  const root =
    typeof groupSettings === 'object' && groupSettings !== null && !Array.isArray(groupSettings)
      ? (groupSettings as Record<string, unknown>)
      : {};
  return mergeAlertSettings(root.alerts);
}

/* ------------------------------------------------------------------ messages */

function stripTrailingZero(s: string): string {
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

function compact(n: number): string {
  return n < 10 ? stripTrailingZero(n.toFixed(1)) : String(Math.round(n));
}

/**
 * `$541K`, `$1.2M`, `$820`, `—`. Mirrors apps/web/src/format.ts's fmtUsd so a
 * Telegram alert and the board card read the same; the web app is a separate
 * package that the server does not (and should not) import.
 */
export function fmtUsd(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  // Thresholds sit just under the round number so 999_600 reads "$1M".
  if (abs >= 999.5e6) return `${sign}$${compact(abs / 1e9)}B`;
  if (abs >= 999.5e3) return `${sign}$${compact(abs / 1e6)}M`;
  if (abs >= 999.5) return `${sign}$${compact(abs / 1e3)}K`;
  if (abs === 0) return '$0';
  if (abs < 0.01) return `${sign}<$0.01`;
  return `${sign}$${compact(abs)}`;
}

/** `14m`, `6h`, `2d` — an elapsed duration, never below 1m. */
export function fmtElapsed(ms: number): string {
  const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  const minutes = Math.max(1, Math.round(safe / MINUTE_MS));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(safe / HOUR_MS);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(safe / (24 * HOUR_MS))}d`;
}

/** `0x1234…cdef` — mirrors the web app's fallback for a symbol-less token. */
export function shortAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** How a token is named in Telegram: its symbol, or a short address. */
export function tokenLabel(symbol: string | null | undefined, address: string): string {
  const trimmed = symbol?.trim();
  return trimmed ? trimmed : shortAddress(address);
}

export interface AlertMessageArgs {
  /** Symbol when known, otherwise a shortened address. */
  label: string;
  dropPct: number;
  peakMcapUsd: number;
  currentMcapUsd: number;
  peakAtMs: number;
  nowMs: number;
  /** Nuke only: omitted or null prints no LP segment. */
  liquidityUsd?: number | null;
  /** Buy-opp: the lookback the peak was found in ("from 24h high"). */
  peakWindowHours?: number;
}

/**
 * The exact text posted into the group. Plain text with ONE leading emoji: no
 * markdown, so a symbol containing `*` or `_` can never break the send.
 */
export function alertMessage(type: AlertType, args: AlertMessageArgs): string {
  const pct = Math.round(Math.abs(args.dropPct));
  const elapsed = fmtElapsed(args.nowMs - args.peakAtMs);
  if (type === 'nuke') {
    const lp =
      typeof args.liquidityUsd === 'number' && Number.isFinite(args.liquidityUsd)
        ? ` · LP ${fmtUsd(args.liquidityUsd)}`
        : '';
    return (
      `🚨 NUKE: ${args.label} -${pct}% in ${elapsed} · ` +
      `${fmtUsd(args.peakMcapUsd)} → ${fmtUsd(args.currentMcapUsd)}${lp}`
    );
  }
  const window = Math.round(args.peakWindowHours ?? ALERT_DEFAULTS.buyPeakWindowHours);
  return (
    `🟢 BUY OPP: ${args.label} -${pct}% from ${window}h high ${fmtUsd(args.peakMcapUsd)} ` +
    `(peaked ${elapsed} ago) · now ${fmtUsd(args.currentMcapUsd)}`
  );
}
