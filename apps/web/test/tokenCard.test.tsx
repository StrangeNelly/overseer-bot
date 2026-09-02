import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BoardCard } from '@groupie/shared';
import { TokenCard } from '../src/components/TokenCard';
import type { SectionKey } from '../src/components/SectionTabs';

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
