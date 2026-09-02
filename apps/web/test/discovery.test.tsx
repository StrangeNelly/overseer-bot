import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DiscoveryEntry, DiscoveryResponse } from '@groupie/shared';
import { Discovery } from '../src/components/Discovery';
import {
  DEFAULT_DISCOVERY_HOURS,
  DISCOVERY_DORMANT_LINE,
  DISCOVERY_WAITING_LINE,
  asOfText,
  bundleText,
  deriveDiscoverySummary,
  dexLabel,
  discoveryCountOf,
  feedStatusText,
  filtersAfterFailedReload,
  filtersKey,
  filtersSentence,
  openedWithText,
  parseDiscoveryFlag,
  parseDiscoveryHours,
  subline,
} from '../src/discovery';
import type { WatchProps } from '../src/watch';

/**
 * Discovery is the chain's own feed (docs/decisions.md rounds 18 and 20), and
 * the three things it must never do are pretend a missing reading is a zero,
 * pretend a dormant (or stalled) feed is a quiet chain, and let a lit chip imply
 * a filter the payload dropped.
 */

const NOW = Date.UTC(2026, 8, 3, 12, 0, 0);
const MINUTE = 60_000;
const HOUR = 3_600_000;

const NO_WATCH: WatchProps = { onWatch: () => {}, pending: new Set<string>() };

function entry(over: Partial<DiscoveryEntry> = {}): DiscoveryEntry {
  return {
    kind: 'launch',
    address: '0xaaaa000000000000000000000000000000000001',
    symbol: 'NIMBUS',
    name: 'Nimbus',
    imageUrl: null,
    poolAddress: '0xpool000000000000000000000000000000000001',
    dex: 'uniswap-v4-robinhood',
    at: new Date(NOW - 3 * HOUR).toISOString(),
    initialLiquidityUsd: 24_000,
    initialLiquidityEth: 5.8,
    quoteSymbol: 'ETH',
    mcapUsd: 84_000,
    liquidityUsd: 22_000,
    dataAsOf: new Date(NOW - 2 * MINUTE).toISOString(),
    lpLockedPct: 100,
    twitterUrl: 'https://x.com/nimbus',
    websiteUrl: 'https://nimbus.example',
    launchBlockPct: 12,
    launchBlockWallets: 9,
    isStock: false,
    alerted: false,
    watched: false,
    watchedByMe: false,
    links: { axiom: 'https://axiom', gmgn: 'https://gmgn', dexscreener: 'https://dexscreener' },
    ...over,
  };
}

function payload(over: Partial<DiscoveryResponse> = {}): DiscoveryResponse {
  return {
    enabled: true,
    lastTickAt: new Date(NOW - MINUTE).toISOString(),
    hours: 24,
    filters: { xWeb: true, noBundles: true, noStocks: true },
    bundleMaxPct: 25,
    launches: [entry()],
    graduations: [],
    ...over,
  };
}

/** The payload landed a moment ago unless a test is about an OLD payload. */
const render = (data: DiscoveryResponse | null, fetchedAt: number | null = NOW) =>
  renderToStaticMarkup(
    <Discovery
      data={data}
      loading={false}
      error={null}
      onRetry={() => {}}
      hours={24}
      onHours={() => {}}
      filterChips={null}
      fetchedAt={fetchedAt}
      serverAt={null}
      now={NOW}
      watch={NO_WATCH}
    />,
  );

describe('Discovery — a launch row prints the facts, not a verdict', () => {
  it('names the venue, the money and the launch block', () => {
    const html = render(payload());
    expect(html).toContain('$NIMBUS');
    expect(html).toContain('v4');
    expect(html).toContain('$84K · LP $22K (locked 100%) · opened with 5.8 ETH');
    expect(html).toContain('launch block 12% · 9 wallets');
    // Both zones exist even when one of them is empty: the map never shifts.
    expect(html).toContain('LAUNCHES');
    expect(html).toContain('GRADUATED');
    expect(html).toContain('Nothing has graduated in this window.');
    expect(html).toContain('nothing here is tracked or called');
  });

  it('says unknown where the chain gave us nothing', () => {
    const html = render(
      payload({
        launches: [
          entry({
            launchBlockPct: null,
            launchBlockWallets: null,
            lpLockedPct: null,
            mcapUsd: null,
            initialLiquidityEth: null,
            initialLiquidityUsd: null,
            quoteSymbol: null,
          }),
        ],
      }),
    );
    expect(html).toContain('launch block unknown');
    expect(html).toContain('mcap unknown');
    expect(html).toContain('(lock unknown)');
    expect(html).toContain('opening size unknown');
    // The one thing an unreadable log must never turn into.
    expect(html).not.toContain('launch block 0%');
  });

  it('marks the rows the chat already announced', () => {
    expect(render(payload({ launches: [entry({ alerted: true })] }))).toContain('ALERTED');
    expect(render(payload())).not.toContain('ALERTED');
  });

  it('reports the filters the PAYLOAD applied, not the ones asked for', () => {
    const html = render(payload());
    expect(html).toContain('launch block under 25%');
    expect(html).toContain('no tokenized stocks');

    // Each filter is its own flag now: dropping one drops one clause.
    const noStocksOff = render(
      payload({ filters: { xWeb: true, noBundles: true, noStocks: false } }),
    );
    expect(noStocksOff).toContain('launch block under 25%');
    expect(noStocksOff).not.toContain('no tokenized stocks');

    const raw = render(payload({ filters: { xWeb: false, noBundles: false, noStocks: false } }));
    expect(raw).toContain('no filters applied — this is the raw stream');
    expect(raw).not.toContain('launch block under 25%');
  });

  it('dates a stale reading on the row itself', () => {
    const html = render(
      payload({ launches: [entry({ dataAsOf: new Date(NOW - 3 * HOUR).toISOString() })] }),
    );
    expect(html).toContain('opened with 5.8 ETH · read 3h ago');
  });
});

describe('Discovery — a stalled feed says so', () => {
  it('prints the last read when the listener has gone quiet', () => {
    const html = render(payload({ lastTickAt: new Date(NOW - 12 * MINUTE).toISOString() }));
    expect(html).toContain('feed stalled · last read 12m ago');
    // ...and still draws the zones: the rows are real, they are just not fresh.
    expect(html).toContain('LAUNCHES');
  });

  it('says it is waiting before the first tick', () => {
    expect(render(payload({ lastTickAt: null }))).toContain(DISCOVERY_WAITING_LINE);
    // ...even when the payload saying so is itself old: "no tick yet" is a fact
    // about the response, not a claim about the last two minutes.
    expect(render(payload({ lastTickAt: null }), NOW - 4 * HOUR)).toContain(
      DISCOVERY_WAITING_LINE,
    );
  });

  it('says nothing at all while the feed is reading', () => {
    const html = render(payload());
    expect(html).not.toContain('feed stalled');
    expect(html).not.toContain(DISCOVERY_WAITING_LINE);
  });

  it('blames the listener only when the payload on screen is current', () => {
    // Back from a hidden tab: the poll was asleep, so this payload is an hour
    // old. Its tick is an hour old with it — that is OUR silence, not a stall.
    const stale = render(
      payload({ lastTickAt: new Date(NOW - 61 * MINUTE).toISOString() }),
      NOW - 60 * MINUTE,
    );
    expect(stale).not.toContain('feed stalled');
    // The rows are still drawn: they are real, they are just not fresh.
    expect(stale).toContain('LAUNCHES');
  });
});

describe('Discovery — dormant is a sentence, never an empty list', () => {
  it('says the feed is not configured instead of drawing zones', () => {
    const html = render(
      payload({ enabled: false, lastTickAt: null, launches: [], graduations: [] }),
    );
    expect(html).toContain(DISCOVERY_DORMANT_LINE);
    expect(html).not.toContain('LAUNCHES');
    expect(html).not.toContain('GRADUATED');
    expect(html).not.toContain('nothing here is tracked or called');
    // A dormant deployment has no listener to be stalled or waiting.
    expect(html).not.toContain(DISCOVERY_WAITING_LINE);
  });

  it('never claims the chips narrowed a stream that does not exist', () => {
    const html = render(
      payload({ enabled: false, lastTickAt: null, launches: [], graduations: [] }),
    );
    expect(html).not.toContain('showing ');
    expect(html).not.toContain('launch block under 25%');
    expect(html).toContain('each filter is its own switch');
  });
});

describe('discovery helpers — the stored controls', () => {
  it('only accepts a window the view actually has', () => {
    expect(parseDiscoveryHours('6')).toBe(6);
    expect(parseDiscoveryHours('24')).toBe(24);
    expect(parseDiscoveryHours('12')).toBe(DEFAULT_DISCOVERY_HOURS);
    expect(parseDiscoveryHours('nonsense')).toBe(DEFAULT_DISCOVERY_HOURS);
    expect(parseDiscoveryHours('')).toBe(DEFAULT_DISCOVERY_HOURS);
    expect(parseDiscoveryHours(null)).toBe(DEFAULT_DISCOVERY_HOURS);
  });

  it('turns a filter off only for a literal 0', () => {
    expect(parseDiscoveryFlag('0')).toBe(false);
    expect(parseDiscoveryFlag('1')).toBe(true);
    // First visit, and a blob some other version (or hand) wrote.
    expect(parseDiscoveryFlag(null)).toBe(true);
    expect(parseDiscoveryFlag('false')).toBe(true);
  });

  it('names exactly the filters the payload applied', () => {
    expect(filtersSentence(payload())).toBe(
      'showing only coins with an X account and a website, launch block under 25%, no tokenized stocks',
    );
    expect(
      filtersSentence(payload({ filters: { xWeb: false, noBundles: true, noStocks: false } })),
    ).toBe('showing launch block under 25%');
    expect(
      filtersSentence(payload({ filters: { xWeb: false, noBundles: false, noStocks: false } })),
    ).toBe('no filters applied — this is the raw stream');
  });

  it('snaps the chips back to the payload when a reload fails', () => {
    const shown = payload();
    // The member turned "no stocks" off, the request failed, and the rows on
    // screen are still the filtered ones: the chip goes back to matching them.
    expect(
      filtersAfterFailedReload({ xWeb: true, noBundles: true, noStocks: false }, shown),
    ).toEqual(shown.filters);
    // A failed poll that asked for exactly what is on screen changes nothing.
    expect(filtersAfterFailedReload({ xWeb: true, noBundles: true, noStocks: true }, shown)).toBeNull();
    // Nothing painted yet: there is no payload for the chips to disagree with,
    // and the failure screen says why the rows are missing.
    expect(
      filtersAfterFailedReload({ xWeb: false, noBundles: false, noStocks: false }, null),
    ).toBeNull();
  });

  it('keys the three flags so a chip change remounts the grid', () => {
    expect(filtersKey({ xWeb: true, noBundles: true, noStocks: true })).toBe('111');
    expect(filtersKey({ xWeb: true, noBundles: false, noStocks: true })).toBe('101');
    expect(filtersKey({ xWeb: false, noBundles: false, noStocks: false })).toBe('000');
  });
});

describe('discovery helpers — row text', () => {
  it('labels the venue a member would recognise', () => {
    expect(dexLabel('uniswap-v2-robinhood')).toBe('v2');
    expect(dexLabel('uniswap-v4-robinhood')).toBe('v4');
    expect(dexLabel('pons-v2-dex')).toBe('PONS');
    expect(dexLabel('pons-v2')).toBe('PONS');
    // An id we do not know prints itself rather than a guess.
    expect(dexLabel('sushiswap-v3-robinhood')).toBe('SUSHISWAP');
    expect(dexLabel('  ')).toBe('—');
  });

  it('counts one wallet in the singular', () => {
    expect(bundleText(12, 1)).toBe('launch block 12% · 1 wallet');
    expect(bundleText(12, null)).toBe('launch block 12%');
    expect(bundleText(null, 9)).toBe('launch block unknown');
    expect(bundleText(0, 0)).toBe('launch block 0% · 0 wallets');
  });

  it('names the asset the pool was actually opened with', () => {
    expect(openedWithText(entry())).toBe('opened with 5.8 ETH');
    // A USDG pool's ETH figure is an EQUIVALENT, never a deposit: printing it
    // would invent an ETH pairing that never existed.
    expect(
      openedWithText(entry({ quoteSymbol: 'USDG', initialLiquidityUsd: 12_000, initialLiquidityEth: 3.1 })),
    ).toBe('opened with $12K USDG');
    expect(
      openedWithText(entry({ quoteSymbol: 'USDG', initialLiquidityUsd: null, initialLiquidityEth: 3.1 })),
    ).toBe('opening size unknown');
    // An unmeasured deposit with no quote asset at all.
    expect(
      openedWithText(entry({ quoteSymbol: null, initialLiquidityEth: null, initialLiquidityUsd: null })),
    ).toBe('opening size unknown');
  });

  it('never claims a graduation opened a pool', () => {
    const migrated = entry({ kind: 'graduation', dex: 'pons-v2-dex' });
    expect(openedWithText(migrated)).toBeNull();
    const text = subline(migrated, NOW);
    expect(text).toBe('$84K · LP $22K (locked 100%)');
    expect(text).not.toContain('opened with');
  });

  it('dates the money only once the reading is stale', () => {
    expect(asOfText(new Date(NOW - 2 * MINUTE).toISOString(), NOW)).toBeNull();
    expect(asOfText(new Date(NOW - 14 * MINUTE).toISOString(), NOW)).toBeNull();
    expect(asOfText(new Date(NOW - 40 * MINUTE).toISOString(), NOW)).toBe('read 40m ago');
    expect(asOfText(new Date(NOW - 3 * HOUR).toISOString(), NOW)).toBe('read 3h ago');
    // Never enriched: "mcap unknown" already says it, and there is no read to date.
    expect(asOfText(null, NOW)).toBeNull();
    expect(asOfText('not a date', NOW)).toBeNull();
  });
});

describe('discovery helpers — the feed status line', () => {
  it('is silent inside the stall window and loud past it', () => {
    expect(feedStatusText(true, new Date(NOW - MINUTE).toISOString(), NOW, NOW)).toBeNull();
    expect(feedStatusText(true, new Date(NOW - 4 * MINUTE).toISOString(), NOW, NOW)).toBeNull();
    expect(feedStatusText(true, new Date(NOW - 12 * MINUTE).toISOString(), NOW, NOW)).toBe(
      'feed stalled · last read 12m ago',
    );
    expect(feedStatusText(true, new Date(NOW - 5 * HOUR).toISOString(), NOW, NOW)).toBe(
      'feed stalled · last read 5h ago',
    );
  });

  it('measures the lag from the payload, not from the wall clock', () => {
    const tick = new Date(NOW - 6 * MINUTE).toISOString();
    // The read that fetched this payload happened a minute ago and the tick was
    // already five minutes behind it then: that IS a stalled listener.
    expect(feedStatusText(true, tick, NOW - MINUTE, NOW)).toBe('feed stalled · last read 6m ago');
    // Same tick, but the payload predates it by an hour: this screen is old, and
    // an old screen has nothing to say about what the listener is doing now.
    expect(feedStatusText(true, tick, NOW - 60 * MINUTE, NOW)).toBeNull();
  });

  it('does not turn a jumped clock into a verdict on the chain', () => {
    // The device slept (or its clock stepped forward): `now` ran away from the
    // instant the payload landed, while the tick behind it was current.
    const tick = new Date(NOW - 3 * HOUR - MINUTE).toISOString();
    expect(feedStatusText(true, tick, NOW - 3 * HOUR, NOW)).toBeNull();
    // A clock that ran BACKWARDS cannot invent one either.
    expect(feedStatusText(true, new Date(NOW + HOUR).toISOString(), NOW, NOW)).toBeNull();
  });

  it('reads the tick against the SERVER clock when the response carries one', () => {
    // This device runs ten minutes ahead of the server. The server's Date
    // header says the payload was written at NOW - 10m (server time); the tick
    // was one minute before that, i.e. a listener reading normally.
    const serverAt = NOW - 10 * MINUTE;
    const tick = new Date(serverAt - MINUTE).toISOString();
    expect(feedStatusText(true, tick, NOW, NOW, serverAt)).toBeNull();
    // Without the server's instant the same payload would read as an 11-minute
    // lag: that is the false stall the header exists to prevent.
    expect(feedStatusText(true, tick, NOW, NOW)).toBe('feed stalled · last read 11m ago');
    // A genuine stall on the server's clock still prints, and prints the
    // server-relative age rather than the skewed one.
    const stale = new Date(serverAt - 6 * MINUTE).toISOString();
    expect(feedStatusText(true, stale, NOW, NOW, serverAt)).toBe(
      'feed stalled · last read 6m ago',
    );
  });

  it('waits rather than claiming a stall it cannot date', () => {
    expect(feedStatusText(true, null, NOW, NOW)).toBe(DISCOVERY_WAITING_LINE);
    expect(feedStatusText(true, 'not a date', NOW, NOW)).toBe(DISCOVERY_WAITING_LINE);
    // Before the first successful read there is no payload to judge, but "no
    // tick yet" is still the honest line.
    expect(feedStatusText(true, null, null, NOW)).toBe(DISCOVERY_WAITING_LINE);
    expect(feedStatusText(true, new Date(NOW - 5 * HOUR).toISOString(), null, NOW)).toBeNull();
  });

  it('says nothing on a deployment with no listener at all', () => {
    expect(feedStatusText(false, null, NOW, NOW)).toBeNull();
    expect(feedStatusText(false, new Date(NOW - 5 * HOUR).toISOString(), NOW, NOW)).toBeNull();
  });
});

describe('discovery helpers — the rail summary', () => {
  it('carries the counts, the window, the heartbeat and the newest event', () => {
    const newer = entry({ symbol: 'GRAD', kind: 'graduation', at: new Date(NOW - MINUTE).toISOString() });
    const summary = deriveDiscoverySummary(payload({ graduations: [newer] }), NOW);
    expect(summary).not.toBeNull();
    expect(summary?.launches).toBe(1);
    expect(summary?.graduations).toBe(1);
    expect(summary?.hours).toBe(24);
    expect(summary?.lastTickAt).toBe(new Date(NOW - MINUTE).toISOString());
    // The rail judges the stall against the payload too, so it carries the
    // instant that payload landed.
    expect(summary?.fetchedAt).toBe(NOW);
    expect(summary?.newest?.label).toBe('$GRAD');
  });

  it('falls back to a short address and ignores an unparseable stamp', () => {
    const summary = deriveDiscoverySummary(
      payload({
        launches: [entry({ symbol: null, at: new Date(NOW - HOUR).toISOString() })],
        graduations: [entry({ symbol: 'BROKEN', kind: 'graduation', at: 'not a date' })],
      }),
      NOW,
    );
    expect(summary?.newest?.label).toBe('0xaaaa…0001');
  });

  it('counts nothing while the feed is dormant', () => {
    expect(discoveryCountOf(payload())).toBe(1);
    expect(discoveryCountOf(payload({ enabled: false }))).toBeNull();
    expect(discoveryCountOf(null)).toBeNull();
    expect(deriveDiscoverySummary(null, NOW)).toBeNull();
  });
});
