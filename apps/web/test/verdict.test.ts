import { describe, expect, it } from 'vitest';
import type { BoardCard, BoardResponse } from '@groupie/shared';
import { applyVerdicts, deathNote, isMemberDeath } from '../src/derive';
import { deadForCard, settleVerdicts } from '../src/dead';
import type { DeadProps } from '../src/dead';

/**
 * The member verdict, off-screen (docs/decisions.md round 21).
 *
 * $VLR is the case these tests are written from: 0.4x, $106K → $46K on $19K of
 * intact liquidity — alive by every rule the poller has, and finished by every
 * member who looked at it.
 */

const NOW = Date.UTC(2026, 8, 3, 12, 0, 0);
const HOUR = 3_600_000;

function card(over: Partial<BoardCard> = {}): BoardCard {
  return {
    callId: 1,
    tokenId: 1,
    address: '0xvlr00000000000000000000000000000000beef',
    symbol: 'VLR',
    name: null,
    imageUrl: null,
    twitterUrl: null,
    websiteUrl: null,
    phase: 'graduated',
    callStatus: 'active',
    mcapUsd: 46_000,
    liquidityUsd: 19_000,
    vol24Usd: null,
    mcapAtCall: 106_000,
    multiple: 46 / 106,
    peakMcapSinceCall: 320_000,
    peakMultiple: 3.02,
    retraceFromPeakPct: 86,
    calledAt: new Date(NOW - 30 * HOUR).toISOString(),
    callerName: '@caller',
    mentionsCount: 1,
    lastMentionAt: new Date(NOW - 30 * HOUR).toISOString(),
    revived: false,
    diedAt: null,
    deathReason: null,
    mcapAtDeath: null,
    deathMarkedBy: null,
    txns24: null,
    dataAsOf: new Date(NOW - 60_000).toISOString(),
    watched: false,
    watchedByMe: false,
    revivingAt: null,
    links: { axiom: 'https://axiom', gmgn: 'https://gmgn', dexscreener: 'https://dexscreener' },
    sparkline: [],
    ...over,
  };
}

function board(over: Partial<BoardResponse['sections']> = {}): BoardResponse {
  return {
    group: { slug: 'g', title: 'hammertime' },
    window: '24h',
    generatedAt: new Date(NOW).toISOString(),
    todayCallCount: 3,
    hiddenProbationCount: 0,
    sections: { fresh: [], runners: [], retraced: [], died: [], reviving: [], ...over },
    watchlist: [],
  };
}

const memberDead = card({
  callStatus: 'died',
  deathReason: 'member',
  deathMarkedBy: '@pwnzssg',
  diedAt: new Date(NOW - HOUR).toISOString(),
  mcapAtDeath: 46_000,
});

describe('deathNote', () => {
  it('names who pronounced a member death', () => {
    expect(deathNote(memberDead)).toBe('marked dead by @pwnzssg');
  });

  it('still says what kind of death it was when the name did not survive', () => {
    expect(deathNote({ ...memberDead, deathMarkedBy: null })).toBe('marked dead by a member');
    expect(deathNote({ ...memberDead, deathMarkedBy: '  ' })).toBe('marked dead by a member');
  });

  it('prints the flatline evidence — volume and trades, never a verdict', () => {
    const flat = card({
      callStatus: 'died',
      deathReason: 'flatline',
      vol24Usd: 120,
      txns24: 3,
      diedAt: new Date(NOW - HOUR).toISOString(),
    });
    expect(deathNote(flat)).toBe('flatlined · vol $120 / 24h · 3 trades');
  });

  it('says "1 trade", not "1 trades"', () => {
    const flat = card({ callStatus: 'died', deathReason: 'flatline', vol24Usd: 80, txns24: 1 });
    expect(deathNote(flat)).toBe('flatlined · vol $80 / 24h · 1 trade');
  });

  it('drops a clause it does not have — an unknown reading is never a zero', () => {
    const noTrades = card({ callStatus: 'died', deathReason: 'flatline', vol24Usd: 120, txns24: null });
    expect(noTrades.txns24).toBeNull();
    expect(deathNote(noTrades)).toBe('flatlined · vol $120 / 24h');

    const noVolume = card({ callStatus: 'died', deathReason: 'flatline', vol24Usd: null, txns24: 4 });
    expect(deathNote(noVolume)).toBe('flatlined · 4 trades');

    const neither = card({ callStatus: 'died', deathReason: 'flatline' });
    expect(deathNote(neither)).toBe('flatlined');
  });

  it('...and a zero reading IS a reading: $0 volume prints', () => {
    const zero = card({ callStatus: 'died', deathReason: 'flatline', vol24Usd: 0, txns24: 0 });
    expect(deathNote(zero)).toBe('flatlined · vol $0 / 24h · 0 trades');
  });

  it('leaves every other death wording alone', () => {
    expect(deathNote(card({ callStatus: 'died', deathReason: 'liquidity_floor' }))).toBeNull();
    expect(deathNote(card({ callStatus: 'died', deathReason: 'wrong_chain:base' }))).toBeNull();
    expect(deathNote(card())).toBeNull();
  });
});

describe('deadForCard', () => {
  const props: DeadProps = {
    onMarkDead: () => {},
    onRestore: () => {},
    pending: new Set<number>([7]),
  };

  it('offers MARK DEAD on a live call', () => {
    expect(deadForCard(card(), props)?.mode).toBe('mark');
  });

  it('offers RESTORE — and only RESTORE — on a member death', () => {
    expect(isMemberDeath(memberDead)).toBe(true);
    expect(deadForCard(memberDead, props)?.mode).toBe('restore');
  });

  it('offers nothing on a rule-driven death: the poller owns that one', () => {
    expect(deadForCard(card({ callStatus: 'died', deathReason: 'liquidity_floor' }), props)).toBeUndefined();
    expect(deadForCard(card({ callStatus: 'died', deathReason: 'flatline' }), props)).toBeUndefined();
    expect(deadForCard(card({ callStatus: 'died', deathReason: null }), props)).toBeUndefined();
  });

  it('offers MARK DEAD on a live call with no data yet — the Base dud (amendment e)', () => {
    // A call the poller cannot resolve is exactly the one a member has to be
    // able to end: liveness of the CALL is the only scope.
    const unresolved = card({ phase: 'unresolved', mcapUsd: null, multiple: null });
    expect(deadForCard(unresolved, props)?.mode).toBe('mark');
  });

  it('offers nothing on a binned call', () => {
    expect(deadForCard(card({ callStatus: 'binned' }), props)).toBeUndefined();
  });

  it('marks the pill pending for the call in flight, and only that one', () => {
    expect(deadForCard(card({ callId: 7 }), props)?.pending).toBe(true);
    expect(deadForCard(card({ callId: 8 }), props)?.pending).toBe(false);
  });

  it('is absent entirely on a surface that does not offer the verdict', () => {
    expect(deadForCard(card(), undefined)).toBeUndefined();
  });
});

/**
 * Which optimistic verdicts a board load settles.
 *
 * The board refetches constantly — the live stream, tab focus, another card's
 * watch toggle — and any of those can land while a MARK DEAD is still in the
 * air. Clearing the overlay wholesale made the card jump back to FRESH for the
 * rest of the round trip: the reader watching their own verdict undo itself.
 */
describe('settleVerdicts', () => {
  const at = new Date(NOW).toISOString();

  it('hands a settled death over to the payload', () => {
    const next = settleVerdicts(new Map([[5, at]]), new Set(), new Set());
    expect(next.markedDead.size).toBe(0);
  });

  it('keeps a death whose request is still open', () => {
    const next = settleVerdicts(new Map([[5, at]]), new Set(), new Set([5]));
    expect(next.markedDead.get(5)).toBe(at);
  });

  it('settles the answered ones and keeps the in-flight one, in the same load', () => {
    const next = settleVerdicts(
      new Map([
        [5, at],
        [6, at],
      ]),
      new Set([7, 8]),
      new Set([6, 8]),
    );
    expect([...next.markedDead.keys()]).toEqual([6]);
    expect([...next.restored]).toEqual([8]);
  });

  it('settles a restore the same way', () => {
    expect(settleVerdicts(new Map(), new Set([7]), new Set()).restored.size).toBe(0);
    expect(settleVerdicts(new Map(), new Set([7]), new Set([7])).restored.has(7)).toBe(true);
  });

  it('returns the very same collections when nothing settles — no needless repaint', () => {
    const marks = new Map([[5, at]]);
    const back = new Set([7]);
    const next = settleVerdicts(marks, back, new Set([5, 7]));
    expect(next.markedDead).toBe(marks);
    expect(next.restored).toBe(back);

    const empty = settleVerdicts(marks, back, new Set([5, 7]));
    expect(empty.markedDead).toBe(marks);
  });

  it('is a no-op on the common case: nothing pronounced, nothing in flight', () => {
    const marks: ReadonlyMap<number, string> = new Map();
    const back: ReadonlySet<number> = new Set();
    const next = settleVerdicts(marks, back, new Set());
    expect(next.markedDead).toBe(marks);
    expect(next.restored).toBe(back);
  });
});

describe('applyVerdicts', () => {
  const at = new Date(NOW).toISOString();

  it('returns the payload untouched when nothing is pending', () => {
    const payload = board({ fresh: [card()] });
    expect(applyVerdicts(payload, new Map(), new Set())).toBe(payload);
  });

  it('moves a pronounced call out of its zones and into DIED', () => {
    const live = card({ callId: 5 });
    const payload = board({ fresh: [live], retraced: [live] });
    const next = applyVerdicts(payload, new Map([[5, at]]), new Set());

    expect(next.sections.fresh).toHaveLength(0);
    expect(next.sections.retraced).toHaveLength(0);
    expect(next.sections.died).toHaveLength(1);

    const moved = next.sections.died[0]!;
    expect(moved.callStatus).toBe('died');
    expect(moved.deathReason).toBe('member');
    expect(moved.diedAt).toBe(at);
    // Named honestly for the round trip: it WAS you, until the payload says so.
    expect(moved.deathMarkedBy).toBe('you');
    // Mark-to-market at the verdict, exactly what the server stamps.
    expect(moved.mcapAtDeath).toBe(46_000);
  });

  it('never claims a death price it does not have', () => {
    const live = card({ callId: 5, mcapUsd: null });
    const next = applyVerdicts(board({ fresh: [live] }), new Map([[5, at]]), new Set());
    expect(next.sections.died[0]!.mcapAtDeath).toBeNull();
  });

  it('drops the reviving spotlight — a dead call is not also a comeback', () => {
    const back = card({ callId: 5, revivingAt: new Date(NOW - HOUR).toISOString() });
    const next = applyVerdicts(board({ reviving: [back] }), new Map([[5, at]]), new Set());
    expect(next.sections.reviving).toHaveLength(0);
    expect(next.sections.died[0]!.revivingAt).toBeNull();
  });

  it('adds the moved card exactly once, however many zones held it', () => {
    const live = card({ callId: 5 });
    const next = applyVerdicts(
      board({ fresh: [live], runners: [live], retraced: [live] }),
      new Map([[5, at]]),
      new Set(),
    );
    expect(next.sections.died).toHaveLength(1);
  });

  it('yields to the server once the refetch carries the real death', () => {
    const serverSide = { ...memberDead, callId: 5, deathMarkedBy: '@pwnzssg' };
    const next = applyVerdicts(board({ died: [serverSide] }), new Map([[5, at]]), new Set());
    expect(next.sections.died).toHaveLength(1);
    expect(next.sections.died[0]!.deathMarkedBy).toBe('@pwnzssg');
  });

  it('takes a restored call straight out of DIED', () => {
    const next = applyVerdicts(
      board({ died: [{ ...memberDead, callId: 5 }] }),
      new Map(),
      new Set([5]),
    );
    expect(next.sections.died).toHaveLength(0);
    // ...and does not invent a zone for it: the payload decides where it lands.
    expect(next.sections.fresh).toHaveLength(0);
    expect(next.sections.runners).toHaveLength(0);
  });

  it('leaves the rest of the payload alone', () => {
    const payload = board({ fresh: [card({ callId: 5 })] });
    const next = applyVerdicts(payload, new Map([[5, at]]), new Set());
    expect(next.todayCallCount).toBe(payload.todayCallCount);
    expect(next.watchlist).toBe(payload.watchlist);
    expect(next.generatedAt).toBe(payload.generatedAt);
  });
});
