import { describe, expect, it } from 'vitest';
import { pickCandleClose } from '../src/market/geckoterminal.js';

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
