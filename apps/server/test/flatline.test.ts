import { beforeEach, describe, expect, it, vi } from 'vitest';
import { is, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { SQL as SQLClass } from 'drizzle-orm/sql/sql';
import { calls as callsTable, snapshots, tokens, watches, type Db } from '@groupie/db';
import { DEATH, FLATLINE_DEATH_REASON, MEMBER_DEATH_REASON, THRESHOLDS } from '@groupie/shared';
import type { GtPoolInfo } from '../src/market/geckoterminal.js';
import type { DsPair } from '../src/market/dexscreener.js';
import {
  flatlineDeathDue,
  flatlineElapsed,
  flatlineVerdict,
  flatlineVolumeRecovered,
  retracePctFromPeak,
} from '../src/poller/flatline.js';
import { isRevived } from '../src/poller/death.js';

/**
 * Round 21's flatline death (docs/decisions.md round 21).
 *
 * $VLR is the case: 0.4x, $106K -> $46K on $19K of INTACT liquidity, which
 * every rule before this one reads as a living coin. What it has actually lost
 * is its tape, so the rule watches volume and trades against the peak — and,
 * because one quiet reading is not a death, the clock (`tokens.flat_since`) is
 * as much the rule as the condition is.
 *
 * Harness style is curveBatch.test.ts's: the Drizzle builder is faked and the
 * assertions are about the statements the poller attempted.
 */

vi.mock('../src/market/geckoterminal.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/market/geckoterminal.js')>();
  return { ...actual, getPool: vi.fn(), getPoolsMulti: vi.fn() };
});
vi.mock('../src/market/dexscreener.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/market/dexscreener.js')>();
  return { ...actual, getBestPairs: vi.fn(), findChainsFor: vi.fn() };
});
vi.mock('../src/poller/alerts.js', () => ({ runAlertPass: vi.fn(async () => undefined) }));

const gt = await import('../src/market/geckoterminal.js');
const ds = await import('../src/market/dexscreener.js');
const { pollCurve, pollDead } = await import('../src/poller/scheduler.js');

const dialect = new PgDialect();

interface DbCall {
  key: string;
  values?: Record<string, unknown>;
  set?: Record<string, unknown>;
  where?: SQL;
}

type Script = Record<string, unknown[][]>;

function chain(call: DbCall, take: (key: string) => unknown[]) {
  const node: Record<string, unknown> = {
    then: (ok: (rows: unknown[]) => unknown, err: (e: unknown) => unknown) =>
      Promise.resolve()
        .then(() => take(call.key))
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
    'leftJoin',
    'innerJoin',
    'groupBy',
  ]) {
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
    if (table === watches) return 'watches';
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
const whereText = (call: DbCall | undefined): string =>
  call?.where ? dialect.sqlToQuery(call.where).sql : '';
const setText = (call: DbCall | undefined, key: string): string => {
  const value = call?.set?.[key];
  return is(value, SQLClass) ? dialect.sqlToQuery(value).sql : String(value);
};
const setParams = (call: DbCall | undefined, key: string): unknown[] => {
  const value = call?.set?.[key];
  return is(value, SQLClass) ? (dialect.sqlToQuery(value).params as unknown[]) : [];
};
/** An app-clock stamp: `new Date().toISOString()`, the repo's raw-SQL convention. */
const isIso = (value: unknown): boolean =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value);

type TokenRow = typeof tokens.$inferSelect;

const NOW = Date.now();
const HOUR = 3_600_000;

function tokenRow(over: Partial<TokenRow> = {}): TokenRow {
  return {
    id: 7,
    chainId: 42161,
    address: '0xvlr',
    symbol: 'VLR',
    name: 'Valor',
    imageUrl: null,
    socials: null,
    launchpad: 'pons',
    phase: 'curve',
    poolAddress: '0xpool',
    tokenCreatedAt: new Date(NOW - 24 * HOUR),
    graduatedAt: null,
    diedAt: null,
    deathReason: null,
    mcapAtDeath: null,
    revivedAt: null,
    rugHiddenAt: null,
    revivingAt: null,
    priceUsd: 0.00005,
    mcapUsd: 46_000,
    liquidityUsd: 19_000,
    vol24Usd: 120,
    txns24: 3,
    flatSince: null,
    flatReadings: 0,
    flatLastAt: null,
    firstSeenAt: new Date(NOW - 24 * HOUR),
    lastPolledAt: new Date(NOW - 60_000),
    lastSnapshotAt: new Date(NOW - 60_000),
    ...over,
  };
}

function poolInfo(over: Partial<GtPoolInfo> = {}): GtPoolInfo {
  return {
    poolAddress: '0xpool',
    priceUsd: 0.00005,
    fdvUsd: 46_000,
    reserveUsd: 19_000,
    // The $VLR shape: money in the pool, nothing moving through it.
    vol24Usd: 120,
    txns24: 3,
    poolCreatedAt: new Date(NOW - 24 * HOUR),
    graduationPct: 42.5,
    graduated: false,
    migratedPoolAddress: null,
    dex: 'pons',
    lockedLiquidityPct: null,
    ...over,
  };
}

function dsPair(over: Partial<DsPair> = {}): DsPair {
  return {
    tokenAddress: '0xvlr',
    pairAddress: '0xpool',
    dexId: 'uniswap',
    symbol: 'VLR',
    name: 'Valor',
    imageUrl: null,
    socials: null,
    priceUsd: 0.00005,
    mcapUsd: 46_000,
    liquidityUsd: 19_000,
    vol24Usd: 120,
    txns24: 3,
    pairCreatedAt: new Date(NOW - 24 * HOUR),
    ...over,
  };
}

/**
 * A poll of one curve token. The peak-since-call the rule is judged against is
 * whatever the peak UPDATE returns, so it is scripted as the first
 * `update:calls` answer — exactly where the poller reads it from.
 */
async function poll(script: Script, over: Partial<TokenRow> = {}): Promise<DbCall[]> {
  const { db, calls } = makeDb(script);
  vi.mocked(gt.getPool).mockResolvedValue(poolInfo());
  await pollCurve(db, tokenRow(over), { budgeted: false });
  return calls;
}

const peaks = (peak: number | null): unknown[][] => [[{ peak }]];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('flatlineVerdict — the round-21 table', () => {
  const flat = {
    mcapUsd: 46_000,
    peakMcapSinceCall: 400_000,
    vol24Usd: 120,
    txns24: 3,
  };

  it('holds on the $VLR shape: far off peak, no volume, no trades', () => {
    expect(flatlineVerdict(flat)).toBe('holds');
  });

  it('holds exactly AT each boundary the decision states', () => {
    // 85% off peak is in; $500 of volume is out (strictly below); 5 trades are in.
    expect(flatlineVerdict({ ...flat, mcapUsd: 15_000, peakMcapSinceCall: 100_000 })).toBe('holds');
    expect(flatlineVerdict({ ...flat, vol24Usd: DEATH.flatlineVolumeUsd - 1 })).toBe('holds');
    expect(flatlineVerdict({ ...flat, txns24: DEATH.flatlineTxns24 })).toBe('holds');
  });

  it('fails one tick the other side of each boundary', () => {
    expect(flatlineVerdict({ ...flat, mcapUsd: 15_100, peakMcapSinceCall: 100_000 })).toBe('fails');
    expect(flatlineVerdict({ ...flat, vol24Usd: DEATH.flatlineVolumeUsd })).toBe('fails');
    expect(flatlineVerdict({ ...flat, txns24: DEATH.flatlineTxns24 + 1 })).toBe('fails');
  });

  it('a coin that is merely down is not flat', () => {
    // 60% off peak with volume and trades: a loss, and the board keeps showing it.
    expect(
      flatlineVerdict({ mcapUsd: 40_000, peakMcapSinceCall: 100_000, vol24Usd: 9_000, txns24: 90 }),
    ).toBe('fails');
  });

  it('UNKNOWN DATA IS NEVER A VERDICT: any missing input answers unknown', () => {
    expect(flatlineVerdict({ ...flat, vol24Usd: null })).toBe('unknown');
    expect(flatlineVerdict({ ...flat, txns24: null })).toBe('unknown');
    expect(flatlineVerdict({ ...flat, mcapUsd: null })).toBe('unknown');
    // No active call means no peak-since-call: the rule does not apply.
    expect(flatlineVerdict({ ...flat, peakMcapSinceCall: null })).toBe('unknown');
    expect(flatlineVerdict({ ...flat, peakMcapSinceCall: 0 })).toBe('unknown');
    expect(flatlineVerdict({ ...flat, vol24Usd: Number.NaN })).toBe('unknown');
  });

  it('a tier whose reading carries no trade count cannot flatline anything', () => {
    // The whole point of storing txns24 as nullable: "not reported" is not "no
    // trades", and only the second one is allowed to kill a coin.
    expect(flatlineVerdict({ ...flat, txns24: null })).not.toBe('holds');
  });
});

describe('retracePctFromPeak', () => {
  it('is clamped, so a reading above the peak is 0% off it, never negative', () => {
    expect(retracePctFromPeak(120, 100)).toBe(0);
    expect(retracePctFromPeak(50, 100)).toBe(50);
  });

  it('answers null when either side is missing or the peak is unusable', () => {
    expect(retracePctFromPeak(null, 100)).toBeNull();
    expect(retracePctFromPeak(50, null)).toBeNull();
    expect(retracePctFromPeak(50, 0)).toBeNull();
  });
});

describe('flatlineElapsed — the clock, not the condition', () => {
  it('needs the full window', () => {
    expect(flatlineElapsed(new Date(NOW - DEATH.flatlineHours * HOUR + 1_000), NOW)).toBe(false);
    expect(flatlineElapsed(new Date(NOW - DEATH.flatlineHours * HOUR), NOW)).toBe(true);
  });

  it('a clock we cannot read is not six hours old', () => {
    expect(flatlineElapsed(null, NOW)).toBe(false);
    expect(flatlineElapsed(new Date(Number.NaN), NOW)).toBe(false);
  });
});

describe('flatlineDeathDue — elapsed AND covered (round 21 amendment a)', () => {
  const covered = {
    flatSince: new Date(NOW - DEATH.flatlineHours * HOUR),
    readings: DEATH.flatlineMinReadings,
    previousReadingAt: new Date(NOW - 60_000),
  };

  it('all three clauses together are the death', () => {
    expect(flatlineDeathDue(covered, NOW)).toBe(true);
  });

  it('elapsed alone is not enough — a process that was down saw nothing', () => {
    expect(
      flatlineDeathDue({ ...covered, readings: DEATH.flatlineMinReadings - 1 }, NOW),
    ).toBe(false);
    expect(flatlineDeathDue({ ...covered, readings: null }, NOW)).toBe(false);
  });

  it('a hole before this reading is not an unbroken run', () => {
    const gap = DEATH.flatlineMaxGapMinutes * 60_000;
    expect(
      flatlineDeathDue({ ...covered, previousReadingAt: new Date(NOW - gap) }, NOW),
    ).toBe(true);
    expect(
      flatlineDeathDue({ ...covered, previousReadingAt: new Date(NOW - gap - 1_000) }, NOW),
    ).toBe(false);
    // One reading is not six hours of anything.
    expect(flatlineDeathDue({ ...covered, previousReadingAt: null }, NOW)).toBe(false);
  });

  it('and the six hours are still required', () => {
    expect(
      flatlineDeathDue({ ...covered, flatSince: new Date(NOW - 5 * HOUR) }, NOW),
    ).toBe(false);
    expect(flatlineDeathDue({ ...covered, flatSince: null }, NOW)).toBe(false);
  });
});

describe('the flat_since transitions (scheduler)', () => {
  it('starts the clock on the first holding reading, without moving an existing one', async () => {
    const calls = await poll({ 'update:calls': peaks(400_000) });
    const clock = find(calls, 'update:tokens')[1];
    // coalesce is what makes the first writer's stamp the one that counts: a
    // concurrent poll re-running this statement cannot restart the six hours.
    expect(setText(clock, 'flatSince')).toContain('coalesce');
    // ...and the stamp is the APP clock the whole file writes with — an ISO
    // parameter cast to timestamptz, never the database's now(), so a clock and
    // the readings it is compared against cannot come from two sources.
    expect(setText(clock, 'flatSince')).not.toContain('now()');
    expect(setParams(clock, 'flatSince').some(isIso)).toBe(true);
    expect(setParams(clock, 'flatLastAt').some(isIso)).toBe(true);
    expect(setText(clock, 'flatLastAt')).not.toContain('now()');
  });

  it('counts the reading into the run: 0 -> 1 when the clock starts, +1 after', async () => {
    const calls = await poll({ 'update:calls': peaks(400_000) });
    const clock = find(calls, 'update:tokens')[1];
    // Elapsed time is not coverage (round 21 amendment a) — the count is what
    // an outage cannot fake.
    expect(setText(clock, 'flatReadings')).toContain('flat_readings');
    expect(setText(clock, 'flatReadings')).toContain('+ 1');
    expect(setText(clock, 'flatReadings')).toContain('then 1');
  });

  it('a reading whose predecessor is stale starts a FRESH run, not an inherited one', async () => {
    const calls = await poll({ 'update:calls': peaks(400_000) });
    const clock = find(calls, 'update:tokens')[1];
    // Judged inside the statement because SET sees the OLD row — the only place
    // the previous reading's stamp still exists once this one is written.
    const since = setText(clock, 'flatSince');
    expect(since).toContain('flat_last_at');
    expect(since).toContain(`interval '${DEATH.flatlineMaxGapMinutes} minutes'`);
    expect(since).toContain('case when');
  });

  it('clears the clock when the condition FAILS — counters and all', async () => {
    // Volume is back: whatever the last six hours looked like, this is a market.
    vi.mocked(gt.getPool).mockResolvedValue(poolInfo({ vol24Usd: 40_000, txns24: 400 }));
    const { db, calls } = makeDb({ 'update:calls': peaks(400_000) });
    await pollCurve(
      db,
      tokenRow({ flatSince: new Date(NOW - 5 * HOUR), flatReadings: 40, flatLastAt: new Date() }),
      { budgeted: false },
    );
    const clock = find(calls, 'update:tokens')[1];
    expect(clock?.set?.flatSince).toBeNull();
    // The count only ever describes the run the clock was timing.
    expect(clock?.set?.flatReadings).toBe(0);
    expect(clock?.set?.flatLastAt).toBeNull();
    // Guarded, so the overwhelming majority of polls write nothing at all.
    expect(whereText(clock)).toContain('is not null');
  });

  it('clears the clock on a reading that cannot measure volume or trades', async () => {
    // Not evidence of silence — an absence of evidence. Same effect as failure.
    vi.mocked(gt.getPool).mockResolvedValue(poolInfo({ vol24Usd: null }));
    const { db, calls } = makeDb({ 'update:calls': peaks(400_000) });
    await pollCurve(db, tokenRow({ flatSince: new Date(NOW - 5 * HOUR) }), { budgeted: false });
    expect(find(calls, 'update:tokens')[1]?.set?.flatSince).toBeNull();

    vi.mocked(gt.getPool).mockResolvedValue(poolInfo({ txns24: null }));
    const second = makeDb({ 'update:calls': peaks(400_000) });
    await pollCurve(second.db, tokenRow({ flatSince: new Date(NOW - 5 * HOUR) }), {
      budgeted: false,
    });
    expect(find(second.calls, 'update:tokens')[1]?.set?.flatSince).toBeNull();
  });

  it('a token with no active call has no peak, so no clock ever starts', async () => {
    // The peak UPDATE hits no rows; the rule is "since the call", and there is
    // no call to be 85% below.
    const calls = await poll({ 'update:calls': [[]] });
    expect(find(calls, 'update:tokens')[1]?.set?.flatSince).toBeNull();
  });

  it('does NOT kill before the window is up', async () => {
    const { db, calls } = makeDb({
      'update:calls': peaks(400_000),
      'update:tokens': [[], [{ flatSince: new Date(NOW - 5 * HOUR), flatReadings: 400 }]],
    });
    vi.mocked(gt.getPool).mockResolvedValue(poolInfo());
    await pollCurve(db, tokenRow({ flatLastAt: new Date(NOW - 60_000) }), { budgeted: false });
    expect(find(calls, 'update:tokens').some((c) => c.set?.phase === 'dead')).toBe(false);
  });

  it('kills with reason flatline once the run is old enough AND covered', async () => {
    const { db, calls } = makeDb({
      'update:calls': peaks(400_000),
      'update:tokens': [
        [], // the market-cache write
        [
          {
            flatSince: new Date(NOW - DEATH.flatlineHours * HOUR - 60_000),
            flatReadings: DEATH.flatlineMinReadings,
          },
        ],
        [{ id: 7, mcapAtDeath: 46_000 }], // markTokenDead's RETURNING
      ],
    });
    vi.mocked(gt.getPool).mockResolvedValue(poolInfo());
    // Twelve holding readings across the six hours, the last of them a minute
    // ago: a run nothing was blind for.
    await pollCurve(db, tokenRow({ flatLastAt: new Date(NOW - 60_000) }), { budgeted: false });

    const death = find(calls, 'update:tokens').find((c) => c.set?.phase === 'dead');
    expect(death?.set?.deathReason).toBe(FLATLINE_DEATH_REASON);
    // From the token's OWN column — the reading this poll just cached.
    expect(setText(death, 'mcapAtDeath')).toContain('mcap_usd');
    // A death ends the clock; a revived coin must not inherit six hours it
    // spent not being polled for a tape.
    expect(death?.set?.flatSince).toBeNull();
    expect(death?.set?.flatReadings).toBe(0);
    expect(death?.set?.flatLastAt).toBeNull();
  });

  it('two readings six hours apart do NOT kill — an outage is not six quiet hours', async () => {
    const { db, calls } = makeDb({
      'update:calls': peaks(400_000),
      'update:tokens': [
        [],
        // Even a row claiming the elapsed hours and the readings...
        [
          {
            flatSince: new Date(NOW - DEATH.flatlineHours * HOUR - 60_000),
            flatReadings: DEATH.flatlineMinReadings,
          },
        ],
      ],
    });
    vi.mocked(gt.getPool).mockResolvedValue(poolInfo());
    // ...cannot kill when the reading before this one was six hours ago.
    await pollCurve(db, tokenRow({ flatLastAt: new Date(NOW - 6 * HOUR) }), { budgeted: false });
    expect(find(calls, 'update:tokens').some((c) => c.set?.phase === 'dead')).toBe(false);
  });

  it('twelve readings are the floor: eleven do not kill', async () => {
    const { db, calls } = makeDb({
      'update:calls': peaks(400_000),
      'update:tokens': [
        [],
        [
          {
            flatSince: new Date(NOW - DEATH.flatlineHours * HOUR - 60_000),
            flatReadings: DEATH.flatlineMinReadings - 1,
          },
        ],
      ],
    });
    vi.mocked(gt.getPool).mockResolvedValue(poolInfo());
    await pollCurve(db, tokenRow({ flatLastAt: new Date(NOW - 60_000) }), { budgeted: false });
    expect(find(calls, 'update:tokens').some((c) => c.set?.phase === 'dead')).toBe(false);
  });

  it('caches the trade count with its own reading, nulls included', async () => {
    const calls = await poll({ 'update:calls': peaks(400_000) });
    const cache = find(calls, 'update:tokens')[0];
    expect(cache?.set?.txns24).toBe(3);
    expect(cache?.set?.vol24Usd).toBe(120);
  });

  it('a corpse that stays dead never runs the rule at all', async () => {
    // Its clock was cleared when it died, and a dead poll writes no market
    // state. (A corpse that REVIVES is alive again and is judged like any other
    // living token from that poll on — which is the point of clearing it.)
    vi.mocked(ds.getBestPairs).mockResolvedValue(new Map([['0xvlr', dsPair({ mcapUsd: 5_000 })]]));
    const { db, calls } = makeDb({});
    await pollDead(
      db,
      tokenRow({ phase: 'dead', deathReason: 'liquidity_floor', graduatedAt: new Date() }),
      { budgeted: false },
    );
    expect(find(calls, 'update:tokens').some((c) => 'flatSince' in (c.set ?? {}))).toBe(false);
  });
});

describe('revival of a flatline corpse needs the volume back too', () => {
  const snap = (vol24Usd: number | null, mcapUsd = THRESHOLDS.revivalMcapUsd + 16_000) => ({
    priceUsd: null,
    mcapUsd,
    liquidityUsd: 19_000,
    vol24Usd,
    txns24: null,
  });

  it('mcap alone revives every OTHER corpse', () => {
    expect(isRevived('graduated', snap(0), null, 'liquidity_floor')).toBe(true);
    expect(isRevived('graduated', snap(0), null, null)).toBe(true);
  });

  it('...but not a flatline one — that mcap is exactly what the rule left standing', () => {
    expect(isRevived('graduated', snap(0), null, FLATLINE_DEATH_REASON)).toBe(false);
    expect(isRevived('graduated', snap(DEATH.flatlineRevivalVolumeUsd - 1), null, FLATLINE_DEATH_REASON)).toBe(false);
  });

  it('volume back at the bar revives it', () => {
    expect(isRevived('graduated', snap(DEATH.flatlineRevivalVolumeUsd), null, FLATLINE_DEATH_REASON)).toBe(true);
  });

  it('unknown volume is not a comeback', () => {
    expect(isRevived('graduated', snap(null), null, FLATLINE_DEATH_REASON)).toBe(false);
    expect(flatlineVolumeRecovered(null)).toBe(false);
  });

  it('still fails the mcap bar first, whatever the volume is', () => {
    expect(isRevived('graduated', snap(50_000, 1_000), null, FLATLINE_DEATH_REASON)).toBe(false);
  });

  it('graduating while dead does NOT revive a flatline corpse on the flag alone', () => {
    // Amendment (b): the curve exception is about the LAUNCHPAD, and this death
    // was about the tape. A completed curve with nothing trading through it is
    // the same six quiet hours all over again.
    expect(isRevived('curve', snap(0, 100), true, FLATLINE_DEATH_REASON)).toBe(false);
    expect(isRevived('curve', snap(0), true, FLATLINE_DEATH_REASON)).toBe(false);
    // ...while it still revives every other corpse on the flag alone.
    expect(isRevived('curve', snap(0, 100), true, 'rug_floor')).toBe(true);
  });

  it('a graduated flatline corpse with mcap AND volume back revives like any other', () => {
    expect(
      isRevived('curve', snap(DEATH.flatlineRevivalVolumeUsd), true, FLATLINE_DEATH_REASON),
    ).toBe(true);
  });
});

describe('a flatline corpse is re-read on the source it died on', () => {
  it('an ungraduated one reads the CURVE, never DexScreener (amendment c)', async () => {
    // DexScreener does not index a curve token, so a "best pair" lookup would
    // answer nothing for ever and the corpse could never come back.
    vi.mocked(gt.getPool).mockResolvedValue(poolInfo({ vol24Usd: 90_000, txns24: 900 }));
    const { db, calls } = makeDb({ 'update:tokens': [[{ id: 7 }]] });
    await pollDead(
      db,
      tokenRow({ phase: 'dead', deathReason: FLATLINE_DEATH_REASON, graduatedAt: null }),
      { budgeted: false },
    );
    expect(gt.getPool).toHaveBeenCalledWith('0xpool');
    expect(ds.getBestPairs).not.toHaveBeenCalled();
    // Read as a CURVE corpse all the way through: the revival puts it back on
    // the curve, because its pool has not graduated.
    const revived = find(calls, 'update:tokens').find((c) => c.set?.phase !== undefined);
    expect(revived?.set?.phase).toBe('curve');
  });

  it('a GRADUATED one still reads DexScreener', async () => {
    vi.mocked(ds.getBestPairs).mockResolvedValue(new Map([['0xvlr', dsPair({ mcapUsd: 5_000 })]]));
    const { db } = makeDb({});
    await pollDead(
      db,
      tokenRow({
        phase: 'dead',
        deathReason: FLATLINE_DEATH_REASON,
        graduatedAt: new Date(NOW - 12 * HOUR),
      }),
      { budgeted: false },
    );
    expect(ds.getBestPairs).toHaveBeenCalled();
    expect(gt.getPool).not.toHaveBeenCalled();
  });
});

describe('a member verdict survives every automatic revival', () => {
  it('the token coming back does not re-activate a member-dead call', async () => {
    vi.mocked(ds.getBestPairs).mockResolvedValue(
      new Map([['0xvlr', dsPair({ mcapUsd: 500_000, vol24Usd: 80_000 })]]),
    );
    const { db, calls } = makeDb({ 'update:tokens': [[{ id: 7 }]] });
    await pollDead(
      db,
      tokenRow({ phase: 'dead', deathReason: 'liquidity_floor', graduatedAt: new Date() }),
      { budgeted: false },
    );
    const revive = find(calls, 'update:calls').find((c) => c.set?.status === 'active');
    expect(revive).toBeDefined();
    const where = whereText(revive);
    expect(where).toContain('death_reason');
    expect(where).toContain('is null or');
    // The NULL branch matters: `<> 'member'` alone answers NULL for every death
    // recorded before per-call reasons existed, and would stop reviving them.
    expect(dialect.sqlToQuery(revive!.where!).params).toContain(MEMBER_DEATH_REASON);
  });

  it('a repost of a member-dead call is inert — the flag is consumed, nothing revives', async () => {
    // applyCallRevivals runs inside the ordinary poll; the call is dead by a
    // member's say-so, so the repost only records the mention.
    const { db, calls } = makeDb({
      'update:calls': peaks(400_000),
      'select:calls': [
        [], // fillCallBaselines: nothing missing a baseline
        [{ id: 91, status: 'died', deathReason: MEMBER_DEATH_REASON, liquidityAtCall: 50_000 }],
      ],
    });
    vi.mocked(gt.getPool).mockResolvedValue(poolInfo({ vol24Usd: 90_000, txns24: 900 }));
    await pollCurve(db, tokenRow(), { budgeted: false });

    // The revive flag is still consumed (a stale flag must never stand)...
    expect(find(calls, 'update:calls').some((c) => c.set?.reviveRequested === false)).toBe(true);
    // ...but nothing was put back on the board.
    expect(find(calls, 'update:calls').some((c) => c.set?.status === 'active')).toBe(false);
  });
});
