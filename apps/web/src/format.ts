/**
 * Display helpers. Rules: compact USD (K/M/B), one decimal below 10 and none
 * above, never scientific notation, and an em dash for every missing value.
 */

const DASH = '—';

function stripTrailingZero(s: string): string {
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/** One decimal under 10, whole numbers at or above it. */
function compact(n: number): string {
  return n < 10 ? stripTrailingZero(n.toFixed(1)) : String(Math.round(n));
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** `$541K`, `$1.2M`, `$820`, `—`. */
export function fmtUsd(value: number | null | undefined): string {
  if (!isNum(value)) return DASH;
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);

  // Thresholds sit just under the round number so 999_600 reads "$1M", not
  // "$1000K".
  if (abs >= 999.5e6) return `${sign}$${compact(abs / 1e9)}B`;
  if (abs >= 999.5e3) return `${sign}$${compact(abs / 1e6)}M`;
  if (abs >= 999.5) return `${sign}$${compact(abs / 1e3)}K`;
  if (abs === 0) return '$0';
  if (abs < 0.01) return `${sign}<$0.01`;
  return `${sign}$${compact(abs)}`;
}

/** `4.2x`, `13x`, `0.38x`, `—`. */
export function fmtMultiple(value: number | null | undefined): string {
  if (!isNum(value) || value < 0) return DASH;
  if (value >= 10) return `${Math.round(value)}x`;
  if (value >= 0.1) return `${stripTrailingZero(value.toFixed(1))}x`;
  if (value === 0) return '0x';
  if (value < 0.01) return '<0.01x';
  return `${value.toFixed(2)}x`;
}

/**
 * Turnover (vol24 / mcap) as a percentage: `640%`, `10.2K%`, `4.5%`, `—`.
 * Robinhood Chain routinely runs four-figure turnover, so the thousands are
 * compacted rather than printing a seven-character hero number.
 */
export function fmtTurnover(turnover: number | null | undefined): string {
  if (!isNum(turnover) || turnover < 0) return DASH;
  const pct = turnover * 100;
  if (pct >= 999.5e3) return `${compact(pct / 1e6)}M%`;
  if (pct >= 999.5) return `${compact(pct / 1e3)}K%`;
  if (pct >= 10) return `${Math.round(pct)}%`;
  if (pct === 0) return '0%';
  if (pct < 0.1) return '<0.1%';
  return `${stripTrailingZero(pct.toFixed(1))}%`;
}

/** Green at or above 1x, red below, neutral when unknown. */
export function multipleTone(value: number | null | undefined): 'up' | 'down' | 'flat' {
  if (!isNum(value)) return 'flat';
  return value >= 1 ? 'up' : 'down';
}

function parseTime(iso: string | null | undefined): number | null {
  if (typeof iso !== 'string' || iso.length === 0) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** `45s`, `12m`, `3h`, `12d`, `—`. */
export function fmtAge(iso: string | null | undefined, now: number = Date.now()): string {
  const t = parseTime(iso);
  if (t === null) return DASH;
  const seconds = Math.max(0, Math.floor((now - t) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** A duration already measured in hours: `14h`, `2d 3h`, `2d`, `—`. */
export function fmtHours(hours: number | null | undefined): string {
  if (!isNum(hours) || hours < 0) return DASH;
  // Under an hour, hours are the wrong unit: the 30-minute range filter would
  // otherwise round a real 0.5h streak up to "1h" (or a 20-minute one to "0h").
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  const whole = Math.round(hours);
  if (whole < 48) return `${whole}h`;
  const days = Math.floor(whole / 24);
  const rest = whole % 24;
  return rest === 0 ? `${days}d` : `${days}d ${rest}h`;
}

/** Milliseconds since `iso`, or null when it is missing/unparseable. */
export function ageMs(iso: string | null | undefined, now: number = Date.now()): number | null {
  const t = parseTime(iso);
  return t === null ? null : Math.max(0, now - t);
}

/** `-62%` for a 0-100 retrace figure. */
export function fmtRetrace(pct: number | null | undefined): string {
  if (!isNum(pct)) return DASH;
  return `-${Math.round(Math.abs(pct))}%`;
}

/** `0x1234…cdef` — used when a token has no symbol yet. */
export function shortAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Deterministic hue per symbol for the image fallback disc. */
export function avatarHue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}

/** `+38%`, `-12%`, `—` — a signed percentage change (already in percent). */
export function fmtSignedPct(pct: number | null | undefined): string {
  if (!isNum(pct)) return DASH;
  const rounded = Math.round(pct);
  return `${rounded > 0 ? '+' : rounded < 0 ? '-' : ''}${Math.abs(rounded)}%`;
}

/**
 * Death reason as the board prints it: `liquidity_floor` -> `LIQ FLOOR`.
 * Unknown reasons still read as a label rather than a raw column value.
 */
export function fmtDeathReason(reason: string | null | undefined): string | null {
  if (typeof reason !== 'string' || reason.length === 0) return null;
  if (reason === 'liquidity_floor') return 'LIQ FLOOR';
  return reason.replace(/_/g, ' ').toUpperCase();
}

/**
 * `$50,000` — the custom-band echo. Grouped, never compact: the whole point is
 * to show the number the input really means.
 */
export function fmtExactUsd(value: number): string {
  const whole = Math.round(value);
  return `$${whole.toLocaleString('en-US')}`;
}

/**
 * Custom band input -> dollars. Accepts `50000`, `50k`, `1.5M`, `$120,000`.
 * Bare numbers are DOLLARS (round 8 behavior change: the old bare-K reading is
 * what the dollar echo exists to kill). null = not a number at all.
 */
export function parseMoney(raw: string): number | null {
  const trimmed = raw.trim().replace(/[$,\s]/g, '');
  if (trimmed === '') return null;
  const match = /^(\d+(?:\.\d+)?)([kmb])?$/i.exec(trimmed);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const suffix = match[2]?.toLowerCase();
  const scale = suffix === 'b' ? 1e9 : suffix === 'm' ? 1e6 : suffix === 'k' ? 1e3 : 1;
  return value * scale;
}
