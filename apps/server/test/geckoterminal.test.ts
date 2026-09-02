import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BASE_GAP_MS,
  MAX_GAP_MS,
  MAX_PER_WINDOW,
  SCAN_MAX_YIELD_MS,
  SCAN_YIELD_MS,
  WINDOW_MS,
  acquireSlot,
  backedOffGap,
  budgetDecision,
  chunk,
  getOhlcvMinutes,
  getTopPools,
  gtSnapshot,
  parsePoolResource,
  parsePoolsMulti,
  relaxedGap,
  resetBudget,
  type BudgetState,
  type JsonApiResource,
} from '../src/market/geckoterminal.js';

/**
 * The GeckoTerminal budget diet (docs/decisions.md round 16b). Everything here
 * is the pure half of the client — the batched pool parse and the budgeter's
 * grant policy — so no test touches the network or a real clock.
 */

const NOW = Date.UTC(2026, 8, 2, 12, 0, 0);

/** A `/pools/multi` member, in the shape the live endpoint answers with. */
function poolResource(
  over: { address?: string; fdv?: unknown; completed?: unknown; migrated?: unknown } = {},
): JsonApiResource {
  const address = over.address ?? '0xPool1';
  return {
    id: `robinhood_${address.toLowerCase()}`,
    type: 'pool',
    attributes: {
      address,
      name: 'AAA / WETH 1%',
      // Every money figure arrives as a STRING off this endpoint.
      base_token_price_usd: '0.00025',
      fdv_usd: over.fdv === undefined ? '250000' : over.fdv,
      market_cap_usd: null,
      reserve_in_usd: '30000',
      volume_usd: { h24: '12000' },
      transactions: { h24: { buys: 40, sells: 12 } },
      pool_created_at: '2026-09-01T10:00:00Z',
      launchpad_details: {
        completed: over.completed ?? false,
        graduation_percentage: '42.5',
        migrated_destination_pool_address: over.migrated ?? null,
      },
    },
    relationships: {
      base_token: { data: { id: 'robinhood_0xtoken' } },
      dex: { data: { id: 'pons' } },
    },
  };
}

describe('chunk', () => {
  it('never asks for more than the endpoint accepts', () => {
    const addresses = Array.from({ length: 61 }, (_, i) => `0x${i}`);
    expect(chunk(addresses, 30).map((c) => c.length)).toEqual([30, 30, 1]);
  });

  it('keeps order, and an empty input asks for nothing at all', () => {
    expect(chunk(['a', 'b', 'c'], 2)).toEqual([['a', 'b'], ['c']]);
    expect(chunk([], 30)).toEqual([]);
  });
});

describe('parsePoolsMulti', () => {
  it('keys by the lowercase address GeckoTerminal returns', () => {
    const map = parsePoolsMulti({ data: [poolResource({ address: '0xAbC' })] }, ['0xabc']);
    expect(map.get('0xabc')?.fdvUsd).toBe(250_000);
  });

  it('matches case-insensitively against the address we asked with', () => {
    // A pool_address column written in mixed case must still find its answer.
    const map = parsePoolsMulti({ data: [poolResource({ address: '0xabc' })] }, ['0xAbC']);
    expect(map.get('0xAbC')?.poolAddress).toBe('0xabc');
    expect(map.get('0xabc')?.poolAddress).toBe('0xabc');
  });

  it('falls back to the resource id when attributes carry no address', () => {
    const resource: JsonApiResource = { id: 'robinhood_0xfromid', attributes: { fdv_usd: '1000' } };
    expect(parsePoolsMulti({ data: [resource] }, ['0xfromid'])?.get('0xfromid')?.fdvUsd).toBe(1000);
  });

  it('leaves an unknown pool ABSENT — never a $0 reading', () => {
    // The endpoint answers 200 with a shorter array for a pool it does not
    // know. Absence is "no reading"; a fabricated zero would be death evidence.
    const map = parsePoolsMulti({ data: [poolResource({ address: '0xknown' })] }, [
      '0xknown',
      '0xghost',
    ]);
    expect(map.has('0xghost')).toBe(false);
    expect(map.get('0xghost')).toBeUndefined();
  });

  it('leaves an ATTRIBUTE-LESS resource absent, exactly as getPool returns null', () => {
    // getPool guards on body.data.attributes; a sparse resource in a batch must
    // not become an all-null pool that would clobber the cached market state.
    const sparse: JsonApiResource = { id: 'robinhood_0xsparse', type: 'pool' };
    const map = parsePoolsMulti({ data: [poolResource({ address: '0xknown' }), sparse] }, [
      '0xknown',
      '0xsparse',
    ]);
    expect(map.has('0xsparse')).toBe(false);
    expect(map.has('0xknown')).toBe(true);
  });

  it('survives an empty or malformed body without inventing pools', () => {
    expect(parsePoolsMulti({ data: [] }, ['0xa']).size).toBe(0);
    expect(parsePoolsMulti(null, ['0xa']).size).toBe(0);
    expect(parsePoolsMulti({}, ['0xa']).size).toBe(0);
  });

  it('reads a batched pool EXACTLY as the single-pool endpoint is read', () => {
    // The two endpoints answer with the same attributes, so one parser serves
    // both: a batched poll and a single one can never disagree about a coin.
    const resource = poolResource({ address: '0xabc', completed: true, migrated: '0xMIGRATED' });
    const single = parsePoolResource(resource, '0xabc');
    const batched = parsePoolsMulti({ data: [resource] }, ['0xabc']).get('0xabc');
    expect(batched).toEqual(single);
    expect(gtSnapshot(batched!)).toEqual(gtSnapshot(single));
    // ...including the fields graduation detection turns on.
    expect(batched?.graduated).toBe(true);
    expect(batched?.migratedPoolAddress).toBe('0xmigrated');
    expect(gtSnapshot(single)).toEqual({
      priceUsd: 0.00025,
      mcapUsd: 250_000,
      liquidityUsd: 30_000,
      vol24Usd: 12_000,
      // Round 21: the trade count rides the same reading as the volume.
      txns24: single.txns24,
    });
  });

  it('carries an unreadable figure through as null rather than zero', () => {
    const map = parsePoolsMulti({ data: [poolResource({ address: '0xabc', fdv: null })] }, ['0xabc']);
    // market_cap_usd is null too in the fixture, so there is genuinely no mcap.
    expect(map.get('0xabc')?.fdvUsd).toBeNull();
  });
});

/* ------------------------------------------------------- budgeter policy */

function state(over: Partial<BudgetState> = {}): BudgetState {
  return {
    stamps: [],
    cooldownUntil: 0,
    lastGrantMs: 0,
    minGapMs: BASE_GAP_MS,
    waitingPoll: 0,
    ...over,
  };
}

/* -------------------------------------------- reserve readings (round 22) */

/**
 * GeckoTerminal reports a NEGATIVE `reserve_in_usd` for some Uniswap v4 pools on
 * this chain (nine in the 2026-09-02 14:15Z sleeper scan). It is the singleton
 * PoolManager's delta accounting reaching the field, not a pool balance.
 */
describe('reserve_in_usd', () => {
  const withReserve = (reserve: unknown): JsonApiResource => ({
    id: 'robinhood_0xabc',
    type: 'pool',
    attributes: { address: '0xabc', reserve_in_usd: reserve },
  });

  it('is UNKNOWN when negative — a reading like that measures nothing', () => {
    expect(parsePoolResource(withReserve('-545308.12'), '0xabc').reserveUsd).toBeNull();
    expect(parsePoolResource(withReserve(-1), '0xabc').reserveUsd).toBeNull();
    expect(gtSnapshot(parsePoolResource(withReserve('-620576'), '0xabc')).liquidityUsd).toBeNull();
  });

  it('stands as a reading at ZERO on the pool resource: a drained pool is real', () => {
    // The liquidity_floor death rule is entitled to this one (death.ts); only
    // the sleeper listing treats 0 as unknown, where nothing is lost by it.
    expect(parsePoolResource(withReserve('0'), '0xabc').reserveUsd).toBe(0);
    expect(parsePoolResource(withReserve('30000'), '0xabc').reserveUsd).toBe(30_000);
    // Absent stays absent — this rule invents nothing.
    expect(parsePoolResource(withReserve(null), '0xabc').reserveUsd).toBeNull();
    expect(parsePoolResource(withReserve('not a number'), '0xabc').reserveUsd).toBeNull();
  });
});

describe('budgetDecision', () => {
  it('grants when nothing is in the way', () => {
    expect(budgetDecision(state(), 'poll', NOW)).toEqual({ grant: true });
    expect(budgetDecision(state(), 'scan', NOW)).toEqual({ grant: true });
  });

  it('waits out a cooldown, whatever the priority', () => {
    const s = state({ cooldownUntil: NOW + 12_000 });
    expect(budgetDecision(s, 'poll', NOW)).toEqual({ grant: false, waitMs: 12_000 });
    expect(budgetDecision(s, 'scan', NOW)).toEqual({ grant: false, waitMs: 12_000 });
  });

  it('SCAN yields while a poll is waiting; the poll itself does not', () => {
    const s = state({ waitingPoll: 1 });
    expect(budgetDecision(s, 'scan', NOW)).toEqual({ grant: false, waitMs: SCAN_YIELD_MS });
    expect(budgetDecision(s, 'poll', NOW)).toEqual({ grant: true });
  });

  it('lets the scan through the moment no poll is queued', () => {
    expect(budgetDecision(state({ waitingPoll: 0 }), 'scan', NOW)).toEqual({ grant: true });
  });

  it('stops yielding once the scan has waited its ceiling out', () => {
    // Continuous poll traffic keeps waitingPoll above zero indefinitely; without
    // this the scan would never take a slot at all.
    const s = state({ waitingPoll: 2 });
    expect(budgetDecision(s, 'scan', NOW, SCAN_MAX_YIELD_MS - 1)).toEqual({
      grant: false,
      waitMs: SCAN_YIELD_MS,
    });
    expect(budgetDecision(s, 'scan', NOW, SCAN_MAX_YIELD_MS)).toEqual({ grant: true });
  });

  it('an aged scan still waits out a cooldown and the gap', () => {
    const cooling = state({ waitingPoll: 1, cooldownUntil: NOW + 5_000 });
    expect(budgetDecision(cooling, 'scan', NOW, SCAN_MAX_YIELD_MS)).toEqual({
      grant: false,
      waitMs: 5_000,
    });
    const paced = state({ waitingPoll: 1, lastGrantMs: NOW - 500, minGapMs: 2_000 });
    expect(budgetDecision(paced, 'scan', NOW, SCAN_MAX_YIELD_MS)).toEqual({
      grant: false,
      waitMs: 1_500,
    });
  });

  it('paces every grant by the adaptive gap', () => {
    const s = state({ lastGrantMs: NOW - 500, minGapMs: 2_000 });
    expect(budgetDecision(s, 'poll', NOW)).toEqual({ grant: false, waitMs: 1_500 });
    expect(budgetDecision(s, 'poll', NOW + 1_500)).toEqual({ grant: true });
  });

  it('holds the window ceiling and waits for the oldest stamp to expire', () => {
    const stamps = Array.from({ length: MAX_PER_WINDOW }, (_, i) => NOW - WINDOW_MS + 1_000 + i);
    const s = state({ stamps, lastGrantMs: NOW - 10_000 });
    expect(budgetDecision(s, 'poll', NOW)).toEqual({ grant: false, waitMs: 1_000 + 100 });
  });

  it('ignores stamps that have already left the window', () => {
    const stale = Array.from({ length: MAX_PER_WINDOW }, () => NOW - WINDOW_MS - 1);
    const s = state({ stamps: stale, lastGrantMs: NOW - 10_000 });
    expect(budgetDecision(s, 'poll', NOW)).toEqual({ grant: true });
  });

  it('cooldown outranks the scan yield, and the yield outranks the gap', () => {
    const s = state({ cooldownUntil: NOW + 5_000, waitingPoll: 3, lastGrantMs: NOW });
    expect(budgetDecision(s, 'scan', NOW)).toEqual({ grant: false, waitMs: 5_000 });
    const noCooldown = state({ waitingPoll: 3, lastGrantMs: NOW });
    expect(budgetDecision(noCooldown, 'scan', NOW)).toEqual({ grant: false, waitMs: SCAN_YIELD_MS });
  });

  it('never returns a zero wait, so a caller looping on it cannot spin', () => {
    const cases: Array<[BudgetState, 'poll' | 'scan']> = [
      [state({ cooldownUntil: NOW + 1 }), 'poll'],
      [state({ waitingPoll: 1 }), 'scan'],
      [state({ lastGrantMs: NOW - 1, minGapMs: 2_000 }), 'poll'],
      [
        state({
          stamps: Array.from({ length: MAX_PER_WINDOW }, () => NOW - WINDOW_MS),
          lastGrantMs: NOW - 10_000,
        }),
        'poll',
      ],
    ];
    for (const [s, priority] of cases) {
      const decision = budgetDecision(s, priority, NOW);
      expect(decision.grant).toBe(false);
      if (!decision.grant) expect(decision.waitMs).toBeGreaterThan(0);
    }
  });
});

describe('acquireSlot queueing', () => {
  beforeEach(() => {
    resetBudget();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    resetBudget();
  });

  it('a poll that arrives SECOND still takes the slot first, and releases the scan', async () => {
    // The whole "scan yields" policy rests on two things acquireSlot does and
    // budgetDecision cannot: counting the poll before its own first decision,
    // and dropping that count in `finally` once it is granted.
    const order: string[] = [];
    await acquireSlot('poll'); // seeds lastGrantMs, so the gap is live below

    const scan = acquireSlot('scan').then(() => order.push('scan'));
    const poll = acquireSlot('poll').then(() => order.push('poll'));

    await vi.advanceTimersByTimeAsync(BASE_GAP_MS);
    expect(order).toEqual(['poll']);

    await vi.advanceTimersByTimeAsync(BASE_GAP_MS + SCAN_YIELD_MS);
    expect(order).toEqual(['poll', 'scan']);
    await Promise.all([scan, poll]);
  });
});

describe('getTopPools', () => {
  beforeEach(() => resetBudget());
  afterEach(() => {
    vi.unstubAllGlobals();
    resetBudget();
  });

  it('surfaces the last hour of trades alongside the trailing 24h count', async () => {
    // The 24h figures keep a coin on the listing after it stops trading; the h1
    // block is the only thing in a listing row that is about now.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        status: 200,
        ok: true,
        json: async () => ({
          data: [
            {
              id: 'robinhood_0xpool1',
              attributes: {
                address: '0xPool1',
                name: 'AAA / WETH 1%',
                base_token_price_usd: '0.00008',
                fdv_usd: '80000',
                reserve_in_usd: '25000',
                volume_usd: { h24: '200000' },
                transactions: { h24: { buys: 300, sells: 100 }, h1: { buys: 0, sells: 0 } },
                pool_created_at: '2026-09-01T10:00:00Z',
              },
              relationships: { base_token: { data: { id: 'robinhood_0xtoken' } } },
            },
            {
              id: 'robinhood_0xpool2',
              attributes: {
                address: '0xPool2',
                volume_usd: { h24: '1000' },
                transactions: { h24: { buys: 10, sells: 5 } },
              },
              relationships: { base_token: { data: { id: 'robinhood_0xtoken2' } } },
            },
          ],
        }),
      })),
    );
    const rows = await getTopPools(1);
    expect(rows.map((r) => [r.txns24, r.txns1h])).toEqual([
      [400, 0],
      // No h1 block at all is UNKNOWN, not zero trades.
      [15, null],
    ]);
  });

  it('reads a non-positive reserve as unknown liquidity (round 22)', async () => {
    // On this listing a zero or negative reserve is a figure the scan does not
    // have: it must reach the floors as null so DexScreener can answer instead.
    const row = (address: string, reserve: unknown) => ({
      id: `robinhood_${address}`,
      attributes: {
        address,
        name: 'AAA / WETH 1%',
        fdv_usd: '80000',
        reserve_in_usd: reserve,
        volume_usd: { h24: '200000' },
        transactions: { h24: { buys: 300, sells: 100 } },
      },
      relationships: { base_token: { data: { id: `robinhood_${address}token` } } },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        status: 200,
        ok: true,
        json: async () => ({
          data: [
            row('0xnegative', '-55040.5'),
            row('0xzero', '0'),
            row('0xreal', '25000'),
            row('0xmissing', null),
          ],
        }),
      })),
    );
    expect((await getTopPools(1)).map((r) => r.liquidityUsd)).toEqual([null, null, 25_000, null]);
  });
});

describe('getOhlcvMinutes', () => {
  beforeEach(() => resetBudget());
  afterEach(() => {
    vi.unstubAllGlobals();
    resetBudget();
  });

  it('asks the minute endpoint for aggregated buckets and parses them newest-first', async () => {
    const fetchMock = vi.fn(async (url: unknown) => ({
      url,
      status: 200,
      ok: true,
      json: async () => ({
        data: {
          attributes: {
            // Deliberately oldest-first: the parse re-asserts the order.
            ohlcv_list: [
              [1_788_200_000, '1', '1', '1', '0.00007', 10],
              [1_788_200_900, '1', '1', '1', '0.00008', 10],
            ],
          },
        },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const candles = await getOhlcvMinutes('0xpool', 15, 12, 'scan');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      '/pools/0xpool/ohlcv/minute?aggregate=15&limit=12',
    );
    expect(candles.map((c) => c.close)).toEqual([0.00008, 0.00007]);
  });
});

describe('adaptive pacing curve', () => {
  it('doubles on a 429 and stops at the ceiling', () => {
    expect(backedOffGap(BASE_GAP_MS)).toBe(4_000);
    expect(backedOffGap(4_000)).toBe(8_000);
    expect(backedOffGap(8_000)).toBe(MAX_GAP_MS);
    expect(backedOffGap(MAX_GAP_MS)).toBe(MAX_GAP_MS);
  });

  it('halves back down on a success streak and stops at the base', () => {
    expect(relaxedGap(MAX_GAP_MS)).toBe(7_500);
    expect(relaxedGap(4_000)).toBe(BASE_GAP_MS);
    expect(relaxedGap(BASE_GAP_MS)).toBe(BASE_GAP_MS);
  });
});
