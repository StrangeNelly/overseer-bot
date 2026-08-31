import { THRESHOLDS } from '@groupie/shared';
import * as ds from './dexscreener.js';
import * as gt from './geckoterminal.js';
import type { ResolvedToken } from './types.js';

/**
 * Resolve a fresh CA into token metadata + first market snapshot.
 * GeckoTerminal first (it sees launchpad bonding curves; DexScreener does
 * not), DexScreener as fallback for anything GT missed. Returns null when
 * neither source knows the token yet (stay `unresolved`, retry on the next
 * poll — brand-new launches can take ~40s-3min to index).
 *
 * DexScreener dust landmine: for curve-phase tokens it can return parasitic
 * Uniswap pools with absurd FDVs on near-zero liquidity, so a DS pair only
 * counts as proof of a real pool above the dust threshold.
 */
export async function resolveToken(address: string): Promise<ResolvedToken | null> {
  const gtInfo = (await gt.getTokensMulti([address])).get(address);
  if (gtInfo) {
    const pool = gtInfo.topPoolAddress ? await gt.getPool(gtInfo.topPoolAddress) : null;
    // No pool = no phase evidence. Staying unresolved retries next tick; a
    // curve token guessed as 'graduated' is polled via DexScreener, which does
    // not index curve tokens, so it would never be corrected. The 48h
    // never_graduated rule is the backstop for a token that never resolves.
    if (!pool) return null;
    // launchpad_details.completed === false means still on the bonding curve.
    const phase: ResolvedToken['phase'] =
      gtInfo.launchpadCompleted === false || pool.graduated === false ? 'curve' : 'graduated';
    return {
      symbol: gtInfo.symbol,
      name: gtInfo.name,
      imageUrl: gtInfo.imageUrl,
      socials: null, // GT socials need a separate /info call; DS fills these on graduation.
      launchpad: phase === 'curve' ? pool.dex : null,
      phase,
      poolAddress: pool.poolAddress,
      tokenCreatedAt: pool.poolCreatedAt,
      snapshot: gt.gtSnapshot({
        priceUsd: gtInfo.priceUsd ?? pool.priceUsd,
        fdvUsd: gtInfo.fdvUsd ?? pool.fdvUsd,
        reserveUsd: pool.reserveUsd,
        vol24Usd: gtInfo.vol24Usd ?? pool.vol24Usd,
      }),
    };
  }

  const pair = (await ds.getBestPairs([address])).get(address);
  if (pair && (pair.liquidityUsd ?? 0) >= THRESHOLDS.dustLiquidityUsd) {
    return {
      symbol: pair.symbol,
      name: pair.name,
      imageUrl: pair.imageUrl,
      socials: pair.socials,
      launchpad: null,
      phase: 'graduated',
      poolAddress: pair.pairAddress,
      tokenCreatedAt: pair.pairCreatedAt,
      snapshot: ds.dsSnapshot(pair),
    };
  }

  return null;
}

/**
 * Best-effort price at the call instant for late-processed calls, via the GT
 * minute candle covering the call time. Returns mcap (price x supply-implied
 * multiplier from the current snapshot) or null.
 */
export async function mcapAtTimestamp(
  poolAddress: string,
  at: Date,
  currentPriceUsd: number | null,
  currentMcapUsd: number | null,
): Promise<number | null> {
  if (!currentPriceUsd || !currentMcapUsd || currentPriceUsd <= 0) return null;
  try {
    const close = await gt.getMinuteClose(poolAddress, at);
    if (close === null || close <= 0) return null;
    const supply = currentMcapUsd / currentPriceUsd;
    return close * supply;
  } catch {
    return null; // backfill is best-effort; the live value stands in
  }
}
