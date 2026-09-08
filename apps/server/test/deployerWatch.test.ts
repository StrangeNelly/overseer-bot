import { describe, expect, it, vi } from 'vitest';
import { type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { deployerWatches, groups, tokens, type Db } from '@groupie/db';
import { DEPLOYER_WATCH, DISCOVERY } from '@groupie/shared';
import {
  PONS_GRADUATION_HOOK,
  PONS_V2_FACTORY,
  TOPICS,
  UNISWAP_V2_FACTORY,
  UNISWAP_V4_POOL_MANAGER,
} from '../src/chain/addresses.js';
import type { ChainClient, ChainLog, LogQuery } from '../src/chain/client.js';
import {
  activeWatches,
  attributePools,
  catchUpPonsLaunches,
  hasCode,
  matchPonsLaunches,
  newDeployerTickBudget,
  publishedToken,
  recordHit,
  runDeployerWatchPass,
  scanCreates,
  scanRegistries,
  undeliveredHits,
  type DeployerWatchRow,
} from '../src/discovery/deployerWatch.js';
import { routeRangeLogs } from '../src/discovery/scan.js';

/**
 * The deployer watch (docs/decisions.md round 26), against a fake chain and a
 * scripted database.
 *
 * What is pinned here is everything that would be a WRONG MESSAGE IN A CHAT
 * ROOM if it drifted: that the PONS deployer is read out of topics[3] and not
 * out of the curve's topic, that a wallet added today is never scanned back
 * through its history, that an unreadable answer is unknown rather than a
 * match, and that two roads to one launch fire exactly once.
 */

const dialect = new PgDialect();

/* -------------------------------------------------------------- fixtures */

/**
 * The motivating case, verified on chain 2026-09-08: EOA 0x9c5c…074a deployed
 * the @clubytech registry at its own nonce 163, and viem's CREATE prediction
 * reproduces that address exactly. Hardcoded on BOTH sides on purpose — a test
 * that predicted the address with the same call the code makes would pass even
 * if the prediction were wrong.
 */
const DEPLOYER_EOA = '0x9c5c4b4a985b0a60a1067a0d82020774661d074a';
const REGISTRY = '0xd0a32d0ba6efa91b2637af14fd1580fe3ddb337a';
const REGISTRY_NONCE = 163;

const TOKEN = '0x8fcf98e1348d3ddee46cdd15a5c7d9a8d423077d';
const CURVE = '0x7b2864c490875f64ec2666d7055074c1c9e182af';
const OTHER_WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const POOL = '0x887c2718bfc9133ce881c09f0df18ba572189236';

const pad = (address: string) => `0x000000000000000000000000${address.slice(2)}`;
const word = (value: bigint) => value.toString(16).padStart(64, '0');

function log(over: Partial<ChainLog> & Pick<ChainLog, 'address' | 'topics'>): ChainLog {
  return {
    data: '0x',
    blockNumber: 52_223_000,
    transactionHash: '0xtx1',
    logIndex: 0,
    ...over,
  };
}

/**
 * A live-shaped `TokenLaunched`: topics[1]=token, topics[2]=curve,
 * topics[3]=DEPLOYER (verified against live launches, 2026-09-08).
 */
const tokenLaunched = log({
  address: PONS_V2_FACTORY,
  topics: [TOPICS.tokenLaunched, pad(TOKEN), pad(CURVE), pad(DEPLOYER_EOA)],
  data: `0x${word(0n)}${word(1n)}${word(2n)}`,
  transactionHash: '0xlaunch',
});

function watchRow(over: Partial<DeployerWatchRow> = {}): DeployerWatchRow {
  return {
    id: 1,
    groupId: 2,
    address: DEPLOYER_EOA,
    kind: 'eoa',
    addedBy: 144913755,
    addedAt: new Date('2026-09-08T00:00:00Z'),
    note: null,
    status: 'active',
    lastNonce: REGISTRY_NONCE,
    nonceCheckedAt: null,
    firedAddress: null,
    firedTokenId: null,
    firedAt: null,
    firedVia: null,
    firedTxHash: null,
    notifiedAt: null,
    ...over,
  };
}

/* ------------------------------------------------------------ fake chain */

interface FakeChain extends ChainClient {
  queries: LogQuery[];
  /** Addresses `eth_getCode` was asked about, in order. */
  codeReads: string[];
  /** Transactions `eth_getTransactionByHash` was asked about, in order. */
  senderReads: string[];
  /** Addresses whose nonce was read. */
  nonceReads: string[];
  /** Bytecode per address; anything absent answers '0x' (nothing deployed). */
  code: Map<string, string | null>;
  /** Sender per transaction hash; absent = the node would not say. */
  senders: Map<string, string | null>;
  nonce: number | null;
}

function fakeChain(logs: ChainLog[] = []): FakeChain {
  const matches = (entry: ChainLog, query: LogQuery): boolean => {
    const addresses =
      query.address === undefined
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
  const chain: FakeChain = {
    queries: [],
    codeReads: [],
    senderReads: [],
    nonceReads: [],
    code: new Map(),
    senders: new Map(),
    nonce: null,
    getBlockNumber: async () => 52_223_427,
    getBlockTimestamp: async () => 1_800_000_000,
    getLogs: async (query) => {
      chain.queries.push(query);
      return logs.filter((entry) => matches(entry, query));
    },
    call: async () => null,
    getCode: async (address) => {
      chain.codeReads.push(address.toLowerCase());
      const answer = chain.code.get(address.toLowerCase());
      return answer === undefined ? '0x' : answer;
    },
    getTransactionSender: async (txHash) => {
      chain.senderReads.push(txHash.toLowerCase());
      return chain.senders.get(txHash.toLowerCase()) ?? null;
    },
    getTransactionCount: async (address) => {
      chain.nonceReads.push(address.toLowerCase());
      return chain.nonce;
    },
    getTransactionValue: async () => null,
    getTransactionLogs: async () => null,
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
    if (table === deployerWatches) return 'deployerWatches';
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
            if (rows[0] instanceof Error) throw rows[0];
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
/**
 * The nonce a stamp wrote. It arrives as a `greatest(coalesce(...), N)`
 * expression — the mark may only move forward — so the number is the
 * expression's last bound parameter.
 */
const nonceOf = (call: DbCall | undefined): unknown => {
  const value = call?.set?.lastNonce;
  if (value === undefined || value === null || typeof value !== 'object') return value;
  const params = dialect.sqlToQuery(value as SQL).params as unknown[];
  return params[params.length - 1];
};

/* ------------------------------------------------------------------ tests */

describe('matchPonsLaunches', () => {
  it('reads the deployer out of topics[3], not the curve or the token', () => {
    const hits = matchPonsLaunches([watchRow()], [tokenLaunched]);
    expect(hits).toEqual([
      {
        watchId: 1,
        groupId: 2,
        addedBy: 144913755,
        watchedAddress: DEPLOYER_EOA,
        tokenAddress: TOKEN,
        via: 'pons',
        txHash: '0xlaunch',
      },
    ]);
  });

  it('does not match the curve address that sits in topics[2]', () => {
    expect(matchPonsLaunches([watchRow({ address: CURVE })], [tokenLaunched])).toEqual([]);
  });

  it('says nothing about a launch by somebody else', () => {
    expect(matchPonsLaunches([watchRow({ address: OTHER_WALLET })], [tokenLaunched])).toEqual([]);
  });

  it('matches case-insensitively — a member pastes a checksummed address', () => {
    const checksummed = `0x${DEPLOYER_EOA.slice(2).toUpperCase()}`;
    const hits = matchPonsLaunches([watchRow({ address: checksummed })], [tokenLaunched]);
    expect(hits).toHaveLength(1);
    // ...and the hit reports the address in the lowercase the chain speaks.
    expect(hits[0]?.watchedAddress).toBe(DEPLOYER_EOA);
  });

  it('skips a half-decoded log rather than guessing who launched it', () => {
    const truncated = log({
      address: PONS_V2_FACTORY,
      topics: [TOPICS.tokenLaunched, pad(TOKEN)],
    });
    expect(matchPonsLaunches([watchRow()], [truncated])).toEqual([]);
  });

  it('matches a watched CONTRACT deploying through PONS as readily as a wallet', () => {
    const hits = matchPonsLaunches(
      [watchRow({ address: DEPLOYER_EOA, kind: 'contract' })],
      [tokenLaunched],
    );
    expect(hits).toHaveLength(1);
  });
});

describe('routeRangeLogs', () => {
  const pairCreated = log({
    address: UNISWAP_V2_FACTORY,
    topics: [TOPICS.pairCreated, pad(TOKEN), pad(POOL)],
  });
  const initialize = log({
    address: UNISWAP_V4_POOL_MANAGER,
    topics: [TOPICS.initialize, `0x${'11'.repeat(32)}`],
  });
  const graduated = log({
    address: PONS_V2_FACTORY,
    topics: [TOPICS.poolGraduated, pad(TOKEN)],
  });
  const registered = log({
    address: PONS_GRADUATION_HOOK,
    topics: [TOPICS.poolRegistered, `0x${'22'.repeat(32)}`],
  });

  it('still splits the four pre-existing streams exactly as before', () => {
    const routed = routeRangeLogs([pairCreated, initialize, graduated, registered, tokenLaunched]);
    expect(routed.pairLogs).toEqual([pairCreated]);
    expect(routed.initLogs).toEqual([initialize]);
    expect(routed.gradLogs).toEqual([graduated]);
    expect(routed.registerLogs).toEqual([registered]);
  });

  it('buckets TokenLaunched, and never into one of the four', () => {
    const routed = routeRangeLogs([tokenLaunched]);
    expect(routed.launchedLogs).toEqual([tokenLaunched]);
    expect(routed.pairLogs).toEqual([]);
    expect(routed.initLogs).toEqual([]);
    expect(routed.gradLogs).toEqual([]);
    expect(routed.registerLogs).toEqual([]);
  });

  it('will not read a TokenLaunched emitted by somebody other than the factory', () => {
    const impostor = { ...tokenLaunched, address: OTHER_WALLET };
    expect(routeRangeLogs([impostor]).launchedLogs).toEqual([]);
  });
});

describe('scanCreates', () => {
  it('stamps a null high-water mark and probes NOTHING — never scans history', async () => {
    const chain = fakeChain();
    chain.nonce = 200;
    chain.code.set(REGISTRY, '0x60806040');
    const { db, calls } = makeDb();

    const hits = await scanCreates(db, chain, [watchRow({ lastNonce: null })]);

    expect(hits).toEqual([]);
    expect(chain.codeReads).toEqual([]);
    expect(nonceOf(find(calls, 'update:deployerWatches')[0])).toBe(200);
  });

  it('finds a contract deployed at the CREATE address predicted from the nonce', async () => {
    const chain = fakeChain();
    chain.nonce = REGISTRY_NONCE + 1;
    chain.code.set(REGISTRY, '0x60806040');
    const { db, calls } = makeDb();

    const hits = await scanCreates(db, chain, [watchRow({ lastNonce: REGISTRY_NONCE })]);

    // The verified datum: nonce 163 of 0x9c5c…074a IS the @clubytech registry.
    expect(chain.codeReads).toEqual([REGISTRY]);
    expect(hits).toEqual([
      {
        watchId: 1,
        groupId: 2,
        addedBy: 144913755,
        watchedAddress: DEPLOYER_EOA,
        tokenAddress: REGISTRY,
        via: 'create',
        txHash: null,
      },
    ]);
    expect(nonceOf(find(calls, 'update:deployerWatches')[0])).toBe(REGISTRY_NONCE + 1);
  });

  it('never probes below the mark, and reports nothing for a plain transfer', async () => {
    const chain = fakeChain();
    chain.nonce = REGISTRY_NONCE + 1;
    // The wallet's whole history is contract-shaped; only the unused nonce is
    // probed, and that one deployed nothing.
    chain.code.set(REGISTRY, '0x');
    const { db } = makeDb();

    const hits = await scanCreates(db, chain, [watchRow({ lastNonce: REGISTRY_NONCE })]);

    expect(hits).toEqual([]);
    expect(chain.codeReads).toEqual([REGISTRY]);
  });

  it('caps the walk per tick and carries the remainder to the next one', async () => {
    const chain = fakeChain();
    chain.nonce = 300;
    const { db, calls } = makeDb();

    await scanCreates(db, chain, [watchRow({ lastNonce: 100 })]);

    expect(chain.codeReads).toHaveLength(DEPLOYER_WATCH.createScanPerTick);
    // The mark advances only over what was probed: the rest is next tick's.
    expect(nonceOf(find(calls, 'update:deployerWatches')[0])).toBe(
      100 + DEPLOYER_WATCH.createScanPerTick,
    );
  });

  it('leaves the mark UNDER a nonce whose code could not be read', async () => {
    const chain = fakeChain();
    chain.nonce = 300;
    const { db, calls } = makeDb();
    let reads = 0;
    chain.getCode = async (address) => {
      chain.codeReads.push(address.toLowerCase());
      reads += 1;
      // The third probe is a node that would not answer: unknown, so the walk
      // stops with the mark below it rather than stepping over a deployment.
      return reads === 3 ? null : '0x';
    };

    await scanCreates(db, chain, [watchRow({ lastNonce: 100 })]);

    expect(chain.codeReads).toHaveLength(3);
    expect(nonceOf(find(calls, 'update:deployerWatches')[0])).toBe(102);
  });

  it('re-reads a nonce at most once per nonceCheckSeconds', async () => {
    const chain = fakeChain();
    chain.nonce = 300;
    const { db } = makeDb();

    await scanCreates(db, chain, [watchRow({ nonceCheckedAt: new Date() })]);

    expect(chain.nonceReads).toEqual([]);
    expect(chain.codeReads).toEqual([]);
  });

  it('skips contract watches and does nothing without the reads it needs', async () => {
    const chain = fakeChain();
    chain.nonce = 300;
    const { db } = makeDb();
    expect(await scanCreates(db, chain, [watchRow({ kind: 'contract' })])).toEqual([]);
    expect(chain.nonceReads).toEqual([]);

    const blind = fakeChain();
    blind.nonce = 300;
    delete (blind as { getCode?: unknown }).getCode;
    // No way to confirm a prediction: no scan, and NO mark stamped either — a
    // mark taken here would skip everything deployed in between.
    const second = makeDb();
    expect(await scanCreates(second.db, blind, [watchRow({ lastNonce: 100 })])).toEqual([]);
    expect(find(second.calls, 'update:deployerWatches')).toHaveLength(0);
  });
});

describe('attributePools', () => {
  const launchRow = { kind: 'launch' as const, tokenAddress: TOKEN, txHash: '0xpooltx' };

  it('matches the SENDER of the pool-creating transaction', async () => {
    const chain = fakeChain();
    chain.senders.set('0xpooltx', DEPLOYER_EOA);
    const { db } = makeDb();

    const hits = await attributePools(db, chain, [watchRow()], [launchRow]);

    expect(hits).toEqual([
      {
        watchId: 1,
        groupId: 2,
        addedBy: 144913755,
        watchedAddress: DEPLOYER_EOA,
        tokenAddress: TOKEN,
        via: 'pool',
        txHash: '0xpooltx',
      },
    ]);
  });

  it('does not pay to re-ask about a token PONS already matched for free', async () => {
    const chain = fakeChain();
    chain.senders.set('0xpooltx', DEPLOYER_EOA);
    const { db } = makeDb();

    const hits = await attributePools(db, chain, [watchRow()], [launchRow], new Set([TOKEN]));

    expect(hits).toEqual([]);
    expect(chain.senderReads).toEqual([]);
  });

  it('treats an unreadable sender as unknown, never as a match', async () => {
    const chain = fakeChain(); // no sender recorded: the node would not say
    const { db } = makeDb();

    expect(await attributePools(db, chain, [watchRow()], [launchRow])).toEqual([]);
    expect(chain.senderReads).toEqual(['0xpooltx']);
  });

  it('reads nothing at all when a client cannot answer who sent a transaction', async () => {
    const chain = fakeChain();
    delete (chain as { getTransactionSender?: unknown }).getTransactionSender;
    const { db } = makeDb();
    expect(await attributePools(db, chain, [watchRow()], [launchRow])).toEqual([]);
  });

  it('is bounded per pass, and skips graduations', async () => {
    const chain = fakeChain();
    const rows = Array.from({ length: DEPLOYER_WATCH.poolAttributionPerTick + 5 }, (_, i) => ({
      kind: 'launch' as const,
      tokenAddress: `0x${String(i).padStart(40, '0')}`,
      txHash: `0xtx${i}`,
    }));
    rows.push({ kind: 'graduation', tokenAddress: TOKEN, txHash: '0xgrad' } as never);
    const { db } = makeDb();

    await attributePools(db, chain, [watchRow()], rows);

    expect(chain.senderReads).toHaveLength(DEPLOYER_WATCH.poolAttributionPerTick);
    expect(chain.senderReads).not.toContain('0xgrad');
  });

  it('costs nothing with an empty watchlist', async () => {
    const chain = fakeChain();
    const { db } = makeDb();
    expect(await attributePools(db, chain, [], [launchRow])).toEqual([]);
    expect(chain.senderReads).toEqual([]);
  });
});

describe('scanRegistries', () => {
  const contractWatch = watchRow({ id: 7, address: REGISTRY, kind: 'contract' });

  it('decodes a TokenSet whose addresses are INDEXED (in the topics)', async () => {
    const indexed = log({
      address: REGISTRY,
      topics: [TOPICS.tokenSet, pad(TOKEN), pad(POOL)],
      data: `0x${word(1_800_000_000n)}`,
      transactionHash: '0xset',
    });
    const chain = fakeChain([indexed]);
    const { db } = makeDb();

    const hits = await scanRegistries(db, chain, [contractWatch], 52_222_000, 52_224_000);

    expect(hits).toEqual([
      {
        watchId: 7,
        groupId: 2,
        addedBy: 144913755,
        watchedAddress: REGISTRY,
        tokenAddress: TOKEN,
        via: 'registry',
        txHash: '0xset',
      },
    ]);
  });

  it('decodes the same event with its addresses in the DATA instead', async () => {
    const unindexed = log({
      address: REGISTRY,
      topics: [TOPICS.tokenSet],
      data: `0x${pad(TOKEN).slice(2)}${pad(POOL).slice(2)}${word(1_800_000_000n)}`,
      transactionHash: '0xset2',
    });
    const chain = fakeChain([unindexed]);
    const { db } = makeDb();

    const hits = await scanRegistries(db, chain, [contractWatch], 52_222_000, 52_224_000);
    expect(hits[0]?.tokenAddress).toBe(TOKEN);
    expect(hits[0]?.txHash).toBe('0xset2');
  });

  it('still reports an event it cannot decode, with the transaction hash', async () => {
    const opaque = log({
      address: REGISTRY,
      topics: [TOPICS.tokenSet],
      // Only a uint64 timestamp: no address-shaped word anywhere. A small
      // integer wearing an address's padding is NOT read as a token.
      data: `0x${word(1_800_000_000n)}`,
      transactionHash: '0xset3',
    });
    const chain = fakeChain([opaque]);
    const { db } = makeDb();

    const hits = await scanRegistries(db, chain, [contractWatch], 52_222_000, 52_224_000);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.tokenAddress).toBeNull();
    expect(hits[0]?.txHash).toBe('0xset3');
    expect(publishedToken(opaque)).toBeNull();
  });

  it('makes ZERO queries when no contract is watched', async () => {
    const chain = fakeChain();
    const { db } = makeDb();
    expect(await scanRegistries(db, chain, [watchRow()], 52_222_000, 52_224_000)).toEqual([]);
    expect(chain.queries).toEqual([]);
  });

  it('asks for every contract watch in ONE query over the range', async () => {
    const chain = fakeChain();
    const { db } = makeDb();
    await scanRegistries(
      db,
      chain,
      [contractWatch, watchRow({ id: 8, address: POOL, kind: 'contract' })],
      52_222_000,
      52_224_000,
    );
    expect(chain.queries).toHaveLength(1);
    expect(chain.queries[0]?.address).toEqual([REGISTRY, POOL]);
    expect(chain.queries[0]?.topics).toEqual([[TOPICS.tokenSet]]);
  });

  it('a failed query is silence, not a thrown tick', async () => {
    const chain = fakeChain();
    chain.getLogs = async () => {
      throw new Error('boom');
    };
    const { db } = makeDb();
    await expect(
      scanRegistries(db, chain, [contractWatch], 52_222_000, 52_224_000),
    ).resolves.toEqual([]);
  });
});

describe('recordHit', () => {
  const hit = {
    watchId: 1,
    groupId: 2,
    addedBy: 144913755,
    watchedAddress: DEPLOYER_EOA,
    tokenAddress: TOKEN,
    via: 'pons' as const,
    txHash: '0xlaunch',
  };

  it('has exactly one winner when two passes race the same row', async () => {
    // The second UPDATE returns nothing: the row is no longer 'active'.
    const { db, calls } = makeDb({ 'update:deployerWatches': [[{ id: 1 }], []] });

    expect(await recordHit(db, hit)).toBe(true);
    expect(await recordHit(db, hit)).toBe(false);

    const first = find(calls, 'update:deployerWatches')[0];
    expect(whereSql(first)).toContain('status');
    expect(whereParams(first)).toContain('active');
    expect(first?.set?.status).toBe('fired');
    expect(first?.set?.firedVia).toBe('pons');
    expect(first?.set?.firedAddress).toBe(TOKEN);
    // CLAIMED, not yet told: the recovery sweep reads exactly this state, so a
    // re-armed watch firing a second time must not inherit the old stamp.
    expect(first?.set?.notifiedAt).toBeNull();
  });
});

describe('runDeployerWatchPass', () => {
  const ctx = {
    launchedLogs: [tokenLaunched],
    launchRows: [{ kind: 'launch' as const, tokenAddress: TOKEN, txHash: '0xpooltx' }],
    fromBlock: 52_222_000,
    toBlock: 52_224_000,
  };

  it('spends nothing when nothing is on watch', async () => {
    const chain = fakeChain();
    const { db, calls } = makeDb({ 'select:deployerWatches': [[]] });

    expect(await runDeployerWatchPass(db, chain, ctx)).toEqual([]);
    expect(chain.queries).toEqual([]);
    expect(chain.nonceReads).toEqual([]);
    expect(find(calls, 'update:deployerWatches')).toHaveLength(0);
  });

  it('fires a watched PONS deployer once, and does not pay for the pool road', async () => {
    const chain = fakeChain();
    chain.nonce = REGISTRY_NONCE; // nothing new to probe
    chain.senders.set('0xpooltx', DEPLOYER_EOA);
    const { db } = makeDb({
      'select:deployerWatches': [[watchRow()]],
      // Every UPDATE answers as a winner: what stops a second fire is the
      // pass's own one-attempt-per-watch rule, not the script.
      'update:deployerWatches': [[{ id: 1 }]],
    });

    const won = await runDeployerWatchPass(db, chain, ctx);

    expect(won).toHaveLength(1);
    expect(won[0]?.via).toBe('pons');
    // The PONS road already answered for this token, so no sender was bought.
    expect(chain.senderReads).toEqual([]);
  });

  it('does NOT retire the watch on a raw CREATE — the launch is still coming', async () => {
    const chain = fakeChain();
    chain.nonce = REGISTRY_NONCE + 1;
    chain.code.set(REGISTRY, '0x60806040');
    const { db, calls } = makeDb({
      'select:deployerWatches': [[watchRow()]],
      'update:deployerWatches': [[{ id: 1 }]],
    });

    // No PONS launch and no pool this range: the create is the only signal.
    const won = await runDeployerWatchPass(db, chain, {
      launchedLogs: [],
      launchRows: [],
      fromBlock: 52_222_000,
      toBlock: 52_224_000,
    });

    // Announced...
    expect(won).toHaveLength(1);
    expect(won[0]?.via).toBe('create');
    expect(won[0]?.tokenAddress).toBe(REGISTRY);
    // ...and the row was never flipped, so a PONS launch by the same wallet
    // hours later can still fire. The motivating wallet deployed its registry
    // at nonce 163 and launched afterwards; retiring the watch on the
    // scaffolding is the miss this feature exists to prevent.
    const updates = find(calls, 'update:deployerWatches');
    expect(updates.filter((c) => c.set?.status === 'fired')).toHaveLength(0);
  });

  it('prefers the launch when a create and a PONS launch land in one pass', async () => {
    const chain = fakeChain();
    chain.nonce = REGISTRY_NONCE + 1;
    chain.code.set(REGISTRY, '0x60806040');
    const { db, calls } = makeDb({
      'select:deployerWatches': [[watchRow()]],
      'update:deployerWatches': [[{ id: 1 }]],
    });

    const won = await runDeployerWatchPass(db, chain, ctx);

    // One message about one wallet in one pass, and it is the stronger one.
    expect(won).toHaveLength(1);
    expect(won[0]?.via).toBe('pons');
    const updates = find(calls, 'update:deployerWatches');
    expect(updates.filter((c) => c.set?.status === 'fired')).toHaveLength(1);
  });

  it('records at most one hit per watch per pass', async () => {
    const chain = fakeChain();
    chain.nonce = REGISTRY_NONCE + 1;
    chain.code.set(REGISTRY, '0x60806040'); // a CREATE hit for the same watch
    const { db, calls } = makeDb({
      'select:deployerWatches': [[watchRow()]],
      'update:deployerWatches': [[{ id: 1 }]],
    });

    const won = await runDeployerWatchPass(db, chain, ctx);

    expect(won).toHaveLength(1);
    // One fire, and the two housekeeping stamps (the nonce, the seen block).
    const updates = find(calls, 'update:deployerWatches');
    expect(updates.filter((c) => c.set?.status === 'fired')).toHaveLength(1);
  });

  it('survives a watchlist read that fails', async () => {
    const chain = fakeChain();
    const { db } = makeDb({ 'select:deployerWatches': [[new Error('db down')]] });
    await expect(runDeployerWatchPass(db, chain, ctx)).resolves.toEqual([]);
  });
});

describe('activeWatches', () => {
  it('reads only active rows, capped at the scan ceiling', async () => {
    const { db, calls } = makeDb({ 'select:deployerWatches': [[watchRow()]] });
    await activeWatches(db);
    const call = find(calls, 'select:deployerWatches')[0];
    expect(whereParams(call)).toContain('active');
    expect(call?.limit).toBe(DEPLOYER_WATCH.maxWatchesScanned);
  });
});

describe('hasCode', () => {
  it("reads '' the same as '0x' — an empty account, not a deployment", () => {
    // The two sites that ask (`/overseer deployer`'s kind probe and the CREATE
    // scan) must never disagree about what the node just said: reading '' as
    // bytecode would announce a deployment at an address with no code.
    expect(hasCode('')).toBe(false);
    expect(hasCode('0x')).toBe(false);
    expect(hasCode('0x0')).toBe(false);
    expect(hasCode('0x60806040')).toBe(true);
  });
});

describe('the pool road budget', () => {
  const rowsFor = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      kind: 'launch' as const,
      tokenAddress: TOKEN,
      txHash: `0xtx${i}`,
    }));

  it('is spent ACROSS a tick, not reset for each block range', async () => {
    const chain = fakeChain();
    const { db } = makeDb();
    const budget = newDeployerTickBudget();
    const watches = [watchRow()];

    await attributePools(db, chain, watches, rowsFor(30), new Set(), budget);
    const afterFirstRange = chain.senderReads.length;
    await attributePools(db, chain, watches, rowsFor(30), new Set(), budget);

    // A 40-chunk catch-up tick must not spend forty times the ceiling.
    expect(afterFirstRange).toBe(DEPLOYER_WATCH.poolAttributionPerTick);
    expect(chain.senderReads).toHaveLength(DEPLOYER_WATCH.poolAttributionPerTick);
  });

  it('says out loud when it runs out, once per tick', async () => {
    const chain = fakeChain();
    const { db } = makeDb();
    const budget = newDeployerTickBudget();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let said: string[] = [];
    try {
      await attributePools(db, chain, [watchRow()], rowsFor(30), new Set(), budget);
      await attributePools(db, chain, [watchRow()], rowsFor(30), new Set(), budget);
      // Read INSIDE the try: mockRestore resets the recorded calls with it.
      said = warn.mock.calls.map((call) => String(call[0]));
    } finally {
      warn.mockRestore();
    }
    // The range is never re-read, so a pool nobody attributed is a miss — said
    // once for the whole tick, the way the outage catch-up admits its gap.
    const budgetLines = said.filter((line) => line.includes('pool attribution budget'));
    expect(budgetLines).toHaveLength(1);
    expect(budgetLines[0]).toContain(`${30 - DEPLOYER_WATCH.poolAttributionPerTick} new pool(s)`);
  });

  it('buys nothing for a CONTRACT watch: a transaction sender is always an EOA', async () => {
    const chain = fakeChain();
    chain.senders.set('0xtx0', REGISTRY);
    const { db } = makeDb();
    const hits = await attributePools(
      db,
      chain,
      [watchRow({ address: REGISTRY, kind: 'contract' })],
      rowsFor(1),
    );
    expect(hits).toEqual([]);
    expect(chain.senderReads).toEqual([]);
  });
});

describe('undeliveredHits', () => {
  it('reads fired rows nobody told the chat about, and rebuilds the hit', async () => {
    const { db, calls } = makeDb({
      'select:deployerWatches': [
        [
          watchRow({
            status: 'fired',
            firedAddress: TOKEN,
            firedVia: 'pons',
            firedTxHash: '0xlaunch',
            firedAt: new Date('2026-09-08T12:00:00Z'),
          }),
        ],
      ],
    });

    const lost = await undeliveredHits(db, Date.parse('2026-09-08T12:05:00Z'));

    expect(lost).toEqual([
      {
        watchId: 1,
        groupId: 2,
        addedBy: 144913755,
        watchedAddress: DEPLOYER_EOA,
        tokenAddress: TOKEN,
        via: 'pons',
        txHash: '0xlaunch',
      },
    ]);
    const call = find(calls, 'select:deployerWatches')[0];
    expect(whereParams(call)).toContain('fired');
    expect(whereSql(call)).toContain('is null');
    expect(call?.limit).toBe(DEPLOYER_WATCH.recoveryPerPass);
  });

  it('leaves a fire that is still being delivered alone', async () => {
    const { db, calls } = makeDb({ 'select:deployerWatches': [[]] });
    const now = Date.parse('2026-09-08T12:00:00Z');

    await undeliveredHits(db, now);

    // Two bounds, not one: old enough to be lost (the 2h window) AND settled
    // enough not to be mid-delivery. Without the second, the sweep could re-send
    // the one road the alerts index cannot dedupe — an undecodable registry
    // event, whose `details.address` is null and nulls are distinct in a unique
    // index — while the first delivery was still running.
    const bound = whereParams(find(calls, 'select:deployerWatches')[0]).map((value) =>
      value instanceof Date ? value.getTime() : Date.parse(String(value)),
    );
    expect(bound).toContain(now - DEPLOYER_WATCH.recoveryGraceSeconds * 1000);
    expect(bound).toContain(now - DEPLOYER_WATCH.recoveryWindowMinutes * 60_000);
  });

  it('says nothing about a fired row whose signal was never recorded', async () => {
    const { db } = makeDb({
      'select:deployerWatches': [
        [watchRow({ status: 'fired', firedVia: null, firedAt: new Date() })],
      ],
    });
    // A message that cannot say WHICH road fired is not one this feature sends.
    expect(await undeliveredHits(db)).toEqual([]);
  });
});

describe('catchUpPonsLaunches', () => {
  it('asks only about the watched addresses, in the indexed topic position', async () => {
    const chain = fakeChain([tokenLaunched]);
    const { db, calls } = makeDb({
      'select:deployerWatches': [[watchRow()]],
      'update:deployerWatches': [[{ id: 1 }]],
    });

    const won = await catchUpPonsLaunches(db, chain, 52_222_000, 52_224_000);

    expect(won).toHaveLength(1);
    expect(won[0]?.via).toBe('pons');
    expect(chain.queries).toHaveLength(1);
    expect(chain.queries[0]?.address).toEqual([PONS_V2_FACTORY]);
    // topics[3] is the deployer: an ARRAY there is an OR-filter, so the
    // response is bounded by the watchlist rather than by chain volume.
    expect(chain.queries[0]?.topics?.[0]).toBe(TOPICS.tokenLaunched);
    expect(chain.queries[0]?.topics?.[1]).toBeNull();
    expect(chain.queries[0]?.topics?.[3]).toEqual([pad(DEPLOYER_EOA)]);
    expect(find(calls, 'update:deployerWatches')[0]?.set?.status).toBe('fired');
  });

  it('spends nothing when nobody is watching', async () => {
    const chain = fakeChain([tokenLaunched]);
    const { db } = makeDb({ 'select:deployerWatches': [[]] });
    expect(await catchUpPonsLaunches(db, chain, 52_222_000, 52_224_000)).toEqual([]);
    expect(chain.queries).toEqual([]);
  });

  it('reads the most recent part of a gap it cannot afford whole', async () => {
    const chain = fakeChain();
    // The provider's learned ceiling; the catch-up may spend backfillMaxChunks
    // of them and no more.
    chain.maxLogRange = () => 5_000;
    const { db } = makeDb({ 'select:deployerWatches': [[watchRow()]] });

    await catchUpPonsLaunches(db, chain, 1_000_000, 2_000_000);

    const affordable = 5_000 * DEPLOYER_WATCH.backfillMaxChunks;
    expect(chain.queries[0]?.fromBlock).toBe(2_000_000 - affordable + 1);
    expect(chain.queries[0]?.toBlock).toBe(2_000_000);
  });

  it('bounds the read even before the provider cap has been learned', async () => {
    const chain = fakeChain();
    // No refusal has been seen yet — which is exactly the state a just-restarted
    // container is in, and exactly when a long gap exists. Falling back to the
    // gap's own width here made backfillMaxChunks a no-op and handed the client
    // a range it would chunk up to DISCOVERY.maxLogChunksPerQuery (40) instead.
    expect(chain.maxLogRange).toBeUndefined();
    const { db } = makeDb({ 'select:deployerWatches': [[watchRow()]] });

    await catchUpPonsLaunches(db, chain, 1_000_000, 2_000_000);

    const affordable = DISCOVERY.maxBlocksPerRequest * DEPLOYER_WATCH.backfillMaxChunks;
    expect(chain.queries[0]?.fromBlock).toBe(2_000_000 - affordable + 1);
    expect(chain.queries[0]?.toBlock).toBe(2_000_000);
  });

  it('is silence, not a thrown tick, when the gap query fails', async () => {
    const chain = fakeChain();
    chain.getLogs = async () => {
      throw new Error('boom');
    };
    const { db } = makeDb({ 'select:deployerWatches': [[watchRow()]] });
    await expect(catchUpPonsLaunches(db, chain, 52_222_000, 52_224_000)).resolves.toEqual([]);
  });
});
