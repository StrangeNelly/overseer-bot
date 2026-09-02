import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { chainCursor, discoveryEvents, groups, tokens, type Db } from '@groupie/db';
import { DISCOVERY } from '@groupie/shared';
import {
  PONS_GRADUATION_HOOK,
  PONS_V2_FACTORY,
  TOPICS,
  UNISWAP_V2_FACTORY,
  UNISWAP_V4_POOL_MANAGER,
  USDG,
  WETH,
} from '../src/chain/addresses.js';
import type { DsPair } from '../src/market/dexscreener.js';
import type { ChainClient, ChainLog, LogQuery } from '../src/chain/client.js';
import {
  LogRangeTooWideError,
  METHOD_CU,
  RequestMeter,
  chainRpcUrl,
  createChainClient,
  isThrottled,
  logRangeRefusal,
  shouldPauseTicks,
  summarizeRpcError,
} from '../src/chain/client.js';

/**
 * The listener's tick, end to end against a fake chain and a scripted database
 * (docs/decisions.md rounds 18 and 20).
 *
 * What is pinned here is the WIRING the pure tests cannot see: that a fresh
 * install starts at the head instead of replaying history, that the cursor only
 * moves over ranges that were actually read, that the DEPOSIT is what gets
 * recorded rather than the deposit plus a same-block snipe, that a graduation is
 * joined both to the pool it migrated into and to the launch its bundle facts
 * come from, and that without a key nothing runs at all.
 */

vi.mock('../src/market/dexscreener.js', () => ({
  getBestPairs: vi.fn(async () => new Map()),
  getTokenPools: vi.fn(async () => []),
  getEthPriceUsd: vi.fn(async () => 4_000),
  dsSnapshot: vi.fn(),
}));
vi.mock('../src/market/geckoterminal.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/market/geckoterminal.js')>();
  return { ...actual, getPool: vi.fn(async () => null) };
});

const ds = await import('../src/market/dexscreener.js');
const gt = await import('../src/market/geckoterminal.js');
const { findBlockAtTime, runDiscoveryTick, runEnrichment, runLockReads, runReEnrichment } =
  await import('../src/discovery/scan.js');
const { startDiscovery } = await import('../src/discovery/runner.js');

const dialect = new PgDialect();

/* -------------------------------------------------------------- fake chain */

const HEAD = 52_223_427;
/** The last block a tick may read: the tip is left alone (re-org safety). */
const SAFE_HEAD = HEAD - DISCOVERY.headLagBlocks;
const STRIDE = '0x446d76590389b371fbbf53a5d9649522d1946d7e';
const STRIDE_POOL_ID = '0x5564cb672e00e6bc03200b0f13d0377180544201f550da352b632efae7b8ee88';
const STRIDE_CURVE = '0x7b2864c490875f64ec2666d7055074c1c9e182af';
const STRIDE_LAUNCH_BLOCK = 52_216_963;
/** The pons-v2-dex pool DexScreener dates that launch by. */
const STRIDE_CURVE_POOL = '0x9fdb7bdd16b820f088d2055e211512b15782ca6f';
const NEW_TOKEN = '0xdd050541fc432d4ce93f3286246a3bd086440ccd';
const NEW_PAIR = '0x887c2718bfc9133ce881c09f0df18ba572189236';
const WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const nowSeconds = () => Math.floor(Date.now() / 1000);
/**
 * The fake chain's block clock: HEAD is "now" and blocks run backwards at
 * `rate` per second. A LINEAR map on purpose — the launch hunt's bisection is
 * only meaningful against a chain whose timestamps actually order its blocks.
 */
const blockSecondsAt = (block: number, rate: number = DISCOVERY.blocksPerSecond) =>
  Math.floor(nowSeconds() - (HEAD - block) / rate);

const pad = (address: string) => `0x000000000000000000000000${address.slice(2)}`;
const word = (value: bigint) => value.toString(16).padStart(64, '0');
const signedWord = (value: bigint) =>
  (value < 0n ? (1n << 256n) + value : value).toString(16).padStart(64, '0');

function log(over: Partial<ChainLog> & Pick<ChainLog, 'address' | 'topics'>): ChainLog {
  return {
    data: '0x',
    blockNumber: HEAD - 10,
    transactionHash: '0xtx1',
    logIndex: 0,
    ...over,
  };
}

const pairCreated = log({
  address: UNISWAP_V2_FACTORY,
  topics: [TOPICS.pairCreated, pad(WETH), pad(NEW_TOKEN)],
  data: `${pad(NEW_PAIR)}${word(40_322n)}`,
});

const poolGraduated = log({
  address: PONS_V2_FACTORY,
  topics: [TOPICS.poolGraduated, pad(STRIDE)],
  data: `0x${word(1_471_287n)}${word(0n)}${word(4_200_000_000_000_000_250n)}`,
  transactionHash: '0xgrad',
});

const poolRegistered = log({
  address: PONS_GRADUATION_HOOK,
  topics: [TOPICS.poolRegistered, STRIDE_POOL_ID],
  data: `${pad(STRIDE)}${word(0n)}${word(0n)}`,
  transactionHash: '0xgrad',
});

/**
 * 6 WETH DEPOSITED into the new pair — the pair's own Mint, which is the only
 * event that means "somebody added liquidity". WETH is token0 here (see
 * pairCreated), so amount0 is the quote side.
 */
const deposit = log({
  address: NEW_PAIR,
  topics: [TOPICS.v2Mint, pad(WALLET)],
  data: `0x${word(6n * 10n ** 18n)}${word(10n ** 27n)}`,
});

/** A snipe settling through the same pair in the same block. NOT liquidity. */
const snipeTransfer = log({
  address: WETH,
  topics: [TOPICS.transfer, pad(WALLET), pad(NEW_PAIR)],
  data: `0x${word(40n * 10n ** 18n)}`,
});

/** One buyer taking 12% of a 1e9 supply in the launch block. */
const tokenTransfer = log({
  address: NEW_TOKEN,
  topics: [TOPICS.transfer, pad(NEW_PAIR), pad(WALLET)],
  data: `0x${word(120_000_000n * 10n ** 18n)}`,
});

/** STRIDE's original PONS launch — where a graduation's bundle facts live. */
const tokenLaunched = log({
  address: PONS_V2_FACTORY,
  topics: [TOPICS.tokenLaunched, pad(STRIDE), pad(STRIDE_CURVE), pad(WALLET)],
  data: `0x${word(0n)}${word(0n)}${word(0n)}`,
  blockNumber: STRIDE_LAUNCH_BLOCK,
  transactionHash: '0xlaunch',
});

/** ...and one buyer taking 6% of it off the curve in that block. */
const curveBuy = log({
  address: STRIDE,
  topics: [TOPICS.transfer, pad(STRIDE_CURVE), pad(WALLET)],
  data: `0x${word(60_000_000n * 10n ** 18n)}`,
  blockNumber: STRIDE_LAUNCH_BLOCK,
  transactionHash: '0xlaunch',
});

interface FakeChain extends ChainClient {
  queries: LogQuery[];
  /** Every eth_call, with the block tag it was asked at (undefined = latest). */
  calls: Array<{ to: string; blockTag: number | undefined }>;
  txValue: bigint | null;
  /** null = the receipt could not be read at all. */
  receipts: 'ok' | null;
  /** Throw this instead of answering a query the predicate matches. */
  failLogs: ((query: LogQuery) => unknown) | null;
  /** Blocks per second this fake chain's timestamps run at. */
  blockRate: number;
  /** How many block timestamps have been read — the launch hunt's budget. */
  timestampReads: number;
}

function fakeChain(logs: ChainLog[]): FakeChain {
  const queries: LogQuery[] = [];
  const matches = (entry: ChainLog, query: LogQuery): boolean => {
    const addresses = query.address === undefined
      ? null
      : (Array.isArray(query.address) ? query.address : [query.address]).map((a) =>
          a.toLowerCase(),
        );
    if (addresses && !addresses.includes(entry.address)) return false;
    for (const [i, filter] of (query.topics ?? []).entries()) {
      if (filter === null || filter === undefined) continue;
      const wanted = Array.isArray(filter) ? filter : [filter];
      if (!wanted.map((t) => t.toLowerCase()).includes(entry.topics[i]?.toLowerCase() ?? '')) {
        return false;
      }
    }
    if (
      query.fromBlock !== undefined &&
      query.fromBlock !== 'earliest' &&
      entry.blockNumber < query.fromBlock
    ) {
      return false;
    }
    if (query.toBlock !== undefined && entry.blockNumber > query.toBlock) return false;
    return true;
  };
  const calls: FakeChain['calls'] = [];
  const chain: FakeChain = {
    queries,
    calls,
    txValue: null,
    receipts: 'ok',
    failLogs: null,
    blockRate: DISCOVERY.blocksPerSecond,
    timestampReads: 0,
    getBlockNumber: async () => HEAD,
    getBlockTimestamp: async (block) => {
      chain.timestampReads += 1;
      return blockSecondsAt(block, chain.blockRate);
    },
    getLogs: async (query) => {
      queries.push(query);
      const failure = chain.failLogs?.(query);
      if (failure) throw failure;
      return logs.filter((entry) => matches(entry, query));
    },
    // totalSupply(): 1e9 tokens.
    call: async (to, _data, blockTag) => {
      calls.push({ to, blockTag });
      return `0x${word(10n ** 27n)}`;
    },
    getTransactionValue: async () => chain.txValue,
    getTransactionLogs: async (txHash) =>
      chain.receipts === null
        ? null
        : logs.filter((entry) => entry.transactionHash === txHash.toLowerCase()),
    meter: () => ({ total: 0, windowCount: 0, totalCu: 0 }),
  };
  return chain;
}

/* ----------------------------------------------------------- scripted db */

interface DbCall {
  key: string;
  values?: unknown;
  set?: Record<string, unknown>;
  where?: SQL;
  limit?: unknown;
}

type Script = Record<string, unknown[][]>;

function makeDb(script: Script = {}): { db: Db; calls: DbCall[] } {
  const calls: DbCall[] = [];
  const cursor = new Map<string, number>();
  const take = (key: string): unknown[] => {
    const sets = script[key];
    if (!sets || sets.length === 0) return [];
    const index = Math.min(cursor.get(key) ?? 0, sets.length - 1);
    cursor.set(key, index + 1);
    return sets[index] ?? [];
  };
  const nameOf = (table: unknown): string => {
    if (table === discoveryEvents) return 'discoveryEvents';
    if (table === chainCursor) return 'chainCursor';
    if (table === tokens) return 'tokens';
    if (table === groups) return 'groups';
    return 'unknown';
  };
  const start = (op: string, table: unknown) => {
    const call: DbCall = { key: `${op}:${nameOf(table)}` };
    calls.push(call);
    const node: Record<string, unknown> = {
      then: (ok: (rows: unknown[]) => unknown, err: (e: unknown) => unknown) =>
        Promise.resolve()
          .then(() => {
            const rows = take(call.key);
            // The fake honours LIMIT, because "how many rows a pass may touch"
            // is a rule of the code under test, not of the driver.
            return typeof call.limit === 'number' ? rows.slice(0, call.limit) : rows;
          })
          .then(ok, err),
    };
    for (const method of [
      'values',
      'set',
      'from',
      'where',
      'orderBy',
      'limit',
      'returning',
      'onConflictDoNothing',
      'onConflictDoUpdate',
    ]) {
      node[method] = (...args: unknown[]) => {
        if (method === 'values') call.values = args[0];
        if (method === 'set') call.set = args[0] as Record<string, unknown>;
        if (method === 'where') call.where = args[0] as SQL;
        if (method === 'limit') call.limit = args[0];
        return node;
      };
    }
    return node;
  };
  const db = {
    insert: (table: unknown) => start('insert', table),
    update: (table: unknown) => start('update', table),
    delete: (table: unknown) => start('delete', table),
    select: () => ({ from: (table: unknown) => start('select', table) }),
    selectDistinct: () => ({ from: (table: unknown) => start('select', table) }),
    execute: () => Promise.resolve([]),
  };
  return { db: db as unknown as Db, calls };
}

const find = (calls: DbCall[], key: string) => calls.filter((c) => c.key === key);
const whereSql = (call: DbCall | undefined): string =>
  call?.where ? dialect.sqlToQuery(call.where).sql : '';
const whereParams = (call: DbCall | undefined): unknown[] =>
  call?.where ? (dialect.sqlToQuery(call.where).params as unknown[]) : [];
/** The rows one insert carried. */
const rowsOf = (call: DbCall | undefined): Array<Record<string, unknown>> =>
  Array.isArray(call?.values) ? (call.values as Array<Record<string, unknown>>) : [];
/** The combined range queries a tick makes (address is the four-way array). */
const rangeQueries = (chain: FakeChain) => chain.queries.filter((q) => Array.isArray(q.address));

/** A cursor 100 blocks behind the head — one ordinary tick's worth. */
const CURSOR_ROW = [[{ lastBlock: HEAD - 100 }]];

/** DexScreener dating STRIDE's PONS curve pool at its real launch block. */
const mockCurvePool = () => {
  vi.mocked(ds.getTokenPools).mockResolvedValue([
    {
      pairAddress: STRIDE_CURVE_POOL,
      dexId: 'pons-v2-dex',
      pairCreatedAt: new Date(blockSecondsAt(STRIDE_LAUNCH_BLOCK) * 1000),
    },
  ]);
};

beforeEach(() => {
  vi.mocked(ds.getTokenPools).mockResolvedValue([]);
  vi.mocked(ds.getEthPriceUsd).mockResolvedValue(4_000);
  vi.mocked(ds.getBestPairs).mockResolvedValue(new Map());
});

describe('runDiscoveryTick', () => {
  it('starts a fresh install at the READABLE head and reads no history', async () => {
    const chain = fakeChain([pairCreated]);
    const { db, calls } = makeDb({ 'select:chainCursor': [[]] });
    const result = await runDiscoveryTick(db, chain);
    expect(result.detected).toBe(0);
    expect(chain.queries).toHaveLength(0);
    // SAFE_HEAD, not HEAD: initialising past the safe head would step over the
    // headLagBlocks blocks under the tip and never read them.
    expect(find(calls, 'insert:chainCursor')[0]?.values).toMatchObject({ lastBlock: SAFE_HEAD });
  });

  it('sizes its requests to a provider that caps eth_getLogs, so a catch-up is never refused whole', async () => {
    const chain = fakeChain([]);
    // The client learned a 10-block cap (Alchemy's free tier on this chain).
    chain.maxLogRange = () => 10;
    // The cursor fell 1,000 blocks behind: 100 seconds of chain, well over the
    // 400 blocks one query may spend at that cap.
    const { db, calls } = makeDb({ 'select:chainCursor': [[{ lastBlock: HEAD - 1_000 }]] });
    await runDiscoveryTick(db, chain);
    const ranges = rangeQueries(chain);
    expect(ranges.length).toBeGreaterThan(1);
    const cap = 10 * DISCOVERY.maxLogChunksPerQuery;
    for (const q of ranges) {
      expect((q.toBlock as number) - (q.fromBlock as number) + 1).toBeLessThanOrEqual(cap);
    }
    // ...and the whole gap was read this tick, with the cursor following each range.
    expect(ranges[0]?.fromBlock).toBe(HEAD - 1_000 + 1);
    expect(ranges[ranges.length - 1]?.toBlock).toBe(SAFE_HEAD);
    const written = find(calls, 'insert:chainCursor').map((c) => (c.values as { lastBlock: number }).lastBlock);
    expect(written[written.length - 1]).toBe(SAFE_HEAD);
  });

  it('RE-PLANS when the provider ceiling is learned inside the tick', async () => {
    // The 2026-09-02 production shape: the first tick after boot sizes its
    // requests before any cap is known, the client learns the 10-block ceiling
    // from the refusal, and the whole tick used to be lost to the chunk-cap
    // error. Now the tick re-splits what is left and reads it.
    const chain = fakeChain([]);
    let learned: number | null = null;
    chain.maxLogRange = () => learned;
    chain.failLogs = (query) => {
      if (learned !== null || !Array.isArray(query.address)) return null;
      learned = 10;
      return new LogRangeTooWideError(997, 10, 100, DISCOVERY.maxLogChunksPerQuery);
    };
    const { db, calls } = makeDb({ 'select:chainCursor': [[{ lastBlock: HEAD - 1_000 }]] });
    await runDiscoveryTick(db, chain);

    const ranges = rangeQueries(chain);
    // One refused request, then the same gap at the size the provider will serve.
    expect(ranges[0]).toMatchObject({ fromBlock: HEAD - 999, toBlock: SAFE_HEAD });
    const served = ranges.slice(1);
    expect(served.length).toBeGreaterThan(1);
    const cap = 10 * DISCOVERY.maxLogChunksPerQuery;
    for (const query of served) {
      expect((query.toBlock as number) - (query.fromBlock as number) + 1).toBeLessThanOrEqual(cap);
    }
    // Nothing skipped: the re-plan starts at the range that failed, because the
    // cursor only ever moved over ranges that were actually read.
    expect(served[0]?.fromBlock).toBe(HEAD - 999);
    expect(served[served.length - 1]?.toBlock).toBe(SAFE_HEAD);
    for (let i = 1; i < served.length; i++) {
      expect(served[i]?.fromBlock).toBe((served[i - 1]?.toBlock as number) + 1);
    }
    const written = find(calls, 'insert:chainCursor').map(
      (c) => (c.values as { lastBlock: number }).lastBlock,
    );
    expect(written[written.length - 1]).toBe(SAFE_HEAD);
  });

  it('re-plans ONCE: a second too-wide range is a real failure, not a stale plan', async () => {
    const chain = fakeChain([]);
    chain.maxLogRange = () => 10;
    chain.failLogs = (query) =>
      Array.isArray(query.address)
        ? new LogRangeTooWideError(400, 1, 400, DISCOVERY.maxLogChunksPerQuery)
        : null;
    const { db, calls } = makeDb({ 'select:chainCursor': [[{ lastBlock: HEAD - 1_000 }]] });
    await expect(runDiscoveryTick(db, chain)).rejects.toBeInstanceOf(LogRangeTooWideError);
    // ...and the cursor did not move over blocks nobody read.
    expect(find(calls, 'insert:chainCursor')).toHaveLength(0);
  });

  it('records a launch with its DEPOSIT and its bundle facts', async () => {
    const chain = fakeChain([pairCreated, deposit, tokenTransfer]);
    const { db, calls } = makeDb({
      'select:chainCursor': CURSOR_ROW,
      'insert:discoveryEvents': [[{ id: 1 }]],
    });
    await runDiscoveryTick(db, chain);
    const [row] = rowsOf(find(calls, 'insert:discoveryEvents')[0]);
    expect(row).toMatchObject({
      kind: 'launch',
      tokenAddress: NEW_TOKEN,
      poolAddress: NEW_PAIR,
      dex: 'uniswap-v2-robinhood',
      initialLiquidityEth: 6,
      initialLiquidityUsd: 24_000,
      quoteSymbol: 'ETH',
      launchBlockPct: 12,
      launchBlockWallets: 1,
    });
  });

  it('records the DEPOSIT, not the deposit plus a same-block snipe', async () => {
    // 6 ETH added, 40 ETH bought through the same pair in the same block. The
    // old Transfer-sum read this as a 46 ETH launch.
    const chain = fakeChain([pairCreated, deposit, snipeTransfer, tokenTransfer]);
    const { db, calls } = makeDb({
      'select:chainCursor': CURSOR_ROW,
      'insert:discoveryEvents': [[{ id: 1 }]],
    });
    await runDiscoveryTick(db, chain);
    expect(rowsOf(find(calls, 'insert:discoveryEvents')[0])[0]).toMatchObject({
      initialLiquidityEth: 6,
    });
  });

  it('drops a launch whose coin already had an older pool', async () => {
    vi.mocked(ds.getTokenPools).mockResolvedValue([
      { pairAddress: '0xsomethingelse', dexId: 'uniswap-v3-robinhood', pairCreatedAt: new Date(0) },
    ]);
    const chain = fakeChain([pairCreated, deposit, tokenTransfer]);
    const { db, calls } = makeDb({ 'select:chainCursor': CURSOR_ROW });
    await runDiscoveryTick(db, chain);
    expect(find(calls, 'insert:discoveryEvents')).toHaveLength(0);
  });

  it('drops a launch under the board floor without paying for bundle facts', async () => {
    const thin = { ...deposit, data: `0x${word(10n ** 17n)}${word(10n ** 27n)}` };
    const chain = fakeChain([pairCreated, thin, tokenTransfer]);
    const { db, calls } = makeDb({ 'select:chainCursor': CURSOR_ROW });
    await runDiscoveryTick(db, chain);
    expect(find(calls, 'insert:discoveryEvents')).toHaveLength(0);
    // Nothing was asked about the token's own Transfer logs, which is the
    // spend the floor exists to avoid.
    expect(chain.queries.some((q) => q.address === NEW_TOKEN)).toBe(false);
  });

  it('drops a launch whose deposit could not be read at all', async () => {
    // A pair with a snipe but no Mint: inbound quote exists, a deposit does not.
    const chain = fakeChain([pairCreated, snipeTransfer, tokenTransfer]);
    const { db, calls } = makeDb({ 'select:chainCursor': CURSOR_ROW });
    await runDiscoveryTick(db, chain);
    expect(find(calls, 'insert:discoveryEvents')).toHaveLength(0);
  });

  it('joins a graduation to the pool it migrated into', async () => {
    const chain = fakeChain([poolGraduated, poolRegistered]);
    const { db, calls } = makeDb({
      'select:chainCursor': CURSOR_ROW,
      'insert:discoveryEvents': [[{ id: 1 }]],
    });
    await runDiscoveryTick(db, chain);
    const [row] = rowsOf(find(calls, 'insert:discoveryEvents')[0]);
    expect(row).toMatchObject({
      kind: 'graduation',
      tokenAddress: STRIDE,
      poolAddress: STRIDE_POOL_ID,
      dex: 'pons-v2-dex',
      // Unnamed ABI words are never decoded into a liquidity claim.
      initialLiquidityEth: null,
      initialLiquidityUsd: null,
      quoteSymbol: null,
      // No TokenLaunched on this chain: unknown, and shown as unknown.
      launchBlockPct: null,
    });
  });

  it('measures a graduation bundle from the coin ORIGINAL launch block', async () => {
    mockCurvePool();
    const chain = fakeChain([poolGraduated, poolRegistered, tokenLaunched, curveBuy]);
    const { db, calls } = makeDb({
      'select:chainCursor': CURSOR_ROW,
      'insert:discoveryEvents': [[{ id: 1 }]],
    });
    await runDiscoveryTick(db, chain);
    expect(rowsOf(find(calls, 'insert:discoveryEvents')[0])[0]).toMatchObject({
      kind: 'graduation',
      launchBlockPct: 6,
      launchBlockWallets: 1,
    });
    // ...found by a point lookup on the token, over the window its curve pool's
    // creation date placed it in.
    const lookup = chain.queries.find((q) => q.topics?.[0] === TOPICS.tokenLaunched);
    expect(lookup?.topics?.[1]).toBe(pad(STRIDE));
    expect(lookup?.fromBlock).toBeLessThanOrEqual(STRIDE_LAUNCH_BLOCK);
    expect(lookup?.toBlock).toBeGreaterThanOrEqual(STRIDE_LAUNCH_BLOCK);
  });

  it('skips a graduation whose destination pool is not in the range', async () => {
    const chain = fakeChain([poolGraduated]);
    const { db, calls } = makeDb({ 'select:chainCursor': CURSOR_ROW });
    await runDiscoveryTick(db, chain);
    expect(find(calls, 'insert:discoveryEvents')).toHaveLength(0);
  });

  it('drops a candidate whose pool we already recorded, before spending a call', async () => {
    const chain = fakeChain([pairCreated, deposit, tokenTransfer]);
    const { db, calls } = makeDb({
      'select:chainCursor': CURSOR_ROW,
      // The two discovery reads run in order: seenPools answers with this pool,
      // seenTokens answers empty.
      'select:discoveryEvents': [[{ poolAddress: NEW_PAIR }], []],
    });
    await runDiscoveryTick(db, chain);
    expect(find(calls, 'insert:discoveryEvents')).toHaveLength(0);
    // Not even the deposit was read.
    expect(chain.queries.some((q) => q.address === NEW_PAIR)).toBe(false);
  });

  it('asks for all four event streams in ONE query over the range', async () => {
    const chain = fakeChain([]);
    const { db } = makeDb({ 'select:chainCursor': CURSOR_ROW });
    await runDiscoveryTick(db, chain);
    expect(chain.queries).toHaveLength(1);
    const [query] = chain.queries;
    expect(query?.address).toEqual([
      UNISWAP_V2_FACTORY,
      UNISWAP_V4_POOL_MANAGER,
      PONS_V2_FACTORY,
      PONS_GRADUATION_HOOK,
    ]);
    expect(query?.topics?.[0]).toEqual([
      TOPICS.pairCreated,
      TOPICS.initialize,
      TOPICS.poolGraduated,
      TOPICS.poolRegistered,
    ]);
    expect(query?.fromBlock).toBe(HEAD - 99);
    expect(query?.toBlock).toBe(SAFE_HEAD);
  });

  it('advances the cursor to the end of the range it read, never to the head', async () => {
    const chain = fakeChain([]);
    const { db, calls } = makeDb({ 'select:chainCursor': CURSOR_ROW });
    await runDiscoveryTick(db, chain);
    expect(find(calls, 'insert:chainCursor')[0]?.values).toMatchObject({ lastBlock: SAFE_HEAD });
  });

  it('reads at most one tick of chain after a long outage', async () => {
    const chain = fakeChain([]);
    const { db, calls } = makeDb({ 'select:chainCursor': [[{ lastBlock: 1 }]] });
    await runDiscoveryTick(db, chain);
    const ranges = rangeQueries(chain);
    expect(ranges).toHaveLength(DISCOVERY.maxRangesPerTick);
    // ...and it resumes from inside the backfill bound, not from block 1.
    expect(ranges[0]!.fromBlock).toBeGreaterThan(HEAD - 3_600 * DISCOVERY.blocksPerSecond * 3);
    expect(find(calls, 'insert:chainCursor')).toHaveLength(DISCOVERY.maxRangesPerTick);
  });

  it('does nothing at all when the cursor is already at the readable head', async () => {
    const chain = fakeChain([pairCreated]);
    const { db, calls } = makeDb({ 'select:chainCursor': [[{ lastBlock: SAFE_HEAD }]] });
    await runDiscoveryTick(db, chain);
    expect(chain.queries).toHaveLength(0);
    expect(find(calls, 'insert:chainCursor')).toHaveLength(0);
    // ...but the HEARTBEAT still moves: a quiet chain and a dead listener must
    // not look the same on the board.
    expect(find(calls, 'update:chainCursor')[0]?.set).toHaveProperty('updatedAt');
  });
});

/* ------------------------------------------------------- native-ETH launches */

describe('native-ETH v4 launches', () => {
  const V4_POOL_ID = '0xabc0000000000000000000000000000000000000000000000000000000000001';
  const NATIVE = '0x0000000000000000000000000000000000000000';

  /** currency0 = native ETH, currency1 = the new coin, an ordinary hook. */
  const initialize = log({
    address: UNISWAP_V4_POOL_MANAGER,
    topics: [TOPICS.initialize, V4_POOL_ID, pad(NATIVE), pad(NEW_TOKEN)],
    data: `0x${word(0n)}${word(200n)}${word(0n)}${word(0n)}${word(0n)}`,
    transactionHash: '0xv4create',
  });
  const v4TokenTransfer = log({
    address: NEW_TOKEN,
    topics: [TOPICS.transfer, pad(UNISWAP_V4_POOL_MANAGER), pad(WALLET)],
    data: `0x${word(120_000_000n * 10n ** 18n)}`,
    transactionHash: '0xv4create',
  });

  it('measures the deposit off the transaction value instead of dropping it', async () => {
    const chain = fakeChain([initialize, v4TokenTransfer]);
    chain.txValue = 6n * 10n ** 18n;
    const { db, calls } = makeDb({
      'select:chainCursor': CURSOR_ROW,
      'insert:discoveryEvents': [[{ id: 1 }]],
    });
    await runDiscoveryTick(db, chain);
    expect(rowsOf(find(calls, 'insert:discoveryEvents')[0])[0]).toMatchObject({
      kind: 'launch',
      tokenAddress: NEW_TOKEN,
      poolAddress: V4_POOL_ID,
      initialLiquidityEth: 6,
      quoteSymbol: 'ETH',
      launchBlockPct: 12,
    });
  });

  it('subtracts a buy made in the same creating transaction', async () => {
    const sameTxSwap = log({
      address: UNISWAP_V4_POOL_MANAGER,
      topics: [TOPICS.v4Swap, V4_POOL_ID, pad(WALLET)],
      data:
        `0x${signedWord(-1n * 10n ** 18n)}${signedWord(1n)}` +
        `${word(0n)}${word(0n)}${word(0n)}${word(0n)}`,
      transactionHash: '0xv4create',
    });
    const chain = fakeChain([initialize, sameTxSwap, v4TokenTransfer]);
    chain.txValue = 6n * 10n ** 18n;
    const { db, calls } = makeDb({
      'select:chainCursor': CURSOR_ROW,
      'insert:discoveryEvents': [[{ id: 1 }]],
    });
    await runDiscoveryTick(db, chain);
    expect(rowsOf(find(calls, 'insert:discoveryEvents')[0])[0]).toMatchObject({
      initialLiquidityEth: 5,
    });
  });

  it('keeps the unknown_reserve rejection when the transaction cannot be read', async () => {
    const chain = fakeChain([initialize, v4TokenTransfer]);
    chain.txValue = null;
    const { db, calls } = makeDb({ 'select:chainCursor': CURSOR_ROW });
    await runDiscoveryTick(db, chain);
    expect(find(calls, 'insert:discoveryEvents')).toHaveLength(0);
  });
});

/* --------------------------------------------- v4 with an ERC-20 quote (B2) */

describe('a v4 launch quoted in WETH', () => {
  const V4_POOL_ID = '0xabc0000000000000000000000000000000000000000000000000000000000002';
  const initialize = log({
    address: UNISWAP_V4_POOL_MANAGER,
    topics: [TOPICS.initialize, V4_POOL_ID, pad(WETH), pad(NEW_TOKEN)],
    data: `0x${word(0n)}${word(200n)}${word(0n)}${word(0n)}${word(0n)}`,
    transactionHash: '0xv4erc20',
  });
  /** 6 WETH into the singleton, in the creating transaction. */
  const quoteIn = log({
    address: WETH,
    topics: [TOPICS.transfer, pad(WALLET), pad(UNISWAP_V4_POOL_MANAGER)],
    data: `0x${word(6n * 10n ** 18n)}`,
    transactionHash: '0xv4erc20',
  });
  /** ...and a 1 WETH buy through this pool in the same transaction. */
  const sameTxSwap = log({
    address: UNISWAP_V4_POOL_MANAGER,
    topics: [TOPICS.v4Swap, V4_POOL_ID, pad(WALLET)],
    data:
      `0x${signedWord(-1n * 10n ** 18n)}${signedWord(1n)}` +
      `${word(0n)}${word(0n)}${word(0n)}${word(0n)}`,
    transactionHash: '0xv4erc20',
  });
  const v4TokenTransfer = log({
    address: NEW_TOKEN,
    topics: [TOPICS.transfer, pad(UNISWAP_V4_POOL_MANAGER), pad(WALLET)],
    data: `0x${word(120_000_000n * 10n ** 18n)}`,
    transactionHash: '0xv4erc20',
  });

  it('reads the deposit off ONE receipt, subtracting the same-tx buy', async () => {
    const chain = fakeChain([initialize, quoteIn, sameTxSwap, v4TokenTransfer]);
    const { db, calls } = makeDb({
      'select:chainCursor': CURSOR_ROW,
      'insert:discoveryEvents': [[{ id: 1 }]],
    });
    await runDiscoveryTick(db, chain);
    expect(rowsOf(find(calls, 'insert:discoveryEvents')[0])[0]).toMatchObject({
      poolAddress: V4_POOL_ID,
      initialLiquidityEth: 5,
      quoteSymbol: 'ETH',
    });
    // The receipt replaced two log queries: the only ones left are the range
    // read and the bundle's own Transfer window.
    expect(chain.queries.filter((q) => q.address === UNISWAP_V4_POOL_MANAGER)).toHaveLength(0);
    expect(chain.queries.filter((q) => q.address === WETH)).toHaveLength(0);
  });

  it('answers unknown — and stores nothing — when the receipt cannot be read', async () => {
    const chain = fakeChain([initialize, quoteIn, v4TokenTransfer]);
    chain.receipts = null;
    const { db, calls } = makeDb({ 'select:chainCursor': CURSOR_ROW });
    await runDiscoveryTick(db, chain);
    expect(find(calls, 'insert:discoveryEvents')).toHaveLength(0);
  });
});

/* ---------------------------------------------------- graduations, in detail */

/** What a provider answers when it will not serve `earliest`. */
const rangeRefusal = () =>
  Object.assign(new Error('expected fromBlock to be a hex string starting with 0x'), {
    code: -32602,
  });

const gradScript = () => ({
  'select:chainCursor': CURSOR_ROW,
  'insert:discoveryEvents': [[{ id: 1 }]],
});

describe('graduation bundle reads', () => {
  it('finds the launch by DATE, in one narrow window, instead of scanning history', async () => {
    // DexScreener dates the coin's PONS curve pool for free; a bisection over
    // block timestamps turns that instant into a block; ONE bounded eth_getLogs
    // reads the TokenLaunched log there. No `earliest` query at all.
    mockCurvePool();
    const chain = fakeChain([poolGraduated, poolRegistered, tokenLaunched, curveBuy]);
    const { db, calls } = makeDb(gradScript());
    await runDiscoveryTick(db, chain);

    const hunts = chain.queries.filter((q) => q.topics?.[0] === TOPICS.tokenLaunched);
    expect(hunts).toHaveLength(1);
    const [hunt] = hunts;
    expect(hunt?.fromBlock).not.toBe('earliest');
    expect(hunt?.topics?.[1]).toBe(pad(STRIDE));
    const from = hunt?.fromBlock as number;
    const to = hunt?.toBlock as number;
    // The window contains the launch block, and is narrow enough to be one
    // request on PAYG and one chunk budget on a 10-block-capped tier.
    expect(from).toBeLessThanOrEqual(STRIDE_LAUNCH_BLOCK);
    expect(to).toBeGreaterThanOrEqual(STRIDE_LAUNCH_BLOCK);
    expect(to - from + 1).toBeLessThanOrEqual(2 * DISCOVERY.launchHuntWindowBlocks + 1);
    expect(to - from + 1).toBeLessThanOrEqual(10 * DISCOVERY.maxLogChunksPerQuery);
    // ...and the share is still measured off the original launch block.
    expect(rowsOf(find(calls, 'insert:discoveryEvents')[0])[0]).toMatchObject({
      launchBlockPct: 6,
      launchBlockWallets: 1,
    });
  });

  it('reads totalSupply AT the launch window, not at the head', async () => {
    mockCurvePool();
    const chain = fakeChain([poolGraduated, poolRegistered, tokenLaunched, curveBuy]);
    const { db } = makeDb(gradScript());
    await runDiscoveryTick(db, chain);
    // The share is a fraction of the supply that existed when those Transfers
    // happened; a coin that minted while it sat on its curve must not be
    // divided by a denominator from a different day.
    expect(chain.calls).toEqual([
      { to: STRIDE, blockTag: STRIDE_LAUNCH_BLOCK + DISCOVERY.bundleBlockSpan },
    ]);
  });

  it('falls back to ONE unbounded query when DexScreener knows no PONS pool', async () => {
    const chain = fakeChain([poolGraduated, poolRegistered, tokenLaunched, curveBuy]);
    const { db, calls } = makeDb(gradScript());
    await runDiscoveryTick(db, chain);
    const hunts = chain.queries.filter((q) => q.topics?.[0] === TOPICS.tokenLaunched);
    expect(hunts).toHaveLength(1);
    expect(hunts[0]?.fromBlock).toBe('earliest');
    expect(rowsOf(find(calls, 'insert:discoveryEvents')[0])[0]).toMatchObject({
      launchBlockPct: 6,
      launchBlockWallets: 1,
    });
  });

  it('stores the graduation with an UNKNOWN share when that fallback is refused', async () => {
    // The public Robinhood RPC really does refuse `earliest`. There is no wide
    // historic scan behind it any more: one attempt, then unknown — never 0%.
    const chain = fakeChain([poolGraduated, poolRegistered, tokenLaunched, curveBuy]);
    chain.failLogs = (q) => (q.topics?.[0] === TOPICS.tokenLaunched ? rangeRefusal() : null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { db, calls } = makeDb(gradScript());
    await runDiscoveryTick(db, chain);
    expect(chain.queries.filter((q) => q.topics?.[0] === TOPICS.tokenLaunched)).toHaveLength(1);
    expect(rowsOf(find(calls, 'insert:discoveryEvents')[0])[0]).toMatchObject({
      kind: 'graduation',
      poolAddress: STRIDE_POOL_ID,
      launchBlockPct: null,
      launchBlockWallets: null,
    });
    // Logged through summarizeRpcError: a summary, never the error object.
    expect(warn.mock.calls.flat().map(String).join(' ')).toContain('launch lookup failed');
    warn.mockRestore();
  });

  it('spends nothing at all when the curve instant cannot be placed on a block', async () => {
    mockCurvePool();
    const chain = fakeChain([poolGraduated, poolRegistered, tokenLaunched, curveBuy]);
    // A node that will not serve block timestamps: unknown, and no log query is
    // sent on a window nobody could locate.
    chain.getBlockTimestamp = async () => {
      chain.timestampReads += 1;
      return null;
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { db, calls } = makeDb(gradScript());
    await runDiscoveryTick(db, chain);
    expect(chain.queries.filter((q) => q.topics?.[0] === TOPICS.tokenLaunched)).toHaveLength(0);
    expect(rowsOf(find(calls, 'insert:discoveryEvents')[0])[0]).toMatchObject({
      kind: 'graduation',
      launchBlockPct: null,
      launchBlockWallets: null,
    });
    warn.mockRestore();
  });

  it('never retries a hunt that failed for a reason a narrower query cannot fix', async () => {
    mockCurvePool();
    const chain = fakeChain([poolGraduated, poolRegistered, tokenLaunched, curveBuy]);
    chain.failLogs = (q) =>
      q.topics?.[0] === TOPICS.tokenLaunched
        ? Object.assign(new Error('HTTP request failed.'), {
            details: 'Too Many Requests',
            status: 429,
          })
        : null;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { db, calls } = makeDb(gradScript());
    await runDiscoveryTick(db, chain);
    expect(chain.queries.filter((q) => q.topics?.[0] === TOPICS.tokenLaunched)).toHaveLength(1);
    expect(rowsOf(find(calls, 'insert:discoveryEvents')[0])[0]).toMatchObject({
      kind: 'graduation',
      launchBlockPct: null,
      launchBlockWallets: null,
    });
    warn.mockRestore();
  });

  it('spends NOTHING on a duplicate PoolGraduated inside one range', async () => {
    const chain = fakeChain([poolGraduated, poolGraduated, poolRegistered, tokenLaunched, curveBuy]);
    const { db, calls } = makeDb(gradScript());
    await runDiscoveryTick(db, chain);
    expect(rowsOf(find(calls, 'insert:discoveryEvents')[0])).toHaveLength(1);
    // One launch hunt and one totalSupply for the pair of logs, not two.
    expect(chain.queries.filter((q) => q.topics?.[0] === TOPICS.tokenLaunched)).toHaveLength(1);
    expect(chain.calls).toHaveLength(1);
  });

  it('spends nothing on a graduation whose pool we already recorded', async () => {
    const chain = fakeChain([poolGraduated, poolRegistered, tokenLaunched, curveBuy]);
    const { db, calls } = makeDb({
      'select:chainCursor': CURSOR_ROW,
      'select:discoveryEvents': [[{ poolAddress: STRIDE_POOL_ID }]],
    });
    await runDiscoveryTick(db, chain);
    expect(find(calls, 'insert:discoveryEvents')).toHaveLength(0);
    expect(chain.queries.filter((q) => q.topics?.[0] === TOPICS.tokenLaunched)).toHaveLength(0);
    expect(chain.calls).toHaveLength(0);
  });

  it('still stores a graduation older than the launch age gate', async () => {
    // Round 20 deliberately puts no collection-age gate on graduations: the
    // board wants the whole 24h stream after a restart even though the CHAT
    // (maxAlertAgeMinutes) hears about none of it.
    const chain = fakeChain([poolGraduated, poolRegistered]);
    chain.getBlockTimestamp = async () =>
      Math.floor(Date.now() / 1000) - (DISCOVERY.maxDetectionAgeMinutes + 60) * 60;
    const { db, calls } = makeDb(gradScript());
    await runDiscoveryTick(db, chain);
    expect(rowsOf(find(calls, 'insert:discoveryEvents')[0])[0]).toMatchObject({
      kind: 'graduation',
      poolAddress: STRIDE_POOL_ID,
    });
  });
});

/* ----------------------------------------------------------------- USDG */

describe('a USDG-quoted launch', () => {
  const usdgPairCreated = log({
    address: UNISWAP_V2_FACTORY,
    topics: [TOPICS.pairCreated, pad(USDG), pad(NEW_TOKEN)],
    data: `${pad(NEW_PAIR)}${word(40_322n)}`,
  });
  /** $24,000 of USDG deposited — SIX decimals, and USDG is token0 here. */
  const usdgDeposit = log({
    address: NEW_PAIR,
    topics: [TOPICS.v2Mint, pad(WALLET)],
    data: `0x${word(24_000n * 10n ** 6n)}${word(10n ** 27n)}`,
  });

  it('measures the DOLLARS and derives the ETH figure from the ETH price', async () => {
    const chain = fakeChain([usdgPairCreated, usdgDeposit, tokenTransfer]);
    const { db, calls } = makeDb({
      'select:chainCursor': CURSOR_ROW,
      'insert:discoveryEvents': [[{ id: 1 }]],
    });
    await runDiscoveryTick(db, chain);
    expect(rowsOf(find(calls, 'insert:discoveryEvents')[0])[0]).toMatchObject({
      quoteSymbol: 'USDG',
      initialLiquidityUsd: 24_000,
      // $24K at the mocked $4,000/ETH. Read at 18 decimals it would be dust.
      initialLiquidityEth: 6,
    });
  });

  it('is skipped, out loud, when no ETH price can express the ETH floor', async () => {
    vi.mocked(ds.getEthPriceUsd).mockRejectedValue(new Error('down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chain = fakeChain([usdgPairCreated, usdgDeposit, tokenTransfer]);
    const { db, calls } = makeDb({ 'select:chainCursor': CURSOR_ROW });
    await runDiscoveryTick(db, chain);
    expect(find(calls, 'insert:discoveryEvents')).toHaveLength(0);
    expect(warn.mock.calls.flat().join(' ')).toContain(
      `USDG launch ${NEW_TOKEN} skipped — no ETH price to apply the ETH floor`,
    );
    warn.mockRestore();
  });
});

/* ------------------------------------------------- enrichment / lock reads */

const enrichRow = (over: Record<string, unknown> = {}) => ({
  id: 1,
  tokenAddress: NEW_TOKEN,
  poolAddress: NEW_PAIR,
  symbol: 'RABBIT',
  name: 'Rabbit',
  imageUrl: null,
  twitterUrl: 'https://x.com/rabbit',
  websiteUrl: 'https://rabbit.xyz',
  ...over,
});

const dsPair = (over: Record<string, unknown> = {}) =>
  ({
    tokenAddress: NEW_TOKEN,
    pairAddress: NEW_PAIR,
    dexId: 'uniswap-v2-robinhood',
    symbol: 'RABBIT',
    name: 'Rabbit',
    imageUrl: null,
    socials: { twitter: 'https://x.com/rabbit', website: 'https://rabbit.xyz' },
    priceUsd: 1,
    mcapUsd: 23_000,
    liquidityUsd: 22_000,
    vol24Usd: 1_000,
    pairCreatedAt: new Date(),
    ...over,
  }) as unknown as DsPair;

/** The window bounds a WHERE carried, as ms before now. */
const boundsAgoMs = (call: DbCall | undefined): number[] =>
  whereParams(call)
    .filter(
      (p): p is Date | string =>
        p instanceof Date || (typeof p === 'string' && /^\d{4}-\d\d-\d\dT/.test(p)),
    )
    .map((p) => Date.now() - (p instanceof Date ? p.getTime() : Date.parse(p)));

/** Is one of the bounds this many ms old (allowing for the test's own clock)? */
const hasBound = (call: DbCall | undefined, ms: number): boolean =>
  boundsAgoMs(call).some((ago) => Math.abs(ago - ms) < 5_000);

describe('runEnrichment', () => {
  it('leaves a row DexScreener has no pair for unenriched, so the next pass retries', async () => {
    vi.mocked(ds.getBestPairs).mockResolvedValue(new Map());
    const { db, calls } = makeDb({ 'select:discoveryEvents': [[enrichRow()]] });
    expect(await runEnrichment(db)).toBe(0);
    expect(find(calls, 'update:discoveryEvents')).toHaveLength(0);
  });

  it('stamps BOTH enriched_at and data_as_of on the first real read', async () => {
    vi.mocked(ds.getBestPairs).mockResolvedValue(new Map([[NEW_TOKEN, dsPair()]]));
    const { db, calls } = makeDb({ 'select:discoveryEvents': [[enrichRow()]] });
    expect(await runEnrichment(db)).toBe(1);
    const set = find(calls, 'update:discoveryEvents')[0]?.set ?? {};
    expect(set.enrichedAt).toBeInstanceOf(Date);
    expect(set.dataAsOf).toBeInstanceOf(Date);
    expect(set).toMatchObject({ mcapUsd: 23_000, liquidityUsd: 22_000 });
  });
});

describe('findBlockAtTime', () => {
  it('brackets an instant within one window, off a linear estimate plus bisection', async () => {
    const chain = fakeChain([]);
    // A chain running SLOWER than the nominal rate, so the linear seed is wrong
    // by thousands of blocks and the bisection has real work to do.
    chain.blockRate = 8;
    const target = blockSecondsAt(STRIDE_LAUNCH_BLOCK, 8);
    const block = await findBlockAtTime(chain, target, HEAD, nowSeconds());
    expect(block).not.toBeNull();
    // The answer is the LOW end of a bracket at most one window wide that holds
    // the instant — which is what makes the caller's 2 x window query cover it.
    expect(block!).toBeLessThanOrEqual(STRIDE_LAUNCH_BLOCK);
    expect(STRIDE_LAUNCH_BLOCK - block!).toBeLessThanOrEqual(DISCOVERY.launchHuntWindowBlocks);
    expect(chain.timestampReads).toBeLessThanOrEqual(DISCOVERY.launchHuntMaxBlockReads);
  });

  it('costs a couple of reads when the estimate is already right', async () => {
    const chain = fakeChain([]);
    const block = await findBlockAtTime(
      chain,
      blockSecondsAt(STRIDE_LAUNCH_BLOCK),
      HEAD,
      nowSeconds(),
    );
    expect(block).not.toBeNull();
    expect(chain.timestampReads).toBeLessThanOrEqual(3);
  });

  it('gives up rather than hunting forever when the block clock will not converge', async () => {
    const chain = fakeChain([]);
    const frozen = nowSeconds();
    chain.getBlockTimestamp = async () => {
      chain.timestampReads += 1;
      return frozen;
    };
    expect(await findBlockAtTime(chain, frozen - 3_000_000, HEAD, frozen)).toBeNull();
    expect(chain.timestampReads).toBe(DISCOVERY.launchHuntMaxBlockReads);
  });

  it('answers unknown when the node will not serve a block at all', async () => {
    const chain = fakeChain([]);
    chain.getBlockTimestamp = async () => null;
    expect(await findBlockAtTime(chain, nowSeconds() - 600, HEAD, nowSeconds())).toBeNull();
  });
});

describe('runLockReads', () => {
  it('takes only lockReadsPerPass of the eligible rows', async () => {
    vi.mocked(gt.getPool).mockResolvedValue({ lockedLiquidityPct: 100 } as never);
    const rows = [1, 2, 3, 4].map((id) => enrichRow({ id }));
    const { db, calls } = makeDb({ 'select:discoveryEvents': [rows] });
    expect(await runLockReads(db)).toBe(DISCOVERY.lockReadsPerPass);
    expect(vi.mocked(gt.getPool)).toHaveBeenCalledTimes(DISCOVERY.lockReadsPerPass);
    expect(find(calls, 'select:discoveryEvents')[0]?.limit).toBe(DISCOVERY.lockReadsPerPass);
  });

  it('stamps only the ATTEMPT when GeckoTerminal has no pool at all', async () => {
    vi.mocked(gt.getPool).mockResolvedValue(null);
    const { db, calls } = makeDb({ 'select:discoveryEvents': [[enrichRow()]] });
    expect(await runLockReads(db)).toBe(0);
    // The attempt is what rotates an unanswerable pool to the back of the
    // queue; the ANSWER stamp stays untouched so a later pass asks again.
    const updates = find(calls, 'update:discoveryEvents');
    expect(updates).toHaveLength(1);
    expect(Object.keys(updates[0]?.set ?? {})).toEqual(['lockAttemptedAt']);
    expect(updates[0]?.set?.lockAttemptedAt).toBeInstanceOf(Date);
  });

  it('stamps only the attempt when the pool comes back WITHOUT a lock figure', async () => {
    // "Asked and answered" over a question nobody answered would freeze the
    // row's lock as unknown forever.
    vi.mocked(gt.getPool).mockResolvedValue({ lockedLiquidityPct: null } as never);
    const { db, calls } = makeDb({ 'select:discoveryEvents': [[enrichRow()]] });
    expect(await runLockReads(db)).toBe(0);
    const updates = find(calls, 'update:discoveryEvents');
    expect(updates).toHaveLength(1);
    expect(Object.keys(updates[0]?.set ?? {})).toEqual(['lockAttemptedAt']);
  });

  it('stamps the attempt AND the answer when a figure comes back', async () => {
    vi.mocked(gt.getPool).mockResolvedValue({ lockedLiquidityPct: 100 } as never);
    const { db, calls } = makeDb({ 'select:discoveryEvents': [[enrichRow()]] });
    expect(await runLockReads(db)).toBe(1);
    const sets = find(calls, 'update:discoveryEvents').map((c) => c.set ?? {});
    expect(sets).toHaveLength(2);
    expect(Object.keys(sets[0] ?? {})).toEqual(['lockAttemptedAt']);
    expect(sets[1]).toMatchObject({ lpLockedPct: 100 });
    expect(sets[1]?.lockCheckedAt).toBeInstanceOf(Date);
  });

  it('asks only about rows never answered, inside the give-up bound', async () => {
    vi.mocked(gt.getPool).mockResolvedValue(null);
    const { db, calls } = makeDb({ 'select:discoveryEvents': [[enrichRow()]] });
    await runLockReads(db);
    const call = find(calls, 'select:discoveryEvents')[0];
    expect(whereSql(call)).toContain('"lock_checked_at" is null');
    expect(hasBound(call, DISCOVERY.lockGiveUpHours * 3_600_000)).toBe(true);
  });
});

describe('runReEnrichment', () => {
  it('keeps socials the row already has when the pair comes back without them', async () => {
    vi.mocked(ds.getBestPairs).mockResolvedValue(new Map([[NEW_TOKEN, dsPair({ socials: null })]]));
    const { db, calls } = makeDb({ 'select:discoveryEvents': [[enrichRow()]] });
    expect(await runReEnrichment(db)).toBe(1);
    const set = find(calls, 'update:discoveryEvents')[0]?.set ?? {};
    expect(set).toMatchObject({
      twitterUrl: 'https://x.com/rabbit',
      websiteUrl: 'https://rabbit.xyz',
    });
    // A real read, so the age the board prints moves.
    expect(set.dataAsOf).toBeInstanceOf(Date);
    expect(set.refreshAttemptedAt).toBeInstanceOf(Date);
  });

  it('records the ATTEMPT on a no-pair row so it rotates to the back of the queue', async () => {
    vi.mocked(ds.getBestPairs).mockResolvedValue(new Map());
    const { db, calls } = makeDb({ 'select:discoveryEvents': [[enrichRow()]] });
    expect(await runReEnrichment(db)).toBe(0);
    const set = find(calls, 'update:discoveryEvents')[0]?.set ?? {};
    expect(Object.keys(set)).toEqual(['refreshAttemptedAt']);
    expect(set.refreshAttemptedAt).toBeInstanceOf(Date);
  });

  it('asks for young rows whose figures are stale, enrichPerPass at a time', async () => {
    vi.mocked(ds.getBestPairs).mockResolvedValue(new Map());
    const { db, calls } = makeDb({ 'select:discoveryEvents': [[]] });
    await runReEnrichment(db);
    const call = find(calls, 'select:discoveryEvents')[0];
    expect(hasBound(call, DISCOVERY.reenrichWithinHours * 3_600_000)).toBe(true);
    expect(hasBound(call, DISCOVERY.reenrichMinutes * 60_000)).toBe(true);
    expect(call?.limit).toBe(DISCOVERY.enrichPerPass);
  });
});

/* ------------------------------------------------------------ the CU meter */

describe('RequestMeter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('weights each method, because the free tier is denominated in CU', () => {
    const meter = new RequestMeter();
    meter.note('eth_getLogs');
    meter.note('eth_getLogs');
    meter.note('eth_call');
    expect(meter.snapshot().totalCu).toBe(2 * METHOD_CU.eth_getLogs! + METHOD_CU.eth_call!);
    expect(meter.snapshot().totalCu).toBe(176);
    expect(meter.snapshot().total).toBe(3);
  });

  it('prices an unlisted method at the fallback rather than at nothing', () => {
    const meter = new RequestMeter();
    meter.note('eth_someMethodNobodyPriced');
    expect(meter.snapshot().totalCu).toBe(16);
  });

  it('logs the hourly line once an hour, in CU and in requests', () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const meter = new RequestMeter();
    meter.note('eth_getLogs');
    expect(log).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3_600_000);
    meter.note('eth_blockNumber');
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toMatch(
      /^chain client: \d+ CU\/hour \(\d+ requests\)$/,
    );
    log.mockRestore();
  });
});

/* ------------------------------------------- the provider's log-range cap */

/**
 * 2026-09-02 10:47Z, the first tick after the key was set: every `eth_getLogs`
 * came back HTTP 400 with THIS body, the listener failed every 20s and the
 * cursor froze. The text is the production one, character for character —
 * including the suggested range, which is how the client learns the cap.
 */
const FREE_TIER_ERROR = {
  code: -32600,
  message:
    'Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range. ' +
    'Based on your parameters, this block range should work: [0x3214ec9, 0x3214ed2]. ' +
    'Upgrade to PAYG for expanded block range.',
};

/** ...and a provider that refuses without saying what it would have served. */
const MUTE_RANGE_ERROR = { code: -32602, message: 'block range is too large' };

/** An API-keyed RPC URL: the string that must never reach a log line. */
const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/alch_SECRET';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const rpcLog = (block: number) => ({
  address: WETH,
  topics: [TOPICS.transfer],
  data: '0x',
  blockNumber: `0x${block.toString(16)}`,
  transactionHash: `0x${block.toString(16).padStart(64, '0')}`,
  logIndex: '0x0',
});

interface SeenSpan {
  fromBlock: number | 'earliest';
  toBlock: number;
}

describe('eth_getLogs adaptive block range', () => {
  const realFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;
  let spans: SeenSpan[];

  /**
   * A provider that serves at most `cap` blocks per query and answers anything
   * wider with `error` at HTTP 400 — the exact shape viem turns into an
   * `HttpRequestError` whose provider text lives in `details`.
   */
  const provider = (cap: number, error: unknown) => {
    spans = [];
    fetchMock = vi.fn(async (_url: unknown, init: { body: string }) => {
      const params = JSON.parse(init.body).params[0] as {
        fromBlock: string;
        toBlock: string;
      };
      const from = params.fromBlock === 'earliest' ? 'earliest' : Number(params.fromBlock);
      const to = Number(params.toBlock);
      spans.push({ fromBlock: from, toBlock: to });
      if (from === 'earliest' || to - from + 1 > cap) return jsonResponse({ error }, 400);
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: [rpcLog(from)] });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return createChainClient(RPC_URL)!;
  };

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('learns the suggested range from the refusal and re-issues the query in chunks', async () => {
    const client = provider(10, FREE_TIER_ERROR);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logs = await client.getLogs({ address: WETH, fromBlock: 100, toBlock: 129 });
    // The wide query, refused; then the same 30 blocks as consecutive 10-block
    // chunks, in order, with nothing skipped and nothing overlapping.
    expect(spans).toEqual([
      { fromBlock: 100, toBlock: 129 },
      { fromBlock: 100, toBlock: 109 },
      { fromBlock: 110, toBlock: 119 },
      { fromBlock: 120, toBlock: 129 },
    ]);
    // ...and the caller gets ONE concatenated answer, in block order.
    expect(logs.map((entry) => entry.blockNumber)).toEqual([100, 110, 120]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toBe(
      'chain client: provider caps eth_getLogs at 10 blocks per query',
    );
    log.mockRestore();
  });

  it('halves the chunk when the provider refuses without suggesting a range', async () => {
    const client = provider(10, MUTE_RANGE_ERROR);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await client.getLogs({ address: WETH, fromBlock: 100, toBlock: 131 });
    expect(spans).toEqual([
      { fromBlock: 100, toBlock: 131 }, // 32 blocks, refused
      { fromBlock: 100, toBlock: 115 }, // halved to 16, refused
      { fromBlock: 100, toBlock: 109 }, // floor of 10: served
      { fromBlock: 110, toBlock: 119 },
      { fromBlock: 120, toBlock: 129 },
      { fromBlock: 130, toBlock: 131 },
    ]);
    expect(log.mock.calls.flat().map(String)).toEqual([
      'chain client: provider caps eth_getLogs at 16 blocks per query',
      'chain client: provider caps eth_getLogs at 10 blocks per query',
    ]);
    log.mockRestore();
  });

  it('sends a query that already fits the learned cap exactly once', async () => {
    const client = provider(10, FREE_TIER_ERROR);
    await client.getLogs({ address: WETH, fromBlock: 100, toBlock: 129 });
    spans = [];
    await client.getLogs({ address: WETH, fromBlock: 200, toBlock: 205 });
    expect(spans).toEqual([{ fromBlock: 200, toBlock: 205 }]);
  });

  it('refuses a range that would need more than maxLogChunksPerQuery chunks', async () => {
    const client = provider(10, FREE_TIER_ERROR);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await client.getLogs({ address: WETH, fromBlock: 100, toBlock: 129 });
    log.mockRestore();
    const before = fetchMock.mock.calls.length;
    const wide = client.getLogs({ address: WETH, fromBlock: 1_000, toBlock: 1_499 });
    await expect(wide).rejects.toThrow(/500 block\(s\)/);
    await expect(wide).rejects.toThrow(
      new RegExp(`${DISCOVERY.maxLogChunksPerQuery}-chunk cap`),
    );
    // Nothing was spent and nothing was read: the caller isolates this, the
    // cursor stays put, and the same range is attempted again next tick.
    expect(fetchMock.mock.calls.length).toBe(before);
    // TYPED, and carrying the ceiling the tick re-plans against — but with no
    // RPC code and no provider text, so nothing mistakes it for a range refusal
    // worth retrying narrower or for a throughput refusal worth backing off.
    const err = await wide.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LogRangeTooWideError);
    expect(err).toMatchObject({
      span: 500,
      ceiling: 10,
      chunks: 50,
      cap: DISCOVERY.maxLogChunksPerQuery,
    });
    expect(logRangeRefusal(err)).toBeNull();
    expect(isThrottled(err)).toBe(false);
  });

  it('never chunks an `earliest` hunt', async () => {
    const client = provider(10, FREE_TIER_ERROR);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await client.getLogs({ address: WETH, fromBlock: 100, toBlock: 129 });
    log.mockRestore();
    spans = [];
    const hunt = client.getLogs({
      address: PONS_V2_FACTORY,
      topics: [TOPICS.tokenLaunched],
      fromBlock: 'earliest',
      toBlock: 5_000,
    });
    await expect(hunt).rejects.toThrow();
    // ONE attempt, unbounded, straight to the caller's own refusal path
    // (findTokenLaunch retries it over a bounded window).
    expect(spans).toEqual([{ fromBlock: 'earliest', toBlock: 5_000 }]);
    expect(logRangeRefusal(await hunt.catch((e: unknown) => e))).not.toBeNull();
  });

  it('PACES the chunks: N-1 gaps for N chunks, nothing before the first', async () => {
    // The other half of the 2026-09-02 incident: the tier that caps the range
    // also caps compute units per second, and 20 back-to-back chunks a tick
    // drew "exceeded its compute units per second capacity" every 20 seconds.
    vi.useFakeTimers();
    const client = provider(10, FREE_TIER_ERROR);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const query = client.getLogs({ address: WETH, fromBlock: 100, toBlock: 129 });
    await vi.advanceTimersByTimeAsync(5_000);
    await query;
    const gaps = timers.mock.calls.filter((call) => call[1] === DISCOVERY.logChunkGapMs);
    expect(gaps).toHaveLength(2);
    expect(spans).toHaveLength(4);
    timers.mockRestore();
    log.mockRestore();
    vi.useRealTimers();
  });

  it('reads the cap off the provider text, never off viem message', () => {
    expect(logRangeRefusal({ details: JSON.stringify(FREE_TIER_ERROR) })).toEqual({
      suggested: 10,
    });
    expect(logRangeRefusal({ code: -32602, details: 'block range is too large' })).toEqual({
      suggested: null,
    });
    expect(logRangeRefusal({ cause: { code: -32600, details: 'block range too wide' } })).toEqual({
      suggested: null,
    });
    // A 429 whose request body happens to name a range is not a range refusal.
    expect(
      logRangeRefusal(
        Object.assign(
          new Error(
            'HTTP request failed.\n\nRequest body: {"params":[{"fromBlock":"0x1","toBlock":"0x2"}]} block range',
          ),
          { details: 'Too Many Requests', status: 429 },
        ),
      ),
    ).toBeNull();
    expect(logRangeRefusal({ details: 'unauthorized' })).toBeNull();
    expect(logRangeRefusal(null)).toBeNull();
  });
});

/* --------------------------------------------------------- no keys in logs */

/** viem's HttpRequestError, exactly as it carries the API-keyed URL around. */
const keyedTransportError = () =>
  Object.assign(
    new Error(
      `HTTP request failed.\n\nStatus: 400\nURL: ${RPC_URL}\n` +
        'Request body: {"method":"eth_getLogs","params":[{"fromBlock":"0x3214ec9"}]}',
    ),
    {
      name: 'HttpRequestError',
      status: 400,
      shortMessage: 'HTTP request failed.',
      details: JSON.stringify(FREE_TIER_ERROR),
      metaMessages: ['Status: 400', `URL: ${RPC_URL}`, 'Request body: {"method":"eth_getLogs"}'],
      url: RPC_URL,
    },
  );

describe('summarizeRpcError', () => {
  it('keeps the status and the provider text, and drops the keyed URL', () => {
    const summary = summarizeRpcError(keyedTransportError());
    expect(summary).not.toContain('alch_SECRET');
    expect(summary).not.toMatch(/https?:\/\//);
    expect(summary).not.toContain('Request body');
    expect(summary).toContain('HttpRequestError');
    expect(summary).toContain('status=400');
    expect(summary).toContain('Under the Free tier plan');
  });

  it('still says something useful about an error that is not viem-shaped', () => {
    expect(summarizeRpcError(new Error('connection terminated'))).toContain(
      'connection terminated',
    );
    expect(summarizeRpcError(null)).toBe('unknown error');
  });
});

/* ------------------------------------------------------------- dormancy */

describe('dormant without a key', () => {
  it('builds no client at all', () => {
    expect(createChainClient(null)).toBeNull();
  });

  it('reads the RPC URL off the key, and lets an explicit URL win', () => {
    expect(chainRpcUrl({ alchemyApiKey: null, alchemyRpcUrl: null })).toBeNull();
    expect(chainRpcUrl({ alchemyApiKey: 'abc123', alchemyRpcUrl: null })).toBe(
      'https://robinhood-mainnet.g.alchemy.com/v2/abc123',
    );
    expect(chainRpcUrl({ alchemyApiKey: 'abc123', alchemyRpcUrl: 'http://localhost:8545' })).toBe(
      'http://localhost:8545',
    );
  });

  it('starts no timer, and hands back a handle that says it is not running', () => {
    const { db, calls } = makeDb();
    const timers = vi.spyOn(globalThis, 'setInterval');
    const handle = startDiscovery(db, null);
    expect(timers).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    // The board reads this as `enabled`, so it has to be the honest answer.
    expect(handle.running).toBe(false);
    expect(() => handle.stop()).not.toThrow();
    timers.mockRestore();
  });

  it('logs a failed tick as one redacted line, never the error object', async () => {
    vi.useFakeTimers();
    const chain = fakeChain([]);
    const failure = keyedTransportError();
    chain.getBlockNumber = async () => {
      throw failure;
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { db } = makeDb({ 'select:chainCursor': CURSOR_ROW });
    const handle = startDiscovery(db, chain);
    await vi.advanceTimersByTimeAsync(DISCOVERY.pollIntervalMs);
    handle.stop();
    const line = errors.mock.calls.flat().map(String).join(' ');
    expect(line).toContain('discovery tick failed');
    expect(line).toContain('status=400');
    // The one thing this line must never carry: the RPC url, which is the key.
    expect(line).not.toContain('alch_SECRET');
    expect(line).not.toMatch(/https?:\/\//);
    // ...and it is a STRING, not the error object a console would expand.
    expect(errors.mock.calls[0]).toHaveLength(1);
    errors.mockRestore();
    logs.mockRestore();
    vi.useRealTimers();
  });

  it('runs TWO separate loops when a client exists, so neither can stall the other', () => {
    const { db } = makeDb();
    const timers = vi.spyOn(globalThis, 'setInterval').mockReturnValue(0 as never);
    const handle = startDiscovery(db, fakeChain([]));
    expect(timers).toHaveBeenCalledTimes(2);
    expect(timers.mock.calls.map((c) => c[1])).toEqual([
      DISCOVERY.pollIntervalMs,
      DISCOVERY.enrichIntervalMs,
    ]);
    expect(handle.running).toBe(true);
    handle.stop();
    expect(handle.running).toBe(false);
    timers.mockRestore();
  });
});

/* ------------------------------------------------------ the 429 back-off */

/**
 * Alchemy's free tier answered every 20s tick with "Your app has exceeded its
 * compute units per second capacity" on 2026-09-02. Retrying at the poll cadence
 * spends the budget on more 429s and keeps the provider's meter pinned, so the
 * chain loop stops asking for a while — and doubles the wait each time it is
 * refused again.
 */
describe('provider throttling', () => {
  const throttled = () =>
    Object.assign(new Error('HTTP request failed.'), {
      name: 'HttpRequestError',
      status: 429,
      shortMessage: 'HTTP request failed.',
      details:
        '{"code":429,"message":"Your app has exceeded its compute units per second capacity."}',
    });

  /** The pause a warn line announced, in seconds. */
  const pausedSeconds = (warn: { mock: { calls: unknown[][] } }): number[] =>
    warn.mock.calls
      .flat()
      .map(String)
      .filter((line) => line.includes('provider throttled'))
      .map((line) => Number(/for (\d+)s$/.exec(line)?.[1] ?? -1));

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads 429 off status/code — on the error or its cause — and never off the message', () => {
    expect(isThrottled(throttled())).toBe(true);
    expect(isThrottled({ code: 429 })).toBe(true);
    expect(isThrottled({ cause: { status: 429 } })).toBe(true);
    expect(isThrottled({ cause: { code: '429' } })).toBe(true);
    expect(isThrottled({ status: 400 })).toBe(false);
    // viem prints the request body into `message`; a range of 429 blocks is not
    // a rate limit.
    expect(isThrottled(new Error('range of 429 block(s)'))).toBe(false);
    expect(isThrottled(null)).toBe(false);
  });

  it('pauses the chain loop, says so ONCE, and leaves the heartbeat alone', async () => {
    vi.useFakeTimers();
    const chain = fakeChain([]);
    let failing = true;
    chain.getBlockNumber = async () => {
      if (failing) throw throttled();
      return HEAD;
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { db, calls } = makeDb({ 'select:chainCursor': [[{ lastBlock: SAFE_HEAD }]] });
    const handle = startDiscovery(db, chain);

    await vi.advanceTimersByTimeAsync(DISCOVERY.pollIntervalMs);
    expect(pausedSeconds(warn)).toEqual([DISCOVERY.throttleBackoffMs / 1000]);

    // Every tick inside the pause is skipped in SILENCE, and nothing stamps the
    // cursor: a paused listener reads as stalled on the board, which is honest.
    failing = false;
    await vi.advanceTimersByTimeAsync(DISCOVERY.pollIntervalMs * 2);
    expect(pausedSeconds(warn)).toHaveLength(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(find(calls, 'update:chainCursor')).toHaveLength(0);

    // ...and once the pause elapses, a good tick clears the back-off.
    await vi.advanceTimersByTimeAsync(DISCOVERY.throttleBackoffMs);
    expect(find(calls, 'update:chainCursor').length).toBeGreaterThan(0);
    handle.stop();
    warn.mockRestore();
    error.mockRestore();
    log.mockRestore();
  });

  it('doubles the pause on each further 429, up to the ceiling', async () => {
    vi.useFakeTimers();
    const chain = fakeChain([]);
    chain.getBlockNumber = async () => {
      throw throttled();
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { db } = makeDb({ 'select:chainCursor': [[{ lastBlock: SAFE_HEAD }]] });
    const handle = startDiscovery(db, chain);
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(DISCOVERY.throttleBackoffMaxMs);
    }
    handle.stop();
    const seconds = pausedSeconds(warn);
    expect(seconds.slice(0, 5)).toEqual([60, 120, 240, 480, 600]);
    for (const value of seconds) {
      expect(value).toBeLessThanOrEqual(DISCOVERY.throttleBackoffMaxMs / 1000);
    }
    warn.mockRestore();
    error.mockRestore();
    log.mockRestore();
  });

  it('does NOT pause on a failure that is not a throughput refusal', async () => {
    vi.useFakeTimers();
    const chain = fakeChain([]);
    chain.getBlockNumber = async () => {
      throw Object.assign(new Error('upstream exploded'), { status: 500 });
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { db } = makeDb({ 'select:chainCursor': [[{ lastBlock: SAFE_HEAD }]] });
    const handle = startDiscovery(db, chain);
    await vi.advanceTimersByTimeAsync(DISCOVERY.pollIntervalMs * 3);
    handle.stop();
    // Three ticks, three failures, no pause: a 500 is worth retrying at once.
    expect(error).toHaveBeenCalledTimes(3);
    expect(pausedSeconds(warn)).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
    log.mockRestore();
  });

  /* ------------------------------------------------- and a rejected key */

  /**
   * Round 21: a revoked, mistyped or over-quota KEY answers every 20-second
   * tick identically, so it takes the same back-off — the failure the next tick
   * cannot fix is the shape, not the status code. The wording is what separates
   * them: one is waited out, the other is fixed in the Railway variables.
   */
  const rejected = (status: number) =>
    Object.assign(new Error('HTTP request failed.'), {
      name: 'HttpRequestError',
      status,
      shortMessage: 'HTTP request failed.',
    });

  const pauseLines = (warn: { mock: { calls: unknown[][] } }): string[] =>
    warn.mock.calls
      .flat()
      .map(String)
      .filter((line) => line.includes('pausing chain ticks'));

  it('pauses on an auth refusal too, and names the cause', () => {
    expect(shouldPauseTicks(rejected(401))).toBe(true);
    expect(shouldPauseTicks(rejected(403))).toBe(true);
    expect(shouldPauseTicks(throttled())).toBe(true);
    // Read off status/code on the error and its cause, exactly like isThrottled.
    expect(shouldPauseTicks({ code: 401 })).toBe(true);
    expect(shouldPauseTicks({ cause: { status: '403' } })).toBe(true);
    // Everything the next tick might fix keeps its cadence.
    expect(shouldPauseTicks(rejected(500))).toBe(false);
    expect(shouldPauseTicks({ status: 400 })).toBe(false);
    expect(shouldPauseTicks(new Error('range of 401 block(s)'))).toBe(false);
    expect(shouldPauseTicks(null)).toBe(false);
    // ...and an auth refusal is NOT a throttle: the two answers stay distinct.
    expect(isThrottled(rejected(401))).toBe(false);
  });

  it('a 401 pauses the chain loop on the same doubling schedule', async () => {
    vi.useFakeTimers();
    const chain = fakeChain([]);
    chain.getBlockNumber = async () => {
      throw rejected(401);
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { db, calls } = makeDb({ 'select:chainCursor': [[{ lastBlock: SAFE_HEAD }]] });
    const handle = startDiscovery(db, chain);

    await vi.advanceTimersByTimeAsync(DISCOVERY.pollIntervalMs);
    expect(pauseLines(warn)).toEqual([
      `discovery: provider rejected the key (401), pausing chain ticks for ${
        DISCOVERY.throttleBackoffMs / 1000
      }s`,
    ]);
    // A key that answers 429 is a different sentence, and this is not it.
    expect(pausedSeconds(warn)).toHaveLength(0);
    // Silent inside the pause, and nothing stamps the cursor — a paused
    // listener reads as stalled on the board, which is honest.
    await vi.advanceTimersByTimeAsync(DISCOVERY.pollIntervalMs * 2);
    expect(pauseLines(warn)).toHaveLength(1);
    expect(find(calls, 'update:chainCursor')).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(DISCOVERY.throttleBackoffMs);
    expect(pauseLines(warn)).toHaveLength(2);
    expect(pauseLines(warn)[1]).toContain(`for ${(DISCOVERY.throttleBackoffMs * 2) / 1000}s`);
    handle.stop();
    warn.mockRestore();
    error.mockRestore();
    log.mockRestore();
  });

  it('a 403 says the same thing with its own code', async () => {
    vi.useFakeTimers();
    const chain = fakeChain([]);
    chain.getBlockNumber = async () => {
      throw rejected(403);
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { db } = makeDb({ 'select:chainCursor': [[{ lastBlock: SAFE_HEAD }]] });
    const handle = startDiscovery(db, chain);
    await vi.advanceTimersByTimeAsync(DISCOVERY.pollIntervalMs);
    handle.stop();
    expect(pauseLines(warn)[0]).toContain('provider rejected the key (403)');
    warn.mockRestore();
    error.mockRestore();
    log.mockRestore();
  });
});
