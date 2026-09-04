import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { XWATCH } from '@groupie/shared';
import type {
  ProjectCandidate,
  ProjectEntry,
  ProjectsResponse,
  WatchlistEntry,
} from '@groupie/shared';
import { Upcoming } from '../src/components/Upcoming';
import type { WatchProps } from '../src/watch';
import {
  PING_HELD_HIJACK_LABEL,
  PING_HELD_LABEL,
  PING_MUTED_LABEL,
  UPCOMING_DORMANT_LINE,
  UPCOMING_EMPTY_LINE,
  UPCOMING_FOOTNOTE,
  UPCOMING_IDLE_LINE,
  UPCOMING_RENAMED_NOTE,
  UPCOMING_STALL_MS,
  UPCOMING_WAITING_LINE,
  accountAgeText,
  addedText,
  applyUntracked,
  candidateReasonText,
  candidateText,
  canUntrack,
  capsText,
  checkStatus,
  checkStatusText,
  deriveUpcomingSummary,
  followersText,
  handleUrl,
  hasActiveMonitor,
  holdsSlot,
  isAtGroupCap,
  lastPostText,
  launchWatchTarget,
  launchedText,
  normalizeHandle,
  orderProjects,
  pingBadge,
  postedText,
  statusChipText,
  statusNoteText,
  summaryCountsText,
  summaryNewestText,
  upcomingCountOf,
} from '../src/upcoming';

/**
 * UPCOMING (docs/decisions.md round 23). The things this surface must never do:
 * let a token that merely CLAIMS a handle read as something the account posted,
 * print an unknown as a zero, let a dormant (or stalled) watcher read as a set of
 * quiet accounts, and count history against a cap the server counts in slots.
 */

const NOW = Date.UTC(2026, 8, 3, 12, 0, 0);
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const ADDRESS = '0xb2790000000000000000000000000000000060cc';

function links() {
  return { axiom: 'https://axiom', gmgn: 'https://gmgn', dexscreener: 'https://dexscreener' };
}

/** Tier B by default: the impostor that names the handle it never posted from. */
function candidate(over: Partial<ProjectCandidate> = {}): ProjectCandidate {
  return {
    kind: 'claims',
    address: '0xbbbb000000000000000000000000000000000002',
    symbol: 'LEGS',
    mcapUsd: 31_000,
    at: new Date(NOW - 2 * HOUR).toISOString(),
    tweetUrl: null,
    lastReason: null,
    links: links(),
    ...over,
  };
}

/** The account's own post, still one confirmation short of a launch. */
function posted(over: Partial<ProjectCandidate> = {}): ProjectCandidate {
  return candidate({
    kind: 'posted',
    address: ADDRESS,
    symbol: null,
    mcapUsd: null,
    at: new Date(NOW - 4 * MINUTE).toISOString(),
    tweetUrl: 'https://x.com/legsdotfun/status/9',
    lastReason: 'unresolved',
    ...over,
  });
}

type Launched = NonNullable<ProjectEntry['launched']>;

function launched(over: Partial<Launched> = {}): Launched {
  return {
    address: ADDRESS,
    symbol: 'LEGS',
    tokenId: 42,
    at: new Date(NOW - 4 * MINUTE).toISOString(),
    tokenCreatedAt: new Date(NOW - 4 * MINUTE).toISOString(),
    tweetUrl: null,
    pinged: true,
    heldReason: null,
    links: links(),
    ...over,
  };
}

function project(over: Partial<ProjectEntry> = {}): ProjectEntry {
  return {
    id: 1,
    handle: 'legsdotfun',
    xUserId: '1512340',
    displayName: 'legs',
    avatarUrl: null,
    bio: 'the first leg protocol on hood',
    followers: 1_900,
    followersAtAdd: 1_892,
    accountCreatedAt: new Date(NOW - 730 * DAY).toISOString(),
    lastPostAt: new Date(NOW - 14 * HOUR).toISOString(),
    // The ordinary channel (round 25). The recovery channels get their own file,
    // `upcomingVia.test.tsx`, because they are what the row must SAY something
    // about — this fixture is the account X's Latest index is not hiding.
    lastPostVia: 'search',
    lastCheckedAt: new Date(NOW - MINUTE).toISOString(),
    note: 'from the pinned thread',
    addedBy: 55,
    addedByName: '@dev',
    addedAt: new Date(NOW - 3 * DAY).toISOString(),
    addedByMe: false,
    status: 'active',
    launched: null,
    candidates: [],
    ...over,
  };
}

function payload(over: Partial<ProjectsResponse> = {}): ProjectsResponse {
  const projects = over.projects ?? [project()];
  return {
    enabled: true,
    lastCheckAt: new Date(NOW - MINUTE).toISOString(),
    capPerGroup: 12,
    capPerMember: 3,
    // The server counts SLOTS, not rows; so does the fixture, unless a test is
    // about the difference between the two.
    slotsUsed: projects.filter((entry) => holdsSlot(entry.status)).length,
    slotsUsedByMe: projects.filter((entry) => holdsSlot(entry.status) && entry.addedByMe).length,
    ...over,
    projects,
  };
}

function watchEntry(over: Partial<WatchlistEntry> = {}): WatchlistEntry {
  return {
    tokenId: 42,
    // Deliberately not the payload's casing: addresses are matched lowercased.
    address: ADDRESS.toUpperCase(),
    symbol: 'LEGS',
    imageUrl: null,
    phase: 'graduated',
    rugHiddenAt: null,
    callStatus: null,
    mcapUsd: null,
    liquidityUsd: null,
    dataAsOf: null,
    sparkline: [],
    mcapAtWatch: null,
    addedBy: 55,
    addedByName: '@dev',
    addedAt: new Date(NOW - MINUTE).toISOString(),
    watchedByMe: true,
    callId: null,
    twitterUrl: null,
    websiteUrl: null,
    links: links(),
    ...over,
  };
}

const NO_PENDING: ReadonlySet<number> = new Set<number>();
const WATCH_PROPS: WatchProps = { onWatch: () => {}, pending: new Set<string>() };

/** The payload landed a moment ago unless a test is about an OLD payload. */
const render = (
  data: ProjectsResponse | null,
  options: {
    fetchedAt?: number | null;
    watchlist?: readonly WatchlistEntry[];
    watch?: WatchProps;
  } = {},
) =>
  renderToStaticMarkup(
    <Upcoming
      data={data}
      loading={false}
      error={null}
      onRetry={() => {}}
      onTrack={async () => true}
      trackPending={false}
      onUntrack={() => {}}
      untrackPending={NO_PENDING}
      fetchedAt={options.fetchedAt === undefined ? NOW : options.fetchedAt}
      serverAt={null}
      watchlist={options.watchlist}
      watch={options.watch}
      now={NOW}
    />,
  );

describe('Upcoming — a tracked account row prints facts, never a forecast', () => {
  it('names the account, the curve, the age and who put it there', () => {
    const html = render(payload());
    expect(html).toContain('@legsdotfun');
    expect(html).toContain('legs');
    expect(html).toContain('ACTIVE');
    expect(html).toContain('1.9K · +8 since added');
    expect(html).toContain('the first leg protocol on hood');
    expect(html).toContain('account 2y');
    expect(html).toContain('last post 14h ago');
    expect(html).toContain('added by @dev · 3d ago');
    expect(html).toContain('from the pinned thread');
    // The account itself — the one link a reader of this row wants.
    expect(html).toContain('https://x.com/legsdotfun');
    // Any member can remove a monitor, and the pill asks before it fires.
    expect(html).toContain('UNTRACK');
    // The trust frame under the rows.
    expect(html).toContain('never as a launch');
  });

  it('says unknown where X told us nothing', () => {
    const html = render(
      payload({
        projects: [
          project({
            followers: null,
            followersAtAdd: null,
            accountCreatedAt: null,
            lastPostAt: null,
            bio: null,
            displayName: null,
            note: null,
          }),
        ],
      }),
    );
    expect(html).toContain('followers unknown');
    expect(html).toContain('account age unknown');
    expect(html).toContain('no posts seen yet');
    expect(html).toContain('no bio');
    // The one thing a missing count must never become.
    expect(html).not.toContain('0 followers');
  });

  it('prints the launched line, its links and a held ping', () => {
    const html = render(
      payload({
        projects: [
          project({
            status: 'launched',
            launched: launched({
              at: new Date(NOW - 4 * MINUTE).toISOString(),
              tokenCreatedAt: new Date(NOW - 50 * MINUTE).toISOString(),
              tweetUrl: 'https://x.com/legsdotfun/status/1',
              pinged: false,
              heldReason: 'hijack',
            }),
          }),
        ],
      }),
    );
    expect(html).toContain('LAUNCHED');
    // The token predates the post by 46 minutes — the hijack case, dated
    // against the post rather than against the wall clock.
    expect(html).toContain('LEGS · 0xb279…60cc · launched 46m before the post');
    expect(html).toContain('posted 4m ago');
    expect(html).toContain(PING_HELD_HIJACK_LABEL);
    expect(html).toContain('https://x.com/legsdotfun/status/1');
    expect(html).toContain('AXIOM');
  });

  it('dates the launch from the token, and says so when it cannot', () => {
    const twoHours = render(
      payload({
        projects: [
          project({
            status: 'launched',
            launched: launched({ tokenCreatedAt: new Date(NOW - 2 * HOUR).toISOString() }),
          }),
        ],
      }),
    );
    // The POST is four minutes old; the token is two hours old. The row dates
    // the launch from the chain, never from our own trigger.
    expect(twoHours).toContain('launched 2h ago');
    expect(twoHours).toContain('posted 4m ago');

    const unknown = render(
      payload({
        projects: [project({ status: 'launched', launched: launched({ tokenCreatedAt: null }) })],
      }),
    );
    expect(unknown).toContain('launch time unknown');
    expect(unknown).not.toContain('launched 4m ago');
  });

  it('says which silence it was: held for a hijack, or muted by the group', () => {
    const muted = render(
      payload({
        projects: [
          project({
            status: 'launched',
            launched: launched({ pinged: false, heldReason: 'muted' }),
          }),
        ],
      }),
    );
    expect(muted).toContain(PING_MUTED_LABEL);
    expect(muted).not.toContain(PING_HELD_HIJACK_LABEL);
    // A muted ping says nothing about the token's own clock.
    expect(muted).toContain('launched 4m ago');
  });

  it('says nothing about the ping when it actually went out', () => {
    const html = render(
      payload({ projects: [project({ status: 'launched', launched: launched() })] }),
    );
    expect(html).not.toContain(PING_HELD_LABEL);
    expect(html).not.toContain(PING_MUTED_LABEL);
  });

  it('nests a claim under the account and never calls it a launch', () => {
    const html = render(payload({ projects: [project({ candidates: [candidate()] })] }));
    expect(html).toContain('claims @legsdotfun · not posted by the account · $31K');
    expect(html).toContain('$LEGS');
    // A claim is not a launch, and the row that carries it has not fired.
    expect(html).not.toContain('launched ');
    expect(html).not.toContain('LAUNCHED');
  });

  it('draws the account’s own unconfirmed post as posted, with the post itself', () => {
    const html = render(payload({ projects: [project({ candidates: [posted()] })] }));
    expect(html).toContain('posted 0xb279…60cc · not confirmed on chain yet · 4m ago');
    // Why it has not confirmed, in words rather than in a column value.
    expect(html).toContain('not indexed yet');
    expect(html).toContain('https://x.com/legsdotfun/status/9');
    expect(html).toContain('AXIOM');
    // It is the account's own post: it is not "claiming" anything.
    expect(html).not.toContain('claims @legsdotfun');
    // ...and it has not launched, so it never reads as one.
    expect(html).not.toContain('LAUNCHED');
  });
});

describe('Upcoming — a dormant, stalled or idle watcher says so', () => {
  it('says the feed is not configured instead of drawing an empty list', () => {
    const html = render(payload({ enabled: false, lastCheckAt: null, projects: [] }));
    expect(html).toContain(UPCOMING_DORMANT_LINE);
    // A dormant deployment has no watcher to be stalled, waiting or idle...
    expect(html).not.toContain(UPCOMING_WAITING_LINE);
    expect(html).not.toContain(UPCOMING_IDLE_LINE);
    expect(html).not.toContain('feed stalled');
    // ...and "nobody is tracking anything" is a different sentence entirely.
    expect(html).not.toContain(UPCOMING_EMPTY_LINE);
  });

  it('keeps the rows a member added even while nothing is checking them', () => {
    const html = render(payload({ enabled: false, lastCheckAt: null }));
    expect(html).toContain(UPCOMING_DORMANT_LINE);
    expect(html).toContain('@legsdotfun');
  });

  it('invites the first monitor when the watcher is live and the list is empty', () => {
    const html = render(payload({ projects: [] }));
    expect(html).toContain(UPCOMING_EMPTY_LINE);
    expect(html).not.toContain(UPCOMING_DORMANT_LINE);
  });

  it('does not tell a brand-new group there is nothing left to check', () => {
    // Nothing tracked and no check ever made: the invitation is the whole
    // story. A watcher note over an empty list reads as a fault.
    const html = render(payload({ projects: [], lastCheckAt: null }));
    expect(html).toContain(UPCOMING_EMPTY_LINE);
    expect(html).not.toContain(UPCOMING_IDLE_LINE);
    expect(html).not.toContain(UPCOMING_WAITING_LINE);
    expect(html).not.toContain('feed stalled');
  });

  it('prints the last check when the watcher has gone quiet', () => {
    const html = render(payload({ lastCheckAt: new Date(NOW - 22 * MINUTE).toISOString() }));
    expect(html).toContain('feed stalled · last check 22m ago');
    // ...and still draws the rows: they are real, they are just not fresh.
    expect(html).toContain('@legsdotfun');
  });

  it('says nothing at all while the watcher is checking', () => {
    const html = render(payload());
    expect(html).not.toContain('feed stalled');
    expect(html).not.toContain(UPCOMING_WAITING_LINE);
    expect(html).not.toContain(UPCOMING_IDLE_LINE);
  });

  it('says there is nothing left to check rather than waiting for a check', () => {
    // Every monitor is history: the watcher is not stalled and it is not late,
    // it simply has nothing to poll.
    const html = render(
      payload({
        lastCheckAt: null,
        projects: [
          project({ id: 1, status: 'launched', launched: launched() }),
          project({ id: 2, handle: 'gone', status: 'expired' }),
        ],
      }),
    );
    expect(html).toContain(UPCOMING_IDLE_LINE);
    expect(html).not.toContain(UPCOMING_WAITING_LINE);
    expect(html).not.toContain('feed stalled');
    // A note, not the stall frame: no watcher is misbehaving.
    expect(html).toContain('class="upc-idle"');
  });

  it('names the caps the payload actually enforces', () => {
    expect(render(payload())).toContain('1 / 12 tracked · your slots 0 / 3');
  });

  it('reads the stall window and the expiry off the shared constants', () => {
    // The numbers in these sentences are the numbers the server acts on: read
    // from the contract so a tuning change cannot leave the board lying.
    expect(UPCOMING_STALL_MS).toBe(XWATCH.stallMinutes * 60_000);
    expect(UPCOMING_FOOTNOTE).toContain(`no post for ${XWATCH.expireDays} days expires`);
    expect(render(payload())).toContain(`no post for ${XWATCH.expireDays} days expires`);
  });
});

describe('Upcoming — slots, not rows', () => {
  const historyPayload = () =>
    payload({
      projects: [
        project({ id: 1 }),
        project({ id: 2, handle: 'fired', status: 'launched', launched: launched() }),
        project({ id: 3, handle: 'gone', status: 'expired' }),
      ],
    });

  it('counts the slots the server counts wherever the cap is what is being said', () => {
    const data = historyPayload();
    expect(data.slotsUsed).toBe(1);
    expect(capsText(data)).toBe('1 / 12 tracked · your slots 0 / 3');
    expect(deriveUpcomingSummary(data, NOW)?.tracked).toBe(1);
    // Three rows still draw — history is not hidden, it is just not a slot...
    expect(data.projects).toHaveLength(3);
    // ...and the chip beside the tab counts what is behind the tab.
    expect(upcomingCountOf(data)).toBe(3);
  });

  it('never prints a chip of 0 over a screen full of launched rows', () => {
    // Every monitor is history: no slots at all, three rows to read. A chip is
    // a promise about what is behind the tab, so it counts the rows.
    const data = payload({
      projects: [
        project({ id: 1, handle: 'fired', status: 'launched', launched: launched() }),
        project({ id: 2, handle: 'gone', status: 'expired' }),
      ],
    });
    expect(data.slotsUsed).toBe(0);
    expect(upcomingCountOf(data)).toBe(2);
    // ...and an empty list is still an honest zero, a dormant watcher still none.
    expect(upcomingCountOf(payload({ projects: [] }))).toBe(0);
    expect(upcomingCountOf(payload({ enabled: false }))).toBeNull();
  });

  it('prints the reader’s own slots, which is the half they can act on', () => {
    expect(capsText(payload({ slotsUsed: 4, slotsUsedByMe: 2 }))).toBe(
      '4 / 12 tracked · your slots 2 / 3',
    );
    expect(capsText(payload({ capPerGroup: 8, capPerMember: 2, slotsUsed: 8, slotsUsedByMe: 1 }))).toBe(
      '8 / 8 tracked · your slots 1 / 2',
    );
  });

  it('refuses an add only when the SLOTS are gone', () => {
    // Twelve rows, one slot: the server would take another handle, so the field
    // must not refuse it.
    expect(isAtGroupCap(payload({ slotsUsed: 1, capPerGroup: 12 }))).toBe(false);
    expect(isAtGroupCap(payload({ slotsUsed: 12, capPerGroup: 12 }))).toBe(true);
    expect(isAtGroupCap(payload({ slotsUsed: 13, capPerGroup: 12 }))).toBe(true);
    expect(isAtGroupCap(null)).toBe(false);
  });

  it('knows which statuses hold a slot at all', () => {
    expect(holdsSlot('active')).toBe(true);
    expect(holdsSlot('renamed')).toBe(true);
    expect(holdsSlot('suspended')).toBe(true);
    expect(holdsSlot('launched')).toBe(false);
    expect(holdsSlot('expired')).toBe(false);
    expect(holdsSlot('removed')).toBe(false);
  });

  it('gives back the slot the reader just untracked, and only that one', () => {
    const mine = project({ id: 1, addedByMe: true });
    const theirs = project({ id: 2, handle: 'theirs' });
    const fired = project({ id: 3, handle: 'fired', status: 'launched', launched: launched() });
    const data = payload({ projects: [mine, theirs, fired] });
    expect(data.slotsUsed).toBe(2);
    expect(data.slotsUsedByMe).toBe(1);

    const afterMine = applyUntracked(data, new Set([1]));
    expect(afterMine.projects.map((entry) => entry.id)).toEqual([2, 3]);
    expect(afterMine.slotsUsed).toBe(1);
    expect(afterMine.slotsUsedByMe).toBe(0);

    // A launched row holds no slot, so removing it frees none.
    const afterFired = applyUntracked(data, new Set([3]));
    expect(afterFired.slotsUsed).toBe(2);
    expect(afterFired.slotsUsedByMe).toBe(1);

    // Nothing removed is the payload itself, untouched.
    expect(applyUntracked(data, new Set<number>())).toBe(data);
    // ...and the count can never go negative when the payload disagrees.
    expect(applyUntracked({ ...data, slotsUsed: 0, slotsUsedByMe: 0 }, new Set([1])).slotsUsed).toBe(
      0,
    );
  });

  it('shows the slot arithmetic on the surface itself', () => {
    expect(render(historyPayload())).toContain('1 / 12 tracked · your slots 0 / 3');
  });
});

describe('Upcoming — the WATCH pill on a launched token', () => {
  const withLaunch = () =>
    payload({ projects: [project({ status: 'launched', launched: launched() })] });

  it('reads the watch state off the board’s watchlist, by address', () => {
    const html = render(withLaunch(), { watch: WATCH_PROPS, watchlist: [watchEntry()] });
    expect(html).toContain('WATCHING · YOU');
  });

  it('offers the pill on a coin nobody is watching yet', () => {
    const html = render(withLaunch(), { watch: WATCH_PROPS, watchlist: [] });
    expect(html).toContain('>WATCH<');
    expect(html).not.toContain('WATCHING');
  });

  it('names another member’s slot as theirs', () => {
    const html = render(withLaunch(), {
      watch: WATCH_PROPS,
      watchlist: [watchEntry({ watchedByMe: false })],
    });
    expect(html).toContain('WATCHING');
    expect(html).not.toContain('WATCHING · YOU');
  });

  it('never puts one on a candidate — nothing has confirmed it is a coin', () => {
    const html = render(
      payload({
        projects: [
          project({ status: 'launched', launched: launched(), candidates: [candidate(), posted()] }),
        ],
      }),
      { watch: WATCH_PROPS, watchlist: [watchEntry()] },
    );
    expect(html.match(/pill-watch/g)).toHaveLength(1);
  });

  it('draws no toggle at all where the board has none to give', () => {
    expect(render(withLaunch())).not.toContain('pill-watch');
  });

  it('matches on the address whatever its casing, and routes by address', () => {
    const target = launchWatchTarget(launched(), [watchEntry()]);
    expect(target).toEqual({
      address: ADDRESS,
      // Never by id: the card endpoint is scoped to the group's CALLS and a
      // monitor launch has none, so routing there is a guaranteed 404. Sleepers
      // and Discovery take the same by-address route for the same reason.
      tokenId: null,
      symbol: 'LEGS',
      watched: true,
      watchedByMe: true,
    });
    // Presence is the watch; absence is not a watch, never an unknown.
    const none = launchWatchTarget(launched(), [watchEntry({ address: '0xdead' })]);
    expect(none.watched).toBe(false);
    expect(none.watchedByMe).toBe(false);
    // ...and a payload that does carry a token id does not change the routing.
    expect(launchWatchTarget(launched({ tokenId: 42 }), []).tokenId).toBeNull();
    expect(launchWatchTarget(launched({ tokenId: null }), []).tokenId).toBeNull();
  });
});

describe('Upcoming — a status a member has to act on', () => {
  it('says what RENAMED means, because the chip alone does not', () => {
    const html = render(payload({ projects: [project({ status: 'renamed' })] }));
    expect(html).toContain('RENAMED');
    expect(html).toContain(UPCOMING_RENAMED_NOTE);
  });

  it('prints SUSPENDED as the plain fact it is', () => {
    const html = render(payload({ projects: [project({ status: 'suspended' })] }));
    expect(html).toContain('SUSPENDED');
    expect(html).not.toContain(UPCOMING_RENAMED_NOTE);
  });

  it('has a sentence only for the status that needs one', () => {
    expect(statusNoteText('renamed')).toBe(UPCOMING_RENAMED_NOTE);
    for (const status of ['active', 'launched', 'expired', 'suspended', 'removed'] as const) {
      expect(statusNoteText(status)).toBeNull();
    }
  });

  it('offers UNTRACK on every row a member can still act on', () => {
    for (const status of ['active', 'launched', 'expired', 'renamed', 'suspended'] as const) {
      expect(canUntrack(status)).toBe(true);
      const html = render(
        payload({
          projects: [
            project({ status, launched: status === 'launched' ? launched() : null }),
          ],
        }),
      );
      expect(html, status).toContain('UNTRACK');
    }
  });

  it('...and none on one that is already gone', () => {
    expect(canUntrack('removed')).toBe(false);
    expect(render(payload({ projects: [project({ status: 'removed' })] }))).not.toContain('UNTRACK');
  });
});

describe('upcoming helpers — the row text', () => {
  it('prints the follower delta, and the count alone without a baseline', () => {
    expect(followersText(1_900, 1_892)).toBe('1.9K · +8 since added');
    expect(followersText(1_900, 2_100)).toBe('1.9K · -200 since added');
    expect(followersText(1_900, 1_900)).toBe('1.9K · unchanged since added');
    expect(followersText(812, null)).toBe('812 followers');
    expect(followersText(2_400_000, 2_000_000)).toBe('2.4M · +400K since added');
    // Unknown is never zero — the rule this whole file exists for.
    expect(followersText(null, 1_892)).toBe('followers unknown');
    expect(followersText(null, null)).toBe('followers unknown');
    expect(followersText(0, 0)).toBe('0 · unchanged since added');
  });

  it('switches from "last post" to "quiet" after a day of silence', () => {
    expect(lastPostText(new Date(NOW - 40 * MINUTE).toISOString(), NOW)).toBe('last post 40m ago');
    expect(lastPostText(new Date(NOW - 14 * HOUR).toISOString(), NOW)).toBe('last post 14h ago');
    expect(lastPostText(new Date(NOW - 3 * DAY).toISOString(), NOW)).toBe('quiet 3d');
    expect(lastPostText(null, NOW)).toBe('no posts seen yet');
    expect(lastPostText('not a date', NOW)).toBe('no posts seen yet');
  });

  it('ages an account at the scale an account is aged', () => {
    expect(accountAgeText(new Date(NOW - 730 * DAY).toISOString(), NOW)).toBe('account 2y');
    expect(accountAgeText(new Date(NOW - 120 * DAY).toISOString(), NOW)).toBe('account 4mo');
    expect(accountAgeText(new Date(NOW - 12 * DAY).toISOString(), NOW)).toBe('account 12d');
    expect(accountAgeText(new Date(NOW - 3 * HOUR).toISOString(), NOW)).toBe('account 3h');
    expect(accountAgeText(null, NOW)).toBe('account age unknown');
  });

  it('says the status in the board voice', () => {
    expect(statusChipText('active')).toBe('ACTIVE');
    expect(statusChipText('launched')).toBe('LAUNCHED');
    expect(statusChipText('expired')).toBe('EXPIRED');
    expect(statusChipText('renamed')).toBe('RENAMED');
    expect(statusChipText('suspended')).toBe('SUSPENDED');
    expect(statusChipText('removed')).toBe('REMOVED');
  });

  it('names the adder, and the reader as themselves', () => {
    expect(addedText(project(), NOW)).toBe('added by @dev · 3d ago');
    expect(addedText(project({ addedByMe: true }), NOW)).toBe('added by you · 3d ago');
    expect(addedText(project({ addedByName: null }), NOW)).toBe('added by a member · 3d ago');
  });

  it('names the launch by symbol, or by address when it has none', () => {
    expect(launchedText(launched(), NOW)).toBe('LEGS · 0xb279…60cc · launched 4m ago');
    expect(launchedText(launched({ symbol: null }), NOW)).toBe('0xb279…60cc · launched 4m ago');
  });

  it('dates a launch from the token, and a hijack against the post', () => {
    // The token is two hours old; the post is four minutes old.
    expect(launchedText(launched({ tokenCreatedAt: new Date(NOW - 2 * HOUR).toISOString() }), NOW)).toBe(
      'LEGS · 0xb279…60cc · launched 2h ago',
    );
    expect(
      launchedText(
        launched({
          heldReason: 'hijack',
          pinged: false,
          tokenCreatedAt: new Date(NOW - 50 * MINUTE).toISOString(),
        }),
        NOW,
      ),
    ).toBe('LEGS · 0xb279…60cc · launched 46m before the post');
    // A hijack whose stamps do not actually show a lead falls back to the
    // token's own age rather than printing "0m before the post".
    expect(
      launchedText(
        launched({ heldReason: 'hijack', pinged: false, tokenCreatedAt: launched().at }),
        NOW,
      ),
    ).toBe('LEGS · 0xb279…60cc · launched 4m ago');
    // No creation stamp is unknown — never the ping's own instant.
    expect(launchedText(launched({ tokenCreatedAt: null }), NOW)).toBe(
      'LEGS · 0xb279…60cc · launch time unknown',
    );
  });

  it('keeps the post’s own clock beside it', () => {
    expect(postedText(launched(), NOW)).toBe('posted 4m ago');
    expect(postedText(launched({ at: new Date(NOW - 3 * HOUR).toISOString() }), NOW)).toBe(
      'posted 3h ago',
    );
    expect(postedText(launched({ at: 'not a date' }), NOW)).toBe('post time unknown');
  });

  it('says which ping was held, and stays silent when one went out', () => {
    expect(pingBadge(launched())).toBeNull();
    expect(pingBadge(launched({ pinged: false, heldReason: 'hijack' }))?.text).toBe(
      PING_HELD_HIJACK_LABEL,
    );
    expect(pingBadge(launched({ pinged: false, heldReason: 'muted' }))?.text).toBe(PING_MUTED_LABEL);
    // Held for a reason the payload did not give: the fact, never a guess.
    expect(pingBadge(launched({ pinged: false, heldReason: null }))?.text).toBe(PING_HELD_LABEL);
  });

  it('states a Tier-B candidate as a claim, with an unknown mcap said out loud', () => {
    expect(candidateText(candidate(), 'legsdotfun', NOW)).toBe(
      'claims @legsdotfun · not posted by the account · $31K',
    );
    expect(candidateText(candidate({ mcapUsd: null }), 'legsdotfun', NOW)).toBe(
      'claims @legsdotfun · not posted by the account · mcap unknown',
    );
  });

  it('states the account’s own post as posted but unconfirmed', () => {
    expect(candidateText(posted(), 'legsdotfun', NOW)).toBe(
      'posted 0xb279…60cc · not confirmed on chain yet · 4m ago',
    );
    expect(candidateText(posted({ at: 'not a date' }), 'legsdotfun', NOW)).toBe(
      'posted 0xb279…60cc · not confirmed on chain yet · time unknown',
    );
    // It is never described as a claim, whatever the chain has not told us yet.
    expect(candidateText(posted(), 'legsdotfun', NOW)).not.toContain('claims');
  });

  it('humanises why the last attempt did not confirm', () => {
    expect(candidateReasonText('unresolved')).toBe('not indexed yet');
    expect(candidateReasonText('pool_too_old')).toBe('its pool predates the post');
    expect(candidateReasonText('no_code')).toBe('nothing deployed at that address');
    // An unmapped reason still reads as words, never as a column value.
    expect(candidateReasonText('some_new_reason')).toBe('some new reason');
    expect(candidateReasonText(null)).toBeNull();
    expect(candidateReasonText('   ')).toBeNull();
  });

  it('links to the account itself', () => {
    expect(handleUrl('legsdotfun')).toBe('https://x.com/legsdotfun');
  });
});

describe('upcoming helpers — the add field', () => {
  it('accepts a handle in the shapes a member actually has', () => {
    expect(normalizeHandle('legsdotfun')).toBe('legsdotfun');
    expect(normalizeHandle('@LegsDotFun')).toBe('legsdotfun');
    expect(normalizeHandle('  @legsdotfun  ')).toBe('legsdotfun');
    expect(normalizeHandle('https://x.com/legsdotfun')).toBe('legsdotfun');
    expect(normalizeHandle('https://twitter.com/legsdotfun/status/1')).toBe('legsdotfun');
    expect(normalizeHandle('x.com/@legsdotfun')).toBe('legsdotfun');
  });

  it('refuses what X itself would refuse, before a request is spent on it', () => {
    expect(normalizeHandle('')).toBeNull();
    expect(normalizeHandle('   ')).toBeNull();
    expect(normalizeHandle('legs dot fun')).toBeNull();
    expect(normalizeHandle('legs-dot-fun')).toBeNull();
    expect(normalizeHandle('averyveryverylonghandle')).toBeNull();
    expect(normalizeHandle('https://example.com/legsdotfun')).toBeNull();
  });
});

describe('upcoming helpers — order', () => {
  it('puts what fired first, then the accounts that are posting', () => {
    const quiet = project({ id: 1, handle: 'quiet', lastPostAt: new Date(NOW - 5 * DAY).toISOString() });
    const busy = project({ id: 2, handle: 'busy', lastPostAt: new Date(NOW - HOUR).toISOString() });
    const expired = project({ id: 3, handle: 'gone', status: 'expired' });
    const fired = project({
      id: 4,
      handle: 'fired',
      status: 'launched',
      launched: launched({ at: new Date(NOW - 10 * MINUTE).toISOString() }),
    });
    const older = project({
      id: 5,
      handle: 'older',
      status: 'launched',
      launched: launched({
        address: '0xcccc000000000000000000000000000000000003',
        symbol: 'OLD',
        tokenId: 43,
        at: new Date(NOW - 2 * DAY).toISOString(),
      }),
    });

    expect(orderProjects([quiet, expired, busy, older, fired]).map((p) => p.handle)).toEqual([
      'fired',
      'older',
      'busy',
      'quiet',
      'gone',
    ]);
  });

  it('sorts an account we have never seen post below one we have, and never drops a row', () => {
    const never = project({ id: 1, handle: 'never', lastPostAt: null });
    const posted = project({ id: 2, handle: 'posted', lastPostAt: new Date(NOW - DAY).toISOString() });
    const broken = project({ id: 3, handle: 'broken', lastPostAt: 'not a date' });
    const ordered = orderProjects([never, broken, posted]);
    expect(ordered.map((p) => p.handle)).toEqual(['posted', 'never', 'broken']);
    expect(ordered).toHaveLength(3);
    // Pure: the input is left exactly as it was handed over.
    expect([never, broken, posted].map((p) => p.handle)).toEqual(['never', 'broken', 'posted']);
  });
});

describe('upcoming helpers — the status line and the rail summary', () => {
  const check = (over: Partial<Parameters<typeof checkStatusText>[0]> = {}) =>
    checkStatusText({
      enabled: true,
      lastCheckAt: new Date(NOW - MINUTE).toISOString(),
      hasActive: true,
      hasMonitors: true,
      fetchedAt: NOW,
      now: NOW,
      serverAt: null,
      ...over,
    });

  it('is silent inside the stall window and loud past it', () => {
    expect(check()).toBeNull();
    expect(check({ lastCheckAt: new Date(NOW - 9 * MINUTE).toISOString() })).toBeNull();
    expect(check({ lastCheckAt: new Date(NOW - 22 * MINUTE).toISOString() })).toBe(
      'feed stalled · last check 22m ago',
    );
  });

  it('blames the watcher only when the payload on screen is current', () => {
    // Back from a hidden tab: this payload is an hour old, and so is its check.
    // That is OUR silence, not a stalled watcher.
    expect(
      check({
        lastCheckAt: new Date(NOW - 61 * MINUTE).toISOString(),
        fetchedAt: NOW - 60 * MINUTE,
      }),
    ).toBeNull();
  });

  it('reads the check against the SERVER clock when the response carries one', () => {
    const serverAt = NOW - 10 * MINUTE;
    const lastCheckAt = new Date(serverAt - MINUTE).toISOString();
    expect(check({ lastCheckAt, serverAt })).toBeNull();
    // Without the server's instant the same payload reads as an 11-minute lag.
    expect(check({ lastCheckAt })).toBe('feed stalled · last check 11m ago');
  });

  it('waits rather than claiming a stall it cannot date, and is silent when dormant', () => {
    expect(check({ lastCheckAt: null })).toBe(UPCOMING_WAITING_LINE);
    expect(check({ lastCheckAt: 'not a date' })).toBe(UPCOMING_WAITING_LINE);
    expect(check({ enabled: false, lastCheckAt: null })).toBeNull();
    expect(check({ enabled: false, lastCheckAt: new Date(NOW - 5 * HOUR).toISOString() })).toBeNull();
  });

  it('never blames a watcher that has nothing left to poll', () => {
    // No active monitor: not waiting, not stalled — idle, and said quietly.
    expect(checkStatus({
      enabled: true,
      lastCheckAt: null,
      hasActive: false,
      hasMonitors: true,
      fetchedAt: NOW,
      now: NOW,
      serverAt: null,
    })).toEqual({ kind: 'idle', text: UPCOMING_IDLE_LINE });
    // An old successful check with nothing left to poll is simply not news.
    expect(
      check({ hasActive: false, lastCheckAt: new Date(NOW - 5 * HOUR).toISOString() }),
    ).toBeNull();
    // ...and the stall line keeps its own kind, so the view can style it.
    expect(
      checkStatus({
        enabled: true,
        lastCheckAt: new Date(NOW - 22 * MINUTE).toISOString(),
        hasActive: true,
        hasMonitors: true,
        fetchedAt: NOW,
        now: NOW,
        serverAt: null,
      })?.kind,
    ).toBe('stall');
  });

  it('says nothing at all to a group that has never tracked anything', () => {
    // No monitors, so no check has ever been asked for: the empty invitation is
    // the whole story, and "nothing left to check" would read as a fault.
    expect(check({ hasActive: false, hasMonitors: false, lastCheckAt: null })).toBeNull();
    expect(
      check({
        hasActive: false,
        hasMonitors: false,
        lastCheckAt: new Date(NOW - 5 * HOUR).toISOString(),
      }),
    ).toBeNull();
    // The launched/expired-only case still gets its line: those checks stopped.
    expect(check({ hasActive: false, hasMonitors: true, lastCheckAt: null })).toBe(
      UPCOMING_IDLE_LINE,
    );
  });

  it('knows whether anything is still being polled', () => {
    expect(hasActiveMonitor(payload())).toBe(true);
    expect(
      hasActiveMonitor(
        payload({
          projects: [
            project({ status: 'launched', launched: launched() }),
            project({ id: 2, status: 'expired' }),
          ],
        }),
      ),
    ).toBe(false);
    // A renamed or suspended monitor holds a slot but answers nothing.
    expect(hasActiveMonitor(payload({ projects: [project({ status: 'renamed' })] }))).toBe(false);
  });

  it('carries the counts, the caps, the heartbeat and the newest monitor', () => {
    const newer = project({ id: 9, handle: 'newest', addedAt: new Date(NOW - 3 * DAY).toISOString() });
    const older = project({ id: 8, handle: 'older', addedAt: new Date(NOW - 9 * DAY).toISOString() });
    const fired = project({
      id: 7,
      handle: 'fired',
      status: 'launched',
      launched: launched(),
      addedAt: new Date(NOW - 20 * DAY).toISOString(),
    });
    const summary = deriveUpcomingSummary(payload({ projects: [older, newer, fired] }), NOW);
    // Two slots, three rows: "tracked" is the number the cap is about.
    expect(summary?.tracked).toBe(2);
    expect(summary?.launched).toBe(1);
    expect(summary?.capPerGroup).toBe(12);
    expect(summary?.hasActive).toBe(true);
    expect(summary?.fetchedAt).toBe(NOW);
    expect(summaryCountsText(summary!)).toBe('2 tracked · 1 launched');
    expect(summaryNewestText(summary!, NOW)).toBe('newest @newest 3d');
  });

  it('says nothing is tracked rather than naming a monitor that is not there', () => {
    const summary = deriveUpcomingSummary(payload({ projects: [] }), NOW);
    expect(summaryCountsText(summary!)).toBe('0 tracked · 0 launched');
    expect(summaryNewestText(summary!, NOW)).toBe('nothing tracked yet');
    expect(summary?.hasActive).toBe(false);
    // ...and the rail's own idle line is suppressed on the same premise.
    expect(summary?.hasMonitors).toBe(false);
    expect(deriveUpcomingSummary(payload(), NOW)?.hasMonitors).toBe(true);
  });

  it('counts nothing while the watcher is dormant', () => {
    expect(upcomingCountOf(payload())).toBe(1);
    expect(upcomingCountOf(payload({ enabled: false }))).toBeNull();
    expect(upcomingCountOf(null)).toBeNull();
    expect(deriveUpcomingSummary(null, NOW)).toBeNull();
  });
});
