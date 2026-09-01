import { describe, expect, it } from 'vitest';
import { parseOhlcvRows, pickCandleClose } from '../src/market/geckoterminal.js';

// GT returns minute candles newest-first as [ts, open, high, low, close, vol],
// where ts is the candle's START and before_timestamp filters on that start.
const N = 1_788_200_160;

describe('pickCandleClose', () => {
  it('picks the candle covering the call, not the one after it', () => {
    const rows = [
      [N + 60, 1, 1, 1, 0.002, 10],
      [N, 1, 1, 1, 0.001, 10],
    ];
    expect(pickCandleClose(rows, N + 30)).toBe(0.001);
  });
  it('falls back to the last traded minute before the call', () => {
    const rows = [
      [N + 60, 1, 1, 1, 0.002, 10],
      [N - 120, 1, 1, 1, 0.0005, 10],
    ];
    expect(pickCandleClose(rows, N + 30)).toBe(0.0005);
  });
  it('takes the candle starting exactly at the call second', () => {
    expect(pickCandleClose([[N, 1, 1, 1, 0.001, 10]], N)).toBe(0.001);
  });
  it('no rows at or before the call = no answer', () => {
    expect(pickCandleClose([[N + 60, 1, 1, 1, 0.002, 10]], N - 1)).toBeNull();
    expect(pickCandleClose([], N)).toBeNull();
  });
});

describe('parseOhlcvRows', () => {
  it('reads a row into a candle', () => {
    expect(parseOhlcvRows([[N, 0.001, 0.0012, 0.0009, 0.0011, 4200]])).toEqual([
      { tsSec: N, open: 0.001, high: 0.0012, low: 0.0009, close: 0.0011 },
    ]);
  });

  it('coerces the string figures GeckoTerminal actually sends', () => {
    const rows = [[String(N), '0.001', '0.0012', '0.0009', '0.0011', '4200']];
    expect(parseOhlcvRows(rows)).toEqual([
      { tsSec: N, open: 0.001, high: 0.0012, low: 0.0009, close: 0.0011 },
    ]);
  });

  it('DROPS a row with no timestamp or no close rather than defaulting one', () => {
    // A fabricated 0 close would read as "left the band" to the residency walk.
    const rows = [
      [N, 1, 1, 1, 0.001, 1],
      [null, 1, 1, 1, 0.002, 1],
      [N - 3600, 1, 1, 1, null, 1],
      ['nonsense', 1, 1, 1, 0.003, 1],
    ];
    expect(parseOhlcvRows(rows)).toEqual([
      { tsSec: N, open: 1, high: 1, low: 1, close: 0.001 },
    ]);
  });

  it('falls back to the close for a missing OHL, which keeps the candle usable', () => {
    expect(parseOhlcvRows([[N, null, undefined, 'x', 0.005, 1]])).toEqual([
      { tsSec: N, open: 0.005, high: 0.005, low: 0.005, close: 0.005 },
    ]);
  });

  it('re-asserts newest-first order', () => {
    const rows = [
      [N - 7200, 1, 1, 1, 0.001, 1],
      [N, 1, 1, 1, 0.003, 1],
      [N - 3600, 1, 1, 1, 0.002, 1],
    ];
    expect(parseOhlcvRows(rows).map((c) => c.tsSec)).toEqual([N, N - 3600, N - 7200]);
  });

  it('survives a malformed payload', () => {
    expect(parseOhlcvRows([])).toEqual([]);
    expect(parseOhlcvRows([null as unknown as unknown[], [] as unknown[]])).toEqual([]);
  });
});
