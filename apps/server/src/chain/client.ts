import { createPublicClient, defineChain, http, type PublicClient } from 'viem';
import { ROBINHOOD_CHAIN_ID } from '@groupie/shared';

/**
 * The one on-chain client (docs/research-features-2.md §4: "shared Alchemy
 * client, counted once"). Every chain read in the app goes through here so
 * there is a single place that knows the RPC URL, a single request counter, and
 * a single answer to "is the chain listener even configured".
 *
 * DORMANT WITHOUT A KEY. `createChainClient` returns null when no RPC URL is
 * configured, and every caller treats that as "the feature is off" — nothing
 * starts, nothing polls, nothing throws, and /discovery answers `enabled:false`
 * rather than an empty stream that looks like a quiet day.
 *
 * Transport is HTTP JSON-RPC polling, not WebSocket: a dropped subscription is
 * a silent gap, while a cursor in the database is a gap that heals itself on the
 * next tick (see cursor.ts). WebSocket is a later optimisation, not a
 * correctness requirement.
 */

export const ROBINHOOD_CHAIN = defineChain({
  id: ROBINHOOD_CHAIN_ID,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  // Filled in per-client from config; viem wants a default and never uses it
  // because every client below passes an explicit transport.
  rpcUrls: { default: { http: [] } },
});

/** One log, in the shape the decoders in decode.ts read. */
export interface ChainLog {
  address: string;
  topics: readonly string[];
  data: string;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
}

export interface LogQuery {
  /** One address or several; omitted means every address (never used here). */
  address?: string | string[];
  /** Positional topic filter; null is a wildcard, an array is an OR. */
  topics?: (string | string[] | null)[];
  /** A block number, or 'earliest' for an unbounded hunt back through history. */
  fromBlock?: number | 'earliest';
  toBlock?: number;
  /** Exact block, by hash — the cheapest way to read one transaction's context. */
  blockHash?: string;
}

/**
 * What each RPC method costs, in Alchemy compute units. The free tier is
 * denominated in CU, not in requests, and the methods this build uses differ by
 * 7.5x — a request count would say the listener is cheap on the very ticks a
 * batch of `eth_getLogs` made it expensive.
 *
 * Weights are Alchemy's published per-method CU costs for the JSON-RPC methods
 * used here; anything unlisted falls back to the median-ish 16 rather than 0,
 * so an unpriced call can never read as free.
 */
export const METHOD_CU: Readonly<Record<string, number>> = {
  eth_getLogs: 75,
  eth_call: 26,
  eth_getBlockByNumber: 16,
  eth_getTransactionByHash: 17,
  eth_getTransactionReceipt: 15,
  eth_blockNumber: 10,
};
const DEFAULT_CU = 16;

/**
 * What this process has spent, so the free tier is a number somebody can see
 * rather than a surprise. Logged once an hour, in CU and in requests: the CU is
 * the bill, the request count is what the provider's dashboard shows.
 *
 * Fed from the transport's own `onFetchRequest` rather than from the wrappers
 * below, so it counts every HTTP ATTEMPT — a viem retry is a second request the
 * provider bills for, and a meter that counted intentions instead of attempts
 * would under-report exactly when the endpoint was struggling.
 */
export class RequestMeter {
  private total = 0;
  private totalCu = 0;
  private windowStartMs = Date.now();
  private windowCount = 0;
  private windowCu = 0;

  note(method: string): void {
    const cu = METHOD_CU[method] ?? DEFAULT_CU;
    this.total += 1;
    this.totalCu += cu;
    this.windowCount += 1;
    this.windowCu += cu;
    const elapsed = Date.now() - this.windowStartMs;
    if (elapsed < 3_600_000) return;
    const cuPerHour = Math.round((this.windowCu * 3_600_000) / elapsed);
    const perHour = Math.round((this.windowCount * 3_600_000) / elapsed);
    console.log(`chain client: ${cuPerHour} CU/hour (${perHour} requests)`);
    this.windowStartMs = Date.now();
    this.windowCount = 0;
    this.windowCu = 0;
  }

  snapshot(): { total: number; windowCount: number; totalCu: number } {
    return { total: this.total, windowCount: this.windowCount, totalCu: this.totalCu };
  }
}

export interface ChainClient {
  /** Head block number. */
  getBlockNumber(): Promise<number>;
  /** Unix SECONDS of a block, or null when the block cannot be read. */
  getBlockTimestamp(blockNumber: number): Promise<number | null>;
  getLogs(query: LogQuery): Promise<ChainLog[]>;
  /**
   * Raw eth_call; returns the return data, or null when the call reverts.
   *
   * `blockTag` asks the question AT a historic block instead of at the head —
   * needed for a graduation, whose bundle share is measured in a launch window
   * that may be weeks old and whose supply may have changed since. It costs the
   * same 26 CU, but it needs an ARCHIVE node: Alchemy serves historic `eth_call`
   * on this plan, a pruning node would answer with an error and the caller reads
   * that as unknown.
   */
  call(to: string, data: string, blockTag?: number): Promise<string | null>;
  /**
   * The native value a transaction carried, in wei — the only place a
   * native-ETH v4 deposit is written down, since native ETH moves no ERC-20
   * (docs/research-onchain.md). Null when the transaction cannot be read.
   */
  getTransactionValue(txHash: string): Promise<bigint | null>;
  /**
   * Every log ONE transaction emitted, from its receipt. Null when the receipt
   * cannot be read — which is unknown, never "the transaction emitted nothing".
   *
   * This is the cheap way to read a v4 creation: one 15 CU receipt carries the
   * pool's Swaps and the quote Transfers together, where asking for them as two
   * `eth_getLogs` cost 150 CU for the same two answers.
   */
  getTransactionLogs(txHash: string): Promise<ChainLog[] | null>;
  meter(): { total: number; windowCount: number; totalCu: number };
}

function toChainLog(log: {
  address: string;
  topics: readonly string[];
  data: string;
  blockNumber: bigint | null;
  transactionHash: string | null;
  logIndex: number | null;
}): ChainLog | null {
  // A pending log (null block/tx/index) is not an event that happened yet.
  if (log.blockNumber === null || log.transactionHash === null || log.logIndex === null) {
    return null;
  }
  return {
    address: log.address.toLowerCase(),
    topics: log.topics.map((t) => t.toLowerCase()),
    data: log.data,
    blockNumber: Number(log.blockNumber),
    transactionHash: log.transactionHash.toLowerCase(),
    logIndex: log.logIndex,
  };
}

/** Raw JSON-RPC log rows (from a range query or a receipt) -> ChainLogs. */
function decodeLogRows(rows: unknown): ChainLog[] {
  const list = (Array.isArray(rows) ? rows : []) as Array<Record<string, unknown>>;
  const out: ChainLog[] = [];
  for (const row of list) {
    const mapped = toChainLog({
      address: String(row.address ?? ''),
      topics: (row.topics as string[] | undefined) ?? [],
      data: String(row.data ?? '0x'),
      blockNumber: row.blockNumber == null ? null : BigInt(String(row.blockNumber)),
      transactionHash: row.transactionHash == null ? null : String(row.transactionHash),
      logIndex: row.logIndex == null ? null : Number(row.logIndex),
    });
    if (mapped) out.push(mapped);
  }
  return out;
}

/**
 * The RPC URL this deployment should use, or null when the chain features are
 * not configured. ALCHEMY_RPC_URL overrides (a self-hosted node, a different
 * provider, a test double); otherwise the key builds Alchemy's Robinhood
 * endpoint. A blank value is unset, exactly like every other optional knob in
 * config.ts — half a key cannot half-work.
 */
export function chainRpcUrl(env: {
  alchemyApiKey: string | null;
  alchemyRpcUrl: string | null;
}): string | null {
  if (env.alchemyRpcUrl) return env.alchemyRpcUrl;
  if (env.alchemyApiKey) return `https://robinhood-mainnet.g.alchemy.com/v2/${env.alchemyApiKey}`;
  return null;
}

/**
 * The JSON-RPC method names inside a request body, for the meter. A batch is an
 * array of envelopes and each element is its own billed call; anything the body
 * does not name is skipped rather than counted as an unknown, because a body we
 * could not parse is not evidence a request was made for a particular method.
 */
function rpcMethodsOf(body: unknown): string[] {
  if (typeof body !== 'string') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const envelopes = Array.isArray(parsed) ? parsed : [parsed];
  const out: string[] = [];
  for (const envelope of envelopes) {
    const method = (envelope as { method?: unknown } | null)?.method;
    if (typeof method === 'string') out.push(method);
  }
  return out;
}

/** The shared client, or null when no RPC URL is configured. */
export function createChainClient(rpcUrl: string | null): ChainClient | null {
  if (!rpcUrl) return null;
  const meter = new RequestMeter();
  const client: PublicClient = createPublicClient({
    chain: ROBINHOOD_CHAIN,
    // One retry inside viem: a single 5xx or a dropped socket is not worth a
    // whole tick, and anything worse should reach the caller's isolate() so the
    // cursor does not advance past logs nobody read.
    transport: http(rpcUrl, {
      retryCount: 1,
      timeout: 20_000,
      // Metered HERE, at the fetch, because the retry above is a second
      // BILLED request the wrappers below never see. `init.body` is the
      // JSON-RPC envelope viem is about to post; returning nothing leaves
      // viem's own request untouched.
      onFetchRequest: (_request, init) => {
        for (const method of rpcMethodsOf(init.body)) meter.note(method);
      },
    }),
  });

  return {
    async getBlockNumber() {
      return Number(await client.getBlockNumber({ cacheTime: 0 }));
    },
    async getBlockTimestamp(blockNumber) {
      try {
        const block = await client.getBlock({ blockNumber: BigInt(blockNumber) });
        const seconds = Number(block.timestamp);
        return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
      } catch {
        // A block the node has pruned or not yet gossiped is not an error worth
        // failing a whole range over: the caller falls back to wall clock and
        // says so.
        return null;
      }
    },
    async getLogs(query) {
      const from =
        query.fromBlock === 'earliest' ? 'earliest' : `0x${(query.fromBlock ?? 0).toString(16)}`;
      const logs = await client.request({
        method: 'eth_getLogs',
        params: [
          {
            ...(query.address === undefined ? {} : { address: query.address as never }),
            ...(query.topics === undefined ? {} : { topics: query.topics as never }),
            ...(query.blockHash === undefined
              ? {
                  fromBlock: from as never,
                  toBlock: `0x${(query.toBlock ?? 0).toString(16)}` as never,
                }
              : { blockHash: query.blockHash as never }),
          } as never,
        ],
      } as never);
      return decodeLogRows(logs);
    },
    async call(to, data, blockTag) {
      try {
        const at = blockTag === undefined ? 'latest' : `0x${Math.max(0, blockTag).toString(16)}`;
        const result = await client.request({
          method: 'eth_call',
          params: [{ to: to as never, data: data as never }, at as never],
        } as never);
        return typeof result === 'string' ? result : null;
      } catch {
        // A revert (no such function, self-destructed token) is an answer, not
        // a failure: the caller reads null as "unknown".
        return null;
      }
    },
    async getTransactionLogs(txHash) {
      try {
        const receipt = (await client.request({
          method: 'eth_getTransactionReceipt',
          params: [txHash as never],
        } as never)) as { logs?: unknown } | null;
        // No receipt at all: the node does not know this transaction. Unknown,
        // never "it emitted nothing" — the two would read alike downstream and
        // one of them is a claim about a deposit.
        if (receipt === null || receipt === undefined) return null;
        return decodeLogRows(receipt.logs);
      } catch {
        return null;
      }
    },
    async getTransactionValue(txHash) {
      try {
        const tx = (await client.request({
          method: 'eth_getTransactionByHash',
          params: [txHash as never],
        } as never)) as { value?: unknown } | null;
        const raw = tx?.value;
        if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'bigint') {
          return null;
        }
        const value = BigInt(raw);
        return value < 0n ? null : value;
      } catch {
        // A transaction the node cannot serve is unknown, never zero: a zero
        // would read as "this pool opened with no ETH at all", which is a claim.
        return null;
      }
    },
    meter: () => meter.snapshot(),
  };
}
