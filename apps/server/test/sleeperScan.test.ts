import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sleeperEntries, sleeperSeen, type Db } from '@groupie/db';
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
  return { ...actual, getTopPools: vi.fn(), getOhlcv: vi.fn() };
});
vi.mock('../src/market/dexscreener.js', () => ({
  getBestPairs: vi.fn(async () => new Map()),
  dsSnapshot: vi.fn(),
}));

const gt = await import('../src/market/geckoterminal.js');
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

/** Hourly candles, newest first: `inBand` of them in band, then one outside. */
function candles(inBand: number): GtCandle[] {
  const newestSec = Math.floor(NOW / 1000) - 1_800;
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
