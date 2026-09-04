/**
 * The X provider seam (docs/decisions.md round 23).
 *
 * Every X read in the app goes through a `TweetWatcher`, for the same reason
 * every chain read goes through a `ChainClient`: one place knows the vendor, one
 * place counts what it costs, and one answer decides whether the feature is
 * configured at all. The whole category is legally contested (docs/research-x-
 * monitor.md §3) — twitterapi.io primary, SocialData the documented fallback,
 * the official X recent-search the escape hatch — so the vendor is behind an
 * interface and nothing above this file knows its name.
 *
 * DORMANT WITHOUT A KEY. `createTweetWatcher` returns null when no key is
 * configured, and every caller reads that as "the feature is off": nothing
 * starts, nothing polls, nothing throws, and /upcoming answers `enabled:false`.
 */

/** A tracked account as the provider describes it right now. */
export interface XProfile {
  /** The account's numeric X id — stored once, never repointed. */
  userId: string;
  /** Lowercase, no leading @. */
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  followers: number | null;
  accountCreatedAt: Date | null;
}

/**
 * What one handle lookup learned. A discriminated union rather than
 * `XProfile | null` on purpose: 'not_found' is EVIDENCE (the account is gone,
 * and a monitor pointed at it says so), while 'error' is the absence of
 * evidence and must never flip a monitor's status. Conflating them is exactly
 * how a provider outage would mark a whole watchlist suspended.
 */
export type HandleResolution =
  | { status: 'ok'; profile: XProfile }
  | { status: 'not_found' }
  | { status: 'suspended' }
  | { status: 'error'; detail: string };

/** One post by a tracked account, as the detector reads it. */
export interface XPost {
  id: string;
  /** The AUTHOR's numeric id — null when the provider did not carry one. */
  authorUserId: string | null;
  /** Lowercase, no leading @. */
  authorHandle: string;
  /** The account's OWN text. Never a quoted or retweeted post's. */
  text: string;
  /** The account's OWN attached URLs, expanded where the provider expands them. */
  urls: string[];
  createdAt: Date;
  isRetweet: boolean;
  isQuote: boolean;
  quotedAuthorUserId?: string | null;
  /**
   * The provider SAYS this post is a reply. Carried separately from the parent
   * id because the two answers come apart: a provider that flags a reply but
   * supplies no parent user id leaves us unable to prove a self-reply, and an
   * unprovable reply is silence rather than a guess.
   */
  isReply?: boolean;
  inReplyToUserId?: string | null;
  /**
   * The PARENT post's id — what reply recovery is built on (round 25). X hides
   * some accounts from the Latest index entirely (@legsdotfun's launch post,
   * 2026-09-03 21:05Z, never appeared under `from:legsdotfun`), but the REPLIES
   * to it did, and each reply names the post it answers. So a reply nobody
   * tracks is still a pointer to a post we do.
   */
  inReplyToId: string | null;
  /** The parent post's author handle: lowercase, no @, null when unstated. */
  inReplyToHandle: string | null;
  permalink: string;
}

/**
 * One provider rule: a shard of the handle set, small enough for the vendor's
 * 255-character rule grammar (`from:a OR from:b`).
 *
 * The runner needs to know WHICH handles a rule covers — that is what lets a
 * monitor record the shard it is polled in — so this carries the handles rather
 * than the bare id the vendor's own API returns.
 */
export interface XRule {
  id: string;
  value: string;
  handles: string[];
}

/**
 * One poll's posts, in whatever order the provider served them.
 *
 * THE CURSOR IS THE RUNNER'S, not the provider's: it is a unix-SECONDS string
 * naming the instant polling resumes from, and only the runner may move it —
 * after a post has actually been processed. An adapter that let the cursor jump
 * to the newest post it fetched would silently drop every post it had not
 * finished with, which is the defect this shape exists to make impossible.
 */
export interface XPollResult {
  posts: XPost[];
  /**
   * The page hit its bound (XWATCH.maxPagesPerPoll) with more still to serve.
   * The adapter reads NEWEST FIRST, so `posts` does not reach back to the
   * cursor and everything under the oldest one is unread: the runner answers by
   * HOLDING the cursor where it was, never by advancing into the gap.
   */
  truncated: boolean;
}

export interface TweetWatcher {
  /** The account behind a handle, or why we could not have it. */
  resolveHandle(handle: string): Promise<HandleResolution>;
  /**
   * The account behind a stored numeric id, when the provider offers such a
   * lookup. OPTIONAL: an adapter without one simply cannot tell a renamed
   * account from a deleted one, and the caller says 'renamed' — the weaker,
   * honest label — rather than calling somebody suspended on no evidence.
   */
  resolveUserId?(userId: string): Promise<HandleResolution>;
  /**
   * Point the watcher at exactly this handle set, sharded to the provider's
   * rule-length limit, and answer with the rules now in force. Cheap and
   * idempotent: called whenever the tracked set changes.
   */
  syncRules(handles: string[]): Promise<XRule[]>;
  /** New posts by the tracked accounts since `cursor` (unix seconds, or null). */
  pollResults(cursor: string | null): Promise<XPollResult>;
  /**
   * REPLIES TO the tracked accounts since `cursor` — the recovery path (round
   * 25). Measured 2026-09-04 with the production key: `from:legsdotfun` in
   * Latest returned ZERO posts for every window and for all time, while
   * `to:legsdotfun` returned every reply to the account (first reply +130s
   * after the launch post, +24s after the next one). The replies are not the
   * signal; the parent ids they carry are.
   *
   * OPTIONAL, like every method below it: an adapter without these three is
   * polled exactly as it was before this round, from: only.
   */
  pollReplies?(cursor: string | null): Promise<XPollResult>;
  /**
   * The from: shards asked with queryType=Top, one page each. Top is
   * engagement-ranked rather than index-backed, and it DID carry the hidden
   * account's launch post when Latest did not — so it is the belt to reply
   * recovery's braces, for a post nobody replied to.
   *
   * `sinceSeconds` is the INSTANT to search from, in whole unix seconds — NOT a
   * duration. The caller passes now minus XWATCH.topLookbackMinutes and the
   * adapter substitutes it straight into `since_time:`; reading it as a window
   * length would search from the epoch.
   */
  pollTop?(sinceSeconds: number): Promise<XPost[]>;
  /** Posts by id — how a recovered parent is actually read. */
  fetchPosts?(ids: string[]): Promise<XPost[]>;
  /** Requests spent, for the hourly meter line. */
  meter(): { total: number; windowCount: number };
}

/**
 * A provider refusal the loop cannot fix by asking again immediately — the
 * X-side twin of chain/client.ts's refusalStatus. 401/403 (the key) and 429
 * (throughput) share a schedule because they share a failure mode: the next
 * poll answers identically, and an error line every 30 seconds buries the one
 * thing an operator needs to read.
 */
export class XApiError extends Error {
  readonly name = 'XApiError';
  constructor(
    readonly status: number,
    /** Provider text, already clipped and stripped of URLs. */
    readonly detail: string,
  ) {
    super(`x provider ${status}: ${detail}`);
  }
}

/** Anything URL-shaped, gone: a base URL somebody pasted a key into is a secret. */
function scrubUrls(text: string): string {
  return text.replace(/\bhttps?:\/\/\S+/gi, '[url redacted]');
}

function clip(text: string): string {
  return text.length <= 200 ? text : `${text.slice(0, 200)}...`;
}

/**
 * One X-provider failure as a single safe log line.
 *
 * NEVER prints the key (it travels in a header, and nothing here logs headers),
 * never prints a request URL, and never prints the error object — a fetch
 * failure's `cause` can carry the full request. Status plus the provider's own
 * words, clipped, is the whole line.
 */
export function summarizeXError(err: unknown): string {
  if (err === null || err === undefined) return 'unknown error';
  if (err instanceof XApiError) return `status=${err.status} ${clip(scrubUrls(err.detail))}`;
  if (typeof err === 'string') return clip(scrubUrls(err));
  if (typeof err !== 'object') return clip(scrubUrls(String(err)));
  const e = err as { name?: unknown; message?: unknown };
  const name = typeof e.name === 'string' ? e.name : 'Error';
  const message = typeof e.message === 'string' ? clip(scrubUrls(e.message)) : '';
  return message === '' ? name : `${name} ${message}`;
}

/** The status of a refusal that should pause polling, or null. */
export function xRefusalStatus(err: unknown): number | null {
  if (!(err instanceof XApiError)) return null;
  if (err.status === 429) return 429;
  return err.status === 401 || err.status === 403 ? err.status : null;
}

export function shouldPauseXPolling(err: unknown): boolean {
  return xRefusalStatus(err) !== null;
}

/**
 * What this process has spent at the provider. Logged once an hour, in
 * REQUESTS only: twitterapi.io bills a minimum per call (empty checks
 * included) PLUS a per-post charge, and since round 25's `to:` reads return
 * every reply to a tracked account, the posts-returned term is the larger half
 * of the bill (docs/decisions.md round 25, Cost). This counter is the calls
 * half; the posts half is not metered here.
 */
export class XRequestMeter {
  private total = 0;
  private windowStartMs = Date.now();
  private windowCount = 0;

  note(): void {
    this.total += 1;
    this.windowCount += 1;
    const elapsed = Date.now() - this.windowStartMs;
    if (elapsed < 3_600_000) return;
    const perHour = Math.round((this.windowCount * 3_600_000) / elapsed);
    console.log(`x watcher: ${perHour} requests/hour`);
    this.windowStartMs = Date.now();
    this.windowCount = 0;
  }

  snapshot(): { total: number; windowCount: number } {
    return { total: this.total, windowCount: this.windowCount };
  }
}

/** A handle as it is stored and compared everywhere: lowercase, no leading @. */
export function normalizeHandle(raw: string): string | null {
  const trimmed = raw.trim().replace(/^@+/, '');
  // X's own rule: 1-15 characters, letters, digits and underscore.
  return /^[A-Za-z0-9_]{1,15}$/.test(trimmed) ? trimmed.toLowerCase() : null;
}
