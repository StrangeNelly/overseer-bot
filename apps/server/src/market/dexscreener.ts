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
  pairCreatedAt: Date | null;
}

interface RawPair {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  baseToken?: { address?: string; symbol?: string; name?: string };
  priceUsd?: string;
  marketCap?: number;
  fdv?: number;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  pairCreatedAt?: number;
  info?: {
    imageUrl?: string;
    websites?: Array<{ url?: string }>;
    socials?: Array<{ type?: string; url?: string }>;
  };
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

export function dsSnapshot(pair: DsPair): MarketSnapshot {
  return {
    priceUsd: pair.priceUsd,
    mcapUsd: pair.mcapUsd,
    liquidityUsd: pair.liquidityUsd,
    vol24Usd: pair.vol24Usd,
  };
}
