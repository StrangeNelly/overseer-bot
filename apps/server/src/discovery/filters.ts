import { DISCOVERY, DISCOVERY_DEFAULTS, type DiscoveryKind } from '@groupie/shared';

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

export interface FloorEntry {
  kind: DiscoveryKind;
  /** The latest enrichment reading, or null when we have not got one. */
  mcapUsd: number | null;
}

/**
 * The round-22 graduation floor (docs/decisions.md round 22). A graduation that
 * has fallen back under `DISCOVERY.graduationMinMcapUsd` is not served in the
 * GRADUATED zone and does not earn a chat message.
 *
 * This is a FLOOR, not one of the three filters above: it is applied whatever
 * the chips say, so `filtered=0` — the raw stream — still respects it. The zone
 * footnote says so out loud rather than quietly serving a shorter list.
 *
 * UNKNOWN IS NEVER A VERDICT: a null mcap is not "under $15K". A graduation we
 * could not read stays visible and prints "mcap unknown", exactly as an
 * unreadable launch block stays visible rather than becoming an accusation.
 *
 * Launches never fail this: their gate is the opening deposit, and a new pool
 * legitimately opens under $15K.
 */
export function passesGraduationFloor(entry: FloorEntry): boolean {
  if (entry.kind !== 'graduation') return true;
  if (entry.mcapUsd === null) return true;
  return entry.mcapUsd >= DISCOVERY.graduationMinMcapUsd;
}
