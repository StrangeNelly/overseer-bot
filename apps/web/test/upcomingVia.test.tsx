import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProjectEntry, ProjectsResponse } from '@groupie/shared';
import { UPCOMING_VIA_NOTES, Upcoming, postViaNote } from '../src/components/Upcoming';

/**
 * ROUND 25 — the row says HOW it is seeing the account.
 *
 * X hides some accounts from its "Latest" search index (@legsdotfun's launch
 * post, 2026-09-03 21:05Z, never appeared under `from:legsdotfun`), so the
 * watcher recovers those posts from replies and from a Top sweep. A reader who
 * cannot tell a normally-indexed account from a recovered one is being asked to
 * trust a monitor whose primary channel is blind, so the row prints the fact —
 * and prints NOTHING when the ordinary channel is working, because a note on
 * every row is a note nobody reads.
 *
 * IT REPORTS THE ROAD, NOT A VERDICT. `lastPostVia` records which read got there
 * first, and the three reads use different windows over in-process state a
 * restart empties — so "X search hides this account" would be a claim the column
 * cannot support for a visible account whose post fell in the gap. And it is
 * PAST TENSE: only 'active' monitors are polled, a recovered launch ends as
 * 'launched', so "watching replies" would describe a poller that has stopped on
 * the very row this whole path exists to produce.
 */

const NOW = Date.UTC(2026, 8, 4, 12, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function project(over: Partial<ProjectEntry> = {}): ProjectEntry {
  return {
    id: 1,
    handle: 'legsdotfun',
    xUserId: '2094468493223620608',
    displayName: 'legs',
    avatarUrl: null,
    bio: 'soon',
    followers: 1_900,
    followersAtAdd: 1_892,
    accountCreatedAt: new Date(NOW - 730 * DAY).toISOString(),
    lastPostAt: new Date(NOW - 2 * HOUR).toISOString(),
    lastPostVia: 'search',
    lastCheckedAt: new Date(NOW - 60_000).toISOString(),
    note: null,
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

function payload(entry: ProjectEntry): ProjectsResponse {
  return {
    enabled: true,
    lastCheckAt: new Date(NOW - 60_000).toISOString(),
    capPerGroup: 12,
    capPerMember: 3,
    slotsUsed: 1,
    slotsUsedByMe: 0,
    projects: [entry],
  };
}

const render = (entry: ProjectEntry) =>
  renderToStaticMarkup(
    <Upcoming
      data={payload(entry)}
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

describe('postViaNote', () => {
  it('says nothing for the ordinary channel, or before any post has been seen', () => {
    // 'search' IS the healthy case, and null is "we have not seen a post yet" —
    // neither is news about X's index.
    expect(postViaNote('search')).toBeNull();
    expect(postViaNote(null)).toBeNull();
  });

  it('names the road the newest post actually travelled', () => {
    expect(postViaNote('replies')).toBe(UPCOMING_VIA_NOTES.replies);
    expect(postViaNote('top')).toBe(UPCOMING_VIA_NOTES.top);
    // A reply and the Top sweep are DIFFERENT facts: the second means the
    // engagement-ranked sweep is the belt that found it.
    expect(UPCOMING_VIA_NOTES.replies).not.toBe(UPCOMING_VIA_NOTES.top);
    expect(UPCOMING_VIA_NOTES.replies).toContain('reply');
    expect(UPCOMING_VIA_NOTES.top).toContain('Top sweep');
  });

  it('never blames the account, and never claims more than the column knows', () => {
    for (const note of Object.values(UPCOMING_VIA_NOTES)) {
      // What is known: which read carried the post. What is NOT known from one
      // stamp: that X is hiding the account — the windows differ and the seen
      // set is per-process, so a visible account can be recovered by a reply.
      // The stronger sentence is the operator log's, hedged with "may".
      expect(note).toContain('not through X search');
      expect(note).not.toContain('hides this account');
      // ...and no ongoing-activity claim: only 'active' monitors are polled, and
      // a recovered launch row is 'launched'.
      expect(note).not.toContain('watching');
      expect(note.toLowerCase()).not.toContain('warning');
      expect(note.toLowerCase()).not.toContain('suspicious');
    }
  });
});

describe('Upcoming — the visibility note on the row', () => {
  it('prints nothing at all when Latest search is finding the account', () => {
    const html = render(project({ lastPostVia: 'search' }));
    expect(html).not.toContain('not through X search');
    // ...and the row itself still renders, so the assertion above is not vacuous.
    expect(html).toContain('@legsdotfun');
  });

  it('prints nothing before the first post has been seen', () => {
    const html = render(project({ lastPostVia: null, lastPostAt: null }));
    expect(html).not.toContain('not through X search');
    expect(html).toContain('no posts seen yet');
  });

  it('names the reply road when a reply recovered the post', () => {
    const html = render(project({ lastPostVia: 'replies' }));
    expect(html).toContain(UPCOMING_VIA_NOTES.replies);
    // The dim sub-text line every other note on this row uses — one voice, and
    // the class that carries the phone's re-indent.
    expect(html).toContain('class="upc-status-note"');
  });

  it('names the Top sweep when the sweep is the channel', () => {
    const html = render(project({ lastPostVia: 'top' }));
    expect(html).toContain(UPCOMING_VIA_NOTES.top);
  });

  it('keeps the RENAMED sentence and the visibility note as separate lines', () => {
    // Two different facts about one account: the handle moved, AND the post came
    // by the recovery road. Collapsing either into the other would lose one.
    const html = render(project({ status: 'renamed', lastPostVia: 'replies' }));
    expect(html).toContain('the @ no longer answers for the account you added');
    expect(html).toContain(UPCOMING_VIA_NOTES.replies);
  });

  it('stays true on a row nobody polls any more', () => {
    // A hidden account recovered through replies ENDS as 'launched' — the most
    // likely row this note ever appears on — and 'launched' is not polled
    // (POLLED_STATUSES is 'active' alone). The note is provenance about the post
    // we hold, so it survives that; a "watching replies" claim would not.
    const html = render(project({ status: 'launched', lastPostVia: 'replies' }));
    expect(html).toContain(UPCOMING_VIA_NOTES.replies);
    expect(html).not.toContain('watching');
  });
});
