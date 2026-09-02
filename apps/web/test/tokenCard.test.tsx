import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BoardCard } from '@groupie/shared';
import { TokenCard } from '../src/components/TokenCard';
import type { SectionKey } from '../src/components/SectionTabs';
import { peakNote } from '../src/derive';

/**
 * A dead card never renders as "unresolved" (docs/decisions.md round 17b
 * review).
 *
 * A wrong-chain death has no market numbers by construction — nothing was ever
 * measured on this chain — so the "no data yet" derivation is true of it, and
 * the row used to print "indexing…" underneath a WRONG CHAIN badge: the board
 * saying, in one line, both that the coin is gone and that its numbers are on
 * the way. Death wins in every branch now.
 */

const NOW = Date.UTC(2026, 8, 2, 12, 0, 0);
const HOUR = 3_600_000;

function card(over: Partial<BoardCard> = {}): BoardCard {
  return {
    callId: 1,
    tokenId: 1,
    address: '0xdead00000000000000000000000000000000beef',
    symbol: null,
    name: null,
    imageUrl: null,
    twitterUrl: null,
    websiteUrl: null,
    phase: 'unresolved',
    callStatus: 'active',
    mcapUsd: null,
    liquidityUsd: null,
    vol24Usd: null,
    mcapAtCall: null,
    multiple: null,
    peakMcapSinceCall: null,
    peakMultiple: null,
    retraceFromPeakPct: null,
    calledAt: new Date(NOW - 8 * HOUR).toISOString(),
    callerName: 'someone',
    mentionsCount: 1,
    lastMentionAt: new Date(NOW - 8 * HOUR).toISOString(),
    revived: false,
    diedAt: null,
    deathReason: null,
    mcapAtDeath: null,
    deathMarkedBy: null,
    txns24: null,
    dataAsOf: null,
    watched: false,
    watchedByMe: false,
    revivingAt: null,
    links: { axiom: 'https://axiom', gmgn: 'https://gmgn', dexscreener: 'https://dexscreener' },
    sparkline: [],
    ...over,
  };
}

/** The live shape: dead of wrong chain, and therefore with no numbers at all. */
const wrongChain = card({
  phase: 'dead',
  callStatus: 'died',
  deathReason: 'wrong_chain:base',
  diedAt: new Date(NOW - 2 * HOUR).toISOString(),
});

const render = (over: BoardCard, section: SectionKey = 'died') =>
  renderToStaticMarkup(<TokenCard card={over} section={section} now={NOW} animate={false} />);

describe('TokenCard — a dead card is never unresolved', () => {
  it('says where the coin is, not that its data is coming', () => {
    const html = render(wrongChain);
    expect(html).toContain('WRONG CHAIN · BASE');
    expect(html).toContain('on Base, not Robinhood Chain');
    expect(html).not.toContain('indexing');
    expect(html).not.toContain('not indexed yet');
    expect(html).not.toContain('awaiting first data');
  });

  it('...in every list, not just the died section', () => {
    // FRESH is where the live case actually showed: a second group's call on an
    // already-dead token, printing "not indexed yet · 8h" under DIED.
    const html = render(wrongChain, 'fresh');
    expect(html).toContain('DIED · WRONG CHAIN · BASE');
    expect(html).toContain('on Base, not Robinhood Chain');
    expect(html).not.toContain('indexed');
  });

  it('...including the never-graduated death, which also dies without numbers', () => {
    const html = render(
      card({
        phase: 'dead',
        callStatus: 'died',
        deathReason: 'never_graduated',
        diedAt: new Date(NOW - 2 * HOUR).toISOString(),
      }),
    );
    expect(html).toContain('NEVER GRADUATED');
    expect(html).toContain('last seen');
    expect(html).not.toContain('indexed');
  });

  it('while a LIVING unresolved card still says so', () => {
    // The control: the wording exists, it just may not outrank a death.
    const html = render(card(), 'fresh');
    expect(html).toContain('not indexed yet');
    expect(html).toContain('awaiting first data');
  });
});

/**
 * The peak note: every headline number on the board is mark-to-market since the
 * call, so a card at 0.8x reads the same whether it drifted there or touched
 * $30M first. The note says where the coin has BEEN — as a fact, never a
 * verdict — and stays silent whenever the live multiple already tells it.
 */

/** A live, resolved card: $13M call, $30M peak, back at $11M. */
const roundTripped = card({
  phase: 'graduated',
  mcapUsd: 11e6,
  mcapAtCall: 13e6,
  multiple: 11 / 13,
  peakMcapSinceCall: 30e6,
  peakMultiple: 30 / 13,
  retraceFromPeakPct: 63,
  symbol: 'ORBIO',
  dataAsOf: new Date(NOW - 60_000).toISOString(),
});

describe('peakNote', () => {
  it('says nothing when the coin never went anywhere above the call', () => {
    expect(peakNote({ ...roundTripped, peakMultiple: 1.1, peakMcapSinceCall: 14.3e6 })).toBeNull();
  });

  it('says nothing while the coin sits at its peak — the multiple already is it', () => {
    expect(peakNote({ ...roundTripped, retraceFromPeakPct: 4 })).toBeNull();
  });

  it('says nothing without a recorded peak', () => {
    expect(peakNote({ ...roundTripped, peakMcapSinceCall: null })).toBeNull();
    expect(peakNote({ ...roundTripped, peakMultiple: null })).toBeNull();
  });

  it('prints peak and peak multiple for a retraced runner still above its call', () => {
    // 2.3x offered, 1.1x now: up, but a long way off the high.
    expect(peakNote({ ...roundTripped, mcapUsd: 14.3e6, multiple: 1.1 })).toBe('peak $30M · 2.3x');
  });

  it('names the round trip when the coin has fallen back under the call', () => {
    expect(peakNote(roundTripped)).toBe('peak $30M · 2.3x · back under call');
  });

  it('still holds for a dead call — the 2.3x it offered first happened', () => {
    expect(
      peakNote({
        ...roundTripped,
        phase: 'dead',
        callStatus: 'died',
        multiple: 0.02,
        diedAt: new Date(NOW - 3 * HOUR).toISOString(),
      }),
    ).toBe('peak $30M · 2.3x · back under call');
  });
});

describe('TokenCard — the peak on every call surface', () => {
  it('prints the peak note on a fresh card', () => {
    const html = render(roundTripped, 'fresh');
    expect(html).toContain('sub-peak');
    expect(html).toContain('peak $30M · 2.3x · back under call');
  });

  it('...and on a died row, under the death line', () => {
    const html = render(
      { ...roundTripped, phase: 'dead', callStatus: 'died', diedAt: new Date(NOW - 3 * HOUR).toISOString() },
      'died',
    );
    expect(html).toContain('died 3h ago');
    expect(html).toContain('peak $30M · 2.3x');
  });

  it('but not on a card that never left its call behind', () => {
    const html = render(
      { ...roundTripped, peakMcapSinceCall: null, peakMultiple: null, retraceFromPeakPct: null },
      'fresh',
    );
    expect(html).not.toContain('sub-peak');
    expect(html).not.toContain('peak $');
  });

  it('and never twice on a Retraced row, which already says it', () => {
    const html = render(roundTripped, 'retraced');
    expect(html).toContain('-63% from peak $30M');
    expect(html).not.toContain('sub-peak');
  });
});
