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
