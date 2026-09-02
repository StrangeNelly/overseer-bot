import { and, eq, gte, inArray, isNull, isNotNull, lt, or, sql } from 'drizzle-orm';
import { discoveryEvents, tokens, type Db } from '@groupie/db';
import {
  DISCOVERY,
  isTokenizedStock,
  twitterUrlFrom,
  websiteUrlFrom,
} from '@groupie/shared';
import {
  DEX_IDS,
  NATIVE_ETH,
  PONS_GRADUATION_HOOK,
  PONS_V2_FACTORY,
  QUOTE_DECIMALS,
  TOPICS,
  UNISWAP_V2_FACTORY,
  UNISWAP_V4_POOL_MANAGER,
  WETH,
  bundleExclusions,
} from '../chain/addresses.js';
import { TOTAL_SUPPLY_CALLDATA, computeLaunchBlockShare } from '../chain/bundle.js';
import {
  LogRangeTooWideError,
  summarizeRpcError,
  type ChainClient,
  type ChainLog,
} from '../chain/client.js';
import {
  planRange,
  readCursor,
  requestBlocksFor,
  splitRanges,
  touchCursor,
  writeCursor,
} from '../chain/cursor.js';
import { dataWord, topicAddress, unitsToNumber, wordToBigInt } from '../chain/decode.js';
import { sumV2MintQuote, v4DepositFromTx, v4NativeDeposit } from '../chain/reserve.js';
import * as ds from '../market/dexscreener.js';
import * as gt from '../market/geckoterminal.js';
import {
  decideLaunch,
  parseInitialize,
  parsePairCreated,
  parsePoolGraduated,
  parsePoolRegistered,
  quoteIsEth,
  quoteSymbolOf,
  type LaunchCandidate,
} from './launchLogic.js';

/**
 * The discovery listener (docs/decisions.md rounds 18 and 20).
 *
 * Every ~20 seconds the chain tick reads the block range since the cursor,
 * decides which new pools are launches and which PONS tokens graduated, and
 * writes them down. A SEPARATE loop (runner.ts) enriches and delivers, so a
 * DexScreener batch or a GeckoTerminal back-off can never delay the next block
 * range — the review found that coupling and it is the reason the two are split.
 *
 * Cost discipline, in the order the checks run: ONE log query per range for all
 * four event streams, then the free database questions (have we seen this pool /
 * this token), then the reads behind the deposit, and only for what clears the
 * board floor the two calls behind the bundle facts.
 */

/** A block cannot be re-read for free, so its timestamp is cached per tick. */
class BlockClock {
  private readonly cache = new Map<number, number | null>();
  constructor(private readonly chain: ChainClient) {}

  /** The block's instant, falling back to wall clock when it cannot be read. */
  async at(blockNumber: number): Promise<Date> {
    if (!this.cache.has(blockNumber)) {
      this.cache.set(blockNumber, await this.chain.getBlockTimestamp(blockNumber));
    }
    const seconds = this.cache.get(blockNumber) ?? null;
    return seconds === null ? new Date() : new Date(seconds * 1000);
  }
}

/** A 20-byte address as a 32-byte log topic. */
export function addressTopic(address: string): string {
  return `0x${'0'.repeat(24)}${address.toLowerCase().replace(/^0x/, '')}`;
}

/** The deposit that opened a pool, in quote base units — null when unmeasured. */
export interface Deposit {
  units: bigint | null;
  quoteSymbol: 'ETH' | 'USDG' | null;
}

/**
 * How much of the quote token the DEPLOYER put into the new pool.
 *
 * The distinction the review insisted on: a deposit, never a buy. Summing the
 * quote token's transfers into the pool counts both, so a launch sniped for 40
 * ETH in the same block would have printed "40 ETH liquidity" in the chat while
 * the team put up two. Each venue is therefore measured by the event that
 * actually names a deposit:
 *
 * - **v2** — the pair emits `Mint(sender, amount0, amount1)` per deposit. Every
 *   Mint in [launch block, +bundleBlockSpan] is summed on the quote side; a buy
 *   is not a Mint and cannot be counted.
 * - **v4** — one singleton holds every pool, so nothing is separable by
 *   address. Inside the creating transaction: quote into the singleton MINUS
 *   what a same-transaction buyer paid, named by this pool's own `Swap` events.
 *   Both come out of ONE transaction receipt (15 CU) rather than two log
 *   queries (150 CU) — the receipt is exactly the "inside this transaction"
 *   scope the measurement is defined over.
 * - **v4, native ETH** — no ERC-20 moves at all, so the transaction's own
 *   `value` stands in for the inbound side, minus the same swap subtraction off
 *   the same receipt. One extra RPC (17 CU), and only for a candidate that
 *   already cleared the free checks.
 *
 * Cost, after the free checks and before the bundle reads: v4 with an ERC-20
 * quote 15 CU, v4 native 32 CU, v2 75 CU (one `eth_getLogs` for the pair's
 * Mints, which span blocks a single receipt cannot cover).
 *
 * Null anywhere means unknown, and unknown can never clear a threshold.
 */
export async function readDeposit(
  chain: ChainClient,
  candidate: LaunchCandidate,
): Promise<Deposit> {
  const quoteSymbol = quoteSymbolOf(candidate.quoteToken);
  const quote = candidate.quoteToken.toLowerCase();

  if (candidate.dex === DEX_IDS.uniswapV2) {
    const mints = await chain.getLogs({
      address: candidate.poolAddress,
      topics: [TOPICS.v2Mint],
      fromBlock: candidate.blockNumber,
      toBlock: candidate.blockNumber + DISCOVERY.bundleBlockSpan,
    });
    return {
      units: sumV2MintQuote(mints, candidate.poolAddress, candidate.quoteIsCurrency0),
      quoteSymbol,
    };
  }

  // v4: ONE receipt for the creating transaction. Everything the measurement is
  // defined over — this pool's Swaps and the quote that entered the singleton —
  // is inside that one transaction, so a receipt answers both questions for 15
  // CU where two `eth_getLogs` cost 150 for the same two answers.
  const receipt = await chain.getTransactionLogs(candidate.txHash);
  // The receipt is the whole evidence base here. Without it the deposit is
  // unknown, and unknown never clears a threshold — treating a failed read as
  // "no swaps happened" would print an unsubtracted figure as a fact.
  if (receipt === null) return { units: null, quoteSymbol };

  const manager = UNISWAP_V4_POOL_MANAGER.toLowerCase();
  const poolId = candidate.poolAddress.toLowerCase();
  const txSwaps = receipt.filter(
    (log) =>
      log.address.toLowerCase() === manager &&
      log.topics[0]?.toLowerCase() === TOPICS.v4Swap &&
      log.topics[1]?.toLowerCase() === poolId,
  );

  if (quote === NATIVE_ETH) {
    const value = await chain.getTransactionValue(candidate.txHash);
    return {
      units: v4NativeDeposit({
        txValueWei: value,
        txLogs: txSwaps,
        poolId: candidate.poolAddress,
        poolManager: UNISWAP_V4_POOL_MANAGER,
        quoteIsCurrency0: candidate.quoteIsCurrency0,
      }),
      quoteSymbol,
    };
  }

  const managerTopic = addressTopic(UNISWAP_V4_POOL_MANAGER);
  let quoteIn: bigint | null = null;
  for (const log of receipt) {
    if (log.address.toLowerCase() !== quote) continue;
    if (log.topics[0]?.toLowerCase() !== TOPICS.transfer) continue;
    if (log.topics[2]?.toLowerCase() !== managerTopic) continue;
    const value = wordToBigInt(dataWord(log.data, 0));
    if (value === null) continue;
    quoteIn = (quoteIn ?? 0n) + value;
  }
  return {
    units: v4DepositFromTx({
      quoteIn,
      txLogs: txSwaps,
      poolId: candidate.poolAddress,
      poolManager: UNISWAP_V4_POOL_MANAGER,
      quoteIsCurrency0: candidate.quoteIsCurrency0,
    }),
    quoteSymbol,
  };
}

interface Reserve {
  eth: number | null;
  usd: number | null;
}

/**
 * Deposit units -> the pair of figures the board shows.
 *
 * USDG is treated as one US dollar. It is a fiat-backed regulated stablecoin, so
 * the error is fractions of a percent, and the alternative — quoting a USDG
 * launch in "unknown ETH" forever — would drop a whole quote token off the chat
 * stream. The assumption is here, in one place, rather than spread over the
 * board.
 *
 * Which figure is MEASURED differs by quote, and the row records which
 * (`quote_symbol`): an ETH pool's ETH amount is the measurement and its dollars
 * are derived; a USDG pool's dollars are the measurement and its ETH is
 * derived. The ETH figure is what every threshold compares against either way.
 */
export function toReserve(
  units: bigint | null,
  quoteToken: string,
  ethPriceUsd: number | null,
): Reserve {
  const decimals = QUOTE_DECIMALS[quoteToken.toLowerCase()];
  if (units === null || decimals === undefined) return { eth: null, usd: null };
  const amount = unitsToNumber(units, decimals);
  if (amount === null) return { eth: null, usd: null };
  if (quoteIsEth(quoteToken)) {
    const usd = ethPriceUsd === null ? null : amount * ethPriceUsd;
    return { eth: amount, usd };
  }
  const eth = ethPriceUsd === null || ethPriceUsd <= 0 ? null : amount / ethPriceUsd;
  return { eth, usd: amount };
}

/** Bundle facts for a brand-new token, or null when the chain would not say. */
async function readBundleFacts(
  chain: ChainClient,
  candidate: LaunchCandidate,
): Promise<{ pct: number; wallets: number } | null> {
  const supplyRaw = await chain.call(candidate.tokenAddress, TOTAL_SUPPLY_CALLDATA);
  const supply = wordToBigInt(dataWord(supplyRaw, 0));
  if (supply === null) return null;
  const logs = await chain.getLogs({
    address: candidate.tokenAddress,
    topics: [TOPICS.transfer],
    fromBlock: candidate.blockNumber,
    toBlock: candidate.blockNumber + DISCOVERY.bundleBlockSpan,
  });
  // Where bought supply comes OUT of: the pair for v2, the singleton for v4.
  const sink =
    candidate.dex === DEX_IDS.uniswapV2 ? candidate.poolAddress : UNISWAP_V4_POOL_MANAGER;
  const sinks = new Set([sink.toLowerCase()]);
  return computeLaunchBlockShare(
    logs,
    supply,
    sinks,
    bundleExclusions([sink], candidate.tokenAddress, candidate.hook),
  );
}

/**
 * WHEN a PONS coin launched, according to DexScreener: the creation instant of
 * its curve pool.
 *
 * The curve is the first pool a PONS coin ever has — supply is minted straight
 * into it (docs/research-onchain.md, "the curve is the SINK") — so its
 * `pairCreatedAt` is the launch instant. DexScreener carries it for free on a
 * route this build already calls, and that one free reading is what turns an
 * unbounded `TokenLaunched` hunt over all of history into a single 400-block
 * query.
 *
 * Null when DexScreener has no PONS pool for the coin, or could not answer.
 * Absence is not a verdict here: the caller falls back to the unbounded query
 * rather than inventing a window.
 */
async function ponsCurveCreatedAt(tokenAddress: string): Promise<Date | null> {
  let pools: Array<{ dexId: string | null; pairCreatedAt: Date }>;
  try {
    pools = await ds.getTokenPools(tokenAddress);
  } catch (err) {
    console.warn(
      `discovery: curve pool lookup failed for ${tokenAddress}: ${summarizeRpcError(err)}`,
    );
    return null;
  }
  let earliest: Date | null = null;
  for (const pool of pools) {
    // `pons-v2-dex` today; matched loosely so a renamed dex id does not silently
    // turn every graduation's launch block into unknown.
    if (!(pool.dexId ?? '').toLowerCase().includes('pons')) continue;
    if (earliest === null || pool.pairCreatedAt.getTime() < earliest.getTime()) {
      earliest = pool.pairCreatedAt;
    }
  }
  return earliest;
}

/**
 * The block an instant falls in, located by bisection — or null when the chain
 * would not say inside DISCOVERY.launchHuntMaxBlockReads reads.
 *
 * What comes back is the LOW end of a bracket at most
 * DISCOVERY.launchHuntWindowBlocks wide that contains the instant, which is
 * what the caller builds its log window around. The search is seeded with a
 * linear estimate off the chain's nominal block rate, so a coin that launched
 * an hour ago is bracketed in a couple of reads instead of bisected over all of
 * history; the read budget is what stops a chain whose block times misbehave
 * from turning one graduation into an open-ended search.
 *
 * Each read is an `eth_getBlockByNumber` (16 CU) — two orders cheaper than the
 * `eth_getLogs` it replaces having to scan the same history.
 */
export async function findBlockAtTime(
  chain: ChainClient,
  atSeconds: number,
  headBlock: number,
  nowSeconds: number,
): Promise<number | null> {
  const window = DISCOVERY.launchHuntWindowBlocks;
  let reads = 0;
  const secondsAt = async (block: number): Promise<number | null> => {
    if (reads >= DISCOVERY.launchHuntMaxBlockReads) return null;
    reads += 1;
    return chain.getBlockTimestamp(block);
  };

  const behind = Math.max(0, nowSeconds - atSeconds) * DISCOVERY.blocksPerSecond;
  let lo = Math.min(headBlock, Math.max(1, Math.round(headBlock - behind)));
  let hi = lo;
  const seeded = await secondsAt(lo);
  if (seeded === null) return null;
  let loSeconds = seeded;
  let hiSeconds = seeded;

  // Push whichever end sits on the wrong side of the instant outward, doubling
  // the step. Only one of these two loops can run — the estimate is either
  // early or late — and an estimate wrong by a factor still brackets in a
  // handful of reads.
  for (let step = window; loSeconds > atSeconds && lo > 1; step *= 2) {
    lo = Math.max(1, lo - step);
    const seconds = await secondsAt(lo);
    if (seconds === null) return null;
    loSeconds = seconds;
  }
  for (let step = window; hiSeconds < atSeconds && hi < headBlock; step *= 2) {
    hi = Math.min(headBlock, hi + step);
    const seconds = await secondsAt(hi);
    if (seconds === null) return null;
    hiSeconds = seconds;
  }

  while (hi - lo > window) {
    const mid = Math.floor((lo + hi) / 2);
    if (mid <= lo || mid >= hi) break;
    const seconds = await secondsAt(mid);
    if (seconds === null) return null;
    if (seconds <= atSeconds) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * A graduating coin's ORIGINAL launch: the block it launched in and the PONS
 * curve that sold its supply. `TokenLaunched` indexes the token, so this is a
 * point lookup — but a coin may have sat on its curve for weeks, so the
 * question is WHERE to look, not what to look for.
 *
 * The primary path never scans history at all. DexScreener dates the coin's
 * curve pool for free; a bisection over block timestamps turns that instant
 * into a block; and ONE `eth_getLogs` over 2 x DISCOVERY.launchHuntWindowBlocks
 * around it finds the log. That is ~4-8 block reads (16 CU each) plus one log
 * query per graduation, and the query is narrow enough to be a single request
 * on PAYG and exactly one chunk budget on a capped tier.
 *
 * The fallback, when DexScreener knows no PONS pool for the coin, is the
 * unbounded `earliest` query — ONE attempt. There is no wide historic scan
 * behind it: a provider that refuses the range (the public Robinhood RPC does)
 * answers unknown, the graduation is stored with its share null rather than 0,
 * and being a known pool from that moment it is never re-measured. One failed
 * hunt can neither wedge the listener nor spend a second call.
 */
export async function findTokenLaunch(
  chain: ChainClient,
  tokenAddress: string,
  headBlock: number,
): Promise<{ launchBlock: number; curve: string } | null> {
  const curveAt = await ponsCurveCreatedAt(tokenAddress);
  let range: { fromBlock: number | 'earliest'; toBlock: number };
  if (curveAt === null) {
    range = { fromBlock: 'earliest', toBlock: headBlock };
  } else {
    const block = await findBlockAtTime(
      chain,
      Math.floor(curveAt.getTime() / 1000),
      headBlock,
      Date.now() / 1000,
    );
    if (block === null) {
      console.warn(
        `discovery: launch hunt for ${tokenAddress} could not place the curve instant on a block`,
      );
      return null;
    }
    const window = DISCOVERY.launchHuntWindowBlocks;
    // The bisection's bracket is at most one window wide and starts at `block`,
    // so half a window of slack below it and the rest above covers the launch
    // either way — while the whole query stays 2 x window blocks.
    const fromBlock = Math.max(1, block - Math.floor(window / 2));
    range = { fromBlock, toBlock: Math.min(headBlock, fromBlock + 2 * window - 1) };
  }

  let logs: ChainLog[];
  try {
    logs = await chain.getLogs({
      address: PONS_V2_FACTORY,
      topics: [TOPICS.tokenLaunched, addressTopic(tokenAddress)],
      ...range,
    });
  } catch (err) {
    console.warn(`discovery: launch lookup failed for ${tokenAddress}: ${summarizeRpcError(err)}`);
    return null;
  }
  // Oldest wins: a coin is launched once, and a later log for the same token
  // would be a re-listing rather than the launch the bundle question is about.
  let best: { launchBlock: number; curve: string } | null = null;
  for (const log of logs) {
    const curve = topicAddress(log.topics, 2);
    if (curve === null) continue;
    if (best === null || log.blockNumber < best.launchBlock) {
      best = { launchBlock: log.blockNumber, curve };
    }
  }
  return best;
}

/**
 * Bundle facts for a GRADUATION, measured at the coin's original launch (round
 * 20: "measured from the launch"). The curve is the sink — that is where a
 * PONS buyer's supply comes from — and the factory and the graduation hook are
 * excluded like any other infrastructure.
 *
 * Total supply is read AT the launch window, not at the head: the share is a
 * fraction of the supply that existed when those Transfers happened, and a coin
 * that minted or burned in the weeks it sat on its curve would otherwise be
 * measured against a denominator from a different day. This assumes an ARCHIVE
 * node — Alchemy serves historic `eth_call` — and a node that will not answer
 * for an old block returns null, which reads as unknown like any other failure.
 *
 * Null whenever a read failed. The board says "unknown"; it never says 0%.
 */
async function readGraduationBundle(
  chain: ChainClient,
  tokenAddress: string,
  headBlock: number,
): Promise<{ pct: number; wallets: number } | null> {
  const launch = await findTokenLaunch(chain, tokenAddress, headBlock);
  if (launch === null) return null;
  const supplyRaw = await chain.call(
    tokenAddress,
    TOTAL_SUPPLY_CALLDATA,
    launch.launchBlock + DISCOVERY.bundleBlockSpan,
  );
  const supply = wordToBigInt(dataWord(supplyRaw, 0));
  if (supply === null) return null;
  let logs: ChainLog[];
  try {
    logs = await chain.getLogs({
      address: tokenAddress,
      topics: [TOPICS.transfer],
      fromBlock: launch.launchBlock,
      toBlock: launch.launchBlock + DISCOVERY.bundleBlockSpan,
    });
  } catch (err) {
    console.warn(
      `discovery: graduation bundle read failed for ${tokenAddress}: ${summarizeRpcError(err)}`,
    );
    return null;
  }
  const sinks = new Set([launch.curve.toLowerCase()]);
  return computeLaunchBlockShare(logs, supply, sinks, bundleExclusions([launch.curve], tokenAddress));
}

/** Which of these pool addresses we already hold a discovery row for. */
async function seenPools(db: Db, poolAddresses: string[]): Promise<Set<string>> {
  if (poolAddresses.length === 0) return new Set();
  const rows = await db
    .select({ poolAddress: discoveryEvents.poolAddress })
    .from(discoveryEvents)
    .where(inArray(discoveryEvents.poolAddress, poolAddresses));
  return new Set(rows.map((r) => r.poolAddress.toLowerCase()));
}

/** ...and which TOKENS: a second fee tier or a second market is not a launch. */
async function seenTokens(db: Db, tokenAddresses: string[]): Promise<Set<string>> {
  if (tokenAddresses.length === 0) return new Set();
  const rows = await db
    .selectDistinct({ tokenAddress: discoveryEvents.tokenAddress })
    .from(discoveryEvents)
    .where(inArray(discoveryEvents.tokenAddress, tokenAddresses));
  return new Set(rows.map((r) => r.tokenAddress.toLowerCase()));
}

/**
 * Tokens we already TRACK that have a pool — round 18's "never seen in our
 * tokens table". An unresolved row (a CA someone pasted minutes ago, no pool
 * yet) is deliberately not disqualifying: that coin may be launching right now,
 * and this is exactly the launch.
 */
async function trackedTokens(db: Db, addresses: string[]): Promise<Set<string>> {
  if (addresses.length === 0) return new Set();
  const rows = await db
    .select({ address: tokens.address })
    .from(tokens)
    .where(and(inArray(tokens.address, addresses), sql`${tokens.poolAddress} is not null`));
  return new Set(rows.map((r) => r.address.toLowerCase()));
}

/**
 * Does DexScreener know an OLDER pool for this coin? True = not the first pool
 * (a migration, a second fee tier, a PONS graduate opening a plain market).
 * Null when DexScreener could not answer — kept, because an outage must not
 * silently empty the board.
 */
async function hasOlderPool(candidate: LaunchCandidate, at: Date): Promise<boolean | null> {
  try {
    const pools = await ds.getTokenPools(candidate.tokenAddress);
    // One minute of slack: DexScreener's own pairCreatedAt for the pool we are
    // looking at can land a beat before our block timestamp.
    const cutoff = at.getTime() - 60_000;
    return pools.some(
      (pool) =>
        pool.pairAddress !== candidate.poolAddress && pool.pairCreatedAt.getTime() < cutoff,
    );
  } catch (err) {
    console.warn(`discovery: first-pool check failed for ${candidate.tokenAddress}:`, err);
    return null;
  }
}

interface PendingRow {
  kind: 'launch' | 'graduation';
  tokenAddress: string;
  poolAddress: string;
  dex: string;
  at: Date;
  blockNumber: number;
  txHash: string;
  initialLiquidityEth: number | null;
  initialLiquidityUsd: number | null;
  quoteSymbol: 'ETH' | 'USDG' | null;
  launchBlockPct: number | null;
  launchBlockWallets: number | null;
}

/** Insert, ignoring anything already written: pool_address is the dedupe key. */
async function persist(db: Db, rows: PendingRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const written = await db
    .insert(discoveryEvents)
    .values(rows)
    .onConflictDoNothing({ target: discoveryEvents.poolAddress })
    .returning({ id: discoveryEvents.id });
  return written.length;
}

/** Every event stream this listener watches, as ONE provider-side filter. */
export const RANGE_ADDRESSES = [
  UNISWAP_V2_FACTORY,
  UNISWAP_V4_POOL_MANAGER,
  PONS_V2_FACTORY,
  PONS_GRADUATION_HOOK,
];
export const RANGE_TOPIC0S = [
  TOPICS.pairCreated,
  TOPICS.initialize,
  TOPICS.poolGraduated,
  TOPICS.poolRegistered,
];

/**
 * Sort one range's logs back into the four streams, by the pair that identifies
 * each one. The address matters as much as the topic: `Transfer` aside, an
 * event signature is not unique to a contract, and a hook that happened to emit
 * a same-signature event must not be read as the factory's.
 */
export function routeRangeLogs(logs: readonly ChainLog[]): {
  pairLogs: ChainLog[];
  initLogs: ChainLog[];
  gradLogs: ChainLog[];
  registerLogs: ChainLog[];
} {
  const out = {
    pairLogs: [] as ChainLog[],
    initLogs: [] as ChainLog[],
    gradLogs: [] as ChainLog[],
    registerLogs: [] as ChainLog[],
  };
  for (const log of logs) {
    const address = log.address.toLowerCase();
    const topic0 = log.topics[0]?.toLowerCase();
    if (address === UNISWAP_V2_FACTORY && topic0 === TOPICS.pairCreated) out.pairLogs.push(log);
    else if (address === UNISWAP_V4_POOL_MANAGER && topic0 === TOPICS.initialize) {
      out.initLogs.push(log);
    } else if (address === PONS_V2_FACTORY && topic0 === TOPICS.poolGraduated) {
      out.gradLogs.push(log);
    } else if (address === PONS_GRADUATION_HOOK && topic0 === TOPICS.poolRegistered) {
      out.registerLogs.push(log);
    }
  }
  return out;
}

/** One block range: decode, decide, measure, write. Returns rows written. */
async function processRange(
  db: Db,
  chain: ChainClient,
  clock: BlockClock,
  headBlock: number,
  range: { fromBlock: number; toBlock: number },
): Promise<number> {
  // ONE query for all four streams. Four separate ones cost four times the CU
  // for the same answer, and `eth_getLogs` is by far the dearest method here.
  const logs = await chain.getLogs({
    address: RANGE_ADDRESSES,
    topics: [RANGE_TOPIC0S],
    ...range,
  });
  const { pairLogs, initLogs, gradLogs, registerLogs } = routeRangeLogs(logs);

  const pending: PendingRow[] = [];
  pending.push(...(await collectGraduations(db, chain, clock, headBlock, gradLogs, registerLogs)));
  pending.push(...(await collectLaunches(db, chain, clock, headBlock, [...pairLogs, ...initLogs])));
  return persist(db, pending);
}

/**
 * Graduations. `PoolGraduated` names the token; the hook's `PoolRegistered` in
 * the SAME transaction names the pool it migrated into. A graduation whose pool
 * cannot be found is dropped rather than stored under a made-up address — the
 * row's whole job is to point at the new market.
 *
 * The DEDUPE happens before any of the reads, not at the insert: a replayed
 * range would otherwise pay for a whole launch hunt (a DexScreener call, a
 * handful of block reads, an `eth_getLogs`, an `eth_call` and a window of
 * Transfers) per graduation only for `onConflictDoNothing` to throw the row
 * away. One `seenPools` query per range
 * answers it for every graduation in that range, and a Set catches the same pool
 * twice inside one range.
 */
async function collectGraduations(
  db: Db,
  chain: ChainClient,
  clock: BlockClock,
  headBlock: number,
  gradLogs: ChainLog[],
  registerLogs: ChainLog[],
): Promise<PendingRow[]> {
  if (gradLogs.length === 0) return [];
  const poolsByTx = new Map<string, { poolAddress: string; tokenAddress: string }>();
  for (const log of registerLogs) {
    const registered = parsePoolRegistered(log);
    if (registered) poolsByTx.set(`${registered.txHash}:${registered.tokenAddress}`, registered);
  }

  const joined: Array<{
    graduation: { tokenAddress: string; blockNumber: number; txHash: string };
    registered: { poolAddress: string; tokenAddress: string };
  }> = [];
  for (const log of gradLogs) {
    const graduation = parsePoolGraduated(log);
    if (!graduation) continue;
    const registered = poolsByTx.get(`${graduation.txHash}:${graduation.tokenAddress}`);
    if (!registered) {
      console.warn(
        `discovery: graduation of ${graduation.tokenAddress} in ${graduation.txHash} has no registered pool; skipped`,
      );
      continue;
    }
    joined.push({ graduation, registered });
  }
  if (joined.length === 0) return [];

  const known = await seenPools(db, joined.map((j) => j.registered.poolAddress));
  const inThisRange = new Set<string>();

  const out: PendingRow[] = [];
  for (const { graduation, registered } of joined) {
    const pool = registered.poolAddress.toLowerCase();
    // Already stored, or already handled a moment ago in this same range:
    // either way there is nothing to learn and nothing to spend.
    if (known.has(pool) || inThisRange.has(pool)) continue;
    inThisRange.add(pool);
    // Round 20's filter is "not heavily bundled, measured from the launch" —
    // so a graduation's bundle facts come from its ORIGINAL launch block on the
    // curve, found by TokenLaunched, not from the graduation block.
    const bundle = await readGraduationBundle(
      chain,
      graduation.tokenAddress,
      headBlock,
    ).catch((err) => {
      console.warn(
        `discovery: graduation bundle failed for ${graduation.tokenAddress}: ${summarizeRpcError(err)}`,
      );
      return null;
    });
    out.push({
      kind: 'graduation',
      tokenAddress: graduation.tokenAddress,
      poolAddress: registered.poolAddress,
      dex: DEX_IDS.ponsDex,
      at: await clock.at(graduation.blockNumber),
      blockNumber: graduation.blockNumber,
      txHash: graduation.txHash,
      // PoolGraduated's uint256 arguments are unnamed in every source available
      // (docs/research-onchain.md): the row shows measured DexScreener liquidity
      // rather than a figure inferred from a word we cannot name.
      initialLiquidityEth: null,
      initialLiquidityUsd: null,
      quoteSymbol: null,
      launchBlockPct: bundle?.pct ?? null,
      launchBlockWallets: bundle?.wallets ?? null,
    });
  }
  return out;
}

/** Launches: the round-18 decision table, with the RPC spend staged behind it. */
async function collectLaunches(
  db: Db,
  chain: ChainClient,
  clock: BlockClock,
  headBlock: number,
  logs: ChainLog[],
): Promise<PendingRow[]> {
  const candidates: LaunchCandidate[] = [];
  const byPool = new Set<string>();
  for (const log of logs) {
    const candidate = parsePairCreated(log) ?? parseInitialize(log);
    if (!candidate) continue;
    // Two Initialize logs for one pool id cannot happen, but a replayed range
    // can hand us the same log twice; the set is free insurance.
    if (byPool.has(candidate.poolAddress)) continue;
    byPool.add(candidate.poolAddress);
    candidates.push(candidate);
  }
  if (candidates.length === 0) return [];

  const [pools, seenTokenSet, tracked] = await Promise.all([
    seenPools(db, [...byPool]),
    seenTokens(db, candidates.map((c) => c.tokenAddress)),
    trackedTokens(db, candidates.map((c) => c.tokenAddress)),
  ]);

  const out: PendingRow[] = [];
  // Tokens kept inside THIS range, so two pools of one new coin in one range
  // cannot both be posted as its launch.
  const keptTokens = new Set<string>();
  let ethPriceUsd: number | null = null;
  let ethPriceAsked = false;

  for (const candidate of candidates) {
    // Cheap first: the age gate off block numbers costs nothing, and in steady
    // state it is always satisfied — it only bites after a backfill.
    const approxAgeMinutes = Math.max(0, headBlock - candidate.blockNumber) /
      DISCOVERY.blocksPerSecond /
      60;
    const free = decideLaunch({
      tokenTracked: tracked.has(candidate.tokenAddress),
      tokenSeen: seenTokenSet.has(candidate.tokenAddress) || keptTokens.has(candidate.tokenAddress),
      poolSeen: pools.has(candidate.poolAddress),
      hasOlderPool: null,
      isStock: isTokenizedStock(null, candidate.tokenAddress),
      // Not yet measured; a null here would reject on `unknown_reserve` before
      // the free reasons had their say, so the reserve gate runs separately
      // below with the real figure.
      initialLiquidityEth: Number.POSITIVE_INFINITY,
      ageMinutes: approxAgeMinutes,
    });
    if (!free.keep) continue;

    const deposit = await readDeposit(chain, candidate);
    if (deposit.units === null) continue;
    if (!ethPriceAsked) {
      ethPriceAsked = true;
      ethPriceUsd = await ds.getEthPriceUsd(WETH).catch((err) => {
        // Not just cosmetic: an ETH-quoted launch loses its dollar figure, and a
        // USDG one loses the ETH figure every threshold is expressed in, so it
        // cannot be admitted at all until the price comes back.
        console.warn(
          'discovery: eth price unavailable — USD figures omitted, and USDG launches ' +
            'cannot be measured against the ETH floor:',
          err,
        );
        return null;
      });
    }
    const reserve = toReserve(deposit.units, candidate.quoteToken, ethPriceUsd);
    if (reserve.eth === null) {
      // A measured USDG deposit with no way to express it in ETH. Said out
      // loud at the point of the discard: silently dropping a whole quote
      // token's launches for as long as a price API is down is the kind of
      // absence nobody notices.
      if (deposit.quoteSymbol === 'USDG') {
        console.warn(
          `discovery: USDG launch ${candidate.tokenAddress} skipped — no ETH price to apply the ETH floor`,
        );
      }
      continue;
    }
    if (reserve.eth < DISCOVERY.boardMinEth) continue;

    const at = await clock.at(candidate.blockNumber);
    const older = await hasOlderPool(candidate, at);
    const verdict = decideLaunch({
      tokenTracked: tracked.has(candidate.tokenAddress),
      tokenSeen: seenTokenSet.has(candidate.tokenAddress) || keptTokens.has(candidate.tokenAddress),
      poolSeen: pools.has(candidate.poolAddress),
      hasOlderPool: older,
      isStock: isTokenizedStock(null, candidate.tokenAddress),
      initialLiquidityEth: reserve.eth,
      ageMinutes: (Date.now() - at.getTime()) / 60_000,
    });
    if (!verdict.keep) continue;

    const bundle = await readBundleFacts(chain, candidate).catch((err) => {
      console.warn(
        `discovery: bundle read failed for ${candidate.tokenAddress}: ${summarizeRpcError(err)}`,
      );
      return null;
    });
    keptTokens.add(candidate.tokenAddress);
    out.push({
      kind: 'launch',
      tokenAddress: candidate.tokenAddress,
      poolAddress: candidate.poolAddress,
      dex: candidate.dex,
      at,
      blockNumber: candidate.blockNumber,
      txHash: candidate.txHash,
      initialLiquidityEth: reserve.eth,
      initialLiquidityUsd: reserve.usd,
      quoteSymbol: deposit.quoteSymbol,
      launchBlockPct: bundle?.pct ?? null,
      launchBlockWallets: bundle?.wallets ?? null,
    });
  }
  return out;
}

/**
 * Enrichment: socials, market figures and the tokenized-stock verdict, once the
 * indexers have had DISCOVERY.enrichAfterSeconds to see the pool.
 *
 * DexScreener carries this alone (30 addresses per call, free) and is the ONLY
 * thing that stamps `enriched_at` — the review's finding was that folding the
 * GeckoTerminal lock read in here meant a GT 429 could leave a fully enriched
 * row looking unenriched forever. A row DexScreener has no pair for is left
 * unstamped so the next pass retries, until enrichGiveUpHours retires it.
 */
export async function runEnrichment(db: Db): Promise<number> {
  const now = Date.now();
  const rows = await db
    .select()
    .from(discoveryEvents)
    .where(
      and(
        isNull(discoveryEvents.enrichedAt),
        lt(discoveryEvents.at, new Date(now - DISCOVERY.enrichAfterSeconds * 1000)),
        gte(discoveryEvents.at, new Date(now - DISCOVERY.enrichGiveUpHours * 3_600_000)),
      ),
    )
    .orderBy(discoveryEvents.at)
    .limit(DISCOVERY.enrichPerPass);
  if (rows.length === 0) return 0;

  const pairs = await ds
    .getBestPairs(rows.map((r) => r.tokenAddress))
    .catch((err) => {
      console.warn('discovery: dexscreener enrichment failed:', err);
      return new Map<string, ds.DsPair>();
    });

  let enriched = 0;
  for (const row of rows) {
    const pair = pairs.get(row.tokenAddress);
    // Nothing came back: leave the row unenriched so the next pass tries again,
    // until enrichGiveUpHours retires the question.
    if (!pair) continue;
    const readAt = new Date();
    await db
      .update(discoveryEvents)
      .set({
        symbol: pair.symbol,
        name: pair.name,
        imageUrl: pair.imageUrl,
        twitterUrl: twitterUrlFrom(pair.socials),
        websiteUrl: websiteUrlFrom(pair.socials),
        mcapUsd: pair.mcapUsd,
        liquidityUsd: pair.liquidityUsd,
        isStock: isTokenizedStock(pair.name, row.tokenAddress),
        enrichedAt: readAt,
        dataAsOf: readAt,
      })
      .where(and(eq(discoveryEvents.id, row.id), isNull(discoveryEvents.enrichedAt)));
    enriched += 1;
  }
  return enriched;
}

/**
 * The LP lock percentage — the one field DexScreener has not got, and therefore
 * the one that costs a GeckoTerminal grant. Asked only for rows that would
 * actually be shown, at most DISCOVERY.lockReadsPerPass per pass, at scan
 * priority so it can never starve the alert path (docs/decisions.md round 16b).
 *
 * `lock_checked_at` is the memory, and it is stamped ONLY when the answer
 * carried a lock figure. A pool GeckoTerminal has not indexed, a 429, or a pool
 * object with no `locked_liquidity_percentage` all leave it null so a later
 * pass asks again; after DISCOVERY.lockGiveUpHours the row is simply no longer
 * selected and keeps its unknown lock. Stamping on a figureless answer would
 * write "asked and answered" over a question nobody answered.
 *
 * `lock_attempted_at` is the queue: stamped on EVERY attempt and ordered by
 * (falling back to enriched_at), so the three pools GeckoTerminal cannot answer
 * rotate to the back instead of monopolising every pass for six hours.
 */
export async function runLockReads(db: Db): Promise<number> {
  const now = Date.now();
  const rows = await db
    .select({ id: discoveryEvents.id, poolAddress: discoveryEvents.poolAddress })
    .from(discoveryEvents)
    .where(
      and(
        isNotNull(discoveryEvents.enrichedAt),
        isNull(discoveryEvents.lockCheckedAt),
        isNotNull(discoveryEvents.twitterUrl),
        isNotNull(discoveryEvents.websiteUrl),
        eq(discoveryEvents.isStock, false),
        gte(discoveryEvents.at, new Date(now - DISCOVERY.lockGiveUpHours * 3_600_000)),
      ),
    )
    .orderBy(sql`coalesce(${discoveryEvents.lockAttemptedAt}, ${discoveryEvents.enrichedAt}) asc`)
    .limit(DISCOVERY.lockReadsPerPass);
  if (rows.length === 0) return 0;

  let read = 0;
  for (const row of rows) {
    await db
      .update(discoveryEvents)
      .set({ lockAttemptedAt: new Date() })
      .where(eq(discoveryEvents.id, row.id));
    const pool = await gt.getPool(row.poolAddress, 'scan').catch(() => null);
    // A 429, a pool GeckoTerminal has not indexed yet, or a pool it knows but
    // has no lock figure for: none of those is an answer, so the row stays
    // unstamped and the next pass asks again (bounded by lockGiveUpHours).
    if (pool === null || pool.lockedLiquidityPct === null) continue;
    await db
      .update(discoveryEvents)
      .set({ lpLockedPct: pool.lockedLiquidityPct, lockCheckedAt: new Date() })
      .where(and(eq(discoveryEvents.id, row.id), isNull(discoveryEvents.lockCheckedAt)));
    read += 1;
  }
  return read;
}

/**
 * Re-enrichment: a launch is minutes old when it is first read, and a coin that
 * adds its X account (or loses its liquidity) an hour later must not be frozen
 * at that first reading. Rows younger than DISCOVERY.reenrichWithinHours are
 * refreshed every DISCOVERY.reenrichMinutes in DexScreener batches.
 *
 * Socials are only ever ADDED, never removed: DexScreener drops a token's
 * socials from a response often enough that treating an absence as "the team
 * deleted their X" would flicker rows in and out of the filtered view.
 * `data_as_of` moves only on a REAL read, so the board can print how old the
 * numbers are; `refresh_attempted_at` moves on every attempt, which is what
 * rotates a row DexScreener has no pair for to the back of the queue instead of
 * letting it head every pass forever.
 */
export async function runReEnrichment(db: Db): Promise<number> {
  const now = Date.now();
  const rows = await db
    .select()
    .from(discoveryEvents)
    .where(
      and(
        isNotNull(discoveryEvents.enrichedAt),
        gte(discoveryEvents.at, new Date(now - DISCOVERY.reenrichWithinHours * 3_600_000)),
        or(
          isNull(discoveryEvents.dataAsOf),
          lt(discoveryEvents.dataAsOf, new Date(now - DISCOVERY.reenrichMinutes * 60_000)),
        ),
      ),
    )
    // Least recently ATTEMPTED first, falling back to the first enrichment for
    // a row this pass has never tried. Ordering by data_as_of alone starved the
    // queue: a row with no DexScreener pair never moves its data_as_of, so it
    // headed every batch and the rest of the window was never re-read.
    .orderBy(sql`coalesce(${discoveryEvents.refreshAttemptedAt}, ${discoveryEvents.enrichedAt}) asc`)
    .limit(DISCOVERY.enrichPerPass);
  if (rows.length === 0) return 0;

  const pairs = await ds
    .getBestPairs(rows.map((r) => r.tokenAddress))
    .catch((err) => {
      console.warn('discovery: dexscreener re-enrichment failed:', err);
      return new Map<string, ds.DsPair>();
    });

  let refreshed = 0;
  for (const row of rows) {
    const attemptedAt = new Date();
    const pair = pairs.get(row.tokenAddress);
    if (!pair) {
      // Tried, and there was nothing to read. The attempt is recorded so this
      // row goes to the back of the queue; nothing else about it moves.
      await db
        .update(discoveryEvents)
        .set({ refreshAttemptedAt: attemptedAt })
        .where(eq(discoveryEvents.id, row.id));
      continue;
    }
    const twitterUrl = row.twitterUrl ?? twitterUrlFrom(pair.socials);
    const websiteUrl = row.websiteUrl ?? websiteUrlFrom(pair.socials);
    await db
      .update(discoveryEvents)
      .set({
        symbol: pair.symbol ?? row.symbol,
        name: pair.name ?? row.name,
        imageUrl: pair.imageUrl ?? row.imageUrl,
        twitterUrl,
        websiteUrl,
        mcapUsd: pair.mcapUsd,
        liquidityUsd: pair.liquidityUsd,
        isStock: isTokenizedStock(pair.name ?? row.name, row.tokenAddress),
        dataAsOf: attemptedAt,
        refreshAttemptedAt: attemptedAt,
      })
      .where(eq(discoveryEvents.id, row.id));
    refreshed += 1;
  }
  return refreshed;
}

/** Rows past the retention window. The zones never look back this far anyway. */
export async function pruneDiscovery(db: Db): Promise<void> {
  await db
    .delete(discoveryEvents)
    .where(lt(discoveryEvents.at, new Date(Date.now() - DISCOVERY.retentionDays * 86_400_000)));
}

export interface DiscoveryTickResult {
  detected: number;
}

/**
 * One CHAIN tick: ranges only. Throwing is fine — the caller isolates it
 * exactly like the poller isolates a scan, and the cursor is only advanced
 * range by range, so a failure re-reads the range it did not finish instead of
 * skipping it.
 *
 * Enrichment and delivery are NOT here (the review's finding): they run on
 * their own loop, so a slow DexScreener batch can never hold up the next block
 * range and turn a market-data hiccup into missed launches.
 */
export async function runDiscoveryTick(db: Db, chain: ChainClient): Promise<DiscoveryTickResult> {
  const head = await chain.getBlockNumber();
  const cursor = await readCursor(db);
  let detected = 0;

  if (cursor === null) {
    // First tick ever: start at the last block a tick may READ, not at the head.
    // Reading history would post launches from before this feature existed —
    // but initialising at the head itself would put the cursor past the safe
    // head, so the headLagBlocks blocks under the tip would be stepped over and
    // never read at all.
    const start = Math.max(0, head - DISCOVERY.headLagBlocks);
    await writeCursor(db, start);
    console.log(`discovery: cursor initialised at block ${start}`);
    return { detected };
  }

  const plan = planRange(cursor, head);
  if (plan === null) {
    // Nothing to read (a quiet chain, or the head lag). Still a successful tick,
    // and the heartbeat has to say so or the board would call the feed stalled.
    await touchCursor(db);
    return { detected };
  }
  if (plan.skippedBlocks > 0) {
    console.warn(
      `discovery: backfill bound skipped ${plan.skippedBlocks} block(s) after a long outage`,
    );
  }
  const clock = new BlockClock(chain);
  // Requests are sized to what the provider has been seen to accept: on a plan
  // that caps eth_getLogs at N blocks, one request spans at most N times the
  // chunk budget, so a catch-up can always be read — slowly, but never refused
  // whole and never stuck.
  let ranges = splitRanges(plan, requestBlocksFor(chain.maxLogRange?.()));
  let replanned = false;
  for (let i = 0; i < ranges.length; i += 1) {
    const range = ranges[i]!;
    try {
      detected += await processRange(db, chain, clock, head, range);
    } catch (err) {
      // The FIRST wide request of a process is what teaches the client the
      // provider's ceiling, so this tick sized its ranges against a cap nobody
      // knew yet. Re-plan from the range that failed — the cursor has only
      // advanced over ranges actually read — and try again at the real size. A
      // second one in the same tick is not a stale plan any more, so it goes to
      // the caller's isolate and the same blocks are re-read next tick.
      if (!(err instanceof LogRangeTooWideError) || replanned) throw err;
      replanned = true;
      console.log(
        `discovery: re-planning this tick at the provider's ${err.ceiling}-block ceiling`,
      );
      ranges = splitRanges(
        { ...plan, fromBlock: range.fromBlock },
        requestBlocksFor(chain.maxLogRange?.()),
      );
      i = -1;
      continue;
    }
    // The cursor is written to the block actually READ, never to the head: a
    // tick that covered half the gap must resume from the middle.
    await writeCursor(db, range.toBlock);
  }
  if (plan.behind) {
    console.log(`discovery: catching up, cursor at ${plan.toBlock} of ${head}`);
  }
  if (detected > 0) console.log(`discovery: ${detected} new event(s)`);
  return { detected };
}
