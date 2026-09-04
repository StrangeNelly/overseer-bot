import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import {
  calls,
  discoveryEvents,
  launchCandidates,
  launchMonitors,
  tokens,
  type Db,
} from '@groupie/db';
import { XWATCH, twitterUrlFrom } from '@groupie/shared';
import { normalizeHandle } from './client.js';
import type { ChainClient } from '../chain/client.js';
import { OCCUPYING_STATUSES } from './monitors.js';

/**
 * Tier B (docs/decisions.md rounds 23 and 25): a token that CLAIMS a tracked
 * handle. BOARD ONLY, never a chat message, ever — six handles had two or three
 * different tokens claiming them inside 8.5 minutes, and the owner's own example
 * (@legsdotfun) already has a $31K impostor whose socials name the real account.
 * Nothing in this file writes an alert row, publishes an event or touches the
 * bot: a 'claims' row is evidence about the chain, not news about the account.
 *
 * ROUND 25 WIDENED WHAT IT LOOKS AT, after measuring that round 23's Tier B had
 * never written a single row in production. It scanned `discovery_events` rows
 * with kind='launch' only, and those rows are exclusively FIRST UNISWAP POOLS —
 * a PONS token only ever appears as kind='graduation'. PONS is the launchpad
 * whose `socials()` this file was built to read, so the one source that could
 * answer was the one source never asked. The LEGS graduation row (id 1462,
 * 2026-09-03 21:03:56Z) even carried `twitter_url = https://x.com/legsdotfun`
 * from DexScreener enrichment by 21:06Z, and nothing read it.
 *
 * So there are now three passes over the same window — 24 hours, bounded by the
 * newest SCAN_CANDIDATES rows of each kind (see that constant) — cheapest first:
 *
 *   1. ENRICHMENT — a discovery row (launch OR graduation) whose stored
 *      `twitter_url` already names a tracked handle. No chain call at all.
 *   2. CHAIN — `socials()` for the rows enrichment could not answer, still
 *      bounded by SCAN_LIMIT reads per pass.
 *   3. CALLS — a token the GROUP ITSELF called whose stored socials name a handle
 *      that same group tracks, read through the shared `twitterUrlFrom` every
 *      other socials consumer in this repo uses. DexScreener fills those socials
 *      on graduation, so this pass works even with no chain client.
 *
 * AN ANSWER RETIRES AN ADDRESS; A STRANGER DOES NOT. The two free passes are
 * re-derived from bounded SELECTs every scan, so re-reading them costs nothing —
 * and the tracked handle set changes between scans. "I saw a coin claiming @foo,
 * so I tracked @foo" is the flow this file exists to serve, and retiring an
 * address because nobody tracked that handle YET would answer it never.
 *
 * THE PONS LAYOUT IS VERIFIED (public RPC, 2026-09-03). PONS v2's `socials()`
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
 *
 * CADENCE: this runs inside the runner's SLOW housekeeping pass, so a scan
 * happens every XWATCH.refreshProfileMinutes (30 minutes), not on every
 * housekeeping tick. Round 25 deliberately did not change that — the two cheap
 * passes above would happily run at the 45-second tick, and a dedicated
 * `tierBMinutes` knob is the open question left for the integrator.
 */

/** PONS v2 `socials()`. Selector and return layout verified 2026-09-03. */
export const SOCIALS_SELECTOR = '0x53cd512a';

/** The five strings the function returns, and which one is the X account. */
const SOCIALS_FIELDS = 5;
const TWITTER_FIELD = 0;

/** How far back one scan looks for launches (and calls) to check. */
const SCAN_WINDOW_HOURS = 24;
/** ...and how many NEW addresses one CHAIN pass will read, so a busy chain is bounded. */
const SCAN_LIMIT = 20;
/**
 * How many recent rows of EACH KIND one pass considers — the effective discovery
 * look-back is min(24h, the newest this many rows per kind), not 24h flat.
 *
 * PER KIND, and sized against the cadence. The listener writes ~5.8 rows/minute
 * in production (CLAUDE.md 2026-09-03: "58 events in the first 10 min") and this
 * scan runs once per XWATCH.refreshProfileMinutes (30), so ~175 rows arrive
 * between passes: a shared cap of 200 left under four minutes of margin, and
 * none at all after a skipped pass. Worse, launches vastly outnumber
 * graduations, and a graduation is the ONLY row a PONS token ever writes — a
 * shared cap let launches crowd out exactly the rows round 25 widened the scan
 * to read. apps/server/src/api/discovery.ts hit the same pathology in
 * production and fixed it the same way: one query per kind, each with its own
 * limit.
 */
const SCAN_CANDIDATES = 500;
/**
 * Both discovery kinds are scanned (round 25). A PONS token — the only kind
 * whose `socials()` this file can read — never produces a 'launch' row: it
 * reaches a Uniswap pool by GRADUATING off the curve, and a graduation is the
 * row the listener writes for it.
 */
const SCAN_KINDS = ['launch', 'graduation'] as const;
/**
 * Questions already ANSWERED in this process, so each costs one call, once.
 *
 * Three key spaces in one set, because the three passes ask three different
 * questions about the same address: the plain address (enrichment — "we know who
 * this coin names"), `chain:<address>` (the chain — "there is no socials() here
 * to read"), and `<address>#g<id>` (the calls pass — group-scoped). Neither ':'
 * nor '#' can appear in a 0x address, so they cannot collide.
 */
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

/**
 * The CALLS pass's own key in the same `seen` set.
 *
 * It carries the group because that pass is group-scoped — the same coin called
 * in two groups is two independent questions, and one plain address key would
 * let the first group's answer silence the second. A '#' can never appear in a
 * 0x address, so these keys cannot collide with the chain pass's.
 */
function callKey(address: string, groupId: number): string {
  return `${address}#g${groupId}`;
}

/**
 * The CHAIN pass's own key, for the same reason the calls pass has one.
 *
 * "This token has no `socials()` to read" and "we know who this coin names" are
 * different questions, and the chain answers only the first. Sharing one key
 * space let a chain verdict — three reverts, or a PONS token whose socials()[0]
 * is empty — permanently suppress the FREE enrichment answer for that address,
 * even though DexScreener's `twitter_url` can land hours later and costs
 * nothing to read. A ':' can never appear in a 0x address, so these keys cannot
 * collide with the enrichment pass's plain ones.
 */
function chainKey(address: string): string {
  return `chain:${address}`;
}

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

/** One tracked monitor, as the passes below need it: which row, whose group. */
interface TrackedMonitor {
  id: number;
  groupId: number;
}

/**
 * One Tier-B pass: recent launches, graduations and the group's own calls ->
 * a 'claims' candidate row per (monitor, token) whose declared X account names
 * a tracked handle.
 *
 * Returns how many rows were written. At most one eth_call per NEW address that
 * enrichment could not answer, and only for events inside the scan window — the
 * last SCAN_WINDOW_HOURS, capped at the newest SCAN_CANDIDATES rows PER KIND.
 */
export async function scanLaunchCandidates(
  db: Db,
  chain: ChainClient | null,
  nowMs: number = Date.now(),
  seen: Set<string> = readAddresses,
  misses: Map<string, number> = nullReads,
): Promise<number> {
  const tracked = await db
    .select({
      id: launchMonitors.id,
      groupId: launchMonitors.groupId,
      handle: sql<string>`lower(${launchMonitors.xHandle})`,
    })
    .from(launchMonitors)
    .where(inArray(launchMonitors.status, [...OCCUPYING_STATUSES]));
  if (tracked.length === 0) return 0;
  const byHandle = new Map<string, TrackedMonitor[]>();
  for (const row of tracked) {
    const list = byHandle.get(row.handle) ?? [];
    list.push({ id: row.id, groupId: row.groupId });
    byHandle.set(row.handle, list);
  }

  const since = new Date(nowMs - SCAN_WINDOW_HOURS * 3_600_000);
  let written = 0;

  /**
   * The ONE write this file makes. A 'posted' row for the same coin OUTRANKS a
   * claim — the account itself spoke — so a conflict is left exactly as it
   * stands, and no path here can turn a claim into a chat message.
   */
  const claim = async (
    monitors: readonly TrackedMonitor[],
    address: string,
    symbol: string | null,
  ): Promise<void> => {
    for (const monitor of monitors) {
      const inserted = await db
        .insert(launchCandidates)
        .values({ monitorId: monitor.id, tokenAddress: address, symbol, kind: 'claims' })
        .onConflictDoNothing()
        .returning({ id: launchCandidates.id });
      written += inserted.length;
    }
  };

  // Cheapest possible bounds; a cleared set costs one extra call per address.
  if (seen.size > READ_CAP) seen.clear();
  if (misses.size > READ_CAP) misses.clear();

  /* ----------------------------------------- (a) the candidate discovery rows */

  // ONE QUERY PER KIND, each with its own limit (apps/server/src/api/discovery.ts
  // learned this the hard way): a busy launch hour must not be able to push
  // every graduation out of the pool, and a graduation is the only row a PONS
  // token — the one launchpad whose socials() this file can read — ever writes.
  const events = (
    await Promise.all(
      SCAN_KINDS.map((kind) =>
        db
          .select({
            address: discoveryEvents.tokenAddress,
            symbol: discoveryEvents.symbol,
            at: discoveryEvents.at,
            twitterUrl: discoveryEvents.twitterUrl,
          })
          .from(discoveryEvents)
          .where(and(eq(discoveryEvents.kind, kind), gte(discoveryEvents.at, since)))
          .orderBy(desc(discoveryEvents.at))
          .limit(SCAN_CANDIDATES),
      ),
    )
  ).flat();

  // Newest row per address wins: a coin that launched and then graduated inside
  // the window has two rows, and the later one carries the later enrichment. The
  // two per-kind reads arrive interleaved, so they are ordered here rather than
  // relied on to come out of the database in one sequence.
  const dated = (at: Date | string | null): number => {
    if (at === null) return 0;
    const ms = at instanceof Date ? at.getTime() : Date.parse(at);
    return Number.isFinite(ms) ? ms : 0;
  };
  const candidates = new Map<string, { symbol: string | null; twitterUrl: string | null }>();
  for (const event of [...events].sort((a, b) => dated(b.at) - dated(a.at))) {
    const address = event.address.toLowerCase();
    if (candidates.has(address)) continue;
    candidates.set(address, { symbol: event.symbol, twitterUrl: event.twitterUrl });
  }

  /* ------------------------------------------------------ (b) enrichment pass */

  const unanswered: Array<{ address: string; symbol: string | null }> = [];
  for (const [address, row] of candidates) {
    if (seen.has(address)) continue;
    // NO twitter_url IS NOT AN ANSWER. Enrichment runs on its own loop and can
    // land minutes after the row exists (LEGS: row written 21:03:56Z, enriched
    // 21:06:17Z), so an unenriched row is not retired here — it falls through to
    // the chain, which is the source that can answer immediately.
    if (typeof row.twitterUrl !== 'string' || row.twitterUrl.trim() === '') {
      unanswered.push({ address, symbol: row.symbol ?? null });
      continue;
    }
    // RETIRED ONLY ONCE IT ANSWERED FOR SOMEBODY WE TRACK. A URL naming a
    // stranger is an answer about the COIN, not about this board: the handle set
    // changes between scans, and a member who tracks @foo after seeing a coin
    // claim it would otherwise never get the claim row — the address was retired
    // before anyone asked the question. Re-reading it costs nothing (this pass
    // is a bounded SELECT that already ran, and claim() is onConflictDoNothing),
    // and the row still never reaches the chain: a stored URL is present, so it
    // is not pushed onto `unanswered`.
    const handle = handleFromSocialUrl(row.twitterUrl);
    const monitors = handle === null ? [] : (byHandle.get(handle) ?? []);
    if (monitors.length > 0) seen.add(address);
    await claim(monitors, address, row.symbol);
  }

  /* ----------------------------------------------------------- (c) chain pass */

  // The chain client is the only optional part: a deployment with no
  // ALCHEMY_API_KEY still runs both cheap passes, and the calls pass below is
  // where such a deployment gets its claims from.
  if (chain !== null) {
    let read = 0;
    for (const launch of unanswered) {
      if (read >= SCAN_LIMIT) break;
      const address = launch.address;
      // Its OWN verdict, on its own key: an address the chain has finished with
      // costs no second eth_call, and the free enrichment pass above is still
      // free to answer for it when DexScreener lands a URL later.
      if (seen.has(chainKey(address))) continue;
      read += 1;
      const data = await chain.call(address, SOCIALS_SELECTOR);
      // A null is a revert ("not a PONS v2 token", most of the chain) OR a read
      // that failed. Indistinguishable here, so the address is retired only
      // after it has answered nothing enough times to mean it.
      if (data === null) {
        const answered = (misses.get(address) ?? 0) + 1;
        if (answered >= XWATCH.tierBNullReadsToRetire) {
          misses.delete(address);
          seen.add(chainKey(address));
        } else {
          misses.set(address, answered);
        }
        continue;
      }
      misses.delete(address);
      seen.add(chainKey(address));
      const socials = decodeSocials(data);
      if (socials === null) continue;
      const handle = handleFromSocialUrl(socials[TWITTER_FIELD]);
      if (handle === null) continue;
      await claim(byHandle.get(handle) ?? [], address, launch.symbol);
    }
  }

  /* ----------------------------------------------------------- (d) calls pass */

  /**
   * The group's OWN calls, judged on `tokens.socials` — read with the SHARED
   * `twitterUrlFrom`, exactly as api/board.ts, discovery/scan.ts and
   * poller/sleeperScan.ts read it.
   *
   * NOT `socials->>'twitter'` IN SQL. That column is untyped jsonb written
   * verbatim from DexScreener's own `type` strings
   * (apps/server/src/market/dexscreener.ts: `socials[s.type] = s.url`), so it
   * can key the account as 'x', or under any other type string the provider
   * emits, and a key-name match would read those rows as "no socials yet" — on
   * the one pass that IS the whole of Tier B for a deployment with no chain
   * client. The shared reader proves the URL instead of trusting the key
   * (docs/decisions.md round 9); it also accepts an x.com URL stored under some
   * other key, which is deliberate: it is the same link the board already prints
   * as this coin's X account, and a Tier-B row is board-only evidence.
   *
   * GROUP-SCOPED, unlike the two chain-derived passes above: a call is a fact
   * about one group's chat, and a monitor in another group has no business
   * learning that this group called a coin naming its handle.
   */
  const calledTokens = await db
    .select({
      address: tokens.address,
      symbol: tokens.symbol,
      groupId: calls.groupId,
      socials: tokens.socials,
    })
    .from(calls)
    .innerJoin(tokens, eq(calls.tokenId, tokens.id))
    .where(gte(calls.calledAt, since))
    .orderBy(desc(calls.calledAt))
    .limit(SCAN_CANDIDATES);

  for (const called of calledTokens) {
    const address = called.address.toLowerCase();
    const key = callKey(address, called.groupId);
    if (seen.has(key)) continue;
    const twitterUrl = twitterUrlFrom(called.socials);
    // Same rule as the enrichment pass: no socials yet is not an answer, and
    // the next scan asks again once the token has been enriched.
    if (twitterUrl === null) continue;
    const handle = handleFromSocialUrl(twitterUrl);
    const monitors =
      handle === null
        ? []
        : (byHandle.get(handle) ?? []).filter((monitor) => monitor.groupId === called.groupId);
    // Retired only once it answered for a monitor on THIS board — same reason
    // as the enrichment pass: the tracked set changes between scans.
    if (monitors.length > 0) seen.add(key);
    await claim(monitors, address, called.symbol);
  }

  return written;
}
