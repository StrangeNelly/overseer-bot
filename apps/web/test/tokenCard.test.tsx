import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BoardCard } from '@groupie/shared';
import { TokenCard } from '../src/components/TokenCard';
import type { SectionKey } from '../src/components/SectionTabs';
import { deadForCard } from '../src/dead';
import type { DeadProps } from '../src/dead';
import { peakNote, peakNoteParts } from '../src/derive';

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

/**
 * The same gating, taken apart: the row prints the head on its own line and
 * lets a container query drop the tail where the identity column is 112px wide.
 * `peakNote` composes these two, so the pair can never disagree — which is the
 * whole reason the split lives in derive and not in the component.
 */
describe('peakNoteParts', () => {
  it('is null in exactly the cases the sentence is', () => {
    expect(peakNoteParts({ ...roundTripped, peakMultiple: 1.1, peakMcapSinceCall: 14.3e6 })).toBeNull();
    expect(peakNoteParts({ ...roundTripped, retraceFromPeakPct: 4 })).toBeNull();
    expect(peakNoteParts({ ...roundTripped, peakMcapSinceCall: null })).toBeNull();
    expect(peakNoteParts({ ...roundTripped, peakMultiple: null })).toBeNull();
  });

  it('carries the peak in the head, with no round trip while the coin is above its call', () => {
    expect(peakNoteParts({ ...roundTripped, mcapUsd: 14.3e6, multiple: 1.1 })).toEqual({
      head: 'peak $30M · 2.3x',
      tail: null,
    });
  });

  it('returns the round trip as its own clause once the coin is back under the call', () => {
    expect(peakNoteParts(roundTripped)).toEqual({
      head: 'peak $30M · 2.3x',
      tail: ' · back under call',
    });
  });

  it('...and on a dead call too — the 2.3x it offered first happened', () => {
    expect(
      peakNoteParts({
        ...roundTripped,
        phase: 'dead',
        callStatus: 'died',
        multiple: 0.02,
        diedAt: new Date(NOW - 3 * HOUR).toISOString(),
      }),
    ).toEqual({ head: 'peak $30M · 2.3x', tail: ' · back under call' });
  });

  it('composes back into exactly what peakNote says — the wording lives once', () => {
    for (const subject of [roundTripped, { ...roundTripped, mcapUsd: 14.3e6, multiple: 1.1 }]) {
      const parts = peakNoteParts(subject);
      expect(parts).not.toBeNull();
      expect(`${parts!.head}${parts!.tail ?? ''}`).toBe(peakNote(subject));
    }
  });
});

describe('TokenCard — the peak on every call surface', () => {
  it('prints the peak on its own line, out of the subline the ellipsis was eating', () => {
    const html = render(roundTripped, 'fresh');
    expect(html).toContain('row-peak');
    expect(html).toContain('peak $30M · 2.3x');
    // The one fact the line exists for must not be back inside the subline: on
    // the 112px desktop rail the caller's handle wins that fight every time.
    const sub = html.slice(html.indexOf('row-sub'), html.indexOf('row-peak'));
    expect(sub).not.toContain('peak $');
    expect(html).not.toContain('sub-peak');
  });

  it('keeps the round trip in its own span, so a narrow column can drop it', () => {
    const html = render(roundTripped, 'fresh');
    expect(html).toContain('<span class="row-peak-tail"> · back under call</span>');
    // The whole sentence survives on the element for anything that reads it.
    expect(html).toContain('title="peak $30M · 2.3x · back under call"');
  });

  it('...and emits no tail at all while the coin is still above its call', () => {
    const html = render({ ...roundTripped, mcapUsd: 14.3e6, multiple: 1.1 }, 'fresh');
    expect(html).toContain('row-peak');
    expect(html).toContain('peak $30M · 2.3x');
    expect(html).not.toContain('row-peak-tail');
    expect(html).not.toContain('back under call');
  });

  it('...and on a died row, under the death line', () => {
    const html = render(
      { ...roundTripped, phase: 'dead', callStatus: 'died', diedAt: new Date(NOW - 3 * HOUR).toISOString() },
      'died',
    );
    expect(html).toContain('died 3h ago');
    expect(html).toContain('row-peak');
    expect(html).toContain('peak $30M · 2.3x');
  });

  it('but not on a card that never left its call behind', () => {
    const html = render(
      { ...roundTripped, peakMcapSinceCall: null, peakMultiple: null, retraceFromPeakPct: null },
      'fresh',
    );
    expect(html).not.toContain('row-peak');
    expect(html).not.toContain('peak $');
  });

  it('and never twice on a Retraced row, which already says it', () => {
    const html = render(roundTripped, 'retraced');
    expect(html).toContain('-63% from peak $30M');
    expect(html).not.toContain('row-peak');
  });
});

/**
 * The member verdict on a card (docs/decisions.md round 21).
 *
 * $VLR is the case: 0.4x on intact liquidity, so no rule could kill it and the
 * group had to be able to. MARK DEAD rides every LIVE call surface; RESTORE
 * exists only where a member's own verdict does.
 */

const DEAD_PROPS: DeadProps = {
  onMarkDead: () => {},
  onRestore: () => {},
  pending: new Set<number>(),
};

/** A live call, resolved: $106K called, $46K now, LP intact. */
const dumped = card({
  phase: 'graduated',
  symbol: 'VLR',
  mcapUsd: 46_000,
  mcapAtCall: 106_000,
  multiple: 46 / 106,
  liquidityUsd: 19_000,
  dataAsOf: new Date(NOW - 60_000).toISOString(),
});

const markedDead = card({
  ...dumped,
  phase: 'dead',
  callStatus: 'died',
  deathReason: 'member',
  deathMarkedBy: '@pwnzssg',
  diedAt: new Date(NOW - 2 * HOUR).toISOString(),
  mcapAtDeath: 46_000,
});

const flatlined = card({
  ...dumped,
  phase: 'dead',
  callStatus: 'died',
  deathReason: 'flatline',
  diedAt: new Date(NOW - 2 * HOUR).toISOString(),
  mcapAtDeath: 46_000,
  vol24Usd: 120,
  txns24: 3,
});

/** Rendered the way a desktop row is: the hover strip is always in the markup. */
const withVerdict = (over: BoardCard, section: SectionKey = 'fresh') =>
  renderToStaticMarkup(
    <TokenCard
      card={over}
      section={section}
      now={NOW}
      size="desk"
      links="hover"
      animate={false}
      dead={deadForCard(over, DEAD_PROPS)}
    />,
  );

describe('TokenCard — MARK DEAD', () => {
  it('is offered on a live call', () => {
    const html = withVerdict(dumped);
    expect(html).toContain('MARK DEAD');
    expect(html).toContain('Mark $VLR dead for the whole group');
  });

  it('...and on an ON WATCH row, which is a live call too', () => {
    expect(withVerdict(dumped, 'watch')).toContain('MARK DEAD');
  });

  it('is never offered on a card that is already dead', () => {
    expect(withVerdict(markedDead, 'died')).not.toContain('MARK DEAD');
    expect(withVerdict(flatlined, 'died')).not.toContain('MARK DEAD');
    expect(
      withVerdict(
        card({ phase: 'dead', callStatus: 'died', deathReason: 'liquidity_floor' }),
        'died',
      ),
    ).not.toContain('MARK DEAD');
  });

  it('...and on a live call the poller cannot resolve (round 21 amendment (e))', () => {
    // The Base dud: the board still says "not indexed yet", and the group is
    // allowed to know better. Liveness of the CALL is the only scope.
    const html = withVerdict(card());
    expect(html).toContain('not indexed yet');
    expect(html).toContain('MARK DEAD');
  });

  it('is absent entirely where the surface does not offer the verdict', () => {
    const html = renderToStaticMarkup(
      <TokenCard card={dumped} section="fresh" now={NOW} size="desk" links="hover" animate={false} />,
    );
    expect(html).not.toContain('MARK DEAD');
    expect(html).not.toContain('pill-dead');
  });

  it('starts at rest — the guard only asks after the first tap', () => {
    expect(withVerdict(dumped)).not.toContain('SURE?');
  });
});

describe('TokenCard — RESTORE', () => {
  it('is offered on a member death, beside bin', () => {
    const html = withVerdict(markedDead, 'died');
    expect(html).toContain('RESTORE');
    expect(html).toContain('Put $VLR back on the board');
  });

  it('rides the hover strip on a desktop row, never the row head the strip covers', () => {
    // The strip paints over the row head the moment the mouse arrives, so a
    // pill in the head would vanish exactly when the reader reaches for it.
    const html = withVerdict(markedDead, 'watch');
    expect(html).toContain('RESTORE');
    expect(html).not.toContain('row-dead');
    const strip = html.slice(html.indexOf('row-hoverlinks'));
    expect(strip).toContain('RESTORE');
  });

  it('sits in the row head on a tap row, where there is no strip', () => {
    const html = renderToStaticMarkup(
      <TokenCard
        card={markedDead}
        section="died"
        now={NOW}
        links="tap"
        onToggle={() => {}}
        animate={false}
        dead={deadForCard(markedDead, DEAD_PROPS)}
      />,
    );
    expect(html).toContain('row-dead');
    expect(html).toContain('RESTORE');
  });

  it('is never offered on a rule-driven death', () => {
    expect(withVerdict(flatlined, 'died')).not.toContain('RESTORE');
    expect(
      withVerdict(
        card({ phase: 'dead', callStatus: 'died', deathReason: 'liquidity_floor' }),
        'died',
      ),
    ).not.toContain('RESTORE');
  });

  it('...nor on a live one', () => {
    expect(withVerdict(dumped)).not.toContain('RESTORE');
  });

  it('reaches the desktop died rail, where the corpse actually sits', () => {
    const html = renderToStaticMarkup(
      <TokenCard
        card={markedDead}
        section="died"
        now={NOW}
        size="rail"
        animate={false}
        dead={deadForCard(markedDead, DEAD_PROPS)}
      />,
    );
    expect(html).toContain('RESTORE');
    expect(html).toContain('marked dead by @pwnzssg');
  });
});

describe('TokenCard — round 21 death wording', () => {
  it('names who marked it, and what it was worth at death', () => {
    const html = withVerdict(markedDead, 'died');
    expect(html).toContain('marked dead by @pwnzssg');
    expect(html).toContain('$46K at death');
    expect(html).toContain('MARKED DEAD');
  });

  it('prints the flatline evidence — volume and trades', () => {
    const html = withVerdict(flatlined, 'died');
    expect(html).toContain('flatlined · vol $120 / 24h · 3 trades');
    expect(html).toContain('$46K at death');
  });

  it('drops a clause it does not have rather than printing a zero', () => {
    const html = withVerdict({ ...flatlined, txns24: null }, 'died');
    expect(html).toContain('flatlined · vol $120 / 24h');
    expect(html).not.toContain('trades');
  });

  it('leaves every other death wording untouched', () => {
    const html = withVerdict(
      card({
        phase: 'dead',
        callStatus: 'died',
        deathReason: 'liquidity_floor',
        diedAt: new Date(NOW - 3 * HOUR).toISOString(),
      }),
      'died',
    );
    expect(html).toContain('LIQ FLOOR');
    expect(html).toContain('died 3h ago');
    expect(html).not.toContain('marked dead');
    expect(html).not.toContain('flatlined');
  });
});
