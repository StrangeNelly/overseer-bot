/**
 * Discovery — the pure half (docs/decisions.md rounds 18 and 20).
 *
 * Every function here turns a DiscoveryResponse (or one stored string) into
 * text or into a shape the rail card draws. Nothing in this file touches React,
 * the network or the clock: `now` always arrives as an argument, so each rule
 * can be asserted directly instead of through a rendered tree.
 *
 * The rules the review made non-negotiable:
 *  - a chip is one query flag, and the sentence under the zones reports the
 *    filters the PAYLOAD applied (`DiscoveryResponse.filters`), never the ones
 *    the chips asked for;
 *  - a listener that has stopped reading blocks is said out loud — an empty
 *    list must never stand in for "the chain was quiet";
 *  - a figure we could not measure prints as unknown, never as zero, and a
 *    USDG-quoted pool never prints its ETH-equivalent as if it were the deposit.
 */

import { DISCOVERY } from '@groupie/shared';
import type { DiscoveryEntry, DiscoveryFilters, DiscoveryResponse } from '@groupie/shared';
import { stallLine } from './feedStall';
import { ageMs, fmtAge, fmtEth, fmtUsd, shortAddress } from './format';

/** The two windows the owner asked for. 24h is the default view. */
export const DISCOVERY_DURATIONS_HOURS = [6, 24] as const;
export type DiscoveryHours = (typeof DISCOVERY_DURATIONS_HOURS)[number];
export const DEFAULT_DISCOVERY_HOURS: DiscoveryHours = 24;

/** All three serve-time filters are ON by default, exactly like the server's. */
export const DEFAULT_DISCOVERY_FILTERS: DiscoveryFilters = {
  xWeb: true,
  noBundles: true,
  noStocks: true,
};

/**
 * What the view says when the deployment has no on-chain client configured
 * (no ALCHEMY_API_KEY). One honest line — an empty list would read as "the chain
 * did nothing", which is a claim we have not earned.
 */
export const DISCOVERY_DORMANT_LINE = 'on-chain feed not configured yet';

/** The trust frame, in one place: the view header and the mobile tone band share it. */
export const DISCOVERY_FRAME_TAIL = 'launches and graduations from the chain itself';

/** A configured listener that has never completed a tick. Not an error yet. */
export const DISCOVERY_WAITING_LINE = 'waiting for the first read';

export const DISCOVERY_EMPTY_LINES = {
  launch: 'No new Uniswap launches in this window.',
  graduation: 'Nothing has graduated in this window.',
} as const;

/**
 * The chain's own feed does not ride the board's stream — a launch is news from
 * the chain, not from this group's calls, and the server publishes no frame for
 * it. So the open surface polls, at a cadence sized for the listener behind it:
 * the chain tick runs every 20s and enrichment every 30s, and a two-minute poll
 * is the coarsest read that still shows a launch while it is new
 * (docs/decisions.md rounds 18 and 20).
 */
export const DISCOVERY_POLL_MS = 120_000;

/**
 * How long a payload can be trusted to describe the listener NOW: one poll plus
 * a grace for the request itself. Past this we are looking at an old response —
 * a backgrounded tab, a suspended laptop, a poll that has been failing — and the
 * listener's health is simply not something this screen still knows.
 */
export const DISCOVERY_PAYLOAD_FRESH_MS = DISCOVERY_POLL_MS + 30_000;

/**
 * The chain tick runs every 20s; five minutes without one is not a slow block,
 * it is a listener that has stopped. Past this the header and the rail card say
 * so rather than presenting whatever the last tick left behind as current.
 */
export const DISCOVERY_STALL_MS = 5 * 60_000;

/**
 * Enrichment refreshes on a 10-minute loop, so a reading older than 15 minutes
 * missed a pass: the row keeps printing the figure and dates it.
 */
export const DISCOVERY_AS_OF_MS = 15 * 60_000;

/** Re-validated against the tuple: the stored value is user-editable. */
export function parseDiscoveryHours(raw: string | null): DiscoveryHours {
  const value = Number(raw);
  if ((DISCOVERY_DURATIONS_HOURS as readonly number[]).includes(value)) {
    return value as DiscoveryHours;
  }
  return DEFAULT_DISCOVERY_HOURS;
}

/**
 * A stored filter flag. Only the literal '0' turns a filter off — an absent key
 * (first visit) and a corrupt one both mean the safe default, which is ON.
 */
export function parseDiscoveryFlag(raw: string | null): boolean {
  return raw !== '0';
}

/**
 * The three flags as one string, for the remount key and the "controls changed"
 * comparison. Read off the PAYLOAD wherever it decides what is on screen.
 */
export function filtersKey(filters: DiscoveryFilters): string {
  return `${filters.xWeb ? 1 : 0}${filters.noBundles ? 1 : 0}${filters.noStocks ? 1 : 0}`;
}

/**
 * What the chips must say once a reload has FAILED: a chip is a request, and a
 * request that failed changed nothing — the rows on screen are still the ones
 * the old payload filtered. Returns the filters to snap back to, or null when
 * the failed request was not asking for anything different (or when there is no
 * payload on screen for the chips to disagree with).
 *
 * While the request is in flight the optimistic chip stands: it is an honest
 * statement of what was asked for, and the footnote under the zones keeps
 * naming what the payload actually applied.
 */
export function filtersAfterFailedReload(
  requested: DiscoveryFilters,
  shown: DiscoveryResponse | null,
): DiscoveryFilters | null {
  if (shown === null) return null;
  return filtersKey(shown.filters) === filtersKey(requested) ? null : shown.filters;
}

/**
 * The dex, as a row-sized label: `v2`, `v4`, `PONS`. An id we do not recognise
 * prints its own first segment rather than a guess.
 */
export function dexLabel(dex: string): string {
  const id = dex.trim().toLowerCase();
  if (id.length === 0) return '—';
  if (id.includes('pons')) return 'PONS';
  const version = /(?:^|[-_])v(\d+)/.exec(id);
  if (id.includes('uniswap') && version) return `v${version[1]}`;
  return (id.split('-')[0] ?? id).toUpperCase();
}

/**
 * The bundle facts, printed neutrally on every row (round 20): the share of
 * supply bought in the launch block and how many wallets took it. Logs we could
 * not read say so — unknown is never rendered as 0%.
 */
export function bundleText(pct: number | null, wallets: number | null): string {
  if (pct === null) return 'launch block unknown';
  const share = `launch block ${Math.round(pct)}%`;
  if (wallets === null) return share;
  return `${share} · ${wallets} ${wallets === 1 ? 'wallet' : 'wallets'}`;
}

/**
 * "opened with 5.8 ETH" / "opened with $12K USDG" — the QUOTE-SIDE deposit that
 * opened the pool, named in the asset actually deposited (contract: rounds 18
 * and 20, `quoteSymbol`).
 *
 * `initialLiquidityEth` is an ETH-EQUIVALENT for a USDG pool, so printing it
 * there would invent an ETH deposit that never happened: a USDG pool prints its
 * USD figure or nothing at all.
 *
 * Only a launch opened a pool; a graduation migrated into one, and "opened
 * with" would be a sentence about an event that row is not.
 */
export function openedWithText(entry: DiscoveryEntry): string | null {
  if (entry.kind !== 'launch') return null;
  if (entry.quoteSymbol === 'USDG') {
    return entry.initialLiquidityUsd === null
      ? 'opening size unknown'
      : `opened with ${fmtUsd(entry.initialLiquidityUsd)} USDG`;
  }
  if (entry.initialLiquidityEth !== null) return `opened with ${fmtEth(entry.initialLiquidityEth)}`;
  if (entry.initialLiquidityUsd !== null) return `opened with ${fmtUsd(entry.initialLiquidityUsd)}`;
  return 'opening size unknown';
}

/**
 * How old the enrichment behind the money figures is, once it is old enough to
 * matter. Null while the reading is current (or was never taken — an entry with
 * no reading already prints "mcap unknown", and dating a figure that does not
 * exist says nothing).
 */
export function asOfText(dataAsOf: string | null, now: number): string | null {
  const age = ageMs(dataAsOf, now);
  if (age === null || age < DISCOVERY_AS_OF_MS) return null;
  return `read ${fmtAge(dataAsOf, now)} ago`;
}

/** `$84K · LP $22K (locked 100%) · opened with 5.8 ETH · read 3h ago` — facts, in that order. */
export function subline(entry: DiscoveryEntry, now: number): string {
  const lock =
    entry.lpLockedPct === null ? ' (lock unknown)' : ` (locked ${Math.round(entry.lpLockedPct)}%)`;
  const parts = [
    entry.mcapUsd === null ? 'mcap unknown' : fmtUsd(entry.mcapUsd),
    entry.liquidityUsd === null ? `LP unknown${lock}` : `LP ${fmtUsd(entry.liquidityUsd)}${lock}`,
  ];
  const opened = openedWithText(entry);
  if (opened !== null) parts.push(opened);
  const asOf = asOfText(entry.dataAsOf, now);
  if (asOf !== null) parts.push(asOf);
  return parts.join(' · ');
}

/**
 * The listener's own health, from `lastTickAt` (contract: the last successful
 * block read). Null means the feed is reading normally and has nothing to say.
 *
 * The rule itself — judge the lag against the PAYLOAD and against the SERVER's
 * clock, never against this device's — lives in `./feedStall`, which the X
 * launch monitor's own status line shares (round 23).
 *
 * A dormant deployment is a different sentence entirely (DISCOVERY_DORMANT_LINE)
 * and is handled where the zones are drawn, so `enabled` false is silent here.
 */
export function feedStatusText(
  enabled: boolean,
  lastTickAt: string | null,
  fetchedAt: number | null,
  now: number,
  serverAt: number | null = null,
): string | null {
  return stallLine({
    enabled,
    at: lastTickAt,
    fetchedAt,
    now,
    serverAt,
    stallMs: DISCOVERY_STALL_MS,
    freshMs: DISCOVERY_PAYLOAD_FRESH_MS,
    waitingLine: DISCOVERY_WAITING_LINE,
    noun: 'read',
  });
}

/**
 * The round-22 graduation floor, in words, read off the constant so the number
 * in the sentence can never drift from the number the server cut on.
 */
export const GRADUATION_FLOOR_NOTE = `graduations under ${fmtUsd(
  DISCOVERY.graduationMinMcapUsd,
)} are hidden`;

/**
 * What the footnote says the PAYLOAD did — never what the chips are asking for.
 *
 * Each filter is now its own query flag, so the sentence names exactly the ones
 * that survived: a chip that is still lit while its filter was dropped is the
 * failure this line exists to make impossible.
 *
 * The graduation floor is named on BOTH branches, the raw-stream one included:
 * it is a floor rather than a chip (docs/decisions.md round 22), so "no filters
 * applied" would otherwise promise a stream the payload does not contain.
 */
export function filtersSentence(data: DiscoveryResponse): string {
  const applied: string[] = [];
  if (data.filters.xWeb) applied.push('only coins with an X account and a website');
  if (data.filters.noBundles) applied.push(`launch block under ${Math.round(data.bundleMaxPct)}%`);
  if (data.filters.noStocks) applied.push('no tokenized stocks');
  if (applied.length === 0) {
    return `no filters applied — this is the raw stream · ${GRADUATION_FLOOR_NOTE}`;
  }
  return `showing ${applied.join(', ')} · ${GRADUATION_FLOOR_NOTE}`;
}

/**
 * The desktop DISCOVERY summary (rounds 18 and 20): two counts, the window they
 * were counted over, the newest thing the chain did, and the listener's last
 * successful read. `enabled` false is the dormant deployment — the rail says so
 * rather than printing two zeroes.
 */
export interface DiscoverySummary {
  enabled: boolean;
  launches: number;
  graduations: number;
  hours: number;
  /** chain_cursor's heartbeat: null before the listener's first tick. */
  lastTickAt: string | null;
  /**
   * The client instant this payload landed. The rail's stall verdict is read
   * against it, not against the clock, for the reason feedStatusText gives.
   */
  fetchedAt: number | null;
  /** The server's own instant for this payload (its Date header), or null. */
  serverAt: number | null;
  /** The most recent entry across both kinds, or null when there is none. */
  newest: { label: string; at: string } | null;
}

export function deriveDiscoverySummary(
  data: DiscoveryResponse | null,
  fetchedAt: number | null,
  serverAt: number | null = null,
): DiscoverySummary | null {
  if (!data) return null;
  // The newest thing the chain did, across both kinds. An unparseable
  // timestamp simply never wins the comparison.
  let newest: DiscoveryEntry | null = null;
  let newestAt = Number.NEGATIVE_INFINITY;
  for (const entry of [...data.launches, ...data.graduations]) {
    const at = Date.parse(entry.at);
    if (Number.isNaN(at) || at <= newestAt) continue;
    newestAt = at;
    newest = entry;
  }
  return {
    enabled: data.enabled,
    launches: data.launches.length,
    graduations: data.graduations.length,
    // The payload's window, never the chip's: the chip can be ahead of the
    // response it is waiting for.
    hours: data.hours,
    lastTickAt: data.lastTickAt,
    fetchedAt,
    serverAt,
    newest: newest
      ? {
          label: newest.symbol ? `$${newest.symbol}` : shortAddress(newest.address),
          at: newest.at,
        }
      : null,
  };
}

/**
 * The DSCVR chip's count. A dormant feed counts nothing — the chip shows an em
 * dash and the card says why, rather than printing a zero nobody can act on.
 */
export function discoveryCountOf(data: DiscoveryResponse | null): number | null {
  return data && data.enabled ? data.launches.length + data.graduations.length : null;
}
