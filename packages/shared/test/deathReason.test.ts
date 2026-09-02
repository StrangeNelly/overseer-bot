import { describe, expect, it } from 'vitest';
import {
  isWrongChainDeath,
  WRONG_CHAIN_PREFIX,
  wrongChainOf,
  wrongChainReason,
} from '../src/deathReason.js';

/**
 * The wrong-chain encoding (docs/decisions.md round 17b). Three surfaces read
 * this one string: the poller writes it, the scheduler keeps the corpse off
 * every market because of it, and the board prints it as
 * "WRONG CHAIN · BASE" with no money line (apps/web's fmtDeathReason and
 * deathMcap are both one call to `wrongChainOf`).
 */
describe('wrongChainReason / wrongChainOf', () => {
  it('round-trips a chain id', () => {
    expect(wrongChainReason('base')).toBe('wrong_chain:base');
    expect(wrongChainOf(wrongChainReason('base'))).toBe('base');
    expect(wrongChainOf(wrongChainReason('arbitrum'))).toBe('arbitrum');
  });

  it('normalises what DexScreener hands over', () => {
    expect(wrongChainReason(' BASE ')).toBe('wrong_chain:base');
  });

  it('names no chain for every other death reason', () => {
    for (const reason of ['liquidity_floor', 'never_graduated', 'rug_floor', 'curve_floor', '']) {
      expect([reason, wrongChainOf(reason)]).toEqual([reason, null]);
      expect([reason, isWrongChainDeath(reason)]).toEqual([reason, false]);
    }
    expect(wrongChainOf(null)).toBeNull();
    expect(wrongChainOf(undefined)).toBeNull();
    expect(isWrongChainDeath(null)).toBe(false);
  });

  it('is a wrong-chain DEATH even when the chain id is missing', () => {
    // The two questions are different, and the poller asks the first: a corpse
    // must never become pollable again because its label lost a word. Only the
    // display side needs a chain to name, and it gets null.
    expect(isWrongChainDeath(WRONG_CHAIN_PREFIX)).toBe(true);
    expect(wrongChainOf(WRONG_CHAIN_PREFIX)).toBeNull();
    expect(wrongChainOf('wrong_chain:   ')).toBeNull();
  });

  it('does not match a reason that merely contains the prefix', () => {
    expect(isWrongChainDeath('not_wrong_chain:base')).toBe(false);
  });
});
