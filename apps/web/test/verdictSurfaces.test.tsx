import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BoardCard, RangeBoardResponse, RangeCard } from '@groupie/shared';
import { MiniRows } from '../src/components/MiniBoard';
import { DEFAULT_CONTROLS, Ranging, resolveBand } from '../src/components/Ranging';
import type { DeadProps } from '../src/dead';
import type { WatchProps } from '../src/watch';

/**
 * MARK DEAD reaches every LIVE call surface (docs/decisions.md round 21,
 * amendment (e)) — including the two that shipped without it: the Telegram
 * half-sheet, where most members read the board, and the Ranging view, which
 * draws the group's own calls from its own payload.
 */

const NOW = Date.UTC(2026, 8, 3, 12, 0, 0);
const HOUR = 3_600_000;

const DEAD_PROPS: DeadProps = {
  onMarkDead: () => {},
  onRestore: () => {},
  pending: new Set<number>(),
};

const WATCH_PROPS: WatchProps = { onWatch: () => {}, pending: new Set<string>() };

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
    vol24Usd: 4_000,
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

describe('MiniBoard rows — the half-sheet carries the verdict', () => {
  const rows = [card()];
  const render = (openId: number | null, dead?: DeadProps) =>
    renderToStaticMarkup(
      <MiniRows
        rows={rows}
        now={NOW}
        watch={WATCH_PROPS}
        dead={dead}
        openId={openId}
        onToggle={() => {}}
      />,
    );

  it('offers MARK DEAD in the tapped-open strip, beside the links', () => {
    const html = render(1, DEAD_PROPS);
    expect(html).toContain('MARK DEAD');
    expect(html).toContain('Mark $VLR dead for the whole group');
  });

  it('...armed only by a second tap: the strip opens at rest', () => {
    expect(render(1, DEAD_PROPS)).not.toContain('SURE?');
  });

  it('keeps it inside the reveal — a closed row is still just a row', () => {
    // The half-sheet has no hover and no room for a strip that is always on,
    // so tapping the row IS how its controls are reached here.
    expect(render(null, DEAD_PROPS)).not.toContain('MARK DEAD');
  });

  it('draws nothing of the kind when the surface is not given the verdict', () => {
    const html = render(1, undefined);
    expect(html).not.toContain('MARK DEAD');
    expect(html).not.toContain('pill-dead');
  });
});

describe('Ranging cards — a coiler can be pronounced too', () => {
  const coiler: RangeCard = {
    ...card({ callId: 4, mcapUsd: 120_000 }),
    range: {
      inRangeSince: new Date(NOW - 9 * HOUR).toISOString(),
      inRangeHours: 9,
      observedLowUsd: 90_000,
      observedHighUsd: 140_000,
      bucketCount: 108,
    },
  };

  const data: RangeBoardResponse = {
    group: { slug: 'g', title: 'hammertime' },
    loUsd: 50_000,
    hiUsd: 150_000,
    minHours: 6,
    generatedAt: new Date(NOW).toISOString(),
    cards: [coiler],
  };

  const render = (dead?: DeadProps) =>
    renderToStaticMarkup(
      <Ranging
        controls={DEFAULT_CONTROLS}
        onControls={() => {}}
        band={resolveBand(DEFAULT_CONTROLS)}
        data={data}
        loading={false}
        error={null}
        onRetry={() => {}}
        now={NOW}
        watch={WATCH_PROPS}
        dead={dead}
      />,
    );

  it('offers MARK DEAD on the card, in the same reveal as the links', () => {
    const html = render(DEAD_PROPS);
    expect(html).toContain('MARK DEAD');
    expect(html).toContain('Mark $VLR dead for the whole group');
  });

  it('starts at rest here too', () => {
    expect(render(DEAD_PROPS)).not.toContain('SURE?');
  });

  it('offers nothing when the surface is not given the verdict', () => {
    const html = render(undefined);
    expect(html).not.toContain('MARK DEAD');
    expect(html).not.toContain('pill-dead');
  });
});
