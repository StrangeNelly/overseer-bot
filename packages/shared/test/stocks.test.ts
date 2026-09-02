import { describe, expect, it } from 'vitest';
import { STOCK_TOKEN_ADDRESSES, isTokenizedStock } from '../src/stocks.js';

/**
 * The tokenized-equity rule (docs/decisions.md round 17). It decides what the
 * default Sleepers view hides, so the two directions matter equally: every
 * Robinhood equity token must be caught, and no coin may ever be hidden on a
 * guess.
 */

const COIN = '0x1111111111111111111111111111111111111111';
const HOOD = '0x32ac8c1d7672667d5ebdea22935f7b06fc8d496f';

describe('isTokenizedStock', () => {
  it('catches the issuer suffix every Robinhood stock and ETF token carries', () => {
    for (const name of [
      'Invesco QQQ • Robinhood Token',
      'Palantir Technologies • Robinhood Token',
      'Moderna • Robinhood Token',
      // Trailing whitespace is still the suffix.
      'Taiwan Semiconductor • Robinhood Token  ',
    ]) {
      expect(isTokenizedStock(name, COIN)).toBe(true);
    }
  });

  it('catches leveraged equity products, which carry no suffix', () => {
    for (const name of ['NVDA 3x Long', 'TSLA 2x Short', 'AAPL 1.5x Long']) {
      expect(isTokenizedStock(name, COIN)).toBe(true);
    }
  });

  it('reads both rules case-insensitively', () => {
    expect(isTokenizedStock('INVESCO QQQ • ROBINHOOD TOKEN', COIN)).toBe(true);
    expect(isTokenizedStock('nvda 3X LONG', COIN)).toBe(true);
    expect(isTokenizedStock('Coin', HOOD.toUpperCase().replace('0X', '0x'))).toBe(true);
  });

  it('catches HOOD by address, the one stock the name rule cannot see', () => {
    expect(STOCK_TOKEN_ADDRESSES.has(HOOD)).toBe(true);
    expect(isTokenizedStock('HOOD', HOOD)).toBe(true);
    // ...and by address alone, whatever the listing calls it.
    expect(isTokenizedStock(null, HOOD)).toBe(true);
  });

  it('answers false for an unknown name rather than guessing', () => {
    expect(isTokenizedStock(null, COIN)).toBe(false);
    expect(isTokenizedStock(undefined, COIN)).toBe(false);
    expect(isTokenizedStock('', COIN)).toBe(false);
  });

  it('leaves coins alone, including ones that merely mention a ticker', () => {
    for (const name of [
      'Sleeper',
      'HOOD',
      'Robinhood Token Killer',
      'Longcat',
      'Short Squeeze',
      '3x Longcat',
    ]) {
      expect(isTokenizedStock(name, COIN)).toBe(false);
    }
  });
});
