import { ROBINHOOD_SLUG } from '@groupie/shared';
import { num, type MarketSnapshot } from './types.js';

const BASE = 'https://api.geckoterminal.com/api/v2';

/**
 * GeckoTerminal free tier: 30 calls/min, keyless. Budget to 25/min for
 * headroom; callers await a slot before each request.
 */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 25;
const COOLDOWN_MS = 30_000;
const stamps: number[] = [];
let cooldownUntil = 0;

async function acquireSlot(): Promise<void> {
  for (;;) {
    const now = Date.now();
    if (now < cooldownUntil) {
      await new Promise((r) => setTimeout(r, cooldownUntil - now));
      continue;
    }
    while (stamps.length > 0 && now - stamps[0]! > WINDOW_MS) stamps.shift();
    if (stamps.length < MAX_PER_WINDOW) {
      stamps.push(now);
      return;
    }
    const waitMs = WINDOW_MS - (now - stamps[0]!) + 100;
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

async function gtFetch(path: string): Promise<unknown | null> {
  await acquireSlot();
  const res = await fetch(`${BASE}${path}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return null;
  if (res.status === 429) {
    // Back off at the budgeter, not in flight: sleeping here would hold the
    // caller's tick open and every later caller would pay the wait again.
    cooldownUntil = Date.now() + COOLDOWN_MS;
    throw new Error('geckoterminal 429');
  }
  if (!res.ok) throw new Error(`geckoterminal ${res.status} on ${path}`);
  return res.json();
}

interface JsonApiResource {
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

export async function getPool(poolAddress: string): Promise<GtPoolInfo | null> {
  const body = (await gtFetch(`/networks/${ROBINHOOD_SLUG}/pools/${poolAddress}`)) as {
    data?: JsonApiResource;
  } | null;
  const a = body?.data?.attributes;
  if (!a) return null;
  const launchpad = a.launchpad_details as Record<string, unknown> | undefined;
  const dexRel = body?.data?.relationships?.dex?.data;
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
  liquidityUsd: number | null;
  vol24Usd: number | null;
  /** buys + sells over 24h; null when the block is missing entirely. */
  txns24: number | null;
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
export async function getTopPools(page: number): Promise<GtPoolListing[]> {
  const body = (await gtFetch(
    `/networks/${ROBINHOOD_SLUG}/pools?sort=h24_volume_usd_desc&page=${page}`,
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

    const txns = (a.transactions as Record<string, unknown> | undefined)?.h24 as
      | Record<string, unknown>
      | undefined;
    const buys = num(txns?.buys);
    const sells = num(txns?.sells);
    const created = typeof a.pool_created_at === 'string' ? new Date(a.pool_created_at) : null;

    out.push({
      poolAddress,
      baseTokenAddress,
      poolName: typeof a.name === 'string' ? a.name : null,
      // Same precedence as everywhere else in this client: fdv first, because
      // market_cap_usd is null for most of the chain.
      mcapUsd: num(a.fdv_usd) ?? num(a.market_cap_usd),
      liquidityUsd: num(a.reserve_in_usd),
      vol24Usd: num((a.volume_usd as Record<string, unknown> | undefined)?.h24),
      txns24: buys === null && sells === null ? null : (buys ?? 0) + (sells ?? 0),
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
