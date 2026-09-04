import { eq } from 'drizzle-orm';
import { groups, type Db } from '@groupie/db';
import { XWATCH } from '@groupie/shared';
import type { ChainClient } from '../chain/client.js';
import { fireLaunch } from './alerts.js';
import {
  shouldPauseXPolling,
  summarizeXError,
  xRefusalStatus,
  type TweetWatcher,
  type XPost,
} from './client.js';
import { confirmAddress } from './confirm.js';
import { detectTierA, type TrackedAccount } from './detect.js';
import {
  applyProfileRefresh,
  expireMonitors,
  markChecked,
  polledMonitors,
  profileRefreshQueue,
  recordPost,
  setRuleIds,
  stampProfileRefreshed,
  type MonitorRow,
} from './monitors.js';
import {
  isDefinitiveRejection,
  queuePendingConfirmation,
  runPendingConfirmations,
} from './pending.js';
import { ruleIdByHandle } from './rules.js';
import { xwatchSettingsOf } from './settings.js';
import { scanLaunchCandidates } from './tierB.js';

/**
 * The X watcher's clocks (docs/decisions.md round 23), built the way the
 * discovery listener is built and for the same reasons.
 *
 * TWO loops. The results loop asks the provider for new posts on a short
 * cadence and must keep it; the housekeeping loop runs the pending-confirmation
 * queue every tick and re-reads profiles, expires finished monitors and scans
 * Tier B on their own slower clock. Each has its own timer, its own `running`
 * flag and its own isolate, so neither can hold the other up and nothing here
 * can crash the process.
 *
 * THREE READS, ONE POLL (round 25). The from: search is the primary one and
 * everything below is unchanged for it. But X hides some accounts from its
 * Latest index — measured 2026-09-04: `from:legsdotfun` returned zero posts for
 * every window and for all time while the account was posting, and its launch
 * post (21:05Z, 288 replies) was never seen — so a poll also reads REPLIES to
 * the tracked accounts and fetches the unseen PARENT posts by id, and every
 * fifth poll asks the same from: shards with queryType=Top, which did carry
 * that post. A recovered parent is judged by exactly the same detector: it is
 * the account's own post, arriving by a different road — and so is a SELF-REPLY
 * the `to:` shard hands back, which is judged on the spot rather than thrown
 * away as a pointer, because a CA dropped under the announcement is the pattern
 * the detector was written for.
 *
 * ORDER MATTERS AND FAILURE DOES NOT. from: first, then replies, then Top — so
 * 'search' is the source recorded whenever the account is visible — and the two
 * recovery reads run in their own isolates: a redundant read that fails must
 * never cost the primary poll, and only a refusal the next poll cannot fix
 * (401/403/429) is rethrown into the back-off. Neither read gates the other: the
 * sweep's cadence is counted on the polls the from: read answered, and a reply
 * read being throttled holds its refusal until the sweep has run.
 *
 * THE CURSOR IS THIS FILE'S. It only ever advances past a post that was
 * actually processed, it never rewinds on an empty poll, and a TRUNCATED page
 * does not move it at all: the adapter serves newest-first, so the posts the
 * page could not reach are the OLDER ones, and any advance would step over
 * them. Holding it re-reads the window (the seen set absorbs the duplicates)
 * instead of losing the part of it nobody looked at.
 *
 * DORMANT WITHOUT A KEY: no watcher means one line at boot and nothing else.
 */

export interface XWatchHandle {
  stop(): void;
  /**
   * Whether the watcher is LIVE IN THIS PROCESS — what /upcoming serves as
   * `enabled`. A WEB_ONLY dev box with a key still answers false: a feed nobody
   * is reading and a feed that is off are different answers.
   */
  readonly running: boolean;
}

const DORMANT: XWatchHandle = { stop: () => {}, running: false };

/** Posts already handled in this process, so a re-served page is a no-op. */
const SEEN_POST_CAP = 2_000;

/**
 * Parent ids waiting for a fetch that has not happened yet — the per-poll cap
 * left them over, or the fetch failed. Bounded for the same reason the seen set
 * is: it is a convenience, and every real guarantee is in the database.
 */
const PENDING_PARENT_CAP = 200;

/** One post, matched against the monitors that could have authored it. */
function monitorsFor(post: XPost, monitors: MonitorRow[]): MonitorRow[] {
  const handle = post.authorHandle.toLowerCase();
  return monitors.filter((m) => {
    if (m.xUserId !== null && post.authorUserId !== null) return m.xUserId === post.authorUserId;
    return m.xHandle.toLowerCase() === handle;
  });
}

/**
 * Is this reply ANSWERING one of the accounts we poll?
 *
 * The same id-first discipline as monitorsFor, applied to the parent rather
 * than the author: a `to:` shard can return a reply that merely mentions the
 * handle, and only the parent's user id (or, when the provider carried none,
 * the parent's handle) says the post being answered is the tracked account's.
 */
function repliesToMonitor(reply: XPost, monitors: MonitorRow[]): boolean {
  const parentUserId = reply.inReplyToUserId ?? null;
  const parentHandle = reply.inReplyToHandle;
  return monitors.some((m) => {
    if (m.xUserId !== null && parentUserId !== null) return m.xUserId === parentUserId;
    return parentHandle !== null && m.xHandle.toLowerCase() === parentHandle;
  });
}

/** Oldest first — the order every write in a poll happens in. */
function oldestFirst(posts: readonly XPost[]): XPost[] {
  return [...posts].sort((a, b) => {
    const byTime = a.createdAt.getTime() - b.createdAt.getTime();
    return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
  });
}

/** Whole unix seconds, the only unit the cursor is ever written in. */
function seconds(ms: number): number {
  return Math.floor(ms / 1000);
}

export function startXWatch(
  db: Db,
  watcher: TweetWatcher | null,
  chain: ChainClient | null,
): XWatchHandle {
  if (watcher === null) {
    // Said once, at boot, so an operator wondering why UPCOMING is empty finds
    // the reason in the logs rather than in the code.
    console.log('xwatch: no X_API_KEY — launch monitor disabled');
    return DORMANT;
  }
  // Bound once, so the loops below carry a non-null client rather than a
  // parameter TypeScript has to be told about at every use.
  const client: TweetWatcher = watcher;

  let polling = false;
  let cursor: string | null = null;
  /**
   * Reply recovery's OWN cursor. Separate from the one above on purpose: the
   * two reads answer different questions, and letting a busy reply thread move
   * the from: cursor would step the primary poll over posts nobody read.
   */
  let replyCursor: string | null = null;
  /** The handle set the rules were last synced for. */
  let ruleSignature = '';
  const seenPosts = new Set<string>();
  /** Parent ids already fetched (or found already handled) in this process. */
  const seenParents = new Set<string>();
  /** ...and the ones still owed a fetch: the per-poll cap, or a failed read. */
  const pendingParents = new Set<string>();
  let pendingOverflowed = false;
  /** Successful polls since boot — the Top sweep rides every fifth one. */
  let pollCount = 0;
  /** Monitors already reported as reachable only by the recovery reads. */
  const hiddenWarned = new Set<number>();
  /** The refusal back-off, on discovery's schedule and for its reasons. */
  let backoffMs = 0;
  let pausedUntilMs = 0;
  /**
   * When the slow half of housekeeping (profiles, expiry) last ran —
   * seeded at boot, so a restart does not spend a burst of provider calls
   * re-reading profiles that were read when the handles were added.
   */
  let slowPassAtMs = Date.now();
  /**
   * Tier B's own clock (XWATCH.tierBMinutes, round 25): a graduation claiming a
   * tracked handle must reach the board in minutes, not on the profile pass's
   * half-hour. Seeded at boot like the slow pass, for the same reason.
   */
  let tierBPassAtMs = Date.now();

  /**
   * One post against the monitors that could have authored it. Answers how many
   * (post, monitor) pairs the window floor threw away, so the poll can say so
   * once with a count instead of a line per discarded post.
   */
  async function processPost(
    post: XPost,
    monitors: MonitorRow[],
    nowMs: number,
    windowFloorMs: number,
    via: 'search' | 'replies' | 'top',
  ): Promise<number> {
    let discarded = 0;
    for (const monitor of monitors) {
      // THE BACK-CATALOGUE FLOOR. A handle tracked five minutes ago must not
      // replay last week's contract address; `windowFloorMs` is the poll's own
      // floor (the lookback, or an older cursor we are still catching up to).
      const floorMs = Math.max(monitor.addedAt.getTime(), windowFloorMs);
      if (post.createdAt.getTime() < floorMs) {
        discarded += 1;
        continue;
      }

      // The account SPOKE — recorded whatever it said, because that is what the
      // 60-day expiry clock and the board's "quiet 14h" read. `via` says which
      // of the three reads found it (monitors.ts only stamps it forward).
      await recordPost(db, monitor.id, { at: post.createdAt, id: post.id, via });

      // SAID ONCE PER MONITOR PER PROCESS, and only when the recovery reads are
      // doing work the from: search should have done: this is the @legsdotfun
      // shape (hidden from the Latest index, found only through its replies),
      // and it is the one thing the logs can tell an operator about it. The
      // stored source is the previous read's, so a monitor already known to be
      // hidden says nothing further.
      if (
        via !== 'search' &&
        (monitor.lastPostVia === null || monitor.lastPostVia === 'search') &&
        !hiddenWarned.has(monitor.id)
      ) {
        hiddenWarned.add(monitor.id);
        console.warn(
          `xwatch: @${monitor.xHandle} posts reach us via ${via} only — ` +
            'X search may be hiding this account',
        );
      }

      const account: TrackedAccount = {
        monitorId: monitor.id,
        groupId: monitor.groupId,
        handle: monitor.xHandle,
        xUserId: monitor.xUserId,
      };
      const detection = detectTierA(post, account);
      if (!detection.fires) continue;

      // A launch announcement carries ONE contract. A post with a dozen
      // address-shaped strings is somebody's thread, and queueing all of them
      // would spend the chain budget on noise.
      for (const address of detection.addresses.slice(0, XWATCH.maxAddressesPerPost)) {
        let confirmation;
        try {
          confirmation = await confirmAddress(address, post.createdAt, { chain, db, nowMs });
        } catch (err) {
          // A THROWN read is unknown, and unknown is queued rather than
          // swallowed: the account did post this, and one failed read is not
          // the answer to whether it is a coin.
          const detail = err instanceof Error ? err.name : 'error';
          await queuePendingConfirmation(db, {
            monitorId: monitor.id,
            address,
            post: { id: post.id, url: post.permalink, createdAt: post.createdAt },
            reason: `error:${detail}`,
            nowMs,
          });
          continue;
        }
        if (!confirmation.ok) {
          const reason = confirmation.reason;
          // Only a DEFINITIVE rejection is the end of it (pending.ts owns the
          // rule). Anything else goes on the ladder and is re-read until it
          // confirms or ages out — a launch announced minutes before its pool
          // indexes is the ordinary case, not the exception.
          if (isDefinitiveRejection(reason)) {
            console.log(
              `xwatch: ${monitor.xHandle} posted ${address} — rejected (${reason})`,
            );
            continue;
          }
          await queuePendingConfirmation(db, {
            monitorId: monitor.id,
            address,
            post: { id: post.id, url: post.permalink, createdAt: post.createdAt },
            reason,
            nowMs,
          });
          console.log(
            `xwatch: ${monitor.xHandle} posted ${address} — not confirmed yet (${reason}), queued`,
          );
          continue;
        }
        const group = (
          await db
            .select({ settings: groups.settings, status: groups.status })
            .from(groups)
            .where(eq(groups.id, monitor.groupId))
        )[0];
        // Removed from the chat since the monitor was added: nothing to tell.
        if (!group || group.status !== 'active') continue;
        const outcome = await fireLaunch(db, {
          monitor,
          token: confirmation.token,
          post: { id: post.id, url: post.permalink, createdAt: post.createdAt },
          settings: xwatchSettingsOf(group.settings),
          nowMs,
        });
        if (outcome === 'held') {
          console.log(
            `xwatch: ${monitor.xHandle} -> ${address} held (token predates the post by more than ${XWATCH.hijackHoldMinutes}m)`,
          );
        }
        // One launch per monitor: whatever this address did, the monitor is
        // decided and the remaining addresses in the post are not a second one.
        break;
      }
    }
    return discarded;
  }

  /**
   * REPLY RECOVERY. Reads the replies TO the tracked accounts, takes the parent
   * ids off them, fetches the parents that are new, and puts each one through
   * the same detector the from: poll uses.
   *
   * Only runs on an adapter that offers BOTH halves: parent ids with no way to
   * read the parents are not a signal, they are a list.
   */
  async function recoverParents(monitors: MonitorRow[], nowMs: number): Promise<void> {
    const pollReplies = client.pollReplies?.bind(client);
    const fetchPosts = client.fetchPosts?.bind(client);
    if (pollReplies === undefined || fetchPosts === undefined) return;

    const previous = replyCursor === null ? null : Number(replyCursor);
    const previousSeconds = previous !== null && Number.isFinite(previous) ? previous : null;
    const result = await pollReplies(replyCursor);

    let newestMs: number | null = null;
    for (const reply of result.posts) {
      const at = reply.createdAt.getTime();
      if (newestMs === null || at > newestMs) newestMs = at;
    }

    // NEWEST REPLIES FIRST, because the cap below cuts the tail: a launch post
    // is answered within seconds (+130s and +24s on the two measured posts), so
    // the newest replies are the ones pointing at the post we are hunting.
    const ordered = [...result.posts].sort((a, b) => {
      const byTime = b.createdAt.getTime() - a.createdAt.getTime();
      return byTime !== 0 ? byTime : b.id.localeCompare(a.id);
    });
    // Hoisted: the recovery floor judges the account's OWN posts on this page
    // as well as the parents fetched below, and both are reached late by design.
    const parentFloorMs = nowMs - XWATCH.parentLookbackMinutes * 60_000;
    const wanted: string[] = [];
    for (const reply of ordered) {
      // THE ACCOUNT'S OWN POST, ALREADY IN HAND AND FREE TO JUDGE. A `to:` shard
      // returns the tracked account's SELF-REPLIES too — a reply to its own post
      // is a reply "to" the account — and a self-reply carrying the CA under the
      // announcement is the launch pattern detect.ts fires on ("the CA dropped
      // under the announcement"). Reaching it only as somebody else's parent
      // would need a stranger to reply to that specific post, so it is judged
      // here, where it costs no provider call. The detector still re-checks
      // authorship, so a stranger merely mentioning the handle fires nothing.
      if (!seenPosts.has(reply.id)) {
        const own = monitorsFor(reply, monitors);
        if (own.length > 0) {
          try {
            await processPost(reply, own, nowMs, parentFloorMs, 'replies');
            seenPosts.add(reply.id);
            if (seenPosts.size > SEEN_POST_CAP) seenPosts.clear();
          } catch (err) {
            // One post's failure is one post's: the parents below still get
            // their turn, and a live thread names this post again next poll.
            console.error(`xwatch: recovered post ${reply.id} failed: ${summarizeXError(err)}`);
          }
        }
      }
      const parentId = reply.inReplyToId;
      if (parentId === null) continue;
      // Already handled (the from: poll got there first), already fetched, or
      // already queued: a thread with 288 replies costs one parent look, once.
      if (seenPosts.has(parentId) || seenParents.has(parentId)) continue;
      if (pendingParents.has(parentId) || wanted.includes(parentId)) continue;
      // A `to:` shard also matches a reply that merely mentions the handle; the
      // parent has to be the tracked account's own post.
      if (!repliesToMonitor(reply, monitors)) continue;
      wanted.push(parentId);
    }

    // THE REPLY CURSOR ALWAYS ADVANCES — a truncated page does not hold it and
    // a failed parent fetch does not either. A STRANGER'S reply is a REDUNDANT
    // pointer: every one of a post's replies names the same parent, so
    // re-reading the window buys nothing, while holding it would let one viral
    // thread pin the reply window open forever and re-read that thread every
    // single poll. (The account's own posts on this page were judged above, in
    // the loop, before anything could advance past them.) The outstanding WORK
    // is carried by the ids below, not by the window. It never rewinds, and it
    // takes the same one-second overlap the from: cursor does.
    const floorSeconds = seconds(nowMs - XWATCH.lookbackMinutes * 60_000);
    replyCursor = String(
      newestMs === null
        ? previousSeconds === null
          ? floorSeconds
          : Math.max(previousSeconds, floorSeconds)
        : Math.max(seconds(newestMs) - 1, previousSeconds ?? 0),
    );

    // Ids a previous poll could not get to go FIRST: they are already late, and
    // burying them under a busy minute's new ones would never clear them.
    const queue = [...pendingParents, ...wanted];
    const ids = queue.slice(0, XWATCH.parentsPerPoll);
    const rest = queue.slice(XWATCH.parentsPerPoll);
    pendingParents.clear();
    for (const id of rest.slice(0, PENDING_PARENT_CAP)) pendingParents.add(id);
    if (rest.length > PENDING_PARENT_CAP && !pendingOverflowed) {
      // Once per process: a queue this long is one condition, not one per poll.
      pendingOverflowed = true;
      console.warn(
        `xwatch: more than ${PENDING_PARENT_CAP} parent post(s) queued for recovery — ` +
          'the oldest are being dropped',
      );
    }
    if (ids.length === 0) return;

    let parents: XPost[];
    try {
      parents = await fetchPosts(ids);
    } catch (err) {
      // The window has already moved on, so these ids are the only record that
      // the work is outstanding. Back on the queue, and the next poll asks.
      for (const id of ids) pendingParents.add(id);
      throw err;
    }
    // Marked BEFORE processing, and by ID rather than by what came back: an id
    // the provider answered nothing for (a deleted post) must not be asked
    // about every poll for the rest of the process's life.
    for (const id of ids) seenParents.add(id);
    if (seenParents.size > SEEN_POST_CAP) seenParents.clear();

    // A recovered parent is judged against the RECOVERY window (computed above,
    // where the own-post branch shares it), not the poll's: it is reached
    // minutes late by design, and the ten-minute lookback would throw away the
    // post it exists to find. processPost still applies the monitor's own
    // added_at on top of it.
    let fresh = 0;
    for (const parent of oldestFirst(parents)) {
      // The from: poll already handled it in this same pass: 'search' stands as
      // the recorded source, and nothing is done twice.
      if (seenPosts.has(parent.id)) continue;
      try {
        await processPost(parent, monitorsFor(parent, monitors), nowMs, parentFloorMs, 'replies');
      } catch (err) {
        // One parent's failure is one parent's, and it is NOT a verdict: the id
        // goes back on the queue so a database hiccup cannot lose a launch post
        // that this account's own timeline will never show us again.
        seenParents.delete(parent.id);
        pendingParents.add(parent.id);
        console.error(`xwatch: recovered post ${parent.id} failed: ${summarizeXError(err)}`);
        continue;
      }
      seenPosts.add(parent.id);
      if (seenPosts.size > SEEN_POST_CAP) seenPosts.clear();
      fresh += 1;
    }
    if (parents.length > 0) {
      console.log(`xwatch: recovered ${parents.length} parent post(s) via replies, ${fresh} new`);
    }
  }

  /**
   * THE TOP SWEEP. The from: shards asked with queryType=Top instead of Latest,
   * every fifth poll over the same window recovered parents are judged against
   * (XWATCH.topLookbackMinutes, kept equal to parentLookbackMinutes so the
   * sweep can never be narrower than the floor its results are judged by) —
   * because Top DID return the hidden account's posts when Latest returned
   * nothing at all, and a post nobody replied to is invisible to the recovery
   * above.
   *
   * Moves NEITHER cursor: Top is engagement-ranked, so "the newest thing it
   * returned" says nothing about how far the chronological read has got.
   */
  async function sweepTop(monitors: MonitorRow[], nowMs: number): Promise<void> {
    const pollTop = client.pollTop?.bind(client);
    if (pollTop === undefined) return;
    const posts = await pollTop(seconds(nowMs) - XWATCH.topLookbackMinutes * 60);
    const parentFloorMs = nowMs - XWATCH.parentLookbackMinutes * 60_000;
    let fresh = 0;
    for (const post of oldestFirst(posts)) {
      if (seenPosts.has(post.id)) continue;
      try {
        await processPost(post, monitorsFor(post, monitors), nowMs, parentFloorMs, 'top');
      } catch (err) {
        // One post's failure is one post's, as in reply recovery: the rest of
        // the sweep still runs, and the sixty-minute window names this post
        // again next sweep.
        console.error(`xwatch: Top-swept post ${post.id} failed: ${summarizeXError(err)}`);
        continue;
      }
      seenPosts.add(post.id);
      if (seenPosts.size > SEEN_POST_CAP) seenPosts.clear();
      fresh += 1;
    }
    if (fresh > 0) {
      console.log(`xwatch: Top sweep found ${fresh} post(s) the from: poll had not`);
    }
  }

  async function pollOnce(): Promise<void> {
    const monitors = await polledMonitors(db);
    if (monitors.length === 0) return;

    const handles = monitors.map((m) => m.xHandle.toLowerCase());
    const signature = [...new Set(handles)].sort().join(',');
    if (signature !== ruleSignature) {
      const rules = await client.syncRules(handles);
      const byHandle = ruleIdByHandle(rules);
      const byMonitor = new Map<number, string>();
      for (const monitor of monitors) {
        const ruleId = byHandle.get(monitor.xHandle.toLowerCase());
        if (ruleId !== undefined) byMonitor.set(monitor.id, ruleId);
      }
      await setRuleIds(db, byMonitor);
      ruleSignature = signature;
      console.log(`xwatch: tracking ${handles.length} handle(s) in ${rules.length} shard(s)`);
    }

    const previous = cursor === null ? null : Number(cursor);
    const previousSeconds = previous !== null && Number.isFinite(previous) ? previous : null;
    const result = await client.pollResults(cursor);
    const checkedAt = new Date();
    const nowMs = checkedAt.getTime();

    // THE WINDOW FLOOR. The lookback is the floor for a poll with NO history —
    // a fresh process must not replay yesterday. But after a back-off the
    // cursor is the honest floor: a poll resuming from forty minutes ago is
    // catching up on posts nobody has read, and clipping them to the last ten
    // minutes would silently drop the outage's backlog. So: the EARLIER of the
    // two, never later than the lookback, and never before a handle was added
    // (processPost applies that half per monitor).
    const lookbackFloorMs = nowMs - XWATCH.lookbackMinutes * 60_000;
    const windowFloorMs =
      previousSeconds === null ? lookbackFloorMs : Math.min(previousSeconds * 1000, lookbackFloorMs);

    // OLDEST FIRST. The cursor is an instant, so posts have to be handled in
    // the order the clock did them or advancing it past one would skip another.
    const ordered = [...result.posts].sort((a, b) => {
      const byTime = a.createdAt.getTime() - b.createdAt.getTime();
      return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
    });
    let lastProcessedMs: number | null = null;
    let stoppedEarly = false;
    let discardedByFloor = 0;

    for (const post of ordered) {
      if (seenPosts.has(post.id)) {
        // Already handled in this process: it counts as processed, so the
        // cursor may still move past it.
        lastProcessedMs = post.createdAt.getTime();
        continue;
      }
      const matched = monitorsFor(post, monitors);
      if (matched.length > 0) {
        try {
          discardedByFloor += await processPost(post, matched, nowMs, windowFloorMs, 'search');
        } catch (err) {
          // STOP THE PAGE. The cursor stays where the last completed post left
          // it, so everything from here on is read again next poll instead of
          // being stepped over by a failure.
          console.error(`xwatch: post ${post.id} failed: ${summarizeXError(err)}`);
          stoppedEarly = true;
          break;
        }
      }
      seenPosts.add(post.id);
      // Cheapest possible bound: this set only exists to stop a re-served page
      // doing the same work twice, and every real guarantee is in the database.
      if (seenPosts.size > SEEN_POST_CAP) seenPosts.clear();
      lastProcessedMs = post.createdAt.getTime();
    }

    if (discardedByFloor > 0) {
      // Said once, with a count: a line per discarded post would bury a real
      // backlog under the ordinary case of a page reaching past the window.
      console.log(
        `xwatch: ${discardedByFloor} post(s) older than the window floor ` +
          `(${new Date(windowFloorMs).toISOString()}) ignored`,
      );
    }

    // THE CURSOR MOVES LAST, and truncation stops it moving at all.
    if (result.truncated) {
      // The provider serves NEWEST FIRST, so a page that hit the bound has an
      // unread OLDER stretch behind it — the gap between the oldest post on the
      // page and the cursor. Advancing anywhere into that gap steps over posts
      // nobody has looked at, so the cursor is HELD and the whole window is
      // re-read next poll; the seen set absorbs everything read twice.
      console.warn(
        `xwatch: truncated page (${XWATCH.maxPagesPerPoll} pages, ${result.posts.length} posts) — ` +
          `holding the cursor at ${previousSeconds === null ? 'the lookback floor' : new Date(previousSeconds * 1000).toISOString()}` +
          ` and re-reading that window next poll`,
      );
    } else if (lastProcessedMs !== null) {
      // One second of overlap so a post sharing that second is not skipped; the
      // duplicate it can cause is absorbed by the seen set and the DB guards.
      cursor = String(seconds(lastProcessedMs) - 1);
    } else if (!stoppedEarly) {
      // Nothing came back (or nothing was left to do). NEVER REWIND: the window
      // may only move forward, and the one-second overlap is subtracted only
      // when a post was actually seen.
      const floor = seconds(nowMs - XWATCH.lookbackMinutes * 60_000);
      cursor = String(previousSeconds === null ? floor : Math.max(previousSeconds, floor));
    }

    // Stamped only on a poll that ANSWERED: `last_checked_at` is what the board
    // reads as "checked 40s ago", so a failed pass must not move it. Stamped
    // HERE rather than at the end of the pass because the from: poll — the read
    // this clock is about — has now answered in full; a 429 from one of the two
    // redundant reads below must not make the board say the watcher stalled.
    await markChecked(
      db,
      monitors.map((m) => m.id),
      checkedAt,
    );

    // COUNTED ON THE POLL THE FROM: READ ANSWERED, before either recovery read
    // can fail. Counting it after them made the sweep's cadence hostage to reply
    // recovery: the reply read is the one that pages hardest (up to
    // maxPagesPerPoll per to: shard, on threads with hundreds of replies), so it
    // is the likeliest to draw a 429 — and a counter that never moved meant the
    // sweep never ran ONCE, taking the last road to a hidden account with no
    // replies with it.
    pollCount += 1;

    // THE TWO RECOVERY READS, each in its own isolate. They run AFTER the from:
    // poll so 'search' is the source recorded whenever the account is visible,
    // and a failure in either is logged and dropped — except a refusal the next
    // poll cannot fix (401/403/429), which is rethrown so the existing back-off
    // applies to the whole watcher rather than to one read of it.
    //
    // A PAUSING REFUSAL FROM THE REPLY READ IS HELD, NOT THROWN, until the sweep
    // has had its turn: Top is one page per from: shard with no paging, the
    // cheapest of the three reads and the one most worth keeping alive while the
    // reply read is being throttled. The back-off still applies — the error is
    // rethrown below, at the end of the pass.
    let pausing: unknown = null;
    try {
      await recoverParents(monitors, nowMs);
    } catch (err) {
      console.error(`xwatch: reply recovery failed: ${summarizeXError(err)}`);
      if (shouldPauseXPolling(err)) pausing = err;
    }

    if (pollCount % XWATCH.topSweepEveryPolls === 0) {
      try {
        await sweepTop(monitors, nowMs);
      } catch (err) {
        console.error(`xwatch: Top sweep failed: ${summarizeXError(err)}`);
        if (shouldPauseXPolling(err)) throw err;
      }
    }
    if (pausing !== null) throw pausing;
  }

  const pollTimer = setInterval(async () => {
    if (polling) return;
    // Silent: the pause was announced once, and a line per skipped poll would
    // bury the reason under the symptom.
    if (Date.now() < pausedUntilMs) return;
    polling = true;
    try {
      await pollOnce();
      if (backoffMs > 0) {
        console.log('xwatch: provider answering again, polling resumed');
        backoffMs = 0;
        pausedUntilMs = 0;
      }
    } catch (err) {
      console.error(`xwatch poll failed: ${summarizeXError(err)}`);
      if (shouldPauseXPolling(err)) {
        backoffMs =
          backoffMs === 0
            ? XWATCH_BACKOFF_MS
            : Math.min(XWATCH_BACKOFF_MAX_MS, backoffMs * 2);
        pausedUntilMs = Date.now() + backoffMs;
        const status = xRefusalStatus(err);
        const secs = Math.round(backoffMs / 1000);
        console.warn(
          status === 429
            ? `xwatch: provider throttled (429), pausing polls for ${secs}s`
            : `xwatch: provider rejected the key (${status}), pausing polls for ${secs}s`,
        );
      }
    } finally {
      polling = false;
    }
  }, XWATCH.pollSeconds * 1000);

  let housekeeping = false;
  const houseTimer = setInterval(async () => {
    if (housekeeping) return;
    // NO PAUSE GATE HERE. `pausedUntilMs` is a back-off against the X PROVIDER,
    // and the only thing below that talks to it is the profile rotation (which
    // checks it for itself). The confirmation queue, the expiry sweep and the
    // Tier-B scan read our own tables and the chain — pausing them because X
    // returned a 429 would leave a confirmed launch unannounced for ten minutes
    // over an outage that has nothing to do with it.
    housekeeping = true;
    try {
      // Every tick: the confirmation queue, whose fastest rung IS this cadence.
      // It reads the chain and our own tables, never the X provider.
      const pending = await runPendingConfirmations(db, { chain });
      if (pending.fired > 0 || pending.stopped > 0) {
        console.log(
          `xwatch: pending confirmations — ${pending.fired} confirmed, ${pending.stopped} finished`,
        );
      }

      const nowMs = Date.now();
      // Tier B on its own clock, BEFORE the slow pass's early return: it reads
      // our own tables and the chain, never the X provider, so the back-off
      // above does not apply to it either.
      if (nowMs - tierBPassAtMs >= XWATCH.tierBMinutes * 60_000) {
        tierBPassAtMs = nowMs;
        const candidates = await scanLaunchCandidates(db, chain);
        if (candidates > 0) console.log(`xwatch: ${candidates} tier-B candidate(s) recorded`);
      }

      if (nowMs - slowPassAtMs < XWATCH.refreshProfileMinutes * 60_000) return;
      slowPassAtMs = nowMs;

      // THE ONE PROVIDER CALLER in this loop, and the one thing the back-off
      // applies to: a paused pass skips the rotation entirely (nothing is
      // stamped, so the same stale profiles are first in line next pass) and
      // still runs the expiry sweep below.
      const monitors = nowMs < pausedUntilMs ? [] : await profileRefreshQueue(db);
      if (monitors.length === 0 && nowMs < pausedUntilMs) {
        console.log('xwatch: provider paused — profile refresh skipped this pass');
      }
      for (const monitor of monitors) {
        try {
          const resolution = await client.resolveHandle(monitor.xHandle);
          // A handle that stopped resolving gets the id asked as well, when the
          // adapter can: the stored id survives a rename, and it is the only
          // source allowed to say 'suspended'.
          const byId =
            (resolution.status === 'not_found' || resolution.status === 'suspended') &&
            monitor.xUserId !== null &&
            typeof client.resolveUserId === 'function'
              ? await client.resolveUserId(monitor.xUserId)
              : undefined;
          const applied = await applyProfileRefresh(db, monitor, resolution, byId);
          if (applied === 'renamed' || applied === 'suspended') {
            console.warn(`xwatch: @${monitor.xHandle} is ${applied} — monitor stopped`);
          }
        } catch (err) {
          // One handle's failure is one handle's: a provider hiccup must not
          // cost the rest of the pass, and it changes no status.
          console.warn(`xwatch: profile refresh failed for @${monitor.xHandle}: ${summarizeXError(err)}`);
        } finally {
          // Stamped on the ATTEMPT, so an account nothing can read rotates to
          // the back of the queue instead of holding its front forever.
          await stampProfileRefreshed(db, monitor.id, new Date()).catch(() => {});
        }
      }
      const expired = await expireMonitors(db);
      if (expired > 0) console.log(`xwatch: ${expired} monitor(s) expired (no post in ${XWATCH.expireDays}d)`);
    } catch (err) {
      console.error(`xwatch housekeeping failed: ${summarizeXError(err)}`);
    } finally {
      housekeeping = false;
    }
  }, XWATCH.housekeepingSeconds * 1000);

  console.log(
    `xwatch launch monitor started (polls ${XWATCH.pollSeconds}s, ` +
      `profiles ${XWATCH.refreshProfileMinutes}m)`,
  );
  let live = true;
  return {
    stop() {
      clearInterval(pollTimer);
      clearInterval(houseTimer);
      live = false;
    },
    get running() {
      return live;
    },
  };
}

/**
 * First pause after a refusal, and the ceiling the doubling stops at. The first
 * pause is TWO cadences: a pause equal to the poll interval would skip no poll
 * at all, which is not a back-off.
 */
const XWATCH_BACKOFF_MS = 2 * XWATCH.pollSeconds * 1000;
const XWATCH_BACKOFF_MAX_MS = 600_000;
