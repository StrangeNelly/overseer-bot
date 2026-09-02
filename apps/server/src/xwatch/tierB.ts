import { and, desc, gte, inArray, sql } from 'drizzle-orm';
import { discoveryEvents, launchCandidates, launchMonitors, type Db } from '@groupie/db';
import { XWATCH } from '@groupie/shared';
import { normalizeHandle } from './client.js';
import type { ChainClient } from '../chain/client.js';
import { OCCUPYING_STATUSES } from './monitors.js';

/**
 * Tier B (docs/decisions.md round 23): an on-chain launch whose creator-declared
 * socials CLAIM a tracked handle. BOARD ONLY, never a chat message, ever — six
 * handles had two or three different tokens claiming them inside 8.5 minutes,
 * and the owner's own example (@legsdotfun) already has a $31K impostor whose
 * socials name the real account.
 *
 * THE LAYOUT IS VERIFIED (public RPC, 2026-09-03). PONS v2's `socials()`
 * (selector 0x53cd512a) returns FIVE ABI strings; index 0 is the X/Twitter URL
 * and index 3 is the website — Stride (0x446d7659…6d7e) answers
 * ["https://x.com/playstridexyz", "", "", "https://playstride.xyz/", ""]. The
 * remaining three are presumably telegram/discord/farcaster and are usually
 * empty. `getTokenInfo()` (0x1a0c2ba4) reverts on the same tokens and is not
 * used.
 *
 * A REVERT IS NOT A FAILURE. A token that was not launched by PONS v2 has no
 * `socials()` at all (Cummingtonite, launched on long.xyz, reverts) — that is
 * the normal answer for most of the chain, and it is skipped in silence.
 */

/** PONS v2 `socials()`. Selector and return layout verified 2026-09-03. */
export const SOCIALS_SELECTOR = '0x53cd512a';

/** The five strings the function returns, and which one is the X account. */
const SOCIALS_FIELDS = 5;
const TWITTER_FIELD = 0;

/** How far back one scan looks for launches to check. */
const SCAN_WINDOW_HOURS = 24;
/** ...and how many NEW addresses one pass will read, so a busy chain is bounded. */
const SCAN_LIMIT = 20;
/** How many recent launches are considered per pass before the seen filter. */
const SCAN_CANDIDATES = 200;
/** Addresses already answered for in this process, so each costs one call, once. */
const READ_CAP = 5_000;
const readAddresses = new Set<string>();
/**
 * Null answers per address, until the retirement threshold.
 *
 * `ChainClient.call` returns null for a REVERT and for a transport failure
 * alike, and the two mean opposite things: the first is "not a PONS v2 token"
 * (most of the chain), the second is "we could not ask". Retiring on the first
 * null would let one RPC blip hide a real claim for the life of the process, so
 * an address has to answer null XWATCH.tierBNullReadsToRetire times before the
 * scan stops asking about it.
 */
const nullReads = new Map<string, number>();

function word(hex: string, index: number): string | null {
  const start = index * 64;
  return start + 64 <= hex.length ? hex.slice(start, start + 64) : null;
}

function wordToNumber(hex: string | null): number | null {
  if (hex === null) return null;
  const value = Number.parseInt(hex, 16);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Decode the five ABI strings, or null when the data is not that shape.
 *
 * Null means UNKNOWN — the token answered something we cannot read — and the
 * caller treats it exactly as it treats a revert: nothing is claimed.
 */
export function decodeSocials(returnData: string | null): string[] | null {
  if (typeof returnData !== 'string') return null;
  const hex = (returnData.startsWith('0x') ? returnData.slice(2) : returnData).toLowerCase();
  if (hex.length % 64 !== 0 || hex.length < SOCIALS_FIELDS * 64) return null;
  if (!/^[0-9a-f]*$/.test(hex)) return null;
  const out: string[] = [];
  for (let field = 0; field < SOCIALS_FIELDS; field++) {
    const offsetBytes = wordToNumber(word(hex, field));
    if (offsetBytes === null || offsetBytes % 32 !== 0) return null;
    const head = offsetBytes / 32;
    const length = wordToNumber(word(hex, head));
    if (length === null) return null;
    if (length === 0) {
      out.push('');
      continue;
    }
    const start = (head + 1) * 64;
    const end = start + length * 2;
    if (end > hex.length) return null;
    let text = '';
    for (let i = start; i < end; i += 2) {
      text += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16));
    }
    out.push(text);
  }
  return out;
}

/**
 * The X handle a socials URL names, or null.
 *
 * Only the FIRST path segment of an x.com/twitter.com URL counts, and X's own
 * reserved paths are not handles — `x.com/i/status/…` names nobody.
 */
const RESERVED_PATHS = new Set(['i', 'intent', 'home', 'search', 'hashtag', 'share', 'status']);

export function handleFromSocialUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const match = /(?:^|\/\/|\s)(?:www\.)?(?:twitter|x)\.com\/([A-Za-z0-9_]{1,15})/i.exec(raw.trim());
  const segment = match?.[1];
  if (segment === undefined) {
    // A bare `@handle` is the other shape a creator puts in that field.
    const bare = /^@?([A-Za-z0-9_]{1,15})$/.exec(raw.trim());
    return bare ? normalizeHandle(bare[1] ?? '') : null;
  }
  if (RESERVED_PATHS.has(segment.toLowerCase())) return null;
  return normalizeHandle(segment);
}

/**
 * One Tier-B pass: recent launches -> `socials()` -> a 'claims' candidate row
 * per (monitor, token) whose declared X account names a tracked handle.
 *
 * Returns how many rows were written. One eth_call per NEW launch address, and
 * only for launches inside the scan window.
 */
export async function scanLaunchCandidates(
  db: Db,
  chain: ChainClient | null,
  nowMs: number = Date.now(),
  seen: Set<string> = readAddresses,
  misses: Map<string, number> = nullReads,
): Promise<number> {
  if (chain === null) return 0;

  const tracked = await db
    .select({
      id: launchMonitors.id,
      handle: sql<string>`lower(${launchMonitors.xHandle})`,
    })
    .from(launchMonitors)
    .where(inArray(launchMonitors.status, [...OCCUPYING_STATUSES]));
  if (tracked.length === 0) return 0;
  const byHandle = new Map<string, number[]>();
  for (const row of tracked) {
    const list = byHandle.get(row.handle) ?? [];
    list.push(row.id);
    byHandle.set(row.handle, list);
  }

  const launches = await db
    .select({
      address: discoveryEvents.tokenAddress,
      symbol: discoveryEvents.symbol,
    })
    .from(discoveryEvents)
    .where(
      and(
        sql`${discoveryEvents.kind} = 'launch'`,
        gte(discoveryEvents.at, new Date(nowMs - SCAN_WINDOW_HOURS * 3_600_000)),
      ),
    )
    .orderBy(desc(discoveryEvents.at))
    .limit(SCAN_CANDIDATES);

  let written = 0;
  let read = 0;
  for (const launch of launches) {
    if (read >= SCAN_LIMIT) break;
    const address = launch.address.toLowerCase();
    if (seen.has(address)) continue;
    read += 1;
    const data = await chain.call(address, SOCIALS_SELECTOR);
    // Cheapest possible bounds; a cleared set costs one extra call per address.
    if (seen.size > READ_CAP) seen.clear();
    if (misses.size > READ_CAP) misses.clear();
    // A null is a revert ("not a PONS v2 token", most of the chain) OR a read
    // that failed. Indistinguishable here, so the address is retired only after
    // it has answered nothing enough times to mean it.
    if (data === null) {
      const answered = (misses.get(address) ?? 0) + 1;
      if (answered >= XWATCH.tierBNullReadsToRetire) {
        misses.delete(address);
        seen.add(address);
      } else {
        misses.set(address, answered);
      }
      continue;
    }
    misses.delete(address);
    seen.add(address);
    const socials = decodeSocials(data);
    if (socials === null) continue;
    const handle = handleFromSocialUrl(socials[TWITTER_FIELD]);
    if (handle === null) continue;
    for (const monitorId of byHandle.get(handle) ?? []) {
      const inserted = await db
        .insert(launchCandidates)
        .values({
          monitorId,
          tokenAddress: address,
          symbol: launch.symbol,
          kind: 'claims',
        })
        // A 'posted' row for the same coin OUTRANKS a claim — the account
        // itself spoke — so a conflict is left exactly as it stands.
        .onConflictDoNothing()
        .returning({ id: launchCandidates.id });
      written += inserted.length;
    }
  }
  return written;
}
