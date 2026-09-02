import { createPublicClient, defineChain, http, type PublicClient } from 'viem';
import { DISCOVERY, ROBINHOOD_CHAIN_ID } from '@groupie/shared';

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
  eth_getCode: 26,
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
   * The deployed bytecode at an address — '0x' for an EOA or an address nothing
   * was ever deployed to, and null when the node could not be asked.
   *
   * OPTIONAL on the interface so a client built for the log listener alone
   * (and every test double of one) stays valid; round 23's confirmation reads
   * it and treats an absent method exactly like a failed read — unknown, which
   * is silence, never a claim that the address is not a contract.
   */
  getCode?(address: string): Promise<string | null>;
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
  /**
   * The widest eth_getLogs span the provider has been seen to accept, learned
   * from its refusals; null until one has been observed. The tick sizes its
   * requests from it so a catch-up range never needs more chunks than one
   * query may spend — without this, a cursor that fell 40 seconds behind on a
   * capped plan would ask for the same too-wide range forever.
   */
  maxLogRange?(): number | null;
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

/* ------------------------------------------------------- errors, redacted */

/**
 * Anything that looks like a URL, gone. The RPC URL CARRIES THE API KEY
 * (`.../v2/<key>`), and viem writes that URL into `message`, `metaMessages` and
 * `url` on every transport failure — so a single `console.warn('...', err)`
 * publishes the key into the deploy logs. Nothing built here prints a URL, and
 * this is the belt to that braces.
 */
function scrubUrls(text: string): string {
  return text.replace(/\bhttps?:\/\/\S+/gi, '[url redacted]');
}

/** Provider text can be a whole JSON body; logs get the first 400 characters. */
function clip(text: string): string {
  return text.length <= 400 ? text : `${text.slice(0, 400)}...`;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return null;
}

/**
 * A chain error as ONE safe log line.
 *
 * What goes in: the error's name, the HTTP status, the JSON-RPC code, the
 * provider's own `details` text (which is where the useful sentence lives — the
 * free-tier block-range refusal included) and viem's `shortMessage`.
 *
 * What NEVER goes in: `message`, `metaMessages`, `url` or the request body.
 * viem composes `message` out of the shortMessage PLUS the metaMessages, and one
 * of those metaMessages is literally `URL: https://…/v2/<API KEY>` — so logging
 * the error object, or its message, leaks the key. The only exception is an
 * error carrying none of viem's markers (a plain `new Error(...)` from our own
 * code, a database failure): there the message is the whole information and
 * there is no request URL in it, and it is scrubbed anyway.
 */
export function summarizeRpcError(err: unknown): string {
  if (err === null || err === undefined) return 'unknown error';
  if (typeof err === 'string') return clip(scrubUrls(err));
  if (typeof err !== 'object') return clip(scrubUrls(String(err)));
  const e = err as Record<string, unknown>;
  const cause = (typeof e.cause === 'object' && e.cause !== null
    ? (e.cause as Record<string, unknown>)
    : null) ?? null;

  const parts: string[] = [firstString(e.name) ?? 'Error'];
  const status = firstNumber(e.status, cause?.status);
  if (status !== null) parts.push(`status=${status}`);
  const code = firstNumber(e.code, cause?.code);
  if (code !== null) parts.push(`code=${code}`);
  const short = firstString(e.shortMessage, cause?.shortMessage);
  if (short !== null) parts.push(clip(scrubUrls(short)));
  const details = firstString(e.details, cause?.details);
  if (details !== null) parts.push(`details=${clip(scrubUrls(details))}`);

  // Not a viem error at all: no url, no metaMessages, no request body — so the
  // message is safe to print and is the only thing this error has to say.
  const viemShaped =
    'shortMessage' in e || 'metaMessages' in e || 'details' in e || 'url' in e || 'status' in e;
  if (!viemShaped && status === null && code === null) {
    const message = firstString(e.message);
    if (message !== null) parts.push(clip(scrubUrls(message)));
  }
  return parts.join(' ');
}

/**
 * Is this failure the provider refusing on THROUGHPUT — HTTP 429, or the
 * JSON-RPC code providers answer their per-second limits with?
 *
 * Read off `status`/`code` on the error and on its cause, never off `message`:
 * viem prints the request body into `message`, so a range that happens to
 * contain the digits 429 would read as a rate limit. Alchemy's own body
 * ("exceeded its compute units per second capacity") arrives as an
 * `HttpRequestError` with `status = 429`, which is the shape this matches.
 */
export function isThrottled(err: unknown): boolean {
  return statusCodes(err).includes(429);
}

/** Every numeric `status`/`code` the error and its cause carry. */
function statusCodes(err: unknown): number[] {
  if (err === null || typeof err !== 'object') return [];
  const e = err as Record<string, unknown>;
  const cause = (typeof e.cause === 'object' && e.cause !== null
    ? (e.cause as Record<string, unknown>)
    : null) ?? null;
  const codes: number[] = [];
  for (const value of [e.status, e.code, cause?.status, cause?.code]) {
    const code = firstNumber(value);
    if (code !== null) codes.push(code);
  }
  return codes;
}

/**
 * The provider REFUSED this read for a reason the next tick cannot fix — the
 * first of 429 (throughput), 401 or 403 (the key) found on the error or its
 * cause, or null for everything else.
 *
 * The two auth codes join the throughput one because their failure mode is
 * identical from the loop's side: a revoked, mistyped or over-quota key answers
 * every 20-second tick the same way, so retrying at the poll cadence is a
 * logged error every 20 seconds and nothing else. Backing off makes it one
 * line, then one an hour.
 *
 * Read off `status`/`code`, never off `message`, for the reason isThrottled
 * documents: viem prints the request body into the message.
 */
export function refusalStatus(err: unknown): number | null {
  const codes = statusCodes(err);
  // Throughput first, so an error carrying both is reported as the refusal the
  // loop can wait out rather than as a dead key.
  if (codes.includes(429)) return 429;
  return codes.find((code) => code === 401 || code === 403) ?? null;
}

/** Should the chain loop stop asking for a while? */
export function shouldPauseTicks(err: unknown): boolean {
  return refusalStatus(err) !== null;
}

/* ------------------------------------------------ the provider's log ceiling */

/** The narrowest chunk a blind halving will ever try. */
export const MIN_LOG_CHUNK = 10;

/**
 * One logical `eth_getLogs` needs more chunks than a single query may spend,
 * at the ceiling the provider has just been seen to enforce.
 *
 * A DEDICATED type rather than a plain Error, because the caller's only useful
 * response is to re-plan: the cap is usually learned INSIDE this very call (the
 * first wide request of a process is what teaches it), so the tick that sized
 * its ranges a moment ago sized them against a ceiling nobody knew yet. It
 * deliberately carries no RPC code and no provider `details`, so neither
 * `logRangeRefusal` nor `isThrottled` can mistake it for something to retry
 * narrower or to back off from.
 */
export class LogRangeTooWideError extends Error {
  readonly name = 'LogRangeTooWideError';
  constructor(
    /** Blocks the caller asked for. */
    readonly span: number,
    /** Blocks the provider will serve in one query. */
    readonly ceiling: number,
    /** Chunks that span needs at that ceiling. */
    readonly chunks: number,
    /** The most chunks one query may be split into. */
    readonly cap: number,
  ) {
    super(
      `eth_getLogs range of ${span} block(s) needs ${chunks} chunks at the provider's ` +
        `${ceiling}-block ceiling, over the ${cap}-chunk cap for one query`,
    );
  }
}

const RANGE_REFUSAL_CODES = [-32600, -32602];

/**
 * Is this failure the provider refusing the BLOCK RANGE of an `eth_getLogs` —
 * and did it say what range it would have served?
 *
 * The shape Alchemy answers a free-tier key with is an HTTP 400 whose body is
 * the JSON-RPC error, so viem hands us an `HttpRequestError` with the code
 * inside `details` rather than on the error object; a provider that answers 200
 * with a JSON-RPC error gives us the code on the error itself. Both are read.
 *
 * `message` is NEVER read (viem prints the request body into it, and that body
 * names fromBlock/toBlock on a timeout and a 429 alike), so a wide-range read is
 * only ever narrowed on the provider's own words.
 */
export function logRangeRefusal(err: unknown): { suggested: number | null } | null {
  if (err === null || typeof err !== 'object') return null;
  const e = err as Record<string, unknown>;
  const cause = (typeof e.cause === 'object' && e.cause !== null
    ? (e.cause as Record<string, unknown>)
    : null) ?? null;
  const text = [e.details, cause?.details]
    .filter((part): part is string => typeof part === 'string')
    .join(' ');
  if (text === '') return null;
  const lower = text.toLowerCase();
  if (!lower.includes('range')) return null;
  const onError = [e.code, cause?.code].some((code) =>
    RANGE_REFUSAL_CODES.includes(Number(code)),
  );
  const inText = /["']?code["']?\s*:\s*(-32600|-32602)\b/.test(text);
  if (!onError && !inText) return null;
  // "…this block range should work: [0x3214ec9, 0x3214ed2]" — an inclusive pair
  // of block numbers, which is the provider telling us its per-query ceiling.
  const match = /\[\s*(0x[0-9a-f]+|\d+)\s*,\s*(0x[0-9a-f]+|\d+)\s*\]/i.exec(text);
  if (match === null) return { suggested: null };
  const from = Number(match[1]);
  const to = Number(match[2]);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return { suggested: null };
  return { suggested: Math.max(1, to - from + 1) };
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

/** Even pacing between the chunks of one query (see DISCOVERY.logChunkGapMs). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  /**
   * The widest block range this provider will serve for one `eth_getLogs`, as
   * LEARNED AT RUNTIME — null until it refuses one. It is not a constant
   * because it is not ours: Alchemy's free tier caps it at 10 blocks and PAYG
   * at thousands, and the plan can change under a running process (the
   * 2026-09-02 incident: every tick 400d on a 395-block range the day the key
   * was first set). The cursor keeps its tick-sized ranges either way; the
   * splitting happens here, where the refusal is.
   */
  let maxLogRange: number | null = null;

  function learnMaxLogRange(blocks: number): void {
    const learned = Math.max(1, Math.floor(blocks));
    if (maxLogRange === learned) return;
    maxLogRange = learned;
    // Once, on change — this is a plan-shaped fact, not a per-request event.
    console.log(`chain client: provider caps eth_getLogs at ${learned} blocks per query`);
  }

  /** ONE eth_getLogs, over exactly the blocks given. Metered by the transport. */
  async function sendGetLogs(
    query: LogQuery,
    fromBlock: number | 'earliest',
    toBlock: number,
  ): Promise<unknown> {
    const from = fromBlock === 'earliest' ? 'earliest' : `0x${fromBlock.toString(16)}`;
    return client.request({
      method: 'eth_getLogs',
      params: [
        {
          ...(query.address === undefined ? {} : { address: query.address as never }),
          ...(query.topics === undefined ? {} : { topics: query.topics as never }),
          ...(query.blockHash === undefined
            ? { fromBlock: from as never, toBlock: `0x${toBlock.toString(16)}` as never }
            : { blockHash: query.blockHash as never }),
        } as never,
      ],
    } as never);
  }

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
      // A hash query and an `earliest` hunt have no numeric span to divide, so
      // they are sent as they are: they either work, or the caller reads the
      // failure as unknown (the graduation hunt's fallback is one attempt).
      if (query.blockHash !== undefined || query.fromBlock === 'earliest') {
        return decodeLogRows(await sendGetLogs(query, query.fromBlock ?? 0, query.toBlock ?? 0));
      }

      const fromBlock = query.fromBlock ?? 0;
      const toBlock = query.toBlock ?? fromBlock;
      const span = Math.max(1, toBlock - fromBlock + 1);
      let chunk = maxLogRange === null ? span : Math.min(span, maxLogRange);

      for (;;) {
        const chunks = Math.ceil(span / chunk);
        if (chunks > DISCOVERY.maxLogChunksPerQuery) {
          // Typed, and carrying no RPC code or provider text: the caller re-plans
          // its ranges against the ceiling that was just learned, the cursor does
          // NOT advance past blocks nobody read, and nothing mistakes this for a
          // range refusal worth retrying narrower.
          throw new LogRangeTooWideError(
            span,
            chunk,
            chunks,
            DISCOVERY.maxLogChunksPerQuery,
          );
        }
        try {
          // Sequential, in block order, and PACED: the chunks are one logical
          // query, and a burst of parallel — or back-to-back — requests is
          // exactly what a tier that caps the range also rate-limits.
          const out: ChainLog[] = [];
          let first = true;
          for (let start = fromBlock; start <= toBlock; start += chunk) {
            if (!first) await sleep(DISCOVERY.logChunkGapMs);
            first = false;
            const end = Math.min(toBlock, start + chunk - 1);
            out.push(...decodeLogRows(await sendGetLogs(query, start, end)));
          }
          return out;
        } catch (err) {
          const refusal = logRangeRefusal(err);
          if (refusal === null) throw err;
          const next =
            refusal.suggested !== null && refusal.suggested < chunk
              ? refusal.suggested
              : Math.max(MIN_LOG_CHUNK, Math.floor(chunk / 2));
          // Nothing narrower left to try: the provider refused a range it will
          // not shrink. The real error goes to the caller rather than a loop.
          if (next >= chunk) throw err;
          learnMaxLogRange(next);
          chunk = next;
        }
      }
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
    async getCode(address) {
      try {
        const code = await client.request({
          method: 'eth_getCode',
          params: [address as never, 'latest' as never],
        } as never);
        return typeof code === 'string' ? code : null;
      } catch {
        // A node that would not answer is UNKNOWN, never "no code there": the
        // caller's next step is a claim about a contract, so it must not be
        // reached on a failure.
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
    maxLogRange: () => maxLogRange,
  };
}
