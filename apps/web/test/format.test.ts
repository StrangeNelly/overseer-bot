import { describe, expect, it } from 'vitest';
import { fmtDeathReason, fmtUnresolvedNote } from '../src/format';

/**
 * The two labels round 17b added to the board (docs/decisions.md round 17b).
 *
 * A wrong-chain card must read as a fact about WHERE the coin is, not as a
 * market event, and an address nothing has indexed must stop implying that
 * data is on its way.
 */
describe('fmtDeathReason', () => {
  const HOUR = 3_600_000;

  it('names the chain a wrong-chain death happened on', () => {
    expect(fmtDeathReason('wrong_chain:base')).toBe('WRONG CHAIN · BASE');
    expect(fmtDeathReason('wrong_chain:arbitrum')).toBe('WRONG CHAIN · ARBITRUM');
  });

  it('leaves every other reason exactly as it read before', () => {
    expect(fmtDeathReason('liquidity_floor')).toBe('LIQ FLOOR');
    expect(fmtDeathReason('never_graduated')).toBe('NEVER GRADUATED');
    expect(fmtDeathReason('rug_floor')).toBe('RUG FLOOR');
    expect(fmtDeathReason('call_liquidity_collapse')).toBe('CALL LIQUIDITY COLLAPSE');
    expect(fmtDeathReason(null)).toBeNull();
    expect(fmtDeathReason('')).toBeNull();
  });

  it('falls back to a label when the chain id is missing', () => {
    // Still a label, never a raw column value — the badge has to say something.
    expect(fmtDeathReason('wrong_chain:')).toBe('WRONG CHAIN:');
  });

  describe('fmtUnresolvedNote', () => {
    const now = Date.UTC(2026, 8, 2, 12, 0, 0);
    const ago = (ms: number) => new Date(now - ms).toISOString();

    it('says indexing for the first hour — new launches really are on their way', () => {
      expect(fmtUnresolvedNote(ago(0), now)).toBe('indexing…');
      expect(fmtUnresolvedNote(ago(59 * 60_000), now)).toBe('indexing…');
    });

    it('stops promising data after that, and says how long it has been', () => {
      expect(fmtUnresolvedNote(ago(HOUR), now)).toBe('not indexed yet · 1h');
      expect(fmtUnresolvedNote(ago(8 * HOUR), now)).toBe('not indexed yet · 8h');
      expect(fmtUnresolvedNote(ago(72 * HOUR), now)).toBe('not indexed yet · 3d');
    });

    it('never claims an age it cannot date', () => {
      expect(fmtUnresolvedNote(null, now)).toBe('indexing…');
      expect(fmtUnresolvedNote('not a date', now)).toBe('indexing…');
    });
  });
});
