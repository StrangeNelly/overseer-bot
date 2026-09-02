import { DISCOVERY_DEFAULTS } from '@groupie/shared';

/**
 * The three default filters on the discovery stream (docs/decisions.md round
 * 20), in one pure function so the board zone, the chat alert and the tests
 * cannot drift apart. `filtered=0` on the route skips the call entirely.
 *
 * Every one of them is also a FACT printed on the row that survives — an X
 * pill, a website pill, "launch block 12% · 9 wallets" — so nothing here is a
 * hidden verdict.
 */

export interface FilterableEntry {
  twitterUrl: string | null;
  websiteUrl: string | null;
  isStock: boolean;
  /** 0-100, or null when the launch block could not be read. */
  launchBlockPct: number | null;
}

export function passesDiscoveryFilters(
  entry: FilterableEntry,
  bundleMaxPct: number = DISCOVERY_DEFAULTS.bundleMaxPct,
): boolean {
  // Round 20, owner: "strip it down to show only the ones with an X account and
  // website". Both, not either.
  if (entry.twitterUrl === null || entry.websiteUrl === null) return false;
  if (entry.isStock) return false;
  // UNKNOWN IS NEVER A VERDICT: a launch block we could not read is rendered as
  // unknown and stays visible. Hiding it would let a failed RPC call quietly
  // become an accusation of bundling.
  if (entry.launchBlockPct === null) return true;
  return entry.launchBlockPct < bundleMaxPct;
}
