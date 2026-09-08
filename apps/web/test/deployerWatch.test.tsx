import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DeployerWatchEntry, ProjectsResponse } from '@groupie/shared';
import { DEPLOYER_VIA_TEXT, Upcoming, deployerLine } from '../src/components/Upcoming';

/**
 * ROUND 26 — the deployer block under UPCOMING.
 *
 * The chat is where a deployer watch pays off ("notify me in the telegram group
 * as soon as its launched"), so this surface is a RECEIPT: what the group is
 * watching, who put it there, and what it has already done. It has no add or
 * remove of its own — `/overseer deployer <address>` is the whole interface —
 * and it must never let the weakest of the four signals read as a launch: a
 * 'create' hit is a contract deployment and may not be a token at all.
 */

const NOW = Date.UTC(2026, 8, 8, 12, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const WALLET = '0x9c5c4b4a985b0a60a1067a0d82020774661d074a';
const TOKEN = '0x8fcf98e1348d3ddee46cdd15a5c7d9a8d423077d';

function links() {
  return {
    axiom: `https://axiom.trade/t/${TOKEN}`,
    gmgn: `https://gmgn.ai/hood/token/${TOKEN}`,
    dexscreener: `https://dexscreener.com/hood/${TOKEN}`,
  };
}

function deployer(over: Partial<DeployerWatchEntry> = {}): DeployerWatchEntry {
  return {
    id: 1,
    address: WALLET,
    kind: 'eoa',
    note: null,
    addedBy: 55,
    addedByName: '@dev',
    addedByMe: false,
    addedAt: new Date(NOW - 3 * DAY).toISOString(),
    status: 'active',
    fired: null,
    ...over,
  };
}

function payload(deployers: DeployerWatchEntry[]): ProjectsResponse {
  return {
    enabled: true,
    lastCheckAt: new Date(NOW - 60_000).toISOString(),
    capPerGroup: 12,
    capPerMember: 3,
    slotsUsed: 0,
    slotsUsedByMe: 0,
    // Deliberately EMPTY: a group can watch a deployer without tracking a single
    // X account, and that is the case the block must survive.
    projects: [],
    deployers,
  };
}

const render = (deployers: DeployerWatchEntry[]) =>
  renderToStaticMarkup(
    <Upcoming
      data={payload(deployers)}
      loading={false}
      error={null}
      onRetry={() => {}}
      onTrack={async () => true}
      trackPending={false}
      onUntrack={() => {}}
      untrackPending={new Set<number>()}
      fetchedAt={NOW}
      serverAt={null}
      now={NOW}
    />,
  );

describe('deployerLine', () => {
  it('says what it is, that it is still watching, and whose slot it is', () => {
    expect(deployerLine(deployer(), NOW)).toBe('wallet · watching · added by @dev 3d ago');
  });

  it('calls the reader\'s own watch theirs, and prints their note verbatim', () => {
    expect(deployerLine(deployer({ addedByMe: true, note: 'cluby team' }), NOW)).toBe(
      'wallet · watching · added by you 3d ago · cluby team',
    );
  });

  it('names the signal that fired, in the same words the chat message used', () => {
    const line = deployerLine(
      deployer({
        kind: 'contract',
        status: 'fired',
        fired: {
          address: TOKEN,
          symbol: 'CLUBY',
          tokenId: 51,
          via: 'pons',
          at: new Date(NOW - 2 * HOUR).toISOString(),
          txHash: null,
          links: links(),
        },
      }),
      NOW,
    );
    expect(line).toContain('contract');
    expect(line).toContain('launched on PONS CLUBY 2h ago');
  });

  it('does not let a raw deployment read as a launch', () => {
    const line = deployerLine(
      deployer({
        status: 'fired',
        fired: {
          address: TOKEN,
          // No symbol: nothing has proved this address is a coin.
          symbol: null,
          tokenId: null,
          via: 'create',
          at: new Date(NOW - 5 * 60_000).toISOString(),
          txHash: null,
          links: links(),
        },
      }),
      NOW,
    );
    expect(line).toContain(DEPLOYER_VIA_TEXT.create);
    expect(line).not.toContain('launched');
  });

  it('never prints "watching" over a row that fired, even with no signal on it', () => {
    // The bot list's explicit rule, and the board owes the same one: a fired row
    // whose `via` never made it to the database serves `fired: null`, and
    // branching on that alone put the row back to "watching" — a promise this
    // watch is no longer keeping.
    const line = deployerLine(deployer({ status: 'fired', fired: null }), NOW);
    expect(line).toContain('fired');
    expect(line).not.toContain('watching');
  });

  it('still says it fired when the event could not be decoded', () => {
    // A registry event whose parameter layout we cannot read is a publication
    // all the same: the row must not print "watching" over it.
    const line = deployerLine(
      deployer({
        kind: 'contract',
        status: 'fired',
        fired: {
          address: null,
          symbol: null,
          tokenId: null,
          via: 'registry',
          at: new Date(NOW - HOUR).toISOString(),
          txHash: '0xabc',
          links: null,
        },
      }),
      NOW,
    );
    expect(line).toContain('published its official token');
    expect(line).toContain('address unreadable');
    expect(line).not.toContain('watching');
  });

  it('keeps the four verbs distinct — they are not equally strong evidence', () => {
    const phrases = Object.values(DEPLOYER_VIA_TEXT);
    expect(new Set(phrases).size).toBe(phrases.length);
    expect(DEPLOYER_VIA_TEXT.create).not.toContain('launch');
  });
});

describe('the deployer block', () => {
  it('draws under the accounts even when the group tracks none', () => {
    const html = render([deployer()]);
    expect(html).toContain('upc-deps');
    // Short address on the row, and the command that put it there in the head.
    expect(html).toContain('0x9c5c…074a');
    expect(html).toContain('/overseer deployer');
  });

  it('is absent entirely when nothing is watched', () => {
    expect(render([])).not.toContain('upc-deps');
  });

  it('links only what actually fired, never the watched wallet', () => {
    const watching = render([deployer()]);
    // A wallet is not a coin: no trading app has anything to say about it.
    expect(watching).not.toContain('dexscreener.com');

    const fired = render([
      deployer({
        status: 'fired',
        fired: {
          address: TOKEN,
          symbol: 'CLUBY',
          tokenId: 51,
          via: 'pool',
          at: new Date(NOW - HOUR).toISOString(),
          txHash: null,
          links: links(),
        },
      }),
    ]);
    expect(fired).toContain(`https://dexscreener.com/hood/${TOKEN}`);
    expect(fired).toContain('opened a pool');
  });
});
