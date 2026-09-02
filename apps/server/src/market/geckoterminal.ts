import { ROBINHOOD_SLUG } from '@groupie/shared';
import { num, type MarketSnapshot } from './types.js';

const BASE = 'https://api.geckoterminal.com/api/v2';

/**
 * GeckoTerminal free tier: nominally 30 calls/min, keyless — but the limit we
 * actually get is VARIABLE. Live on 2026-09-02, evenly-paced traffic at 20/min
 * still drew a 429 every handful of calls, with only a few grants surviving
 * after each cooldown: the per-IP quota is shared with whoever else calls GT
 * from the same egress IP (Railway pools them), so no fixed constant can be
 * right on both a quiet IP and a crowded one.
 *
 * So the budgeter ADAPTS: every grant is paced at least `minGapMs` apart; a
 * 429 doubles that gap (up to 15s) on top of the 30s cooldown, and a sustained
 * run of successes halves it back down to the 2s base. The 20/min window stays
 * as the hard ceiling for the quiet-IP case.
 */
export const WINDOW_MS = 60_000;
export const MAX_PER_WINDOW = 20;
export const BASE_GAP_MS = 2_000;
export const MAX_GAP_MS = 15_000;
/** Successes in a row before the gap relaxes one step. */
const RECOVERY_STREAK = 20;
const COOLDOWN_MS = 30_000;
/**
 * How long a yielding scan waiter sleeps before asking again. Short enough that
 * the scan takes the slot the instant the polls stop queueing.
 */
export const SCAN_YIELD_MS = 250;

/**
 * ...and the ceiling on that yielding: a scan waiter this old is treated as a
 * poll for ONE grant, so continuous poll traffic can delay the scan but never
 * starve it. Costs the polls at most one gap per aged scan call.
 */
export const SCAN_MAX_YIELD_MS = 60_000;

/**
 * What the caller is doing with the slot.
 *
 * 'poll' is the live board — the 15s tick, an immediate poll after a call, a
 * call-time backfill; something on screen is waiting for it. 'scan' is the
 * 3-hourly Sleepers sweep: nothing waits on it and it can afford to be last.
 */
export type GtPriority = 'poll' | 'scan';

/** Everything the grant decision reads. Plain data, so it is testable. */
export interface BudgetState {
  /** Grant timestamps inside the sliding window, oldest first. */
  stamps: readonly number[];
  cooldownUntil: number;
  lastGrantMs: number;
  minGapMs: number;
  /** How many 'poll' callers are queued for a slot right now. */
  waitingPoll: number;
}

export type BudgetDecision = { grant: true } | { grant: false; waitMs: number };

/**
 * Grant or wait, as a pure function of the budget's state and the clock.
 *
 * The order is the policy: a cooldown outranks everything, then scan traffic
 * yields to any waiting poll, then the adaptive inter-call gap, then the
 * window ceiling. Every wait is strictly positive, so a caller looping on this
 * can never spin.
 *
 * `waitedMs` is how long this caller has already been yielding. A scan that has
 * yielded for SCAN_MAX_YIELD_MS stops yielding: without it, poll traffic that
 * keeps one caller queued at all times (a tick of unresolved CAs at a
 * backed-off gap does) would hold the scan off indefinitely.
 */
export function budgetDecision(
  state: BudgetState,
  priority: GtPriority,
  nowMs: number,
  waitedMs = 0,
): BudgetDecision {
  if (nowMs < state.cooldownUntil) return { grant: false, waitMs: state.cooldownUntil - nowMs };
  if (priority === 'scan' && state.waitingPoll > 0 && waitedMs < SCAN_MAX_YIELD_MS) {
    return { grant: false, waitMs: SCAN_YIELD_MS };
  }
  const sinceLast = nowMs - state.lastGrantMs;
  if (sinceLast < state.minGapMs) return { grant: false, waitMs: state.minGapMs - sinceLast };
  const live = state.stamps.filter((s) => nowMs - s <= WINDOW_MS);
  if (live.length < MAX_PER_WINDOW) return { grant: true };
  return { grant: false, waitMs: WINDOW_MS - (nowMs - live[0]!) + 100 };
}

/** The 429 step and the recovery step, split out so the curve is testable. */
export function backedOffGap(currentGapMs: number): number {
  return Math.min(currentGapMs * 2, MAX_GAP_MS);
}
export function relaxedGap(currentGapMs: number): number {
  return Math.max(BASE_GAP_MS, currentGapMs / 2);
}

const stamps: number[] = [];
let cooldownUntil = 0;
let lastGrantMs = 0;
let minGapMs = BASE_GAP_MS;
let successStreak = 0;
let waitingPoll = 0;

function backOff(): void {
  successStreak = 0;
  const next = backedOffGap(minGapMs);
  if (next !== minGapMs) {
    minGapMs = next;
    console.warn(`gt budgeter: 429 — pacing backed off to ${minGapMs / 1000}s between calls`);
  }
}

function noteSuccess(): void {
  successStreak += 1;
  if (successStreak >= RECOVERY_STREAK && minGapMs > BASE_GAP_MS) {
    successStreak = 0;
    minGapMs = relaxedGap(minGapMs);
    console.log(`gt budgeter: quota recovered — pacing relaxed to ${minGapMs / 1000}s`);
  }
}

/** Test-only: returns the module's budget state to its boot values. */
export function resetBudget(): void {
  stamps.length = 0;
  cooldownUntil = 0;
  lastGrantMs = 0;
  minGapMs = BASE_GAP_MS;
  successStreak = 0;
  waitingPoll = 0;
}

/** Exported for the fake-timer test that pins the queueing behaviour. */
export async function acquireSlot(priority: GtPriority): Promise<void> {
  // Counted before the first decision so a scan already sleeping sees this poll
  // on its next look, and released in `finally` so a rejected caller (there is
  // none today) could never leave the count high and park the scan forever.
  if (priority === 'poll') waitingPoll += 1;
  const arrivedMs = Date.now();
  try {
    for (;;) {
      const now = Date.now();
      // Single-threaded: no await between this decision and the grant below, so
      // two concurrent waiters cannot both pass the same gap.
      const decision = budgetDecision(
        { stamps, cooldownUntil, lastGrantMs, minGapMs, waitingPoll },
        priority,
        now,
        Math.max(0, now - arrivedMs),
      );
      if (decision.grant) {
        while (stamps.length > 0 && now - stamps[0]! > WINDOW_MS) stamps.shift();
        stamps.push(now);
        lastGrantMs = now;
        return;
      }
      await new Promise((r) => setTimeout(r, decision.waitMs));
    }
  } finally {
    if (priority === 'poll') waitingPoll -= 1;
  }
}

async function gtFetch(path: string, priority: GtPriority = 'poll'): Promise<unknown | null> {
  await acquireSlot(priority);
  const res = await fetch(`${BASE}${path}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) {
    noteSuccess();
    return null;
  }
  if (res.status === 429) {
    // Back off at the budgeter, not in flight: sleeping here would hold the
    // caller's tick open and every later caller would pay the wait again.
    cooldownUntil = Date.now() + COOLDOWN_MS;
    backOff();
    throw new Error('geckoterminal 429');
  }
  if (!res.ok) throw new Error(`geckoterminal ${res.status} on ${path}`);
  noteSuccess();
  return res.json();
}

export interface JsonApiResource {
  id?: string;
  type?: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: Array<{ id?: string }> | { id?: string } | null }>;
}

export interface GtTokenInfo {
  address: string;
  symbol: string | null;
  name: string | null;
  imageUrl: string | null;
  priceUsd: number | null;
  fdvUsd: number | null;
  totalSupply: number | null;
  vol24Usd: number | null;
  topPoolAddress: string | null;
  /** launchpad_details.completed; null when the token isn't a launchpad token. */
  launchpadCompleted: boolean | null;
}

/** Pool ids look like "robinhood_0xabc..."; strip the network prefix. */
function poolIdToAddress(id: string | undefined): string | null {
  if (!id) return null;
  const idx = id.indexOf('_');
  return idx >= 0 ? id.slice(idx + 1).toLowerCase() : id.toLowerCase();
}

/** Batch lookup by token address (up to 30). Missing tokens are simply absent. */
export async function getTokensMulti(addresses: string[]): Promise<Map<string, GtTokenInfo>> {
  const out = new Map<string, GtTokenInfo>();
  if (addresses.length === 0) return out;
  const body = (await gtFetch(
    `/networks/${ROBINHOOD_SLUG}/tokens/multi/${addresses.join(',')}?include=top_pools`,
  )) as { data?: JsonApiResource[] } | null;
  for (const item of body?.data ?? []) {
    const a = item.attributes ?? {};
    const address = typeof a.address === 'string' ? a.address.toLowerCase() : null;
    if (!address) continue;
    const topPools = item.relationships?.top_pools?.data;
    const first = Array.isArray(topPools) ? topPools[0] : topPools;
    const launchpad = a.launchpad_details as Record<string, unknown> | undefined;
    out.set(address, {
      address,
      symbol: typeof a.symbol === 'string' ? a.symbol : null,
      name: typeof a.name === 'string' ? a.name : null,
      imageUrl: typeof a.image_url === 'string' ? a.image_url : null,
      priceUsd: num(a.price_usd),
      fdvUsd: num(a.fdv_usd) ?? num(a.market_cap_usd),
      totalSupply: num(a.total_supply),
      vol24Usd: num((a.volume_usd as Record<string, unknown> | undefined)?.h24),
      topPoolAddress: poolIdToAddress(first?.id),
      launchpadCompleted: typeof launchpad?.completed === 'boolean' ? launchpad.completed : null,
    });
  }
  return out;
}

export interface GtPoolInfo {
  poolAddress: string;
  priceUsd: number | null;
  fdvUsd: number | null;
  reserveUsd: number | null;
  vol24Usd: number | null;
  poolCreatedAt: Date | null;
  graduationPct: number | null;
  graduated: boolean | null;
  /** Where trading moved after graduation; the curve pool is abandoned. */
  migratedPoolAddress: string | null;
  dex: string | null;
}

/**
 * One pool resource -> GtPoolInfo. The single-pool and multi-pool endpoints
 * answer with the SAME attributes (verified live 2026-09-02), so both go
 * through this: a batched reading and a single one can never diverge.
 *
 * `poolAddress` is supplied by the caller because only it knows which address
 * this resource is the answer to — the request's for /pools/{addr}, the payload's
 * own `attributes.address` for a multi response.
 */
export function parsePoolResource(resource: JsonApiResource, poolAddress: string): GtPoolInfo {
  const a = resource.attributes ?? {};
  const launchpad = a.launchpad_details as Record<string, unknown> | undefined;
  const dexRel = resource.relationships?.dex?.data;
  const dexId = Array.isArray(dexRel) ? dexRel[0]?.id : dexRel?.id;
  const created = typeof a.pool_created_at === 'string' ? new Date(a.pool_created_at) : null;
  const migrated = launchpad?.migrated_destination_pool_address;
  return {
    poolAddress: poolAddress.toLowerCase(),
    priceUsd: num(a.base_token_price_usd),
    fdvUsd: num(a.fdv_usd) ?? num(a.market_cap_usd),
    reserveUsd: num(a.reserve_in_usd),
    vol24Usd: num((a.volume_usd as Record<string, unknown> | undefined)?.h24),
    poolCreatedAt: created && !Number.isNaN(created.getTime()) ? created : null,
    graduationPct: num(launchpad?.graduation_percentage),
    graduated: typeof launchpad?.completed === 'boolean' ? launchpad.completed : null,
    migratedPoolAddress: typeof migrated === 'string' && migrated ? migrated.toLowerCase() : null,
    dex: typeof dexId === 'string' ? dexId : null,
  };
}

export async function getPool(poolAddress: string): Promise<GtPoolInfo | null> {
  const body = (await gtFetch(`/networks/${ROBINHOOD_SLUG}/pools/${poolAddress}`)) as {
    data?: JsonApiResource;
  } | null;
  if (!body?.data?.attributes) return null;
  return parsePoolResource(body.data, poolAddress);
}

/** GeckoTerminal's cap on `/pools/multi/{...}` — verified live 2026-09-02. */
export const POOLS_MULTI_MAX = 30;

/** Fixed-size slices, in order. Exported for the chunking test. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * One `/pools/multi` response -> the pools it actually carried.
 *
 * Keyed by the pool address LOWERCASE (which is how GeckoTerminal returns it
 * and how the database stores it), plus an alias under the exact string the
 * caller asked with when that differs (defensive: pool_address rows are
 * lowercase today) — so `map.get(token.poolAddress)` works whatever casing a
 * row carries.
 *
 * A pool GeckoTerminal does not know is simply ABSENT from `data[]` — no error,
 * no empty row — and so is a resource that arrives with no `attributes`, which
 * getPool answers as null. Either absence is "no reading" and must never be
 * read as a $0 market; the callers own that, and this map just doesn't contain
 * the address.
 */
export function parsePoolsMulti(
  body: unknown,
  requested: readonly string[],
): Map<string, GtPoolInfo> {
  const out = new Map<string, GtPoolInfo>();
  const asked = new Map(requested.map((a) => [a.toLowerCase(), a]));
  const data = (body as { data?: JsonApiResource[] } | null)?.data ?? [];
  for (const item of data) {
    if (!item.attributes) continue;
    const a = item.attributes;
    const address =
      typeof a.address === 'string' && a.address ? a.address.toLowerCase() : poolIdToAddress(item.id);
    if (!address) continue;
    const info = parsePoolResource(item, address);
    out.set(address, info);
    const original = asked.get(address);
    if (original !== undefined && original !== address) out.set(original, info);
  }
  return out;
}

/**
 * Batch pool lookup (docs/decisions.md round 16b). POOLS_MULTI_MAX is the
 * endpoint's own ceiling, so anything longer is chunked into several calls.
 */
export async function getPoolsMulti(poolAddresses: string[]): Promise<Map<string, GtPoolInfo>> {
  const out = new Map<string, GtPoolInfo>();
  for (const part of chunk(poolAddresses, POOLS_MULTI_MAX)) {
    if (part.length === 0) continue;
    const body = await gtFetch(`/networks/${ROBINHOOD_SLUG}/pools/multi/${part.join(',')}`);
    for (const [key, info] of parsePoolsMulti(body, part)) out.set(key, info);
  }
  return out;
}

/**
 * Close of the newest candle that STARTS at or before `atSec`.
 * Rows are newest-first [timestamp, open, high, low, close, volume] and
 * before_timestamp filters on the candle start, so row 0 is routinely the
 * minute AFTER the call — taking it blindly reads the price ~2min late.
 */
export function pickCandleClose(rows: unknown[][], atSec: number): number | null {
  for (const row of rows) {
    const ts = num(row?.[0]);
    if (ts !== null && ts <= atSec) return num(row[4]);
  }
  return null;
}

/**
 * Close price (USD) of the minute candle covering `at`, or null. Used to
 * backfill price-at-call when a call is processed late.
 */
export async function getMinuteClose(poolAddress: string, at: Date): Promise<number | null> {
  const atSec = Math.floor(at.getTime() / 1000);
  const body = (await gtFetch(
    `/networks/${ROBINHOOD_SLUG}/pools/${poolAddress}/ohlcv/minute?before_timestamp=${atSec + 60}&limit=3`,
  )) as { data?: { attributes?: { ohlcv_list?: unknown[][] } } } | null;
  return pickCandleClose(body?.data?.attributes?.ohlcv_list ?? [], atSec);
}

/** One OHLCV candle. `tsSec` is the candle's START, as GeckoTerminal reports it. */
export interface GtCandle {
  tsSec: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * `ohlcv_list` rows, coerced. Same shape as pickCandleClose reads:
 * `[timestamp, open, high, low, close, volume]`, newest-first, with every money
 * figure liable to arrive as a string.
 *
 * A row missing a timestamp or a close is DROPPED rather than defaulted — a
 * candle we cannot price is not a candle, and the residency walk that consumes
 * these would read a fabricated 0 as "left the band". Order is re-asserted
 * (newest first) so a caller never has to trust the server's sort.
 */
export function parseOhlcvRows(rows: unknown[][]): GtCandle[] {
  const out: GtCandle[] = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const tsSec = num(row[0]);
    const close = num(row[4]);
    if (tsSec === null || close === null) continue;
    out.push({
      tsSec,
      open: num(row[1]) ?? close,
      high: num(row[2]) ?? close,
      low: num(row[3]) ?? close,
      close,
    });
  }
  out.sort((a, b) => b.tsSec - a.tsSec);
  return out;
}

/**
 * The last `limit` hourly or daily candles for a pool, newest first.
 *
 * Used by the Sleepers scan to measure how long a coin has been sitting in its
 * band (docs/decisions.md round 14). Goes through the same budgeter as every
 * other call here, so a scan's worth of these simply queues behind the polls.
 */
export async function getOhlcv(
  poolAddress: string,
  timeframe: 'hour' | 'day',
  limit: number,
  priority: GtPriority = 'poll',
): Promise<GtCandle[]> {
  const body = (await gtFetch(
    `/networks/${ROBINHOOD_SLUG}/pools/${poolAddress}/ohlcv/${timeframe}?limit=${limit}`,
    priority,
  )) as { data?: { attributes?: { ohlcv_list?: unknown[][] } } } | null;
  return parseOhlcvRows(body?.data?.attributes?.ohlcv_list ?? []);
}

/**
 * One row of the chain-wide pool listing. Deliberately flat and nullable: the
 * Sleepers scan is the only caller, and it does its own floor checks.
 */
export interface GtPoolListing {
  poolAddress: string;
  /** Base token address, lowercase, network prefix stripped. */
  baseTokenAddress: string;
  /** The pool's own name, e.g. "SABLE / WETH 1%" — a symbol fallback. */
  poolName: string | null;
  mcapUsd: number | null;
  /**
   * Base token price in USD. Paired with mcapUsd it infers circulating supply,
   * which is what turns this pool's candle closes into market caps.
   */
  priceUsd: number | null;
  liquidityUsd: number | null;
  vol24Usd: number | null;
  /** buys + sells over 24h; null when the block is missing entirely. */
  txns24: number | null;
  /**
   * buys + sells over the LAST HOUR; null when the block is missing entirely.
   * The 24h figures are trailing, so this is the only thing in the listing that
   * says whether the coin is still trading right now.
   */
  txns1h: number | null;
  poolCreatedAt: Date | null;
}

/**
 * One page of the network's pools, sorted by 24h volume desc (20 per page).
 *
 * Verified against a live response 2026-09-02: every money figure arrives as a
 * STRING (`fdv_usd`, `market_cap_usd`, `volume_usd.h24`, `reserve_in_usd`),
 * `transactions.h24.buys`/`sells` arrive as numbers, `market_cap_usd` is
 * routinely null for small tokens (fdv is the usable value), and the base token
 * sits in `relationships.base_token.data.id` as "robinhood_0x…".
 *
 * The free tier caps `page` at 10 and answers an 11th with a 401 + errors body;
 * callers must stop at SLEEPERS.maxPages. An empty/missing `data` array returns
 * [] so a caller can stop early.
 */
export async function getTopPools(
  page: number,
  priority: GtPriority = 'poll',
): Promise<GtPoolListing[]> {
  const body = (await gtFetch(
    `/networks/${ROBINHOOD_SLUG}/pools?sort=h24_volume_usd_desc&page=${page}`,
    priority,
  )) as { data?: JsonApiResource[] } | null;

  const out: GtPoolListing[] = [];
  for (const item of body?.data ?? []) {
    const a = item.attributes ?? {};
    const poolAddress =
      typeof a.address === 'string' && a.address ? a.address.toLowerCase() : poolIdToAddress(item.id);
    const baseRel = item.relationships?.base_token?.data;
    const base = Array.isArray(baseRel) ? baseRel[0] : baseRel;
    const baseTokenAddress = poolIdToAddress(base?.id);
    if (!poolAddress || !baseTokenAddress) continue;

    const transactions = a.transactions as Record<string, unknown> | undefined;
    const sumTxns = (window: 'h24' | 'h1'): number | null => {
      const block = transactions?.[window] as Record<string, unknown> | undefined;
      const buys = num(block?.buys);
      const sells = num(block?.sells);
      return buys === null && sells === null ? null : (buys ?? 0) + (sells ?? 0);
    };
    const created = typeof a.pool_created_at === 'string' ? new Date(a.pool_created_at) : null;

    out.push({
      poolAddress,
      baseTokenAddress,
      poolName: typeof a.name === 'string' ? a.name : null,
      // Same precedence as everywhere else in this client: fdv first, because
      // market_cap_usd is null for most of the chain.
      mcapUsd: num(a.fdv_usd) ?? num(a.market_cap_usd),
      priceUsd: num(a.base_token_price_usd),
      liquidityUsd: num(a.reserve_in_usd),
      vol24Usd: num((a.volume_usd as Record<string, unknown> | undefined)?.h24),
      txns24: sumTxns('h24'),
      txns1h: sumTxns('h1'),
      poolCreatedAt: created && !Number.isNaN(created.getTime()) ? created : null,
    });
  }
  return out;
}

export function gtSnapshot(info: {
  priceUsd: number | null;
  fdvUsd: number | null;
  reserveUsd?: number | null;
  vol24Usd: number | null;
}): MarketSnapshot {
  return {
    priceUsd: info.priceUsd,
    mcapUsd: info.fdvUsd,
    liquidityUsd: info.reserveUsd ?? null,
    vol24Usd: info.vol24Usd,
  };
}
