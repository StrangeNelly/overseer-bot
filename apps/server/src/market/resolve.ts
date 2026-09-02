import { THRESHOLDS } from '@groupie/shared';
import * as ds from './dexscreener.js';
import * as gt from './geckoterminal.js';
import type { ResolvedToken } from './types.js';

/**
 * What one resolution attempt learned about an address.
 *
 * `token` null means "no first reading yet" — it is NEVER evidence about the
 * market. `unknownOnChain` splits that null in two, which is the whole point of
 * round 17b: a token GeckoTerminal knows but whose pool we could not read is
 * simply early, while an address NEITHER Robinhood-Chain source has ever heard
 * of is the only shape that can be a wrong-chain candidate.
 */
export interface Resolution {
  token: ResolvedToken | null;
  unknownOnChain: boolean;
}

function fromGt(info: gt.GtTokenInfo, pool: gt.GtPoolInfo): ResolvedToken {
  // launchpad_details.completed === false means still on the bonding curve.
  const phase: ResolvedToken['phase'] =
    info.launchpadCompleted === false || pool.graduated === false ? 'curve' : 'graduated';
  return {
    symbol: info.symbol,
    name: info.name,
    imageUrl: info.imageUrl,
    socials: null, // GT socials need a separate /info call; DS fills these on graduation.
    launchpad: phase === 'curve' ? pool.dex : null,
    phase,
    poolAddress: pool.poolAddress,
    tokenCreatedAt: pool.poolCreatedAt,
    snapshot: gt.gtSnapshot({
      priceUsd: info.priceUsd ?? pool.priceUsd,
      fdvUsd: info.fdvUsd ?? pool.fdvUsd,
      reserveUsd: pool.reserveUsd,
      vol24Usd: info.vol24Usd ?? pool.vol24Usd,
    }),
  };
}

function fromDs(pair: ds.DsPair): ResolvedToken {
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

/**
 * Resolve fresh CAs into token metadata + a first market snapshot, in BATCH
 * (docs/decisions.md round 17b). At most three network calls for the whole
 * group, whatever its size:
 *
 *   1. GT `/tokens/multi` — one call for every address (30 is the endpoint's
 *      ceiling, and the scheduler's cap);
 *   2. GT `/pools/multi` — one call for the top pools of the tokens GT knows.
 *      A second call is unavoidable: the token resource carries price, FDV and
 *      24h volume, but NOT `reserve_in_usd` (liquidity), `pool_created_at` (the
 *      launch clock the age rules run on), the dex id (which launchpad) or the
 *      pool's `launchpad_details.completed` (the curve/graduated verdict). Four
 *      fields, all pool-only;
 *   3. DS `/tokens/v1/robinhood` — one call for the addresses GT did not carry.
 *
 * GeckoTerminal first because it sees launchpad bonding curves and DexScreener
 * does not; DexScreener as the fallback for anything GT missed.
 *
 * DexScreener dust landmine: for curve-phase or thinly traded tokens it can
 * return parasitic Uniswap pools with absurd FDVs on near-zero liquidity, so a
 * DS pair only counts as proof of a real pool above the dust threshold. A dust
 * pair still proves the token EXISTS on this chain, so it is not unknown.
 *
 * Caller contract: at most 30 addresses (both endpoints cap there).
 *
 * FAILURE IS STAGED, not shared (round 17b review). Stage 1 throwing means
 * nothing was learned about anything, so it propagates and the caller defers
 * the tier. A stage 2 or 3 failure only silences the addresses that were
 * waiting on THAT call: everything already answered is returned, and the rest
 * are simply ABSENT from the map — which the caller reads as "still due", never
 * as an answer. A DexScreener outage must not discard the tokens GeckoTerminal
 * just resolved.
 */
export async function resolveTokens(addresses: string[]): Promise<Map<string, Resolution>> {
  const out = new Map<string, Resolution>();
  if (addresses.length === 0) return out;

  const gtInfos = await gt.getTokensMulti(addresses.map((a) => a.toLowerCase()));

  const poolAddresses: string[] = [];
  for (const address of addresses) {
    const top = gtInfos.get(address.toLowerCase())?.topPoolAddress;
    if (top && !poolAddresses.includes(top)) poolAddresses.push(top);
  }
  let pools = new Map<string, gt.GtPoolInfo>();
  let poolStageFailed = false;
  if (poolAddresses.length > 0) {
    try {
      pools = await gt.getPoolsMulti(poolAddresses);
    } catch (err) {
      poolStageFailed = true;
      console.warn('pool stage failed; answering what GeckoTerminal already carried:', err);
    }
  }

  const dsCandidates: string[] = [];
  for (const address of addresses) {
    const info = gtInfos.get(address.toLowerCase());
    if (!info) {
      dsCandidates.push(address);
      continue;
    }
    const pool = info.topPoolAddress ? (pools.get(info.topPoolAddress) ?? null) : null;
    // A pool read that never HAPPENED is not "no pool": leave the address out
    // so it is asked again next tick, instead of stamping a clock on nothing.
    if (!pool && poolStageFailed && info.topPoolAddress) continue;
    // No pool = no phase evidence. Staying unresolved retries next tick; a
    // curve token guessed as 'graduated' is polled via DexScreener, which does
    // not index curve tokens, so it would never be corrected. The 48h
    // never_graduated rule is the backstop for a token that never resolves.
    out.set(address, { token: pool ? fromGt(info, pool) : null, unknownOnChain: false });
  }

  if (dsCandidates.length > 0) {
    let pairs: Map<string, ds.DsPair> | undefined;
    try {
      pairs = await ds.getBestPairs(dsCandidates.map((a) => a.toLowerCase()));
    } catch (err) {
      // Absent from the map, so no caller can read this as "unknown on chain" —
      // the one shape that kills a token. A failure has never been evidence.
      console.warn('dexscreener stage failed; those addresses stay unanswered:', err);
    }
    if (pairs) {
      for (const address of dsCandidates) {
        const pair = pairs.get(address.toLowerCase());
        const real = pair !== undefined && (pair.liquidityUsd ?? 0) >= THRESHOLDS.dustLiquidityUsd;
        out.set(address, {
          token: real ? fromDs(pair) : null,
          unknownOnChain: pair === undefined,
        });
      }
    }
  }
  return out;
}

/**
 * The one-address form, for the immediate poll the bot fires on a paste. It IS
 * the batch of one — same endpoints, same call count as before round 17b (a
 * `/tokens/multi` of one address is what this always did) — so the two paths
 * cannot answer differently.
 */
export async function resolveToken(address: string): Promise<Resolution> {
  const resolved = await resolveTokens([address]);
  return resolved.get(address) ?? { token: null, unknownOnChain: false };
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
