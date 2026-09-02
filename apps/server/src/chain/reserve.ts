import { TOPICS } from './addresses.js';
import type { ChainLog } from './client.js';
import { dataWord, topicBytes32, wordToBigInt, wordToSignedBigInt } from './decode.js';

/**
 * The DEPOSIT that opened a pool — the figure the board calls "initial
 * liquidity" — as pure arithmetic over decoded logs.
 *
 * The review's finding, and the reason this file exists: summing the quote
 * token's transfers into the pool counts the deposit AND every buy that settled
 * through the same address in the same window. A launch sniped for 40 ETH would
 * print "40 ETH liquidity" in the chat while the team had put up 2. The two
 * venues need two different measurements, and both are here so they can be
 * pinned to fixtures rather than to a chain.
 *
 * Every function answers null for "could not be measured". Never 0: an
 * unmeasured deposit must not clear a threshold and must not print as a fact.
 */

/**
 * Uniswap v2: the pair emits its own `Mint(sender, amount0, amount1)` for every
 * deposit, so the deposit is readable directly and buys are simply not Mints.
 * Several Mints inside the launch window are several deposits — they sum.
 *
 * `quoteIsToken0` comes from the `PairCreated` ordering, which is the only
 * source that says which side of the pair the quote token is; guessing would
 * silently read a token amount as an ETH amount.
 */
export function sumV2MintQuote(
  logs: readonly ChainLog[] | null | undefined,
  pairAddress: string,
  quoteIsToken0: boolean,
): bigint | null {
  if (!logs) return null;
  const pair = pairAddress.toLowerCase();
  let total = 0n;
  let seen = false;
  for (const log of logs) {
    if (log.address.toLowerCase() !== pair) continue;
    if (log.topics[0]?.toLowerCase() !== TOPICS.v2Mint) continue;
    const amount = wordToBigInt(dataWord(log.data, quoteIsToken0 ? 0 : 1));
    if (amount === null) continue;
    total += amount;
    seen = true;
  }
  return seen ? total : null;
}

/**
 * Uniswap v4: one singleton holds every pool's funds, so the deposit is not
 * separable by address — it is separable by EVENT. Inside the creating
 * transaction, the quote that entered the singleton is the deposit plus
 * whatever a same-transaction buyer paid; `Swap` names the buyer's payment, so
 * subtracting it leaves the deposit.
 *
 * `amount0`/`amount1` on v4's Swap are the CALLER's deltas: negative is what
 * the caller handed over. Only a negative quote delta is subtracted — a
 * positive one is the caller RECEIVING quote (a sell), which took nothing out
 * of the deposit.
 *
 * Residuals, stated honestly rather than hidden:
 *
 * - A multi-hop route that swaps through this pool on its way somewhere else
 *   settles its other legs through the same singleton, and those legs are not
 *   this pool's Swaps. Such a transaction can OVERSTATE the deposit, and the
 *   launch-block share printed on the same row is what exposes that pattern.
 * - The subtraction is exact only when the buyer's quote entered through an
 *   ERC-20 Transfer in this same transaction. A buy funded some other way — a
 *   routed settlement, a claim against a balance the singleton already held —
 *   is subtracted without ever having been added, so the figure can also
 *   UNDERSTATE, and at the extreme drives the difference to zero or below, which
 *   this function reports as unknown rather than as a small deposit.
 */
export function v4DepositFromTx(params: {
  /** Quote-token Transfers INTO the PoolManager, already narrowed to the tx. */
  quoteIn: bigint | null;
  /** Every log of the creating transaction (Swaps are picked out here). */
  txLogs: readonly ChainLog[] | null | undefined;
  poolId: string;
  poolManager: string;
  quoteIsCurrency0: boolean;
}): bigint | null {
  if (params.quoteIn === null) return null;
  const paid = swapQuotePaid(
    params.txLogs,
    params.poolId,
    params.poolManager,
    params.quoteIsCurrency0,
  );
  const deposit = params.quoteIn - paid;
  // A buy bigger than everything that entered means the arithmetic did not
  // describe this transaction (a route we cannot model). Unknown, not zero.
  return deposit > 0n ? deposit : null;
}

/**
 * How much quote the caller PAID into this pool through same-transaction swaps,
 * as a positive magnitude. Zero when there were none — which is the ordinary
 * case and is not an unknown: "no swap happened" is a fact the logs state.
 */
export function swapQuotePaid(
  txLogs: readonly ChainLog[] | null | undefined,
  poolId: string,
  poolManager: string,
  quoteIsCurrency0: boolean,
): bigint {
  if (!txLogs) return 0n;
  const manager = poolManager.toLowerCase();
  const id = poolId.toLowerCase();
  let paid = 0n;
  for (const log of txLogs) {
    if (log.address.toLowerCase() !== manager) continue;
    if (log.topics[0]?.toLowerCase() !== TOPICS.v4Swap) continue;
    if (topicBytes32(log.topics, 1) !== id) continue;
    const delta = wordToSignedBigInt(dataWord(log.data, quoteIsCurrency0 ? 0 : 1));
    if (delta === null || delta >= 0n) continue;
    paid += -delta;
  }
  return paid;
}

/**
 * A native-ETH v4 pool moves no ERC-20 at all, so the deposit is the creating
 * transaction's own `value` minus the native a same-transaction buyer paid
 * through this pool — the same subtraction, one field instead of a log sum.
 *
 * Residual: `value` is an UPPER BOUND on what the deposit could have been.
 * Native ETH that comes back out in the same transaction — a refund of the
 * unused remainder, a sweep to the deployer, a launchpad's own ETH fee — emits
 * no log, so none of it is subtracted here. The figure is honest about the
 * transaction and can still read high for the pool.
 */
export function v4NativeDeposit(params: {
  /** eth_getTransactionByHash(...).value, in wei; null when it could not be read. */
  txValueWei: bigint | null;
  txLogs: readonly ChainLog[] | null | undefined;
  poolId: string;
  poolManager: string;
  quoteIsCurrency0: boolean;
}): bigint | null {
  if (params.txValueWei === null) return null;
  const paid = swapQuotePaid(
    params.txLogs,
    params.poolId,
    params.poolManager,
    params.quoteIsCurrency0,
  );
  const deposit = params.txValueWei - paid;
  return deposit > 0n ? deposit : null;
}
