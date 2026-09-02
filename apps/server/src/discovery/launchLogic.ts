import {
  DEX_IDS,
  NATIVE_ETH,
  PONS_GRADUATION_HOOK,
  TOPICS,
  USDG,
  WETH,
  isQuoteToken,
} from '../chain/addresses.js';
import { dataWord, topicAddress, topicBytes32, wordToAddress } from '../chain/decode.js';
import type { ChainLog } from '../chain/client.js';
import { DISCOVERY } from '@groupie/shared';

/**
 * What counts as a launch (docs/decisions.md round 18), as pure functions over
 * decoded logs.
 *
 * The signal is pool CREATION, never a liquidity event — so an ordinary
 * liquidity add to an existing pool cannot appear here by construction, which
 * was the owner's whole worry. Everything else is a filter on top of that one
 * structural choice, and every filter is in `decideLaunch` where it can be read
 * as a table.
 */

export interface LaunchCandidate {
  dex: string;
  /** v2 pair address, or a v4 32-byte pool id. */
  poolAddress: string;
  tokenAddress: string;
  quoteToken: string;
  /**
   * Whether the quote token is the pool's FIRST currency (v2 `token0`, v4
   * `currency0`). Both venues report their amounts positionally — v2 `Mint`
   * carries `amount0, amount1`, v4 `Swap` carries `amount0, amount1` — so
   * without the ordering the deposit reader would be as likely to sum the new
   * coin as the ETH.
   */
  quoteIsCurrency0: boolean;
  blockNumber: number;
  txHash: string;
  /** v4 only: the pool's hook, lowercase. Null for v2. */
  hook: string | null;
}

/** `PairCreated(token0, token1, pair, index)` -> a candidate, or null. */
export function parsePairCreated(log: ChainLog): LaunchCandidate | null {
  if (log.topics[0] !== TOPICS.pairCreated) return null;
  const token0 = topicAddress(log.topics, 1);
  const token1 = topicAddress(log.topics, 2);
  const pair = wordToAddress(dataWord(log.data, 0));
  if (token0 === null || token1 === null || pair === null) return null;
  const base = pickBase(token0, token1);
  if (base === null) return null;
  return {
    dex: DEX_IDS.uniswapV2,
    poolAddress: pair,
    tokenAddress: base.base,
    quoteToken: base.quote,
    quoteIsCurrency0: base.quote === token0,
    blockNumber: log.blockNumber,
    txHash: log.transactionHash,
    hook: null,
  };
}

/**
 * `Initialize(id, currency0, currency1, fee, tickSpacing, hooks, ...)` -> a
 * candidate, or null.
 *
 * A pool on the PONS graduation hook is a MIGRATION of a coin that already
 * traded on a curve, so it is never a launch — it is the graduation stream's
 * row, joined to its token by `PoolGraduated` in the same transaction.
 */
export function parseInitialize(log: ChainLog): LaunchCandidate | null {
  if (log.topics[0] !== TOPICS.initialize) return null;
  const poolId = topicBytes32(log.topics, 1);
  const currency0 = topicAddress(log.topics, 2);
  const currency1 = topicAddress(log.topics, 3);
  const hook = wordToAddress(dataWord(log.data, 2));
  if (poolId === null || currency0 === null || currency1 === null) return null;
  if (hook !== null && hook === PONS_GRADUATION_HOOK) return null;
  const base = pickBase(currency0, currency1);
  if (base === null) return null;
  return {
    dex: DEX_IDS.uniswapV4,
    poolAddress: poolId,
    tokenAddress: base.base,
    quoteToken: base.quote,
    quoteIsCurrency0: base.quote === currency0,
    blockNumber: log.blockNumber,
    txHash: log.transactionHash,
    hook,
  };
}

/**
 * Which side is the new coin. Exactly one side must be a quote token: a
 * WETH/USDG pool is two quote tokens and no coin, and a pool of two unknown
 * tokens has no price we could read a reserve in.
 */
function pickBase(a: string, b: string): { base: string; quote: string } | null {
  const aQuote = isQuoteToken(a);
  const bQuote = isQuoteToken(b);
  if (aQuote === bQuote) return null;
  return aQuote ? { base: b, quote: a } : { base: a, quote: b };
}

/** `PoolGraduated(token, ...)` — only the token argument is named (see docs). */
export function parsePoolGraduated(
  log: ChainLog,
): { tokenAddress: string; blockNumber: number; txHash: string } | null {
  if (log.topics[0] !== TOPICS.poolGraduated) return null;
  const tokenAddress = topicAddress(log.topics, 1);
  if (tokenAddress === null) return null;
  return { tokenAddress, blockNumber: log.blockNumber, txHash: log.transactionHash };
}

/**
 * `PoolRegistered(poolId, token, ...)` from the PONS graduation hook — the join
 * that gives a graduation the pool it migrated into. Verified against
 * GeckoTerminal: the pool id here is byte-for-byte the id GT lists for the
 * coin's `pons-v2-dex` pool.
 */
export function parsePoolRegistered(
  log: ChainLog,
): { poolAddress: string; tokenAddress: string; txHash: string } | null {
  if (log.topics[0] !== TOPICS.poolRegistered) return null;
  const poolAddress = topicBytes32(log.topics, 1);
  const tokenAddress = wordToAddress(dataWord(log.data, 0));
  if (poolAddress === null || tokenAddress === null) return null;
  return { poolAddress, tokenAddress, txHash: log.transactionHash };
}

export interface LaunchDecisionInput {
  /** Our `tokens` table already has this coin WITH a pool: it is not new. */
  tokenTracked: boolean;
  /** A discovery row already exists for this TOKEN — a second pool or fee tier. */
  tokenSeen: boolean;
  /** ...or for this exact POOL: the listener replayed a range. */
  poolSeen: boolean;
  /**
   * DexScreener knows a pool for this coin that predates ours. True = not the
   * first pool (a migration, a second fee tier, a PONS graduate that opened a
   * plain market). NULL = DexScreener could not answer, which is not evidence:
   * the coin is kept, because a provider outage must not silently empty the
   * board.
   */
  hasOlderPool: boolean | null;
  /** A tokenized stock by address (the name-based rule needs enrichment). */
  isStock: boolean;
  /**
   * Quote-token deposit that opened the pool, expressed in ETH. Null is
   * unknown, for either of two reasons: the deposit read failed (an unreadable
   * v4 receipt, a native-ETH transaction whose `value` could not be read), or
   * no deposit was found INSIDE the launch window — no v2 `Mint` in it, no
   * quote Transfer into the PoolManager in the creating tx. A pool opened
   * without same-window liquidity is not admitted as a launch by design, and
   * since the cursor has moved on it is not revisited. See
   * apps/server/src/chain/reserve.ts.
   */
  initialLiquidityEth: number | null;
  /** How old the pool was when we first saw it. */
  ageMinutes: number;
}

export type LaunchVerdict =
  | { keep: true }
  | {
      keep: false;
      reason:
        | 'known_token'
        | 'second_pool'
        | 'duplicate'
        | 'not_first_pool'
        | 'stock'
        | 'unknown_reserve'
        | 'thin'
        | 'stale';
    };

/**
 * Round 18's launch test, in the order the cheap questions come first — the
 * caller spends an RPC call between the free checks and the reserve ones.
 *
 * `unknown_reserve` is a deliberate rejection rather than a null row: the board
 * floor exists to keep ~500 dust pools an hour off a research surface, and a
 * reserve we could not read cannot clear it. Unknown here means either that the
 * deposit read FAILED (an unreadable v4 receipt, a native-ETH `value` that could
 * not be read) or that NO deposit landed inside the launch window (no v2 `Mint`,
 * no quote Transfer into the PoolManager in the creating tx). Both drop the
 * candidate for good: a pool that opens without same-window liquidity is not a
 * launch by this definition, and the cursor does not come back for it
 * (apps/server/src/chain/reserve.ts).
 */
export function decideLaunch(input: LaunchDecisionInput): LaunchVerdict {
  if (input.poolSeen) return { keep: false, reason: 'duplicate' };
  if (input.tokenSeen) return { keep: false, reason: 'second_pool' };
  if (input.tokenTracked) return { keep: false, reason: 'known_token' };
  if (input.isStock) return { keep: false, reason: 'stock' };
  if (input.ageMinutes > DISCOVERY.maxDetectionAgeMinutes) return { keep: false, reason: 'stale' };
  if (input.hasOlderPool === true) return { keep: false, reason: 'not_first_pool' };
  if (input.initialLiquidityEth === null) return { keep: false, reason: 'unknown_reserve' };
  if (input.initialLiquidityEth < DISCOVERY.boardMinEth) return { keep: false, reason: 'thin' };
  return { keep: true };
}

/**
 * Whether a stored launch earns a CHAT message for a group (docs/decisions.md
 * round 18): above the group's own ETH threshold, and passing every filter the
 * board's default view applies. 0 mutes.
 */
export function launchAlertQualifies(
  initialLiquidityEth: number | null,
  launchMinEth: number,
): boolean {
  if (!(launchMinEth > 0)) return false;
  if (initialLiquidityEth === null || !Number.isFinite(initialLiquidityEth)) return false;
  return initialLiquidityEth >= launchMinEth;
}

/** Native ETH and WETH are both "ETH" for a threshold expressed in ETH. */
export function quoteIsEth(quoteToken: string): boolean {
  const a = quoteToken.toLowerCase();
  return a === NATIVE_ETH || a === WETH;
}

/**
 * The asset a pool was actually opened with, as the board prints it. Null for a
 * quote token this build does not price — which is also the set `pickBase`
 * refuses, so it never happens on a stored row.
 */
export function quoteSymbolOf(quoteToken: string): 'ETH' | 'USDG' | null {
  if (quoteIsEth(quoteToken)) return 'ETH';
  return quoteToken.toLowerCase() === USDG ? 'USDG' : null;
}
