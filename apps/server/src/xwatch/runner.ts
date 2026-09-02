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

/** One post, matched against the monitors that could have authored it. */
function monitorsFor(post: XPost, monitors: MonitorRow[]): MonitorRow[] {
  const handle = post.authorHandle.toLowerCase();
  return monitors.filter((m) => {
    if (m.xUserId !== null && post.authorUserId !== null) return m.xUserId === post.authorUserId;
    return m.xHandle.toLowerCase() === handle;
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
  /** The handle set the rules were last synced for. */
  let ruleSignature = '';
  const seenPosts = new Set<string>();
  /** The refusal back-off, on discovery's schedule and for its reasons. */
  let backoffMs = 0;
  let pausedUntilMs = 0;
  /**
   * When the slow half of housekeeping (profiles, expiry, Tier B) last ran —
   * seeded at boot, so a restart does not spend a burst of provider calls
   * re-reading profiles that were read when the handles were added.
   */
  let slowPassAtMs = Date.now();

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
      // 60-day expiry clock and the board's "quiet 14h" read.
      await recordPost(db, monitor.id, { at: post.createdAt, id: post.id });

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
          discardedByFloor += await processPost(post, matched, nowMs, windowFloorMs);
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
    // reads as "checked 40s ago", so a failed pass must not move it.
    await markChecked(
      db,
      monitors.map((m) => m.id),
      checkedAt,
    );
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
      if (nowMs - slowPassAtMs < XWATCH.refreshProfileMinutes * 60_000) return;
      slowPassAtMs = nowMs;

      // THE ONE PROVIDER CALLER in this loop, and the one thing the back-off
      // applies to: a paused pass skips the rotation entirely (nothing is
      // stamped, so the same stale profiles are first in line next pass) and
      // still runs the expiry sweep and Tier B below.
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
      const candidates = await scanLaunchCandidates(db, chain);
      if (candidates > 0) console.log(`xwatch: ${candidates} tier-B candidate(s) recorded`);
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
