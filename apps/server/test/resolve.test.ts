import { beforeEach, describe, expect, it, vi } from 'vitest';
import { is, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { SQL as SQLClass } from 'drizzle-orm/sql/sql';
import { calls as callsTable, snapshots, tokens, watches as watchesTable, type Db } from '@groupie/db';
import { POLL_TIERS, wrongChainReason } from '@groupie/shared';
import type { DsPair } from '../src/market/dexscreener.js';
import type { GtPoolInfo, GtTokenInfo } from '../src/market/geckoterminal.js';

/**
 * Resolution honesty + diet (docs/decisions.md round 17b).
 *
 * Three claims are pinned here:
 *
 * 1. WRONG CHAIN. A CA that both Robinhood-Chain sources miss is asked about
 *    any-chain: trading somewhere else is a death (`wrong_chain:<chain>`),
 *    trading here is patience, and nothing anywhere is neither.
 * 2. The question is never asked inside the fast window (both Robinhood sources
 *    have to have had time to index first), never for a token that resolved,
 *    and the death it produces is guarded on the evidence it was reached on.
 * 3. BATCHED resolution answers exactly what the one-address path answers, an
 *    address the batch did not carry is unknown — never death evidence — and a
 *    failed STAGE silences only the addresses that were waiting on it.
 *
 * Same harness style as curveBatch.test.ts: the Drizzle builder is faked and
 * the assertions are about the statements the poller attempted.
 */

vi.mock('../src/market/geckoterminal.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/market/geckoterminal.js')>();
  return { ...actual, getTokensMulti: vi.fn(), getPoolsMulti: vi.fn(), getPool: vi.fn() };
});
vi.mock('../src/market/dexscreener.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/market/dexscreener.js')>();
  return { ...actual, getBestPairs: vi.fn(), findChainsFor: vi.fn() };
});
// The tick's other passes are not under test here and all touch the database.
vi.mock('../src/poller/alerts.js', () => ({ runAlertPass: vi.fn(async () => undefined) }));
vi.mock('../src/poller/rugSweep.js', () => ({ runProbationSweep: vi.fn(async () => undefined) }));
vi.mock('../src/poller/sleeperScan.js', () => ({ runSleeperScan: vi.fn(async () => undefined) }));

const gt = await import('../src/market/geckoterminal.js');
const ds = await import('../src/market/dexscreener.js');
const { resolveToken, resolveTokens } = await import('../src/market/resolve.js');
const { pollDead, pollTokenNow, runTick } = await import('../src/poller/scheduler.js');

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

function chain(call: DbCall, take: (key: string) => unknown[]) {
  const node: Record<string, unknown> = {
    then: (ok: (rows: unknown[]) => unknown, err: (e: unknown) => unknown) =>
      Promise.resolve()
        .then(() => take(call.key))
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
    if (table === tokens) return 'tokens';
    if (table === callsTable) return 'calls';
    if (table === snapshots) return 'snapshots';
    if (table === watchesTable) return 'watches';
    return 'unknown';
  };
  const start = (op: string, table: unknown) => {
    const call: DbCall = { key: `${op}:${nameOf(table)}` };
    calls.push(call);
    return chain(call, take);
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
const isStamp = (call: DbCall): boolean =>
  Object.keys(call.set ?? {}).length === 1 && 'lastPolledAt' in (call.set ?? {});
const died = (calls: DbCall[]) =>
  find(calls, 'update:tokens').filter((c) => renderSet(c.set).phase === 'dead');

type TokenRow = typeof tokens.$inferSelect;

const NOW = Date.now();

/** A CA someone pasted seconds ago: never polled, nothing known about it. */
function unresolvedRow(over: Partial<TokenRow> = {}): TokenRow {
  return {
    id: 7,
    chainId: 42161,
    address: '0xdud',
    symbol: null,
    name: null,
    imageUrl: null,
    socials: null,
    launchpad: null,
    phase: 'unresolved',
    poolAddress: null,
    tokenCreatedAt: null,
    graduatedAt: null,
    diedAt: null,
    deathReason: null,
    mcapAtDeath: null,
    revivedAt: null,
    rugHiddenAt: null,
    revivingAt: null,
    priceUsd: null,
    mcapUsd: null,
    liquidityUsd: null,
    vol24Usd: null,
    firstSeenAt: new Date(NOW - 60_000),
    lastPolledAt: null,
    lastSnapshotAt: null,
    ...over,
  } as TokenRow;
}

function tokenInfo(over: Partial<GtTokenInfo> = {}): GtTokenInfo {
  return {
    address: '0xdud',
    symbol: 'DUD',
    name: 'Dud Coin',
    imageUrl: null,
    priceUsd: 0.0002,
    fdvUsd: 200_000,
    totalSupply: 1e9,
    vol24Usd: 10_000,
    topPoolAddress: '0xpool',
    launchpadCompleted: false,
    ...over,
  };
}

function poolInfo(over: Partial<GtPoolInfo> = {}): GtPoolInfo {
  return {
    poolAddress: '0xpool',
    priceUsd: 0.00025,
    fdvUsd: 250_000,
    reserveUsd: 30_000,
    vol24Usd: 12_000,
    poolCreatedAt: new Date(NOW - 3_600_000),
    graduationPct: 42.5,
    graduated: false,
    migratedPoolAddress: null,
    dex: 'pons',
    ...over,
  };
}

function dsPair(over: Partial<DsPair> = {}): DsPair {
  return {
    tokenAddress: '0xdud',
    pairAddress: '0xpair',
    dexId: 'uniswap',
    symbol: 'DUD',
    name: 'Dud Coin',
    imageUrl: null,
    socials: null,
    priceUsd: 0.0002,
    mcapUsd: 200_000,
    liquidityUsd: 40_000,
    vol24Usd: 5_000,
    pairCreatedAt: new Date(NOW - 3_600_000),
    ...over,
  };
}

const OPTS = { budgeted: true };

/** loadCandidates' row shape, for a token the tick should find due. */
function candidateRow(token: TokenRow) {
  return {
    token,
    lastActivityEpoch: String((NOW - 60_000) / 1000),
    reviveRequested: false,
    watched: false,
    called: '1',
  };
}

beforeEach(() => {
  vi.mocked(gt.getTokensMulti).mockReset().mockResolvedValue(new Map());
  vi.mocked(gt.getPoolsMulti).mockReset().mockResolvedValue(new Map());
  vi.mocked(gt.getPool).mockReset();
  vi.mocked(ds.getBestPairs).mockReset().mockResolvedValue(new Map());
  vi.mocked(ds.findChainsFor).mockReset().mockResolvedValue(new Set());
});

/* ------------------------------------------------------- batched resolution */

describe('resolveTokens (round 17b)', () => {
  it('resolves the whole batch in ONE token call and ONE pool call', async () => {
    vi.mocked(gt.getTokensMulti).mockResolvedValue(
      new Map([
        ['0xa', tokenInfo({ address: '0xa', topPoolAddress: '0xpool1' })],
        ['0xb', tokenInfo({ address: '0xb', topPoolAddress: '0xpool2' })],
      ]),
    );
    vi.mocked(gt.getPoolsMulti).mockResolvedValue(
      new Map([
        ['0xpool1', poolInfo({ poolAddress: '0xpool1' })],
        ['0xpool2', poolInfo({ poolAddress: '0xpool2' })],
      ]),
    );

    const out = await resolveTokens(['0xa', '0xb']);

    expect(vi.mocked(gt.getTokensMulti).mock.calls).toEqual([[['0xa', '0xb']]]);
    expect(vi.mocked(gt.getPoolsMulti).mock.calls).toEqual([[['0xpool1', '0xpool2']]]);
    // GT answered, so DexScreener is never asked anything.
    expect(vi.mocked(ds.getBestPairs)).not.toHaveBeenCalled();
    expect(out.get('0xa')?.token?.phase).toBe('curve');
    expect(out.get('0xa')?.token?.poolAddress).toBe('0xpool1');
    expect(out.get('0xb')?.token?.snapshot).toEqual({
      priceUsd: 0.0002,
      mcapUsd: 200_000,
      liquidityUsd: 30_000,
      vol24Usd: 10_000,
    });
  });

  it('answers the one-address form EXACTLY as the batch answers it', async () => {
    vi.mocked(gt.getTokensMulti).mockResolvedValue(new Map([['0xdud', tokenInfo()]]));
    vi.mocked(gt.getPoolsMulti).mockResolvedValue(new Map([['0xpool', poolInfo()]]));

    const single = await resolveToken('0xdud');
    const batched = (await resolveTokens(['0xdud', '0xother'])).get('0xdud');
    expect(single).toEqual(batched);
  });

  it('a token GeckoTerminal knows but cannot pool is unresolved — and NOT unknown', async () => {
    // No pool = no phase evidence, so there is no reading. But GT naming the
    // token is proof it exists HERE, which is what wrong-chain detection turns
    // on: this address must never be judged as living on another chain.
    vi.mocked(gt.getTokensMulti).mockResolvedValue(new Map([['0xdud', tokenInfo()]]));
    vi.mocked(gt.getPoolsMulti).mockResolvedValue(new Map());

    const out = await resolveTokens(['0xdud']);
    expect(out.get('0xdud')).toEqual({ token: null, unknownOnChain: false });
    expect(vi.mocked(ds.getBestPairs)).not.toHaveBeenCalled();
  });

  it('falls back to DexScreener for exactly the addresses GT did not carry', async () => {
    vi.mocked(gt.getTokensMulti).mockResolvedValue(new Map([['0xa', tokenInfo({ address: '0xa' })]]));
    vi.mocked(gt.getPoolsMulti).mockResolvedValue(new Map([['0xpool', poolInfo()]]));
    vi.mocked(ds.getBestPairs).mockResolvedValue(new Map([['0xb', dsPair({ tokenAddress: '0xb' })]]));

    const out = await resolveTokens(['0xa', '0xb']);
    expect(vi.mocked(ds.getBestPairs).mock.calls).toEqual([[['0xb']]]);
    expect(out.get('0xb')?.token?.phase).toBe('graduated');
    expect(out.get('0xb')?.unknownOnChain).toBe(false);
  });

  it('a DUST DexScreener pair is not a reading, but it still proves the chain', async () => {
    vi.mocked(ds.getBestPairs).mockResolvedValue(new Map([['0xdud', dsPair({ liquidityUsd: 10 })]]));
    const out = await resolveTokens(['0xdud']);
    expect(out.get('0xdud')).toEqual({ token: null, unknownOnChain: false });
  });

  it('absent from BOTH Robinhood-Chain sources is the only unknown', async () => {
    const out = await resolveTokens(['0xdud']);
    expect(out.get('0xdud')).toEqual({ token: null, unknownOnChain: true });
  });

  it('asks nothing at all for an empty batch', async () => {
    expect((await resolveTokens([])).size).toBe(0);
    expect(vi.mocked(gt.getTokensMulti)).not.toHaveBeenCalled();
  });

  /**
   * Staged failure (round 17b review). Three network stages used to share one
   * try scope, so a DexScreener blip discarded the tokens GeckoTerminal had
   * already resolved — and the tier, unstamped, re-burned GT every 15s tick.
   * Now a failure silences only the addresses that were waiting on THAT stage:
   * they are absent from the map, which the caller reads as "still due".
   */
  it('a failed pool stage still answers what GeckoTerminal already carried', async () => {
    vi.mocked(gt.getTokensMulti).mockResolvedValue(
      new Map([
        ['0xa', tokenInfo({ address: '0xa', topPoolAddress: '0xpool1' })],
        // No pool of its own to wait for: already answered, and still not unknown.
        ['0xb', tokenInfo({ address: '0xb', topPoolAddress: null })],
      ]),
    );
    vi.mocked(gt.getPoolsMulti).mockRejectedValue(new Error('geckoterminal 429'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const out = await resolveTokens(['0xa', '0xb']);

    expect(out.has('0xa')).toBe(false); // its stage failed — ask again next tick
    expect(out.get('0xb')).toEqual({ token: null, unknownOnChain: false });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a failed DexScreener stage never turns into an unknown', async () => {
    // unknownOnChain is the one shape that can kill a token, so a stage that
    // could not look must not answer at all.
    vi.mocked(gt.getTokensMulti).mockResolvedValue(
      new Map([['0xa', tokenInfo({ address: '0xa', topPoolAddress: '0xpool1' })]]),
    );
    vi.mocked(gt.getPoolsMulti).mockResolvedValue(
      new Map([['0xpool1', poolInfo({ poolAddress: '0xpool1' })]]),
    );
    vi.mocked(ds.getBestPairs).mockRejectedValue(new Error('dexscreener 502'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const out = await resolveTokens(['0xa', '0xb']);

    // The GT-resolved token is kept — a DS outage costs it nothing.
    expect(out.get('0xa')?.token?.phase).toBe('curve');
    expect(out.has('0xb')).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a failed FIRST stage is still the whole batch failing — nothing was learned', async () => {
    vi.mocked(gt.getTokensMulti).mockRejectedValue(new Error('geckoterminal 429'));
    await expect(resolveTokens(['0xa'])).rejects.toThrow('geckoterminal 429');
  });
});

/* ------------------------------------------------------ wrong-chain detection */

describe('wrong-chain detection (round 17b)', () => {
  /** markTokenDead's guarded UPDATE ... RETURNING has to report a transition. */
  const deathScript: Script = { 'update:tokens': [[{ id: 7, mcapAtDeath: null }]] };

  const MIN_AGE_MS = POLL_TIERS.wrongChainMinMinutes * 60_000;
  /**
   * Old enough to be judged: before wrongChainMinMinutes a miss means "not
   * indexed yet" or "pool not open yet", not "not here" (GT takes minutes on a
   * new pool, DexScreener never indexes curve tokens, and a CA is often pasted
   * before its pool exists).
   */
  const aged = (over: Partial<TokenRow> = {}): TokenRow =>
    unresolvedRow({ firstSeenAt: new Date(NOW - MIN_AGE_MS - 60_000), ...over });

  it('pairs on another chain only: the token dies as wrong_chain:<chain>', async () => {
    vi.mocked(ds.findChainsFor).mockResolvedValue(new Set(['base']));
    const { db, calls } = makeDb({ ...deathScript, 'select:tokens': [[aged()]] });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await pollTokenNow(db, 7);

    expect(vi.mocked(ds.findChainsFor).mock.calls).toEqual([['0xdud']]);
    const death = died(calls)[0];
    expect(death?.set?.deathReason).toBe('wrong_chain:base');
    // Nothing was ever measured here, so mcap-at-death is whatever the token
    // column holds — null for an address that never traded on this chain.
    expect(renderSet(death?.set).mcapAtDeath).toContain('mcap_usd');
    // The call dies with it, carrying the same reason.
    const callDeath = find(calls, 'update:calls').find((c) => c.set?.status === 'died');
    expect(callDeath?.set?.deathReason).toBe('wrong_chain:base');
    // A death is not a market reading: no snapshot row, ever.
    expect(find(calls, 'insert:snapshots')).toHaveLength(0);
    log.mockRestore();
  });

  it('never inside the fast window, whatever DexScreener would have said', async () => {
    // The paste's own poll, seconds old. A same-address multi-chain deploy
    // (CREATE2 / omnichain) is live on Base AND launching here; judging now
    // would kill it before either Robinhood source could index it — for good.
    vi.mocked(ds.findChainsFor).mockResolvedValue(new Set(['base']));
    const { db, calls } = makeDb({ 'select:tokens': [[unresolvedRow()]] });

    await pollTokenNow(db, 7);

    expect(vi.mocked(ds.findChainsFor)).not.toHaveBeenCalled();
    expect(died(calls)).toHaveLength(0);
    expect(find(calls, 'update:tokens').filter(isStamp)).toHaveLength(1);
  });

  it('...and on the first attempt after it, even for a token polled all along', async () => {
    // The check is no longer a one-shot spent on the first attempt: it runs on
    // every failed attempt once the row is old enough to be judged.
    vi.mocked(ds.findChainsFor).mockResolvedValue(new Set(['base']));
    const { db, calls } = makeDb({
      ...deathScript,
      'select:tokens': [[aged({ lastPolledAt: new Date(NOW - 300_000) })]],
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await pollTokenNow(db, 7);

    expect(vi.mocked(ds.findChainsFor)).toHaveBeenCalledTimes(1);
    expect(died(calls)[0]?.set?.deathReason).toBe('wrong_chain:base');
    log.mockRestore();
  });

  it('an undatable first sighting is never judged', async () => {
    vi.mocked(ds.findChainsFor).mockResolvedValue(new Set(['base']));
    const { db, calls } = makeDb({
      'select:tokens': [[unresolvedRow({ firstSeenAt: new Date(NaN) })]],
    });

    await pollTokenNow(db, 7);

    expect(vi.mocked(ds.findChainsFor)).not.toHaveBeenCalled();
    expect(died(calls)).toHaveLength(0);
  });

  it('pairs on Robinhood Chain too: patience, not a death', async () => {
    // DexScreener is simply ahead of the token endpoint here.
    vi.mocked(ds.findChainsFor).mockResolvedValue(new Set(['base', 'robinhood']));
    const { db, calls } = makeDb({ 'select:tokens': [[aged()]] });

    await pollTokenNow(db, 7);

    expect(died(calls)).toHaveLength(0);
    expect(find(calls, 'update:tokens').filter(isStamp)).toHaveLength(1);
  });

  it('nothing anywhere: still unresolved, still on the back-off', async () => {
    vi.mocked(ds.findChainsFor).mockResolvedValue(new Set());
    const { db, calls } = makeDb({ 'select:tokens': [[aged()]] });

    await pollTokenNow(db, 7);

    expect(vi.mocked(ds.findChainsFor)).toHaveBeenCalledTimes(1);
    expect(died(calls)).toHaveLength(0);
    expect(find(calls, 'update:tokens').filter(isStamp)).toHaveLength(1);
  });

  it('never asked for a token this chain knows about', async () => {
    vi.mocked(gt.getTokensMulti).mockResolvedValue(new Map([['0xdud', tokenInfo()]]));
    vi.mocked(gt.getPoolsMulti).mockResolvedValue(new Map());
    const { db } = makeDb({ 'select:tokens': [[aged()]] });

    await pollTokenNow(db, 7);
    expect(vi.mocked(ds.findChainsFor)).not.toHaveBeenCalled();
  });

  it('never asked for a token that resolved', async () => {
    vi.mocked(gt.getTokensMulti).mockResolvedValue(new Map([['0xdud', tokenInfo()]]));
    vi.mocked(gt.getPoolsMulti).mockResolvedValue(new Map([['0xpool', poolInfo()]]));
    const { db, calls } = makeDb({ 'select:tokens': [[aged()]] });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await pollTokenNow(db, 7);

    expect(vi.mocked(ds.findChainsFor)).not.toHaveBeenCalled();
    expect(find(calls, 'insert:snapshots')).toHaveLength(1);
    log.mockRestore();
  });

  it('a failed any-chain lookup is not a verdict — and the NEXT attempt asks again', async () => {
    vi.mocked(ds.findChainsFor)
      .mockRejectedValueOnce(new Error('dexscreener 502'))
      .mockResolvedValue(new Set(['base']));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const blip = makeDb({ 'select:tokens': [[aged()]] });
    await pollTokenNow(blip.db, 7);
    expect(died(blip.calls)).toHaveLength(0);
    expect(find(blip.calls, 'update:tokens').filter(isStamp)).toHaveLength(1);
    expect(warn).toHaveBeenCalled();

    // The blip cost the token nothing: its next scheduled attempt asks again
    // and gets the honest label, instead of riding 48h to never_graduated.
    const retry = makeDb({
      ...deathScript,
      'select:tokens': [[aged({ lastPolledAt: new Date(NOW - 300_000) })]],
    });
    await pollTokenNow(retry.db, 7);
    expect(died(retry.calls)[0]?.set?.deathReason).toBe('wrong_chain:base');
    expect(vi.mocked(ds.findChainsFor)).toHaveBeenCalledTimes(2);

    warn.mockRestore();
    log.mockRestore();
  });

  it('the death is guarded on its evidence: a token resolved meanwhile survives', async () => {
    // The tick loaded this row as unresolved; a concurrent poll resolved it
    // before the verdict landed. The guarded UPDATE matches no row, so there is
    // no death — the attempt just stamps like any other silent one.
    vi.mocked(ds.findChainsFor).mockResolvedValue(new Set(['base']));
    const { db, calls } = makeDb({ 'select:tokens': [[aged()]] });

    await pollTokenNow(db, 7);

    const attempt = died(calls)[0];
    // ...and the guard really is the evidence, not just "not already dead".
    expect(dialect.sqlToQuery(attempt!.where!).params).toContain('unresolved');
    // No call was dragged down with it, and the clock moved on normally.
    expect(find(calls, 'update:calls').some((c) => c.set?.status === 'died')).toBe(false);
    expect(find(calls, 'update:tokens').filter(isStamp)).toHaveLength(1);
  });

  it('hands back the watch slots it holds, like a permanent rug', async () => {
    vi.mocked(ds.findChainsFor).mockResolvedValue(new Set(['base']));
    const { db, calls } = makeDb({
      ...deathScript,
      'select:tokens': [[aged()]],
      'update:watches': [[{ groupId: 2 }, { groupId: 2 }, { groupId: 5 }]],
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await pollTokenNow(db, 7);

    // Nothing here can ever revive, so a watch on it can never fire again —
    // but it would keep counting against its adder's 3-slot cap forever.
    const released = find(calls, 'update:watches')[0];
    expect(released?.set).toEqual({ active: false });
    log.mockRestore();
  });
});

/* --------------------------------------------------------- wrong-chain corpses */

describe('pollDead — a wrong-chain corpse sweeps, but asks no market anything', () => {
  const corpse = (over: Partial<TokenRow> = {}): TokenRow =>
    unresolvedRow({
      phase: 'dead',
      deathReason: wrongChainReason('base'),
      diedAt: new Date(NOW - 3_600_000),
      lastPolledAt: new Date(NOW - 3_600_000),
      ...over,
    });

  it('consumes the repost, sweeps any new call onto the death, and stamps', async () => {
    const { db, calls } = makeDb();
    await pollDead(db, corpse(), OPTS);

    expect(vi.mocked(gt.getPool)).not.toHaveBeenCalled();
    expect(vi.mocked(gt.getPoolsMulti)).not.toHaveBeenCalled();
    expect(vi.mocked(ds.getBestPairs)).not.toHaveBeenCalled();
    expect(calls.map((c) => c.key)).toEqual(['update:calls', 'update:calls', 'update:tokens']);
    // The revive flag is consumed whatever else happens — a standing request
    // would otherwise force a market read the moment any rule changed.
    expect(calls[0]?.set).toEqual({ reviveRequested: false });
    // A call posted after the death (another group's first call) inherits the
    // token's death record rather than showing as live.
    expect(calls[1]?.set?.status).toBe('died');
    expect(calls[1]?.set?.deathReason).toBe('wrong_chain:base');
    expect(isStamp(calls[2]!)).toBe(true);
    // Nothing was measured, so nothing is written as a measurement.
    expect(find(calls, 'insert:snapshots')).toHaveLength(0);
  });

  it('is reached by the TICK, so a late call cannot strand in FRESH', async () => {
    // Round 17b review: the corpse used to be off the tick entirely, which left
    // a first call from another group relying on one fire-and-forget poll. Now
    // it rides the daily dead cadence — the market READ is what it skips.
    const { db, calls } = makeDb({
      'select:tokens': [[candidateRow(corpse({ lastPolledAt: new Date(NOW - 25 * 3_600_000) }))]],
    });

    await runTick(db);

    expect(vi.mocked(gt.getPool)).not.toHaveBeenCalled();
    expect(vi.mocked(gt.getPoolsMulti)).not.toHaveBeenCalled();
    expect(vi.mocked(ds.getBestPairs)).not.toHaveBeenCalled();
    const swept = find(calls, 'update:calls').find((c) => c.set?.status === 'died');
    expect(swept?.set?.deathReason).toBe('wrong_chain:base');
    expect(find(calls, 'update:tokens').filter(isStamp)).toHaveLength(1);
  });

  it('cannot be revived by a market that is not there', async () => {
    // Even if some other chain's price were somehow handed to us, the corpse
    // never reaches the revival test: it returns before any read.
    const { db, calls } = makeDb({ 'update:tokens': [[{ id: 7 }]] });
    await pollDead(db, corpse(), OPTS, new Map([['0xpool', poolInfo({ fdvUsd: 5_000_000 })]]));
    expect(find(calls, 'update:tokens').some((c) => 'phase' in (c.set ?? {}))).toBe(false);
  });
});

/* ------------------------------------------------------------ the tick's batch */

describe('runTick resolution batch (round 17b)', () => {
  it('resolves every due address through ONE token call', async () => {
    const batch = [
      unresolvedRow({ id: 1, address: '0xa' }),
      unresolvedRow({ id: 2, address: '0xb' }),
      unresolvedRow({ id: 3, address: '0xc' }),
    ];
    const { db, calls } = makeDb({ 'select:tokens': [batch.map(candidateRow)] });

    await runTick(db);

    expect(vi.mocked(gt.getTokensMulti).mock.calls).toEqual([[['0xa', '0xb', '0xc']]]);
    // ...and one DexScreener call for the three GT did not carry, not three.
    expect(vi.mocked(ds.getBestPairs).mock.calls).toEqual([[['0xa', '0xb', '0xc']]]);
    // Each token still got its own handling: three stamps, no snapshots.
    expect(find(calls, 'update:tokens').filter(isStamp)).toHaveLength(3);
  });

  it('handles a batched token exactly as the immediate poll handles it', async () => {
    vi.mocked(gt.getTokensMulti).mockResolvedValue(new Map([['0xdud', tokenInfo()]]));
    vi.mocked(gt.getPoolsMulti).mockResolvedValue(new Map([['0xpool', poolInfo()]]));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const single = makeDb({ 'select:tokens': [[unresolvedRow()]] });
    await pollTokenNow(single.db, 7);

    const batched = makeDb({ 'select:tokens': [[candidateRow(unresolvedRow())]] });
    await runTick(batched.db);

    expect(batched.calls.map((c) => c.key)).toEqual(single.calls.map((c) => c.key));
    expect(find(single.calls, 'insert:snapshots')[0]?.values).toEqual({
      tokenId: 7,
      priceUsd: 0.0002,
      mcapUsd: 200_000,
      liquidityUsd: 30_000,
      vol24Usd: 10_000,
    });
    expect(find(batched.calls, 'insert:snapshots')[0]?.values).toEqual(
      find(single.calls, 'insert:snapshots')[0]?.values,
    );
    log.mockRestore();
  });

  it('a failed batch defers the tier — and STAMPS it, so a dud cannot retry every tick', async () => {
    // The realistic throw is the 429 the budgeter just parked on. Left
    // unstamped, the same tokens are due again 15 seconds later and burn a GT
    // grant per cooldown cycle for as long as the 429s last. Nothing else is
    // written: a stamp no longer spends anything the token needed.
    vi.mocked(gt.getTokensMulti).mockRejectedValue(new Error('geckoterminal 429'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { db, calls } = makeDb({
      'select:tokens': [[candidateRow(unresolvedRow({ id: 1 })), candidateRow(unresolvedRow({ id: 2 }))]],
    });

    await runTick(db);

    expect(calls.map((c) => c.key)).toEqual(['select:tokens', 'update:tokens']);
    expect(isStamp(calls[1]!)).toBe(true);
    // One statement for the whole batch, not one per token.
    expect(find(calls, 'update:tokens')).toHaveLength(1);
    expect(vi.mocked(ds.findChainsFor)).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('drives a wrong-chain verdict through the batched `pre` path', async () => {
    // The tick's own shape: one batch, mixed answers. 0xa is on this chain and
    // resolves; 0xb is on none of it, and dies for it — once, by address.
    const seenAt = new Date(NOW - POLL_TIERS.wrongChainMinMinutes * 60_000 - 60_000);
    const batch = [
      unresolvedRow({ id: 1, address: '0xa', firstSeenAt: seenAt }),
      unresolvedRow({ id: 2, address: '0xb', firstSeenAt: seenAt }),
    ];
    vi.mocked(gt.getTokensMulti).mockResolvedValue(
      new Map([['0xa', tokenInfo({ address: '0xa', topPoolAddress: '0xpool1' })]]),
    );
    vi.mocked(gt.getPoolsMulti).mockResolvedValue(new Map([['0xpool1', poolInfo({ poolAddress: '0xpool1' })]]));
    vi.mocked(ds.getBestPairs).mockResolvedValue(new Map());
    vi.mocked(ds.findChainsFor).mockResolvedValue(new Set(['base']));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { db, calls } = makeDb({
      'select:tokens': [batch.map(candidateRow)],
      'update:tokens': [[{ id: 2, mcapAtDeath: null }]],
    });

    await runTick(db);

    // Asked for exactly the address the batch could not carry.
    expect(vi.mocked(ds.findChainsFor).mock.calls).toEqual([['0xb']]);
    expect(died(calls)[0]?.set?.deathReason).toBe('wrong_chain:base');
    // ...while 0xa's own resolution is untouched by its neighbour's death.
    expect(find(calls, 'insert:snapshots')).toHaveLength(1);
    expect(find(calls, 'insert:snapshots')[0]?.values).toMatchObject({ tokenId: 1 });
    log.mockRestore();
  });
});
