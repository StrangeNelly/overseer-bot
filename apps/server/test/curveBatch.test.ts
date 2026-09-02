import { beforeEach, describe, expect, it, vi } from 'vitest';
import { is, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { SQL as SQLClass } from 'drizzle-orm/sql/sql';
import { calls as callsTable, snapshots, tokens, type Db } from '@groupie/db';
import type { GtPoolInfo } from '../src/market/geckoterminal.js';

/**
 * Batched curve polls (docs/decisions.md round 16b).
 *
 * The tick reads up to 30 curve pools in ONE GeckoTerminal call and then does
 * exactly what the single-pool path did per token. The two guarantees worth
 * pinning are: a returned pool is handled identically either way, and a pool
 * the batch did not carry is an UNKNOWN reading — clock stamped, nothing else
 * written, no $0 snapshot and no death path.
 *
 * Same harness style as watchlist.test.ts / ingest.test.ts: the Drizzle builder
 * is faked and the assertions are about the statements the poller attempted.
 */

vi.mock('../src/market/geckoterminal.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/market/geckoterminal.js')>();
  return { ...actual, getPool: vi.fn(), getPoolsMulti: vi.fn() };
});
// The tick's other passes are not under test here and all touch the database.
vi.mock('../src/poller/alerts.js', () => ({ runAlertPass: vi.fn(async () => undefined) }));
vi.mock('../src/poller/rugSweep.js', () => ({ runProbationSweep: vi.fn(async () => undefined) }));
vi.mock('../src/poller/sleeperScan.js', () => ({ runSleeperScan: vi.fn(async () => undefined) }));

const gt = await import('../src/market/geckoterminal.js');
const { deadReadsCurve, pollCurve, pollCurveBatch, pollDead, runTick } = await import(
  '../src/poller/scheduler.js'
);

const dialect = new PgDialect();

interface DbCall {
  key: string;
  values?: Record<string, unknown>;
  set?: Record<string, unknown>;
  where?: SQL;
}

type Script = Record<string, unknown[][]>;

function renderSet(set: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(set ?? {})) {
    out[key] = is(value, SQLClass) ? dialect.sqlToQuery(value).sql : String(value);
  }
  return out;
}

/** A statement the fake should reject, decided once its args are captured. */
type FailOn = (call: DbCall) => boolean;

function chain(call: DbCall, take: (key: string) => unknown[], failOn?: FailOn) {
  const node: Record<string, unknown> = {
    then: (ok: (rows: unknown[]) => unknown, err: (e: unknown) => unknown) =>
      Promise.resolve()
        .then(() => {
          if (failOn?.(call)) throw new Error(`db exploded on ${call.key}`);
          return take(call.key);
        })
        .then(ok, err),
  };
  const methods = [
    'values',
    'set',
    'from',
    'where',
    'orderBy',
    'limit',
    'returning',
    'leftJoin',
    'groupBy',
  ];
  for (const method of methods) {
    node[method] = (...args: unknown[]) => {
      if (method === 'values') call.values = args[0] as Record<string, unknown>;
      if (method === 'set') call.set = args[0] as Record<string, unknown>;
      if (method === 'where') call.where = args[0] as SQL;
      return node;
    };
  }
  return node;
}

function makeDb(script: Script = {}, failOn?: FailOn): { db: Db; calls: DbCall[] } {
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
    if (table === tokens) return 'tokens';
    if (table === callsTable) return 'calls';
    if (table === snapshots) return 'snapshots';
    return 'unknown';
  };
  const start = (op: string, table: unknown) => {
    const call: DbCall = { key: `${op}:${nameOf(table)}` };
    calls.push(call);
    return chain(call, take, failOn);
  };
  const db = {
    insert: (table: unknown) => start('insert', table),
    update: (table: unknown) => start('update', table),
    select: () => ({ from: (table: unknown) => start('select', table) }),
    execute: () => Promise.resolve([]),
  };
  return { db: db as unknown as Db, calls };
}

const find = (calls: DbCall[], key: string) => calls.filter((c) => c.key === key);
/** The bound values of a statement's WHERE — how a test names the row it hit. */
const whereParams = (call: DbCall): unknown[] =>
  call.where ? dialect.sqlToQuery(call.where).params : [];
/** A statement whose whole SET is the clock stamp and nothing else. */
const isStamp = (call: DbCall): boolean =>
  Object.keys(call.set ?? {}).length === 1 && 'lastPolledAt' in (call.set ?? {});

type TokenRow = typeof tokens.$inferSelect;

const NOW = Date.now();

function tokenRow(over: Partial<TokenRow> = {}): TokenRow {
  return {
    id: 7,
    chainId: 42161,
    address: '0xtoken',
    symbol: 'CURVE',
    name: 'Curve Coin',
    imageUrl: null,
    socials: null,
    launchpad: 'pons',
    phase: 'curve',
    poolAddress: '0xpool',
    // Young enough that no age rule can reach a verdict on its own.
    tokenCreatedAt: new Date(NOW - 3_600_000),
    graduatedAt: null,
    diedAt: null,
    deathReason: null,
    mcapAtDeath: null,
    revivedAt: null,
    rugHiddenAt: null,
    revivingAt: null,
    priceUsd: 0.0002,
    mcapUsd: 200_000,
    liquidityUsd: 25_000,
    vol24Usd: 10_000,
    firstSeenAt: new Date(NOW - 3_600_000),
    lastPolledAt: new Date(NOW - 60_000),
    lastSnapshotAt: new Date(NOW - 60_000),
    ...over,
  } as TokenRow;
}

function poolInfo(over: Partial<GtPoolInfo> = {}): GtPoolInfo {
  return {
    poolAddress: '0xpool',
    priceUsd: 0.00025,
    fdvUsd: 250_000,
    reserveUsd: 30_000,
    vol24Usd: 12_000,
    txns24: 40,
    poolCreatedAt: new Date(NOW - 7_200_000),
    graduationPct: 42.5,
    graduated: false,
    migratedPoolAddress: null,
    dex: 'pons',
    lockedLiquidityPct: null,
    ...over,
  };
}

const OPTS = { budgeted: true };

beforeEach(() => {
  vi.mocked(gt.getPool).mockReset();
  vi.mocked(gt.getPoolsMulti).mockReset();
});

describe('pollCurveBatch (round 16b)', () => {
  it('reads every due curve token in ONE call', async () => {
    const batch = [
      tokenRow({ id: 1, address: '0xa', poolAddress: '0xpool1' }),
      tokenRow({ id: 2, address: '0xb', poolAddress: '0xpool2' }),
      tokenRow({ id: 3, address: '0xc', poolAddress: '0xpool3' }),
    ];
    vi.mocked(gt.getPoolsMulti).mockResolvedValue(
      new Map([
        ['0xpool1', poolInfo({ poolAddress: '0xpool1' })],
        ['0xpool2', poolInfo({ poolAddress: '0xpool2' })],
        ['0xpool3', poolInfo({ poolAddress: '0xpool3' })],
      ]),
    );
    const { db, calls } = makeDb();
    await pollCurveBatch(db, batch, OPTS);

    expect(vi.mocked(gt.getPoolsMulti)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(gt.getPoolsMulti).mock.calls[0]?.[0]).toEqual(['0xpool1', '0xpool2', '0xpool3']);
    expect(vi.mocked(gt.getPool)).not.toHaveBeenCalled();
    // One snapshot per token, none of them lost to the batching.
    expect(find(calls, 'insert:snapshots').map((c) => c.values?.tokenId)).toEqual([1, 2, 3]);
  });

  it('handles a returned pool EXACTLY as the single-token poll does', async () => {
    const token = tokenRow();
    const pool = poolInfo();

    vi.mocked(gt.getPool).mockResolvedValue(pool);
    const single = makeDb();
    await pollCurve(single.db, token, OPTS);

    vi.mocked(gt.getPoolsMulti).mockResolvedValue(new Map([['0xpool', pool]]));
    const batched = makeDb();
    await pollCurveBatch(batched.db, [token], OPTS);

    const snapOf = (calls: DbCall[]) => find(calls, 'insert:snapshots')[0]?.values;
    expect(snapOf(batched.calls)).toEqual(snapOf(single.calls));
    expect(snapOf(batched.calls)).toEqual({
      tokenId: 7,
      priceUsd: 0.00025,
      mcapUsd: 250_000,
      liquidityUsd: 30_000,
      vol24Usd: 12_000,
    });
    // ...and the same statements, in the same order.
    expect(batched.calls.map((c) => c.key)).toEqual(single.calls.map((c) => c.key));
  });

  it('graduation detection survives the batch', async () => {
    const token = tokenRow();
    vi.mocked(gt.getPoolsMulti).mockResolvedValue(
      new Map([['0xpool', poolInfo({ graduated: true, migratedPoolAddress: '0xmigrated' })]]),
    );
    const { db, calls } = makeDb();
    await pollCurveBatch(db, [token], OPTS);

    const graduation = find(calls, 'update:tokens')[0];
    expect(graduation?.set?.phase).toBe('graduated');
    expect(graduation?.set?.poolAddress).toBe('0xmigrated');
    expect(renderSet(graduation?.set).graduatedAt).toContain('coalesce');
  });

  it('an ABSENT pool is an unknown reading: clock stamped, nothing else', async () => {
    // GeckoTerminal answers 200 with the pool simply missing. That is "no
    // reading" — never $0, never death evidence.
    const present = tokenRow({ id: 1, address: '0xa', poolAddress: '0xpool1' });
    const ghost = tokenRow({ id: 2, address: '0xb', poolAddress: '0xghost' });
    vi.mocked(gt.getPoolsMulti).mockResolvedValue(
      new Map([['0xpool1', poolInfo({ poolAddress: '0xpool1' })]]),
    );
    const { db, calls } = makeDb();
    await pollCurveBatch(db, [present, ghost], OPTS);

    // Only the readable token produced a snapshot.
    expect(find(calls, 'insert:snapshots').map((c) => c.values?.tokenId)).toEqual([1]);
    // The ghost's only statement is the clock stamp — no market fields written,
    // so nothing can later be read back as a $0 market.
    const stamps = find(calls, 'update:tokens').filter(isStamp);
    expect(stamps).toHaveLength(1);
    expect(stamps[0]?.set?.lastPolledAt).toBeInstanceOf(Date);
    // And no death was recorded for it (markTokenDead updates tokens + calls
    // with a died phase; nothing here does).
    expect(
      find(calls, 'update:tokens').some((c) => renderSet(c.set).phase === 'dead'),
    ).toBe(false);
  });

  it('one poisoned token does not cost the rest of the batch its poll', async () => {
    // Sharing a CALL must not mean sharing a FAILURE: the unbatched tick
    // isolated every poll, and batching keeps that.
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const batch = [
      tokenRow({ id: 1, address: '0xa', poolAddress: '0xpool1' }),
      tokenRow({ id: 2, address: '0xb', poolAddress: '0xpool2' }),
      tokenRow({ id: 3, address: '0xc', poolAddress: '0xpool3' }),
    ];
    vi.mocked(gt.getPoolsMulti).mockResolvedValue(
      new Map(batch.map((t) => [t.poolAddress!, poolInfo({ poolAddress: t.poolAddress! })])),
    );
    const { db, calls } = makeDb(
      {},
      (call) => call.key === 'insert:snapshots' && call.values?.tokenId === 2,
    );
    await pollCurveBatch(db, batch, OPTS);

    expect(find(calls, 'insert:snapshots').map((c) => c.values?.tokenId)).toEqual([1, 2, 3]);
    // The healthy tokens still wrote their cached market state...
    const cached = find(calls, 'update:tokens').filter((c) => 'mcapUsd' in (c.set ?? {}));
    expect(cached).toHaveLength(2);
    // ...and the poisoned one was stamped so it keeps its tier cadence.
    const stamps = find(calls, 'update:tokens').filter(isStamp);
    expect(stamps).toHaveLength(1);
    expect(whereParams(stamps[0]!)).toEqual([2]);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('a failed stamp on an absent pool does not discard the readings behind it', async () => {
    // The absent-pool branch is isolated for the same reason the applied one is:
    // its readings are already paid for, and the tokens after it in the batch
    // must not lose a poll cycle to one transient UPDATE failure.
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const batch = [
      tokenRow({ id: 1, address: '0xa', poolAddress: '0xpool1' }),
      tokenRow({ id: 2, address: '0xb', poolAddress: '0xghost' }),
      tokenRow({ id: 3, address: '0xc', poolAddress: '0xpool3' }),
    ];
    vi.mocked(gt.getPoolsMulti).mockResolvedValue(
      new Map([
        ['0xpool1', poolInfo({ poolAddress: '0xpool1' })],
        ['0xpool3', poolInfo({ poolAddress: '0xpool3' })],
      ]),
    );
    const { db, calls } = makeDb({}, (call) => call.key === 'update:tokens' && isStamp(call));
    await pollCurveBatch(db, batch, OPTS);

    expect(find(calls, 'insert:snapshots').map((c) => c.values?.tokenId)).toEqual([1, 3]);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('an empty batch asks GeckoTerminal nothing', async () => {
    const { db, calls } = makeDb();
    await pollCurveBatch(db, [], OPTS);
    expect(vi.mocked(gt.getPoolsMulti)).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
});

/* --------------------------------------------- the dead tier's shared call */

/** A corpse that is re-read off GeckoTerminal rather than DexScreener. */
function corpseRow(over: Partial<TokenRow> = {}): TokenRow {
  return tokenRow({
    id: 101,
    phase: 'dead',
    deathReason: 'never_graduated',
    graduatedAt: null,
    diedAt: new Date(NOW - 10 * 86_400_000),
    lastPolledAt: new Date(NOW - 10 * 86_400_000),
    ...over,
  });
}

describe('deadReadsCurve', () => {
  it('routes a corpse to the market its phase actually traded on', () => {
    const cases: Array<[Partial<TokenRow>, boolean]> = [
      [{ deathReason: 'never_graduated' }, true],
      // Retired in round 6, but rows written before it still carry it.
      [{ deathReason: 'curve_floor' }, true],
      [{ deathReason: 'rug_floor', graduatedAt: null }, true],
      // The same reason can kill either phase, so graduation decides.
      [{ deathReason: 'rug_floor', graduatedAt: new Date(NOW - 86_400_000) }, false],
      [{ deathReason: 'liquidity_floor' }, false],
      [{ deathReason: 'call_liquidity_collapse' }, false],
      [{ deathReason: null }, false],
    ];
    for (const [over, expected] of cases) {
      expect([over, deadReadsCurve(corpseRow(over))]).toEqual([over, expected]);
    }
  });
});

describe('pollDead with the tick’s prefetched pools', () => {
  it('an ABSENT address is an unknown reading: no revival, no baselines, just the stamp', async () => {
    const token = corpseRow({ poolAddress: '0xghost' });
    const { db, calls } = makeDb();
    await pollDead(db, token, OPTS, new Map([['0xother', poolInfo()]]));

    // No call of its own was spent on it either.
    expect(vi.mocked(gt.getPool)).not.toHaveBeenCalled();
    // Consume the revive flag, sweep any call posted after the death, stamp.
    expect(calls.map((c) => c.key)).toEqual(['update:calls', 'update:calls', 'update:tokens']);
    const stamp = find(calls, 'update:tokens')[0]!;
    expect(isStamp(stamp)).toBe(true);
    // A revival would have written a phase; a baseline fill would have read calls.
    expect(find(calls, 'update:tokens').some((c) => 'phase' in (c.set ?? {}))).toBe(false);
    expect(find(calls, 'select:calls')).toHaveLength(0);
    expect(find(calls, 'insert:snapshots')).toHaveLength(0);
  });

  it('a PRESENT pool is handled exactly as the single-pool read handles it', async () => {
    const token = corpseRow();
    // Over the revival bar, so the comparison covers the comeback path too.
    const pool = poolInfo({ fdvUsd: 250_000 });
    const script = { 'update:tokens': [[{ id: token.id }]] };

    vi.mocked(gt.getPool).mockResolvedValue(pool);
    const single = makeDb(script);
    await pollDead(single.db, token, OPTS);

    const batched = makeDb(script);
    await pollDead(batched.db, token, OPTS, new Map([['0xpool', pool]]));

    expect(vi.mocked(gt.getPool)).toHaveBeenCalledTimes(1);
    expect(batched.calls.map((c) => c.key)).toEqual(single.calls.map((c) => c.key));
    expect(find(batched.calls, 'insert:snapshots')[0]?.values).toEqual(
      find(single.calls, 'insert:snapshots')[0]?.values,
    );
    expect(find(batched.calls, 'update:tokens')[0]?.set?.phase).toBe('curve');
  });
});

describe('runTick dead-tier prefetch', () => {
  /** loadCandidates' row shape, for a corpse the tick should find due. */
  function candidateRow(token: TokenRow, reviveRequested = false) {
    return {
      token,
      lastActivityEpoch: String((NOW - 10 * 86_400_000) / 1000),
      reviveRequested,
      watched: false,
      called: '1',
    };
  }

  it('shares ONE call across the curve-read corpses', async () => {
    const a = corpseRow({ id: 101, address: '0xa', poolAddress: '0xpool1' });
    const b = corpseRow({ id: 102, address: '0xb', poolAddress: '0xpool2' });
    vi.mocked(gt.getPoolsMulti).mockResolvedValue(new Map());
    const { db } = makeDb({ 'select:tokens': [[candidateRow(a), candidateRow(b)]] });
    await runTick(db);

    expect(vi.mocked(gt.getPoolsMulti).mock.calls[0]?.[0]).toEqual(['0xpool1', '0xpool2']);
    expect(vi.mocked(gt.getPool)).not.toHaveBeenCalled();
  });

  it('a failed prefetch defers the corpses instead of re-asking one call at a time', async () => {
    // The realistic throw is the 429 that just parked the budgeter for 30s, so
    // N single reads would hold the tick open on its least urgent tier. A
    // deferred corpse gets its clock stamped and NOTHING else: stamped, so the
    // oldest-first slice moves past it next tick instead of re-selecting the
    // same corpses for as long as the 429 lasts; nothing else, because no
    // reading was taken.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const deferred = corpseRow({ id: 101, address: '0xa', poolAddress: '0xpool1' });
    const repost = corpseRow({ id: 102, address: '0xb', poolAddress: '0xpool2' });
    vi.mocked(gt.getPoolsMulti).mockRejectedValue(new Error('geckoterminal 429'));
    vi.mocked(gt.getPool).mockResolvedValue(null);
    const { db, calls } = makeDb({
      'select:tokens': [[candidateRow(deferred), candidateRow(repost, true)]],
    });
    await runTick(db);

    // The repost keeps its fallback — its revival check is what a member is
    // waiting on — and it is the ONLY single read the tick spends.
    expect(vi.mocked(gt.getPool).mock.calls).toEqual([['0xpool2']]);
    const touching = calls.filter((c) => whereParams(c).includes(deferred.id));
    expect(touching.map((c) => c.key)).toEqual(['update:tokens']);
    expect(Object.keys(touching[0]?.set ?? {})).toEqual(['lastPolledAt']);
    expect(calls.some((c) => whereParams(c).includes(repost.id))).toBe(true);
    warn.mockRestore();
  });
});
