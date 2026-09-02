import { describe, expect, it } from 'vitest';
import {
  FLATLINE_DEATH_REASON,
  isFlatlineDeath,
  isMemberDeath,
  isWrongChainDeath,
  MEMBER_DEATH_REASON,
  UNNAMED_MEMBER,
  WRONG_CHAIN_PREFIX,
  wrongChainOf,
  wrongChainReason,
} from '../src/deathReason.js';
import { DEATH, POLL_TIERS, THRESHOLDS } from '../src/constants.js';

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

/**
 * Round 21's two new reasons. Both are read on more than one surface — the
 * poller writes them, the revival paths branch on them, the board turns them
 * into a label — so the strings live in shared exactly as the wrong-chain
 * encoding does, and these are what stop them drifting.
 */
describe('round 21 death reasons', () => {
  it('spells the two reasons the way the columns store them', () => {
    expect(MEMBER_DEATH_REASON).toBe('member');
    expect(FLATLINE_DEATH_REASON).toBe('flatline');
  });

  it('tells each apart from every other reason, and from each other', () => {
    const others = [
      'liquidity_floor',
      'never_graduated',
      'rug_floor',
      'curve_floor',
      'call_liquidity_collapse',
      wrongChainReason('base'),
      '',
    ];
    for (const reason of others) {
      expect([reason, isMemberDeath(reason)]).toEqual([reason, false]);
      expect([reason, isFlatlineDeath(reason)]).toEqual([reason, false]);
    }
    expect(isMemberDeath(MEMBER_DEATH_REASON)).toBe(true);
    expect(isFlatlineDeath(FLATLINE_DEATH_REASON)).toBe(true);
    expect(isMemberDeath(FLATLINE_DEATH_REASON)).toBe(false);
    expect(isFlatlineDeath(MEMBER_DEATH_REASON)).toBe(false);
  });

  it('treats an absent reason as neither', () => {
    for (const reason of [null, undefined]) {
      expect(isMemberDeath(reason)).toBe(false);
      expect(isFlatlineDeath(reason)).toBe(false);
    }
  });

  it('names an unnamed marker rather than leaving the column null', () => {
    // null on death_marked_by means "a RULE killed this call", so a member we
    // cannot name still has to be stamped as one.
    expect(UNNAMED_MEMBER.trim().length).toBeGreaterThan(0);
  });
});

describe('DEATH — the round-21 thresholds', () => {
  it('is the decision, number for number', () => {
    expect(DEATH).toEqual({
      flatlineHours: 6,
      flatlineRetracePct: 85,
      flatlineVolumeUsd: 500,
      flatlineTxns24: 5,
      flatlineRevivalVolumeUsd: 2_000,
      flatlineMinReadings: 6,
      flatlineMaxGapMinutes: 125,
    });
  });

  it('makes the six hours COVERAGE, not just elapsed time (amendment a)', () => {
    // The readings floor must be reachable on the SLOWEST live tier: an idle
    // coin is polled every POLL_TIERS.idleSeconds, so the window divided by
    // the floor may not demand polls faster than that tier delivers them.
    const idleMinutes = POLL_TIERS.idleSeconds / 60;
    expect((DEATH.flatlineHours * 60) / DEATH.flatlineMinReadings).toBeGreaterThanOrEqual(
      idleMinutes,
    );
    // The gap ceiling must let one idle poll go missing without restarting
    // the clock (two polls plus slack)...
    expect(DEATH.flatlineMaxGapMinutes).toBeGreaterThan(2 * idleMinutes);
    // ...while no single hole may be a large fraction of the window.
    expect(DEATH.flatlineMaxGapMinutes).toBeLessThan(DEATH.flatlineHours * 60);
  });

  it('asks a flatline corpse for more volume than the death allowed it', () => {
    // Otherwise the coin that died of silence would revive on the reading that
    // killed it. Hysteresis, the same shape the inert-remention floor has.
    expect(DEATH.flatlineRevivalVolumeUsd).toBeGreaterThan(DEATH.flatlineVolumeUsd);
  });

  it('leaves the mcap bar exactly where round 13 put it', () => {
    // Flatline revival ADDS a volume clause; it does not move the one bar.
    expect(THRESHOLDS.revivalMcapUsd).toBe(30_000);
  });
});
