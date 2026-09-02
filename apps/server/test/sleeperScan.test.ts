import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sleeperEntries, sleeperSeen, type Db } from '@groupie/db';
import type { DsPair } from '../src/market/dexscreener.js';
import type { GtCandle, GtPoolListing } from '../src/market/geckoterminal.js';

/**
 * The scan's residency wiring (docs/decisions.md round 16b).
 *
 * The 24h re-verification bound only holds because a CARRIED row copies the
 * previous scan's measurement stamp instead of refreshing it, and because a
 * failed read persists no stamp at all. Both are single lines in
 * measureResidency, and neither is visible to sleeperLogic's unit tests.
 */

vi.mock('../src/market/geckoterminal.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/market/geckoterminal.js')>();
  return { ...actual, getTopPools: vi.fn(), getOhlcv: vi.fn(), getOhlcvMinutes: vi.fn() };
});
vi.mock('../src/market/dexscreener.js', () => ({
  getBestPairs: vi.fn(async () => new Map()),
  dsSnapshot: vi.fn(),
}));

const gt = await import('../src/market/geckoterminal.js');
const ds = await import('../src/market/dexscreener.js');
const { runSleeperScan } = await import('../src/poller/sleeperScan.js');

interface DbCall {
  key: string;
  values?: unknown;
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
    if (table === sleeperEntries) return 'sleeper_entries';
    if (table === sleeperSeen) return 'sleeper_seen';
    return 'unknown';
  };
  const start = (op: string, table: unknown) => {
    const call: DbCall = { key: `${op}:${nameOf(table)}` };
    calls.push(call);
    const node: Record<string, unknown> = {
      then: (ok: (rows: unknown[]) => unknown, err: (e: unknown) => unknown) =>
        Promise.resolve()
          .then(() => take(call.key))
          .then(ok, err),
    };
    for (const method of ['values', 'from', 'where', 'onConflictDoUpdate']) {
      node[method] = (...args: unknown[]) => {
        if (method === 'values') call.values = args[0];
        return node;
      };
    }
    return node;
  };
  const db = {
    insert: (table: unknown) => start('insert', table),
    delete: (table: unknown) => start('delete', table),
    select: () => ({ from: (table: unknown) => start('select', table) }),
  };
  return { db: db as unknown as Db, calls };
}

const NOW = Date.UTC(2026, 8, 2, 12, 0, 0);
const HOUR = 3_600_000;
const BAND = { loUsd: 50_000, hiUsd: 100_000 };
/** When the previous scan ran, and measured what it recorded. */
const T0 = NOW - 3 * HOUR;

function listing(over: Partial<GtPoolListing> = {}): GtPoolListing {
  return {
    poolAddress: '0xpoolcarried',
    baseTokenAddress: '0xcarried',
    poolName: 'CARRY / WETH 1%',
    mcapUsd: 80_000,
    // 1e9 supply at $80K — what the residency walk infers supply from.
    priceUsd: 0.00008,
    liquidityUsd: 25_000,
    vol24Usd: 200_000,
    txns24: 400,
    txns1h: 5,
    poolCreatedAt: new Date(NOW - 2 * 24 * HOUR),
    ...over,
  };
}

/** The previous scan's row for 0xcarried, as loadPreviousResidency reads it. */
const previousRow = {
  address: '0xcarried',
  bandLoUsd: BAND.loUsd,
  bandHiUsd: BAND.hiUsd,
  inBandHours: 12,
  scanAt: new Date(T0),
  residencyMeasuredAt: new Date(T0),
};

/**
 * Hourly candles, newest first: `inBand` of them in band, then one outside.
 * The newest one STARTS `newestAgoSec` ago — what both freshness rules read.
 */
function candles(inBand: number, newestAgoSec = 1_800): GtCandle[] {
  const newestSec = Math.floor(NOW / 1000) - newestAgoSec;
  return Array.from({ length: inBand + 1 }, (_, i) => {
    const close = i < inBand ? 0.00008 : 0.00002;
    return { tsSec: newestSec - i * 3_600, open: close, high: close, low: close, close };
  });
}

type Row = Record<string, unknown>;
const inserted = (calls: DbCall[]): Row[] =>
  (calls.find((c) => c.key === 'insert:sleeper_entries')?.values as Row[] | undefined) ?? [];
const rowFor = (calls: DbCall[], address: string): Row | undefined =>
  inserted(calls).find((r) => r.address === address);

beforeEach(() => {
  vi.mocked(gt.getTopPools).mockReset();
  vi.mocked(gt.getOhlcv).mockReset();
  vi.mocked(gt.getOhlcvMinutes).mockReset();
  vi.mocked(gt.getOhlcvMinutes).mockResolvedValue([]);
  vi.mocked(ds.getBestPairs).mockReset();
  vi.mocked(ds.getBestPairs).mockResolvedValue(new Map());
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

/** Runs the scan with the page/OHLCV sleeps driven off the fake clock. */
async function scan(db: Db): Promise<void> {
  const done = runSleeperScan(db);
  await vi.advanceTimersByTimeAsync(120_000);
  await done;
}

describe('measureResidency wiring', () => {
  it('carries the previous figure with the OLD stamp, and pays for candles only on the new one', async () => {
    vi.mocked(gt.getTopPools).mockImplementation(async (page: number) =>
      page === 1
        ? [
            listing(),
            listing({
              poolAddress: '0xpoolnew',
              baseTokenAddress: '0xnew',
              poolName: 'NEW / WETH 1%',
              vol24Usd: 100_000,
            }),
          ]
        : [],
    );
    vi.mocked(gt.getOhlcv).mockResolvedValue(candles(4));

    const { db, calls } = makeDb({ 'select:sleeper_entries': [[previousRow]] });
    await scan(db);

    // The carry is the whole point: no candle call for the address the previous
    // scan already measured in this band.
    expect(vi.mocked(gt.getOhlcv).mock.calls.map((c) => c[0])).toEqual(['0xpoolnew']);

    const carried = rowFor(calls, '0xcarried');
    // 12h as of the previous scan, plus the 3h since it ran.
    expect(carried?.inBandHours).toBeCloseTo(15, 6);
    // The stamp dates the last real MEASUREMENT, not this scan — refreshing it
    // here would push the re-verification out forever and let the figure drift.
    expect((carried?.residencyMeasuredAt as Date).getTime()).toBe(T0);

    const measured = rowFor(calls, '0xnew');
    // 30 minutes into the newest candle plus the three whole hours behind it.
    expect(measured?.inBandHours).toBeCloseTo(3.5, 6);
    expect((measured?.residencyMeasuredAt as Date).getTime()).toBe(NOW);
  });

  it('a failed read persists 0 hours and NO stamp, so the next scan measures it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(gt.getTopPools).mockImplementation(async (page: number) =>
      page === 1 ? [listing({ poolAddress: '0xpoolnew', baseTokenAddress: '0xnew' })] : [],
    );
    vi.mocked(gt.getOhlcv).mockRejectedValue(new Error('geckoterminal 429'));

    const { db, calls } = makeDb();
    await scan(db);

    const row = rowFor(calls, '0xnew');
    expect(row?.inBandHours).toBe(0);
    expect(row?.residencyMeasuredAt).toBeNull();
    warn.mockRestore();
  });

  it('a coin that stopped trading re-measures rather than carrying', async () => {
    // Zero trades in the last hour, but the trailing 24h figures keep it listed
    // and in the same band — the carry would credit it hours it did not trade.
    vi.mocked(gt.getTopPools).mockImplementation(async (page: number) =>
      page === 1 ? [listing({ txns1h: 0 })] : [],
    );
    vi.mocked(gt.getOhlcv).mockResolvedValue(candles(4));

    const { db, calls } = makeDb({ 'select:sleeper_entries': [[previousRow]] });
    await scan(db);

    expect(vi.mocked(gt.getOhlcv).mock.calls.map((c) => c[0])).toEqual(['0xpoolcarried']);
    const row = rowFor(calls, '0xcarried');
    expect(row?.inBandHours).toBeCloseTo(3.5, 6);
    expect((row?.residencyMeasuredAt as Date).getTime()).toBe(NOW);
  });
});

/* ---------------------------------------------- short holds (round 17) */

/** 15-minute candles, newest first: `inBand` in band, then one outside. */
function quarters(inBand: number, newestAgoSec = 300): GtCandle[] {
  const newestSec = Math.floor(NOW / 1000) - newestAgoSec;
  return Array.from({ length: inBand + 1 }, (_, i) => {
    const close = i < inBand ? 0.00008 : 0.00002;
    return { tsSec: newestSec - i * 900, open: close, high: close, low: close, close };
  });
}

describe('the 15-minute read', () => {
  it('pays for minute candles only on a NEW entry with no hourly residency', async () => {
    vi.mocked(gt.getTopPools).mockImplementation(async (page: number) =>
      page === 1
        ? [
            // Carried: previously measured in this band, so no candles at all.
            listing(),
            // New, and its hourly streak broke on the newest candle -> 0h.
            listing({
              poolAddress: '0xpoolshort',
              baseTokenAddress: '0xshort',
              poolName: 'SHORT / WETH 1%',
              vol24Usd: 100_000,
            }),
          ]
        : [],
    );
    vi.mocked(gt.getOhlcv).mockResolvedValue(candles(0));
    vi.mocked(gt.getOhlcvMinutes).mockResolvedValue(quarters(2));

    const { db, calls } = makeDb({ 'select:sleeper_entries': [[previousRow]] });
    await scan(db);

    // Exactly one extra call, for the one new short entry.
    const minuteCalls = vi.mocked(gt.getOhlcvMinutes).mock.calls;
    expect(minuteCalls.map((c) => c[0])).toEqual(['0xpoolshort']);
    // 15-minute buckets, 3h of window, and the scan's own budget priority.
    expect(minuteCalls[0]?.slice(1)).toEqual([15, 12, 'scan']);

    // Two in-band closes = 30 minutes, which is what the 30m chip filters on.
    expect(rowFor(calls, '0xshort')?.inBandHours).toBeCloseTo(0.5, 6);
    expect((rowFor(calls, '0xshort')?.residencyMeasuredAt as Date).getTime()).toBe(NOW);
  });

  it('never asks once the hourly walk has established three hours', async () => {
    vi.mocked(gt.getTopPools).mockImplementation(async (page: number) =>
      page === 1 ? [listing({ poolAddress: '0xpoolnew', baseTokenAddress: '0xnew' })] : [],
    );
    // 3.5h off the hourly candles — past the short-hold threshold.
    vi.mocked(gt.getOhlcv).mockResolvedValue(candles(4));

    const { db, calls } = makeDb();
    await scan(db);

    expect(vi.mocked(gt.getOhlcvMinutes)).not.toHaveBeenCalled();
    expect(rowFor(calls, '0xnew')?.inBandHours).toBeCloseTo(3.5, 6);
  });

  it('never asks after a failed hourly read — that failure is the budgeter talking', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(gt.getTopPools).mockImplementation(async (page: number) =>
      page === 1 ? [listing({ poolAddress: '0xpoolnew', baseTokenAddress: '0xnew' })] : [],
    );
    vi.mocked(gt.getOhlcv).mockRejectedValue(new Error('geckoterminal 429'));

    const { db, calls } = makeDb();
    await scan(db);

    expect(vi.mocked(gt.getOhlcvMinutes)).not.toHaveBeenCalled();
    expect(rowFor(calls, '0xnew')?.residencyMeasuredAt).toBeNull();
    warn.mockRestore();
  });

  it('keeps the hourly figure when the minute read comes back with NO reading', async () => {
    vi.mocked(gt.getTopPools).mockImplementation(async (page: number) =>
      page === 1 ? [listing({ poolAddress: '0xpoolnew', baseTokenAddress: '0xnew' })] : [],
    );
    // 2.5h hourly, and not one readable 15-minute candle: nothing to replace it.
    vi.mocked(gt.getOhlcv).mockResolvedValue(candles(3));
    vi.mocked(gt.getOhlcvMinutes).mockResolvedValue([]);

    const { db, calls } = makeDb();
    await scan(db);

    expect(vi.mocked(gt.getOhlcvMinutes)).toHaveBeenCalledTimes(1);
    expect(rowFor(calls, '0xnew')?.inBandHours).toBeCloseTo(2.5, 6);
  });

  it('lets a stale minute window OVERRULE the hourly figure below the threshold', async () => {
    vi.mocked(gt.getTopPools).mockImplementation(async (page: number) =>
      page === 1 ? [listing({ poolAddress: '0xpoolnew', baseTokenAddress: '0xnew' })] : [],
    );
    // The hourly span says 2.5h, but the finer data the round bought shows the
    // last 15-minute bucket started 45 minutes ago: nothing has traded in band
    // since, and no chip under 3h may claim this coin.
    vi.mocked(gt.getOhlcv).mockResolvedValue(candles(3));
    vi.mocked(gt.getOhlcvMinutes).mockResolvedValue(quarters(4, 2_700));

    const { db, calls } = makeDb();
    await scan(db);

    expect(rowFor(calls, '0xnew')?.inBandHours).toBe(0);
    expect((rowFor(calls, '0xnew')?.residencyMeasuredAt as Date).getTime()).toBe(NOW);
  });

  it('never asks when the listing says the coin has not traded this hour', async () => {
    // txns1h 0 means no 15-minute bucket can have started inside the freshness
    // window, so the call's answer (0) is known before it is made.
    vi.mocked(gt.getTopPools).mockImplementation(async (page: number) =>
      page === 1
        ? [listing({ poolAddress: '0xpoolnew', baseTokenAddress: '0xnew', txns1h: 0 })]
        : [],
    );
    vi.mocked(gt.getOhlcv).mockResolvedValue(candles(0));

    const { db, calls } = makeDb();
    await scan(db);

    expect(vi.mocked(gt.getOhlcvMinutes)).not.toHaveBeenCalled();
    expect(rowFor(calls, '0xnew')?.inBandHours).toBe(0);
  });

  it('never asks when the newest hourly candle is already older than the window', async () => {
    vi.mocked(gt.getTopPools).mockImplementation(async (page: number) =>
      page === 1 ? [listing({ poolAddress: '0xpoolnew', baseTokenAddress: '0xnew' })] : [],
    );
    // Newest hourly candle started 100 minutes ago — more than 30 + 60 — so the
    // hour that would hold a fresh 15-minute bucket has no candle at all.
    vi.mocked(gt.getOhlcv).mockResolvedValue(candles(1, 100 * 60));

    const { db, calls } = makeDb();
    await scan(db);

    expect(vi.mocked(gt.getOhlcvMinutes)).not.toHaveBeenCalled();
    // Below the 3h threshold the minute evidence is the only evidence: a read
    // the listing already proved would answer 0 is recorded as that 0, never
    // as the hourly span it would have overwritten.
    expect(rowFor(calls, '0xnew')?.inBandHours).toBe(0);
  });

  it('a failed minute read keeps the hourly figure AND its stamp', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(gt.getTopPools).mockImplementation(async (page: number) =>
      page === 1 ? [listing({ poolAddress: '0xpoolnew', baseTokenAddress: '0xnew' })] : [],
    );
    vi.mocked(gt.getOhlcv).mockResolvedValue(candles(3));
    vi.mocked(gt.getOhlcvMinutes).mockRejectedValue(new Error('geckoterminal 429'));

    const { db, calls } = makeDb();
    await scan(db);

    const row = rowFor(calls, '0xnew');
    // The hourly walk was a real measurement; a 429 on the follow-up call is no
    // reason to make the next scan pay for it again.
    expect(row?.inBandHours).toBeCloseTo(2.5, 6);
    expect((row?.residencyMeasuredAt as Date).getTime()).toBe(NOW);
    const warnings = warn.mock.calls.map((c) => String(c[0]));
    expect(warnings.some((line) => line.includes('hourly figure kept'))).toBe(true);
    // ...and it is not counted as a residency failure.
    expect(warnings.some((line) => line.includes('residency reads failed'))).toBe(false);
    warn.mockRestore();
  });
});

/* ------------------------------------------- tokenized stocks (round 17) */

function dsPair(tokenAddress: string, name: string, symbol: string): DsPair {
  return {
    tokenAddress,
    pairAddress: null,
    dexId: null,
    symbol,
    name,
    imageUrl: null,
    socials: null,
    priceUsd: null,
    mcapUsd: null,
    liquidityUsd: null,
    vol24Usd: null,
    pairCreatedAt: null,
  };
}

const QQQ_NAME = 'Invesco QQQ • Robinhood Token';

/** A coin (two pools), a tokenized stock, and one listing that qualifies for nothing. */
function stockListings(): GtPoolListing[] {
  return [
    listing({ poolAddress: '0xpoolcoin', baseTokenAddress: '0xcoin', poolName: 'COIN / WETH 1%' }),
    listing({
      poolAddress: '0xpoolcoin2',
      baseTokenAddress: '0xcoin',
      poolName: 'COIN / WETH 0.3%',
      vol24Usd: 50_000,
    }),
    listing({ poolAddress: '0xpoolqqq', baseTokenAddress: '0xqqq', poolName: 'QQQ / WETH 1%' }),
    // Below the absolute liquidity floor: never looked up, never kept.
    listing({ poolAddress: '0xpoolthin', baseTokenAddress: '0xthin', liquidityUsd: 500 }),
  ];
}

describe('the DexScreener name behind is_stock', () => {
  beforeEach(() => {
    vi.mocked(gt.getTopPools).mockImplementation(async (page: number) =>
      page === 1 ? stockListings() : [],
    );
    // 3.5h in band, so no entry pays for a 15-minute read on top.
    vi.mocked(gt.getOhlcv).mockResolvedValue(candles(4));
  });

  it('persists the DS name and the stock flag, looked up before any candle call', async () => {
    vi.mocked(ds.getBestPairs).mockResolvedValue(
      new Map([
        ['0xcoin', dsPair('0xcoin', 'Coin Token', 'COIN')],
        ['0xqqq', dsPair('0xqqq', QQQ_NAME, 'QQQ')],
      ]),
    );

    const { db, calls } = makeDb();
    await scan(db);

    // Exactly the qualified addresses, deduped to one per token — the thin pool
    // cannot be kept whatever it is called, and the coin's second pool is the
    // same token.
    expect(vi.mocked(ds.getBestPairs).mock.calls).toEqual([[['0xcoin', '0xqqq']]]);
    // The name decides the keep cut, so it has to be known before selection —
    // and selection is what the residency calls run over.
    expect(vi.mocked(ds.getBestPairs).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(gt.getOhlcv).mock.invocationCallOrder[0] ?? Infinity,
    );

    expect(rowFor(calls, '0xqqq')).toMatchObject({ isStock: true, name: QQQ_NAME, symbol: 'QQQ' });
    expect(rowFor(calls, '0xcoin')).toMatchObject({ isStock: false, name: 'Coin Token' });
    expect(rowFor(calls, '0xthin')).toBeUndefined();
  });

  it('retries a failed batch once rather than serving the stock as a coin', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(ds.getBestPairs)
      .mockRejectedValueOnce(new Error('dexscreener 429'))
      .mockResolvedValue(new Map([['0xqqq', dsPair('0xqqq', QQQ_NAME, 'QQQ')]]));

    const { db, calls } = makeDb();
    await scan(db);

    expect(vi.mocked(ds.getBestPairs)).toHaveBeenCalledTimes(2);
    expect(rowFor(calls, '0xqqq')).toMatchObject({ isStock: true, name: QQQ_NAME });
    warn.mockRestore();
  });

  it('says how many addresses a still-failing batch left unnamed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(ds.getBestPairs).mockRejectedValue(new Error('dexscreener 429'));

    const { db, calls } = makeDb();
    await scan(db);

    expect(vi.mocked(ds.getBestPairs)).toHaveBeenCalledTimes(2);
    // The degraded scan is visible: an unnamed equity is kept and served as a
    // coin, in a coin's band slot.
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      '2/2 qualified addresses left unnamed',
    );
    expect(rowFor(calls, '0xqqq')).toMatchObject({ isStock: false, name: null });
    warn.mockRestore();
  });
});
