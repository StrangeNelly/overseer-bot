/**
 * UPCOMING — the pure half (docs/decisions.md round 23).
 *
 * A pre-launch X account the group is tracking, and what the board is allowed to
 * say about it. Every function here turns a ProjectsResponse (or one field of
 * it) into text or into a shape the rail card draws. Nothing in this file
 * touches React, the network or the clock: `now` always arrives as an argument,
 * so each rule can be asserted directly instead of through a rendered tree.
 *
 * The rules the decision makes non-negotiable:
 *  - the ping fires on the ACCOUNT's own post, so a Tier-B candidate is drawn
 *    as a claim ("claims @handle · not posted by the account") and never as a
 *    launch;
 *  - a held ping is said out loud on the row — a token that predated the post is
 *    the hijack case, and the chat staying silent is a fact the board owes the
 *    reader;
 *  - unknown data is never a verdict: a follower count we do not have prints as
 *    unknown, never as 0, and a monitor we have never checked says so rather
 *    than reading as a quiet account;
 *  - a deployment with no X key is DORMANT, and an empty list must never stand
 *    in for "nobody has posted".
 */

import { XWATCH } from '@groupie/shared';
import type {
  ProjectCandidate,
  ProjectEntry,
  ProjectStatus,
  ProjectsResponse,
  WatchlistEntry,
} from '@groupie/shared';
import { stallLine } from './feedStall';
import { ageMs, fmtUsd, shortAddress } from './format';
import type { WatchTarget } from './watch';

/**
 * What the view says when the deployment has no X provider key (no X_API_KEY).
 * One honest line — an empty list would read as "nobody is tracking anything",
 * which is a different fact entirely.
 */
export const UPCOMING_DORMANT_LINE = 'x feed not configured yet';

/** The trust frame, in one place: the view header and the mobile tone band share it. */
export const UPCOMING_FRAME_TAIL =
  'pre-launch accounts the group is tracking · a ping when the account itself posts a contract';

/** A configured watcher that has never completed a check. Not an error yet. */
export const UPCOMING_WAITING_LINE = 'waiting for the first check';

/**
 * ...and the case that is neither waiting nor stalled: every monitor this group
 * has is history (launched or expired), so nothing is being polled at all. The
 * watcher is fine; there is simply no account left for it to read, and saying
 * "waiting for the first check" would promise a check nobody is going to make.
 */
export const UPCOMING_IDLE_LINE = 'nothing left to check';

/** Nobody has tracked anything yet — said as an invitation, not as a fault. */
export const UPCOMING_EMPTY_LINE =
  'Nobody is tracking a pre-launch account yet. Add one above, or from the chat with /overseer track @handle.';

/**
 * The X monitor is a poller on the server (default 60s), not a live stream, and
 * the server publishes no frame for it. So the open surface polls at the same
 * two-minute cadence Discovery uses: coarse enough to cost nothing, fine enough
 * that a launch row appears while it is still news.
 */
export const UPCOMING_POLL_MS = 120_000;

/**
 * How long a payload can be trusted to describe the watcher NOW: one poll plus a
 * grace for the request itself. Past this we are looking at an old response — a
 * backgrounded tab, a suspended laptop, a poll that has been failing — and the
 * watcher's health is simply not something this screen still knows.
 */
export const UPCOMING_PAYLOAD_FRESH_MS = UPCOMING_POLL_MS + 30_000;

/**
 * The watcher checks every 60s by default (XWATCH.pollSeconds, owner-tunable up
 * to 120s), so a gap this long is not a slow poll, it is a watcher that has
 * stopped — and this is the surface whose whole promise is that someone is
 * watching. Read off the shared constant so the line and the server's own idea
 * of "stalled" can never drift apart.
 */
export const UPCOMING_STALL_MS = XWATCH.stallMinutes * 60_000;

/**
 * Past a day of silence the row stops saying "last post" and says "quiet": on a
 * pre-launch account the gap between "posted this morning" and "has not posted
 * since Tuesday" is the only thing the row is really reporting.
 */
export const UPCOMING_QUIET_MS = 24 * 60 * 60_000;

/**
 * What this surface is and is not, under the rows where the reader has just read
 * them. The claim clause is the important one: the chain launches ~22 tokens a
 * minute and plenty of them name handles they have nothing to do with. The
 * expiry is read off the shared constant so the sentence cannot outlive the rule.
 */
export const UPCOMING_FOOTNOTE = `the chat is pinged only when the account itself posts a contract that resolves on chain · a token that merely names a handle is listed as a claim, never as a launch · a monitor with no post for ${XWATCH.expireDays} days expires · nothing here is a group call`;

/**
 * A launch whose chat ping did not go out. The bare label is the FACT (no ping
 * was sent); the two below name the reason the payload gave, because "held" and
 * "muted" are different things and only one of them is about the token.
 */
export const PING_HELD_LABEL = 'ping held';

/** The hijack case: the token predates the post (docs/decisions.md round 23). */
export const PING_HELD_HIJACK_LABEL = 'ping held · token predates the post';

export const PING_HELD_TITLE =
  'The token existed before the post — the row stands, the chat was not pinged.';

/** The group turned launch pings off (`/overseer set launchping off`). */
export const PING_MUTED_LABEL = 'ping muted';

export const PING_MUTED_TITLE =
  'This group has launch pings off — the row stands, the chat was not pinged.';

/** The status chip, in the board's voice: dim, neutral, and never a verdict. */
export function statusChipText(status: ProjectStatus): string {
  return status.toUpperCase();
}

/**
 * What a status means for the reader, where the chip alone would leave them
 * guessing. RENAMED is the one that matters: the monitor still watches the
 * x_user_id it was created with, and that account no longer answers to the
 * handle a member typed — so the row says which fact it is reporting. Every
 * other status is self-explanatory and gets no sentence.
 */
export const UPCOMING_RENAMED_NOTE = 'the @ no longer answers for the account you added';

export function statusNoteText(status: ProjectStatus): string | null {
  return status === 'renamed' ? UPCOMING_RENAMED_NOTE : null;
}

/**
 * Whether UNTRACK is offered. Everything except an already-removed monitor can
 * be untracked — EXPIRED and LAUNCHED included: the server accepts it, and a row
 * a member cannot get rid of is a row that stays on the surface forever.
 */
export function canUntrack(status: ProjectStatus): boolean {
  return status !== 'removed';
}

/**
 * Whether a monitor holds one of the group's slots. Launched and expired
 * monitors are HISTORY — the server stopped counting them against the cap, so
 * neither may the board (round 23 verification): counting rows would refuse a
 * member a slot the server would have given them.
 */
export function holdsSlot(status: ProjectStatus): boolean {
  return status === 'active' || status === 'renamed' || status === 'suspended';
}

/** Whether anything is still being polled — the premise of a stall verdict. */
export function hasActiveMonitor(data: ProjectsResponse): boolean {
  return data.projects.some((entry) => entry.status === 'active');
}

/**
 * A follower count at row size: `812`, `1.9K`, `2.4M`. Not money, so it does not
 * borrow fmtUsd — and never rounded up into a claim the account cannot make.
 */
export function fmtFollowers(count: number): string {
  const abs = Math.abs(count);
  if (abs >= 999_500) {
    const millions = abs / 1e6;
    return `${millions < 10 ? trimZero(millions.toFixed(1)) : String(Math.round(millions))}M`;
  }
  if (abs >= 9_995) return `${String(Math.round(abs / 1e3))}K`;
  if (abs >= 999.5) return `${trimZero((abs / 1e3).toFixed(1))}K`;
  return String(Math.round(abs));
}

function trimZero(s: string): string {
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

function isNum(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * `1.9K · +8 since added` — the count, and the only part of it that is news.
 *
 * The delta is the curve the decision asked for: a pre-launch account's follower
 * count means little on its own, and what it has done since a member thought it
 * was worth tracking means quite a lot. No baseline (an older monitor) prints
 * the count alone; no count at all prints unknown, never zero.
 */
export function followersText(followers: number | null, followersAtAdd: number | null): string {
  if (!isNum(followers)) return 'followers unknown';
  const count = fmtFollowers(followers);
  if (!isNum(followersAtAdd)) return `${count} followers`;
  const delta = Math.round(followers) - Math.round(followersAtAdd);
  if (delta === 0) return `${count} · unchanged since added`;
  return `${count} · ${delta > 0 ? '+' : '-'}${fmtFollowers(Math.abs(delta))} since added`;
}

/**
 * `last post 14h ago`, or `quiet 3d` once the account has been silent for a day.
 * An account we have never seen post says exactly that: "no posts seen yet" is a
 * statement about OUR record, not about the account's.
 */
export function lastPostText(lastPostAt: string | null, now: number): string {
  const age = ageMs(lastPostAt, now);
  if (age === null) return 'no posts seen yet';
  const label = coarseAge(age);
  return age >= UPCOMING_QUIET_MS ? `quiet ${label}` : `last post ${label} ago`;
}

/** `account 2y`, `account 7mo`, `account 12d` — unknown when X did not tell us. */
export function accountAgeText(accountCreatedAt: string | null, now: number): string {
  const age = ageMs(accountCreatedAt, now);
  if (age === null) return 'account age unknown';
  return `account ${coarseAge(age)}`;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * An age at the scale this surface cares about: minutes for a post that just
 * landed, years for an account that has been around. `fmtAge` stops at days,
 * which would print a two-year-old account as "730d".
 */
export function coarseAge(ms: number): string {
  const value = Math.max(0, ms);
  if (value < HOUR_MS) return `${Math.floor(value / 60_000)}m`;
  if (value < DAY_MS) return `${Math.floor(value / HOUR_MS)}h`;
  const days = Math.floor(value / DAY_MS);
  if (days < 60) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  const years = days / 365;
  return `${years < 10 ? trimZero(years.toFixed(1)) : String(Math.round(years))}y`;
}

/**
 * `added by @dev · 3d ago`. The reader's own monitors say "you" — the caps are
 * per member (3 of 12), so whose slot this is, is the actionable half.
 */
export function addedText(entry: ProjectEntry, now: number): string {
  const who = entry.addedByMe ? 'you' : (entry.addedByName ?? 'a member');
  const age = ageMs(entry.addedAt, now);
  return age === null ? `added by ${who}` : `added by ${who} · ${coarseAge(age)} ago`;
}

type Launched = NonNullable<ProjectEntry['launched']>;

/**
 * `LEGS · 0xb279…60cc · launched 4m ago` — what the account itself posted, after
 * it resolved on chain. A token with no symbol yet is named by its address
 * rather than guessed at.
 */
export function launchedText(launched: Launched, now: number): string {
  const short = shortAddress(launched.address);
  const head = launched.symbol ? `${launched.symbol} · ${short}` : short;
  return `${head} · ${launchTimingText(launched, now)}`;
}

/**
 * When the TOKEN was created — which is not when it was posted, and the gap
 * between the two is the whole hijack story (docs/decisions.md round 23: the
 * @vladtenev takeover posted a contract that had existed for 46 minutes). So a
 * held ping dates the launch AGAINST the post ("launched 46m before the post"),
 * and every other row dates it from the chain's own clock.
 *
 * `tokenCreatedAt` null is unknown, never "just now": the ping's instant is a
 * fact about US, and using it here would silently turn our timing into the
 * token's.
 */
export function launchTimingText(launched: Launched, now: number): string {
  const created = parseStamp(launched.tokenCreatedAt);
  if (created === null) return 'launch time unknown';
  if (launched.heldReason === 'hijack') {
    const posted = parseStamp(launched.at);
    // Only a token that really does predate the post can be described that way;
    // anything else falls back to its own age rather than printing "0m before".
    if (posted !== null && posted > created) {
      return `launched ${coarseAge(posted - created)} before the post`;
    }
  }
  return `launched ${coarseAge(Math.max(0, now - created))} ago`;
}

/** `posted 4m ago` — the POST's own clock, kept separate from the launch's. */
export function postedText(launched: Launched, now: number): string {
  const age = ageMs(launched.at, now);
  return age === null ? 'post time unknown' : `posted ${coarseAge(age)} ago`;
}

/**
 * The badge beside a launch whose chat ping did not go out, and what it was.
 * `pinged` true says nothing at all — the chat has already spoken. `pinged`
 * false with no reason says only the fact: we know the ping was held, we do not
 * know why, and guessing 'hijack' would be a verdict on the token.
 */
export function pingBadge(launched: Launched): { text: string; title: string } | null {
  if (launched.pinged) return null;
  if (launched.heldReason === 'muted') return { text: PING_MUTED_LABEL, title: PING_MUTED_TITLE };
  if (launched.heldReason === 'hijack') {
    return { text: PING_HELD_HIJACK_LABEL, title: PING_HELD_TITLE };
  }
  return { text: PING_HELD_LABEL, title: 'The chat was not pinged for this launch.' };
}

function parseStamp(iso: string | null): number | null {
  if (iso === null) return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : at;
}

/**
 * A candidate, in the words its KIND earns.
 *
 * 'posted' is the account's own post that has not confirmed on chain yet: it is
 * the thing this surface exists for, one step short of being a launch, and the
 * row must say exactly which step is missing rather than either dropping it or
 * promoting it.
 *
 * 'claims' is Tier B — an on-chain launch naming this handle in its socials,
 * which the account has never posted. The decision forbids it from ever pinging
 * the chat, and this line forbids it from ever reading as a launch.
 */
export function candidateText(candidate: ProjectCandidate, handle: string, now: number): string {
  if (candidate.kind === 'posted') {
    const age = ageMs(candidate.at, now);
    const when = age === null ? 'time unknown' : `${coarseAge(age)} ago`;
    return `posted ${shortAddress(candidate.address)} · not confirmed on chain yet · ${when}`;
  }
  // The symbol rides the candidate's own identity slot, not this sentence: the
  // sentence is about the CLAIM, and it reads the same whether the impostor
  // named itself LEGS or nothing at all.
  const mcap = isNum(candidate.mcapUsd) ? fmtUsd(candidate.mcapUsd) : 'mcap unknown';
  return `claims @${handle} · not posted by the account · ${mcap}`;
}

/**
 * Why the last confirmation attempt did not confirm, in words. The server's
 * vocabulary is machine-shaped (`unresolved`, `pool_too_old`) and this board has
 * never printed a raw column value; an unmapped reason still reads as a label
 * rather than as an identifier. None of these is a verdict on the token — every
 * one of them is a statement about what we have managed to read so far.
 */
const CANDIDATE_REASONS: Record<string, string> = {
  unresolved: 'not indexed yet',
  unreadable: 'the chain would not answer',
  no_chain: 'no chain reader here',
  no_code: 'nothing deployed at that address',
  not_erc20: 'not an ERC-20',
  known_contract: 'a known contract, not a launch',
  pool_unknown: 'no pool date yet',
  pool_too_old: 'its pool predates the post',
};

export function candidateReasonText(reason: string | null): string | null {
  if (reason === null) return null;
  const value = reason.trim();
  if (value.length === 0) return null;
  return CANDIDATE_REASONS[value] ?? value.replace(/_/g, ' ');
}

/** `https://x.com/legsdotfun` — the account itself, which no payload field carries. */
export function handleUrl(handle: string): string {
  return `https://x.com/${encodeURIComponent(handle)}`;
}

export interface CheckStatusInput {
  /** False = no X provider key on this deployment: the surface says so itself. */
  enabled: boolean;
  /** The watcher's last successful poll across the group's still-polled monitors. */
  lastCheckAt: string | null;
  /** Whether this group still has a monitor being polled at all. */
  hasActive: boolean;
  /**
   * Whether this group has ANY monitor — rows, not slots, history included. A
   * group with none has never asked for a check, so "nothing left to check"
   * would answer a question nobody asked.
   */
  hasMonitors: boolean;
  /** The client instant the payload landed, or null before the first read. */
  fetchedAt: number | null;
  /** Shared clock. */
  now: number;
  /** The server's own instant for the payload (its Date header), or null. */
  serverAt: number | null;
}

export interface CheckStatus {
  /** 'stall' is the loud one; the other two are notes, not alarms. */
  kind: 'stall' | 'waiting' | 'idle';
  text: string;
}

/**
 * The watcher's own health. Null means it is checking normally and has nothing
 * to say.
 *
 * A stall is a claim about a POLLER, so it needs a poller: with every monitor
 * launched or expired there is nothing left to check, and both "waiting for the
 * first check" and "feed stalled" would blame a watcher that is behaving exactly
 * as it should. That case gets its own quiet line instead. The stall rule itself
 * lives in ./feedStall, shared with Discovery's listener line.
 *
 * A group with no monitors at all is not even that case: nothing has been asked
 * of the watcher, the surface already says so in its own words (the empty
 * invitation), and "nothing left to check" over an empty list reads as a fault.
 */
export function checkStatus({
  enabled,
  lastCheckAt,
  hasActive,
  hasMonitors,
  fetchedAt,
  now,
  serverAt,
}: CheckStatusInput): CheckStatus | null {
  if (!enabled) return null;
  if (!hasActive) {
    // Nothing has ever been tracked here: the empty invitation is the whole
    // story, and a watcher note under it would be an answer to no question.
    if (!hasMonitors) return null;
    // A check we never made is the honest half of this; an old successful check
    // with nothing left to poll is simply not news.
    return lastCheckAt === null ? { kind: 'idle', text: UPCOMING_IDLE_LINE } : null;
  }
  const text = stallLine({
    enabled,
    at: lastCheckAt,
    fetchedAt,
    now,
    serverAt,
    stallMs: UPCOMING_STALL_MS,
    freshMs: UPCOMING_PAYLOAD_FRESH_MS,
    waitingLine: UPCOMING_WAITING_LINE,
    noun: 'check',
  });
  if (text === null) return null;
  return { kind: text === UPCOMING_WAITING_LINE ? 'waiting' : 'stall', text };
}

/** ...as one line, for the surfaces that only have room for the sentence. */
export function checkStatusText(input: CheckStatusInput): string | null {
  return checkStatus(input)?.text ?? null;
}

/**
 * Row order (round 23): launched first, newest first — a monitor that fired is
 * the only thing on this surface that is news. Then the live ones by how
 * recently the account posted, because that is the closest thing to "warming
 * up" the board can measure. Everything else (expired, renamed, suspended,
 * removed) files under both, newest addition first: those rows are history.
 *
 * Sorting never drops a row and never mutates the input.
 */
export function orderProjects(projects: readonly ProjectEntry[]): ProjectEntry[] {
  const rank = (entry: ProjectEntry): number =>
    entry.status === 'launched' ? 0 : entry.status === 'active' ? 1 : 2;
  // An unparseable (or missing) stamp sorts last within its group rather than
  // winning the comparison against a real one.
  const stamp = (iso: string | null): number => {
    if (iso === null) return Number.NEGATIVE_INFINITY;
    const at = Date.parse(iso);
    return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
  };
  const key = (entry: ProjectEntry): number => {
    if (entry.status === 'launched') {
      const launched = stamp(entry.launched?.at ?? null);
      return launched === Number.NEGATIVE_INFINITY ? stamp(entry.addedAt) : launched;
    }
    if (entry.status === 'active') return stamp(entry.lastPostAt);
    return stamp(entry.addedAt);
  };

  // Compared, never subtracted: a missing stamp is -Infinity, and subtracting
  // two of those is NaN (which is not a comparator) while subtracting one from
  // a real stamp is Infinity (which is not a number a sort may return).
  const newerFirst = (x: number, y: number): number => (x === y ? 0 : x > y ? -1 : 1);

  return projects
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const byRank = rank(a.entry) - rank(b.entry);
      if (byRank !== 0) return byRank;
      const byKey = newerFirst(key(a.entry), key(b.entry));
      if (byKey !== 0) return byKey;
      const byAdded = newerFirst(stamp(a.entry.addedAt), stamp(b.entry.addedAt));
      if (byAdded !== 0) return byAdded;
      return a.index - b.index;
    })
    .map(({ entry }) => entry);
}

/**
 * The UPCMG chip's count — and the tab headline's, which is the same number.
 *
 * This one is ROWS, not slots, because a chip beside a tab is a promise about
 * what is behind the tab: a group whose every monitor has launched holds zero
 * slots, and a chip reading `0` over three LAUNCHED rows is simply false. Slots
 * are the CAP's unit and stay that way everywhere the cap is what is being said
 * — `capsText`, `isAtGroupCap`, the rail card's "tracked".
 *
 * A dormant deployment counts nothing — the chip shows an em dash and the
 * surface says why, rather than printing a zero that reads as "nobody is
 * tracking anything".
 */
export function upcomingCountOf(data: ProjectsResponse | null): number | null {
  return data && data.enabled ? data.projects.length : null;
}

/**
 * The payload as the reader's own untracks have left it: the removed rows gone,
 * and the slots they held given back. Filtering the rows alone would leave "4 /
 * 12 tracked" over three rows until the refetch landed — and, worse, keep the
 * add field disabled at a cap the group is no longer at.
 */
export function applyUntracked(
  data: ProjectsResponse,
  untracked: ReadonlySet<number>,
): ProjectsResponse {
  if (untracked.size === 0) return data;
  const removed = data.projects.filter((entry) => untracked.has(entry.id) && holdsSlot(entry.status));
  return {
    ...data,
    projects: data.projects.filter((entry) => !untracked.has(entry.id)),
    slotsUsed: Math.max(0, data.slotsUsed - removed.length),
    slotsUsedByMe: Math.max(
      0,
      data.slotsUsedByMe - removed.filter((entry) => entry.addedByMe).length,
    ),
  };
}

/**
 * The desktop UPCOMING summary card: how many accounts are tracked, how many
 * have fired, the newest addition, and the watcher's last successful check.
 */
export interface UpcomingSummary {
  enabled: boolean;
  /** Slots held (never the row count): what "tracked" means everywhere else. */
  tracked: number;
  launched: number;
  capPerGroup: number;
  /** Whether anything is still being polled — the premise of the stall line. */
  hasActive: boolean;
  /** Whether the group has any monitor at all — the premise of the idle line. */
  hasMonitors: boolean;
  /** The watcher's last successful poll: null before the first one. */
  lastCheckAt: string | null;
  /**
   * The client instant this payload landed. The rail's stall verdict is read
   * against it, not against the clock, for the reason ./feedStall gives.
   */
  fetchedAt: number | null;
  /** The server's own instant for this payload (its Date header), or null. */
  serverAt: number | null;
  /** The most recently ADDED monitor — "newest @legsdotfun 3d". */
  newest: { handle: string; addedAt: string } | null;
}

export function deriveUpcomingSummary(
  data: ProjectsResponse | null,
  fetchedAt: number | null,
  serverAt: number | null = null,
): UpcomingSummary | null {
  if (!data) return null;
  let newest: ProjectEntry | null = null;
  let newestAt = Number.NEGATIVE_INFINITY;
  for (const entry of data.projects) {
    const at = Date.parse(entry.addedAt);
    if (Number.isNaN(at) || at <= newestAt) continue;
    newestAt = at;
    newest = entry;
  }
  return {
    enabled: data.enabled,
    tracked: data.slotsUsed,
    launched: data.projects.filter((entry) => entry.status === 'launched').length,
    capPerGroup: data.capPerGroup,
    hasActive: hasActiveMonitor(data),
    hasMonitors: data.projects.length > 0,
    lastCheckAt: data.lastCheckAt,
    fetchedAt,
    serverAt,
    newest: newest ? { handle: newest.handle, addedAt: newest.addedAt } : null,
  };
}

/** `4 tracked · 1 launched` — the counts half of the rail card's first line. */
export function summaryCountsText(summary: UpcomingSummary): string {
  return `${summary.tracked} tracked · ${summary.launched} launched`;
}

/** `newest @legsdotfun 3d`, or the honest line when nothing is tracked at all. */
export function summaryNewestText(summary: UpcomingSummary, now: number): string {
  if (summary.newest === null) return 'nothing tracked yet';
  const age = ageMs(summary.newest.addedAt, now);
  const label = age === null ? '' : ` ${coarseAge(age)}`;
  return `newest @${summary.newest.handle}${label}`;
}

/**
 * `4 / 12 tracked · your slots 1 / 3` — the caps, read off the PAYLOAD so the
 * sentence can never drift from the limit the server enforces.
 *
 * Both numbers are SLOTS, not rows: launched and expired monitors stay on the
 * surface as history and cost nothing, so counting rows would tell a member the
 * group was full when the server would happily take another handle. And the
 * per-member half is the actionable one — the group cap is rarely what stops
 * you, your own three slots usually are.
 */
export function capsText(data: ProjectsResponse): string {
  return `${data.slotsUsed} / ${data.capPerGroup} tracked · your slots ${data.slotsUsedByMe} / ${data.capPerMember}`;
}

/**
 * A handle as X itself defines one: 1-15 characters, letters, digits and
 * underscores, with an optional leading @ (and an x.com/twitter.com URL pasted
 * whole, which is what a member actually has on their clipboard). Returned
 * lowercase and bare, exactly as the contract stores it. null = not a handle,
 * and the field says so before a request is spent on it.
 */
export function normalizeHandle(raw: string): string | null {
  let value = raw.trim();
  if (value.length === 0) return null;
  const url = /^(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/(@?[A-Za-z0-9_]{1,15})(?:[/?#].*)?$/i.exec(
    value,
  );
  if (url?.[1]) value = url[1];
  const match = /^@?([A-Za-z0-9_]{1,15})$/.exec(value);
  return match?.[1] ? match[1].toLowerCase() : null;
}

/**
 * Whether this group can take another monitor at all — the cap, said before the
 * 409, and counted in the server's own units: SLOTS, so a board full of launched
 * rows never refuses an add the server would have accepted.
 */
export function isAtGroupCap(data: ProjectsResponse | null): boolean {
  return data !== null && data.slotsUsed >= data.capPerGroup;
}

/**
 * The launched token's watch state, read off the group's whole watchlist
 * (BoardResponse.watchlist — every active watch, call or no call) by address.
 * The address is the only key both surfaces share: a launch found by the X
 * watcher may have no call on this board at all, and a watch set from the chat
 * carries no monitor id.
 *
 * `tokenId` is deliberately null, exactly as it is for a Sleepers lead or a
 * Discovery row: the card endpoint (`/tokens/:id/watch`) is scoped to the
 * group's CALLS, and a monitor launch is by definition a coin nobody called —
 * routing it there is a guaranteed 404. The by-address endpoint upserts the
 * token the way `/overseer watch <ca>` does, and already handles the
 * already-known and already-watched cases.
 */
export function launchWatchTarget(
  launched: Launched,
  watchlist: readonly WatchlistEntry[],
): WatchTarget {
  const key = launched.address.toLowerCase();
  const entry = watchlist.find((row) => row.address.toLowerCase() === key) ?? null;
  return {
    address: launched.address,
    tokenId: null,
    symbol: launched.symbol,
    // Presence IS the watch: the payload carries only active watches.
    watched: entry !== null,
    watchedByMe: entry?.watchedByMe ?? false,
  };
}
