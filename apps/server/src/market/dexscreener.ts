import { ROBINHOOD_SLUG } from '@groupie/shared';
import { num, type MarketSnapshot } from './types.js';

/**
 * DexScreener free API: 300 req/min on the token endpoints, 30 addresses per
 * batch. `/tokens/v1/{chain}/{addrs}` returns ONE best pair per token; unknown
 * addresses are silently omitted — absence means "not indexed", NEVER "dead"
 * (actively-trading launchpad curve tokens are also absent here).
 */
const BASE = 'https://api.dexscreener.com';

export interface DsPair {
  tokenAddress: string;
  pairAddress: string | null;
  dexId: string | null;
  symbol: string | null;
  name: string | null;
  imageUrl: string | null;
  socials: Record<string, string> | null;
  priceUsd: number | null;
  mcapUsd: number | null;
  liquidityUsd: number | null;
  vol24Usd: number | null;
  /**
   * buys + sells over 24h (docs/decisions.md round 21). null when DexScreener
   * carried no `txns.h24` block at all — which is "we were not told", never
   * "nothing traded", and the flatline rule must not read it as the latter.
   */
  txns24: number | null;
  pairCreatedAt: Date | null;
}

interface RawPair {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  baseToken?: { address?: string; symbol?: string; name?: string };
  quoteToken?: { address?: string };
  priceUsd?: string;
  marketCap?: number;
  fdv?: number;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  txns?: { h24?: { buys?: number; sells?: number } };
  pairCreatedAt?: number;
  info?: {
    imageUrl?: string;
    websites?: Array<{ url?: string }>;
    socials?: Array<{ type?: string; url?: string }>;
  };
}

/**
 * `txns.h24.buys + .sells`, or null when the block is absent entirely — the
 * same "missing is not zero" rule GeckoTerminal's sumTxns follows. One side
 * present and the other absent counts the side we have.
 */
function dsTxns24(raw: RawPair): number | null {
  const buys = num(raw.txns?.h24?.buys);
  const sells = num(raw.txns?.h24?.sells);
  return buys === null && sells === null ? null : (buys ?? 0) + (sells ?? 0);
}

function toPair(raw: RawPair): DsPair | null {
  const tokenAddress = raw.baseToken?.address?.toLowerCase();
  if (!tokenAddress) return null;
  const socials: Record<string, string> = {};
  for (const s of raw.info?.socials ?? []) {
    if (s.type && s.url) socials[s.type] = s.url;
  }
  const website = raw.info?.websites?.[0]?.url;
  if (website) socials.website = website;
  return {
    tokenAddress,
    pairAddress: raw.pairAddress?.toLowerCase() ?? null,
    dexId: raw.dexId ?? null,
    symbol: raw.baseToken?.symbol ?? null,
    name: raw.baseToken?.name ?? null,
    imageUrl: raw.info?.imageUrl ?? null,
    socials: Object.keys(socials).length > 0 ? socials : null,
    priceUsd: num(raw.priceUsd),
    // Dead pairs can drop these keys entirely — treat absence as null.
    mcapUsd: num(raw.marketCap) ?? num(raw.fdv),
    // liquidity is nullable in the schema; null here means "unknown", and
    // callers must not treat unknown as zero.
    liquidityUsd: num(raw.liquidity?.usd),
    vol24Usd: num(raw.volume?.h24),
    txns24: dsTxns24(raw),
    pairCreatedAt: raw.pairCreatedAt ? new Date(raw.pairCreatedAt) : null,
  };
}

/** Batch best-pair lookup. Keyed by lowercase token address. Max 30 addresses. */
export async function getBestPairs(addresses: string[]): Promise<Map<string, DsPair>> {
  const out = new Map<string, DsPair>();
  if (addresses.length === 0) return out;
  if (addresses.length > 30) throw new Error('dexscreener batch max is 30 addresses');
  const res = await fetch(`${BASE}/tokens/v1/${ROBINHOOD_SLUG}/${addresses.join(',')}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`dexscreener ${res.status}`);
  const body = (await res.json()) as RawPair[] | null;
  for (const raw of body ?? []) {
    const pair = toPair(raw);
    if (pair) out.set(pair.tokenAddress, pair);
  }
  return out;
}

/**
 * Which chains DexScreener has pairs for, ANY chain (docs/decisions.md round
 * 17b) — the one question `/tokens/v1/{chain}/...` cannot answer.
 *
 * Asked only when both Robinhood-Chain lookups have already missed, and only
 * past the fast window — a token that resolves here never costs this call, and
 * the caller owns both of those rules. `/latest/dex/tokens`
 * answers `{ pairs: [...] }` — `pairs: null` for an address it has never seen,
 * which comes back as an EMPTY SET. Empty is "DexScreener knows nothing", never
 * "the token is fake": the caller owns that distinction.
 *
 * A pair counts only when the requested address is one of its two tokens —
 * matched case-insensitively, since chains disagree about address casing.
 */
export async function findChainsFor(address: string): Promise<Set<string>> {
  const res = await fetch(`${BASE}/latest/dex/tokens/${address}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`dexscreener ${res.status}`);
  const body = (await res.json()) as { pairs?: RawPair[] | null } | null;
  const wanted = address.toLowerCase();
  const chains = new Set<string>();
  for (const raw of body?.pairs ?? []) {
    const chainId = typeof raw.chainId === 'string' ? raw.chainId.trim().toLowerCase() : '';
    if (chainId.length === 0) continue;
    const base = raw.baseToken?.address?.toLowerCase();
    const quote = raw.quoteToken?.address?.toLowerCase();
    if (base !== wanted && quote !== wanted) continue;
    chains.add(chainId);
  }
  return chains;
}

/**
 * Every pool DexScreener knows for a token on THIS chain, oldest-first-ish (the
 * caller sorts) — the "is this the coin's first pool?" question round 18 asks of
 * every launch candidate, and the one `/tokens/v1` cannot answer because it
 * returns a single best pair.
 *
 * Asked once per surviving candidate, after the reserve floor has already cut
 * the ~500 dust pools an hour down to a handful. On the 300/min token route.
 *
 * A `pairCreatedAt` DexScreener does not carry is dropped rather than dated
 * `now`: an undated pool cannot prove it predates ours, and the caller's rule is
 * "an OLDER pool exists", never "some pool exists" (our own pool is in this
 * list within a minute of creation).
 */
export async function getTokenPools(
  address: string,
): Promise<Array<{ pairAddress: string | null; dexId: string | null; pairCreatedAt: Date }>> {
  const res = await fetch(`${BASE}/token-pairs/v1/${ROBINHOOD_SLUG}/${address}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`dexscreener ${res.status}`);
  const body = (await res.json()) as RawPair[] | null;
  const out: Array<{ pairAddress: string | null; dexId: string | null; pairCreatedAt: Date }> = [];
  for (const raw of body ?? []) {
    if (!raw.pairCreatedAt) continue;
    const at = new Date(raw.pairCreatedAt);
    if (Number.isNaN(at.getTime())) continue;
    out.push({
      pairAddress: raw.pairAddress?.toLowerCase() ?? null,
      dexId: raw.dexId ?? null,
      pairCreatedAt: at,
    });
  }
  return out;
}

/**
 * ETH in USD, so an on-chain reserve measured in wei can also be shown in
 * dollars. Cached because it is the same number for every candidate in a tick
 * and it does not move meaningfully inside a few minutes.
 *
 * Read off the WETH token's own best pair — the one where WETH is the BASE
 * token, since that is the row whose `priceUsd` is WETH's price. A response
 * where WETH is only ever the quote gives no answer, and no answer is null: an
 * invented ETH price would corrupt every USD figure downstream.
 */
const ETH_PRICE_TTL_MS = 10 * 60_000;
let ethPriceUsd: number | null = null;
let ethPriceAtMs = 0;

/** Test-only: forget the cached ETH price. */
export function resetEthPriceCache(): void {
  ethPriceUsd = null;
  ethPriceAtMs = 0;
}

export async function getEthPriceUsd(wethAddress: string): Promise<number | null> {
  if (ethPriceUsd !== null && Date.now() - ethPriceAtMs < ETH_PRICE_TTL_MS) return ethPriceUsd;
  const res = await fetch(`${BASE}/latest/dex/tokens/${wethAddress}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`dexscreener ${res.status}`);
  const body = (await res.json()) as { pairs?: RawPair[] | null } | null;
  const wanted = wethAddress.toLowerCase();
  let best: number | null = null;
  let bestLiquidity = -1;
  for (const raw of body?.pairs ?? []) {
    if (raw.chainId !== undefined && raw.chainId.toLowerCase() !== ROBINHOOD_SLUG) continue;
    if (raw.baseToken?.address?.toLowerCase() !== wanted) continue;
    const price = num(raw.priceUsd);
    if (price === null || price <= 0) continue;
    const liquidity = num(raw.liquidity?.usd) ?? 0;
    if (liquidity <= bestLiquidity) continue;
    bestLiquidity = liquidity;
    best = price;
  }
  if (best === null) return null;
  ethPriceUsd = best;
  ethPriceAtMs = Date.now();
  return best;
}

export function dsSnapshot(pair: DsPair): MarketSnapshot {
  return {
    priceUsd: pair.priceUsd,
    mcapUsd: pair.mcapUsd,
    liquidityUsd: pair.liquidityUsd,
    vol24Usd: pair.vol24Usd,
    txns24: pair.txns24,
  };
}
