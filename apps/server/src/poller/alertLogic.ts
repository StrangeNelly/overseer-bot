import { ALERT_DEFAULTS, type AlertSettings, type AlertType } from '@groupie/shared';

/**
 * Watchlist alert rules (docs/decisions.md rounds 4 and 19). Two questions,
 * asked of the same mcap series but from different reference points:
 *
 * - NUKE: did this coin drop hard AND fast? (raw 45s snapshots, minutes-scale)
 * - BUY OPP: is it far enough below the mcap it had WHEN THE WATCH WAS SET?
 *
 * Round 19 moved buy-opp off the peak: a retrace from a high nobody was
 * watching is trivia, while a drawdown from the member's own entry point is the
 * thing they asked to hear about. So the baseline is `mcapAtWatch`, not a peak,
 * and the alert fires ONCE per fall below the line: the caller carries an armed
 * flag (watches.buy_opp_armed), this file says what it should be next, and a
 * recovery above the line re-arms it. The state is explicit rather than read
 * off the last two readings because a polling gap, or a pass where the nuke
 * guard suppresses the message, must not silently consume the fall.
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

/**
 * What fired, and what it is measured against. The two types answer different
 * questions, so they carry different evidence: a nuke points at the peak it
 * fell from (and when), a buy-opp at the watch baseline (which has no reading
 * of its own — it is the number the watch was taken at).
 */
export type AlertCandidate =
  | {
      type: 'nuke';
      /** How far current sits below the peak, 0-100. */
      dropPct: number;
      peakMcapUsd: number;
      peakAtMs: number;
    }
  | {
      type: 'buy_opp';
      /** How far current sits below the watch baseline, 0-100. */
      dropPct: number;
      mcapAtWatch: number;
    };

export interface EvaluateAlertsInput {
  nowMs: number;
  currentMcapUsd: number | null;
  recentSnapshots: AlertSnapshot[];
  settings: AlertSettings;
  /**
   * Market cap when the watch was activated (watches.mcap_at_watch). Null =
   * we never measured one, and buy-opp stays silent rather than guessing a
   * baseline out of the series.
   */
  mcapAtWatch?: number | null;
  /** watches.buy_opp_armed as it stands now. */
  buyOppArmed: boolean;
}

/** What the pass should do, and what it should remember afterwards. */
export interface AlertVerdict {
  candidates: AlertCandidate[];
  /**
   * The armed state to persist. Unchanged whenever the rule could not judge
   * the coin at all (bad reading, no baseline): an unjudged pass must not
   * spend the group's one message for this fall.
   */
  buyOppArmed: boolean;
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
 * Ties keep the LATEST occurrence: the nuke message dates the drop from when
 * the coin last left its window high.
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

/** Drop from `from` down to `current`, as a 0-100 percentage. */
function dropPct(currentMcapUsd: number, fromMcapUsd: number): number {
  return (1 - currentMcapUsd / fromMcapUsd) * 100;
}

function breaches(currentMcapUsd: number, fromMcapUsd: number, thresholdPct: number): boolean {
  return currentMcapUsd <= fromMcapUsd * (1 - thresholdPct / 100);
}

/**
 * Alerts this coin qualifies for right now, plus the armed state to remember.
 *
 * Insufficient data never fires and never moves the state: no current mcap, no
 * watch baseline, or fewer than three readings in the nuke window each mean
 * "we cannot tell", not "no alert-worthy move happened".
 *
 * A crash in progress is NOT a buy signal, so the nuke condition suppresses
 * buy-opp — and it suppresses on the price condition alone, even when thin data
 * blocks the nuke alert itself. The watch stays ARMED through that suppression,
 * so the fall still gets its one message once the crash stops being one.
 */
export function evaluateAlerts(input: EvaluateAlertsInput): AlertVerdict {
  const { nowMs, currentMcapUsd, settings, buyOppArmed } = input;
  const candidates: AlertCandidate[] = [];
  // A zero/negative "market cap" is a bad reading, not a total collapse — death
  // detection owns the collapse case and has real evidence (liquidity) for it.
  if (currentMcapUsd === null || !Number.isFinite(currentMcapUsd) || currentMcapUsd <= 0) {
    return { candidates, buyOppArmed };
  }
  const snapshots = input.recentSnapshots.filter(usable);

  const nukePeak = peakSince(snapshots, nowMs - settings.nukeWindowMin * MINUTE_MS);
  const nuking =
    nukePeak !== null && breaches(currentMcapUsd, nukePeak.mcapUsd, settings.nukeDropPct);
  if (nukePeak !== null && nuking && nukePeak.count >= MIN_NUKE_SNAPSHOTS) {
    candidates.push({
      type: 'nuke',
      dropPct: dropPct(currentMcapUsd, nukePeak.mcapUsd),
      peakMcapUsd: nukePeak.mcapUsd,
      peakAtMs: nukePeak.atMs,
    });
  }

  // Round 19: the baseline is the mcap the watch was taken at, and the message
  // is worth exactly one per fall below the line — hence the armed flag rather
  // than a state test that would repeat every cooldown for as long as the coin
  // stayed down.
  const baseline = input.mcapAtWatch;
  if (typeof baseline !== 'number' || !Number.isFinite(baseline) || baseline <= 0) {
    return { candidates, buyOppArmed };
  }
  const line = baseline * (1 - settings.buyRetracePct / 100);
  if (currentMcapUsd > line) return { candidates, buyOppArmed: true };
  if (!buyOppArmed) return { candidates, buyOppArmed: false };
  if (nuking) return { candidates, buyOppArmed: true };
  candidates.push({
    type: 'buy_opp',
    dropPct: dropPct(currentMcapUsd, baseline),
    mcapAtWatch: baseline,
  });
  return { candidates, buyOppArmed: false };
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
// buyPeakWindowHours / buyMinDeclineHours are RETIRED from the rule (round 19)
// and kept only so stored group settings and old `/overseer set buyopp <pct>
// <hours>` invocations still merge and clamp instead of failing.
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
  /** What the drop is measured from: the window peak, or the watch baseline. */
  fromMcapUsd: number;
  currentMcapUsd: number;
  /** Nuke only: when that peak was set, for the "in 14m" clause. */
  peakAtMs?: number;
  nowMs: number;
  /** Omitted or null prints no LP segment. */
  liquidityUsd?: number | null;
}

/**
 * The exact text posted into the group. Plain text with ONE leading emoji: no
 * markdown, so a symbol containing `*` or `_` can never break the send.
 *
 * Numbers only, never advice (the neutral-framing law): a buy-opp message says
 * where the coin was when the group started watching and where it is now, and
 * leaves the reading to the reader.
 */
export function alertMessage(type: AlertType, args: AlertMessageArgs): string {
  const pct = Math.round(Math.abs(args.dropPct));
  const lp =
    typeof args.liquidityUsd === 'number' && Number.isFinite(args.liquidityUsd)
      ? ` · LP ${fmtUsd(args.liquidityUsd)}`
      : '';
  const move = `${fmtUsd(args.fromMcapUsd)} → ${fmtUsd(args.currentMcapUsd)}`;
  if (type === 'nuke') {
    const elapsed = fmtElapsed(args.nowMs - (args.peakAtMs ?? args.nowMs));
    return `🚨 NUKE: ${args.label} -${pct}% in ${elapsed} · ${move}${lp}`;
  }
  return `🟢 BUY OPP: ${args.label} -${pct}% since watched (${move})${lp}`;
}
