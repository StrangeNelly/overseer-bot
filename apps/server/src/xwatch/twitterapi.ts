import { XWATCH } from '@groupie/shared';
import { isRetweetText } from './detect.js';
import {
  XApiError,
  XRequestMeter,
  normalizeHandle,
  type HandleResolution,
  type TweetWatcher,
  type XPollResult,
  type XPost,
  type XProfile,
  type XRule,
} from './client.js';
import { shardHandles, toTerm } from './rules.js';

/**
 * The twitterapi.io adapter (docs/decisions.md round 23), in POLL MODE.
 *
 * Endpoint shapes verified against docs.twitterapi.io on 2026-09-03:
 *   GET  /twitter/user/info?userName=<handle>
 *        -> { status, msg, data: { id, userName, name, profilePicture,
 *             description, followers, createdAt, isBlueVerified } }
 *   GET  /twitter/tweet/advanced_search?query=<q>&queryType=Latest&cursor=<c>
 *        -> { tweets: [{ id, text, url, createdAt, author: { id, userName },
 *             entities: { urls: [{ url, expanded_url }] }, isReply,
 *             inReplyToId, inReplyToUsername, inReplyToUserId,
 *             retweeted_tweet, quoted_tweet }],
 *             has_next_page, next_cursor }
 *        (queryType=Top verified 2026-09-04: same envelope, same tweet shape,
 *        `since_time:` honoured. The three inReplyTo* fields were measured the
 *        same day — a NON-reply carries them as EMPTY STRINGS rather than
 *        omitting them, which is why `str` mapping "" to null is load-bearing.)
 *   GET  /twitter/tweets?tweet_ids=<id,id,...>            (verified 2026-09-04)
 *        -> { tweets: [ ...the same tweet shape... ], status, msg }
 *        (`status: 'error'` uses that same envelope WITHOUT a tweets array —
 *        the vendor's own failures, never a verdict about the ids.)
 *   GET  /twitter/user/batch_info_by_ids?userIds=<id>   (UNVERIFIED shape — the
 *        docs list it, no key on this machine to exercise it; a body that does
 *        not carry a user is read as 'error', never as a verdict)
 *   Auth: the `X-API-Key` header. Base: https://api.twitterapi.io.
 *
 * WHY POLL AND NOT RULES. The vendor's filter rules (POST /oapi/tweet_filter/
 * add_rule and update_rule, both documented and both capping `value` at 255
 * characters — which is what `rules.ts` shards to) deliver their matches by
 * WEBHOOK or WEBSOCKET only; their docs describe no pull-by-rule endpoint, and
 * their webhook echoes our API key to the configured URL and adds
 * unauthenticated ingress. So this adapter registers no rule at the vendor: it
 * polls `advanced_search` with the same `from:a OR from:b` shard the rule
 * grammar would have carried, plus a `since_time:` clause. The shard IS the
 * poll unit, and its id is what a monitor records.
 *
 * WHY THE THREE EXTRA READS (round 25). Measured on 2026-09-04 with the
 * production key: `from:legsdotfun` with queryType=Latest returned ZERO posts
 * for every window and for all time, and `/twitter/user/last_tweets` returned
 * an empty list for the same account — while queryType=Top returned its posts
 * (the launch post among them) and `to:legsdotfun` in Latest returned every
 * reply to it. X hides some accounts from the Latest index, so the from: poll
 * alone cannot see them. `pollReplies` finds the parent ids, `fetchPosts` reads
 * the parents, and `pollTop` is the belt to that pair's braces.
 *
 * NOTHING HERE LOGS THE KEY OR A URL: the key travels in a header, failures are
 * raised as XApiError with the provider's own words, and summarizeXError is the
 * only thing that ever prints them.
 */

const DEFAULT_BASE = 'https://api.twitterapi.io';

const REQUEST_TIMEOUT_MS = 15_000;

interface RawUser {
  id?: unknown;
  userName?: unknown;
  name?: unknown;
  profilePicture?: unknown;
  description?: unknown;
  followers?: unknown;
  createdAt?: unknown;
}

interface RawTweet {
  id?: unknown;
  text?: unknown;
  url?: unknown;
  createdAt?: unknown;
  author?: RawUser | null;
  entities?: { urls?: Array<{ url?: unknown; expanded_url?: unknown }> | null } | null;
  isReply?: unknown;
  inReplyToId?: unknown;
  inReplyToUsername?: unknown;
  inReplyToUserId?: unknown;
  retweeted_tweet?: unknown;
  quoted_tweet?: { author?: RawUser | null } | null;
}

function str(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function int(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * X dates arrive as `Tue Sep 02 21:14:03 +0000 2026`. Date.parse handles that
 * shape in V8, but the ISO fallback is kept because the vendor has been seen to
 * answer both — and an UNPARSEABLE date is null, never `now`: a post we cannot
 * date cannot be measured against the hijack hold.
 */
export function parseXDate(value: unknown): Date | null {
  const raw = str(value);
  if (raw === null) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/** The post's own attached URLs, expanded where the provider expanded them. */
function postUrls(raw: RawTweet): string[] {
  const out: string[] = [];
  for (const entry of raw.entities?.urls ?? []) {
    const url = str(entry?.expanded_url) ?? str(entry?.url);
    if (url !== null && !out.includes(url)) out.push(url);
  }
  return out;
}

/**
 * One provider tweet -> one XPost, or null when it carries no id, no author or
 * no date (all three are load-bearing for the detector).
 *
 * The quoted/retweeted post's TEXT is deliberately never read: Tier A counts a
 * quote only when the address is in the tracked account's OWN words, and the
 * cheapest way to guarantee that is never to have the other text in hand.
 */
export function toPost(raw: RawTweet): XPost | null {
  const id = str(raw.id);
  const handleRaw = str(raw.author?.userName);
  const createdAt = parseXDate(raw.createdAt);
  if (id === null || handleRaw === null || createdAt === null) return null;
  const handle = handleRaw.toLowerCase().replace(/^@+/, '');
  const text = str(raw.text) ?? '';
  // THE KEY BEING THERE IS THE FLAG. An empty `retweeted_tweet: {}` is the
  // provider saying "this is a retweet" with a body it did not fill in, and
  // reading that as an original post would turn every retweeted contract
  // address into a ping. The RT prefix is checked too, for an adapter or a
  // vendor that stops carrying the field at all.
  const isRetweet =
    ('retweeted_tweet' in raw && raw.retweeted_tweet !== null && raw.retweeted_tweet !== undefined) ||
    isRetweetText(text);
  const quoted = raw.quoted_tweet ?? null;
  // A reply by ANY of the provider's three tells. The parent USER id is a
  // separate question — the detector treats "a reply we cannot attribute" as
  // silence, and it can only do that if this flag survives the parse.
  const isReply =
    raw.isReply === true || str(raw.inReplyToId) !== null || str(raw.inReplyToUsername) !== null;
  return {
    id,
    authorUserId: str(raw.author?.id),
    authorHandle: handle,
    text,
    urls: postUrls(raw),
    createdAt,
    isRetweet,
    isQuote: quoted !== null && Object.keys(quoted).length > 0,
    quotedAuthorUserId: str(quoted?.author?.id),
    isReply,
    inReplyToUserId: str(raw.inReplyToUserId),
    // THE PARENT ID IS THE RECOVERY PATH'S WHOLE PAYLOAD. `str` maps the
    // provider's EMPTY STRINGS to null, which matters here more than anywhere:
    // a non-reply from GET /twitter/tweets carries `inReplyToId: ""`,
    // `inReplyToUserId: ""` and `inReplyToUsername: ""` rather than omitting
    // them, and reading "" as a parent id would put an unfetchable id on the
    // queue every poll.
    inReplyToId: str(raw.inReplyToId),
    inReplyToHandle: str(raw.inReplyToUsername)?.toLowerCase().replace(/^@+/, '') ?? null,
    permalink: str(raw.url) ?? `https://x.com/${handle}/status/${id}`,
  };
}

export function toProfile(raw: RawUser | null | undefined, handle: string): XProfile | null {
  const userId = str(raw?.id);
  if (raw === null || raw === undefined || userId === null) return null;
  return {
    userId,
    handle: (str(raw.userName) ?? handle).toLowerCase().replace(/^@+/, ''),
    displayName: str(raw.name),
    avatarUrl: str(raw.profilePicture),
    bio: str(raw.description),
    followers: int(raw.followers),
    accountCreatedAt: parseXDate(raw.createdAt),
  };
}

/**
 * The tweets a `tweets`-shaped body carries — or a throw, because ANSWERED and
 * FAILED are not the same fact.
 *
 * `get` returns null for any 200 whose body will not parse (a truncated body, an
 * edge proxy's HTML), and the vendor answers its OWN failures with the success
 * envelope minus the payload ("rate limit", "internal error") — the behaviour
 * resolveHandle below has read for `status: 'error'` since round 23. Reading
 * either as "no posts" is how a garbled 200 during a launch minute silently
 * retires the parent id this whole recovery path exists to fetch: the runner
 * requeues a THROW and permanently marks an empty result seen.
 *
 * An empty ARRAY is left exactly as it is: "those ids are gone" is a real
 * answer, and a deleted post must not be asked about every poll forever.
 */
function tweetsOrThrow(body: { tweets?: RawTweet[] | null; msg?: unknown } | null): RawTweet[] {
  if (Array.isArray(body?.tweets)) return body.tweets;
  // Status 0 is not a refusal (client.ts pauses on 401/403/429 only), so this
  // requeues and logs rather than driving the whole watcher into a back-off.
  throw new XApiError(0, str(body?.msg) ?? 'no tweets in response');
}

/** Provider text a "not found" answer carries, in either of its two shapes. */
function saysMissing(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes('not found') || lower.includes('does not exist') || lower.includes('no user');
}

function saysSuspended(text: string): boolean {
  return text.toLowerCase().includes('suspend');
}

export function createTwitterApiWatcher(apiKey: string, baseUrl?: string | null): TweetWatcher {
  const base = (baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
  const meter = new XRequestMeter();
  /** The from: shards in force, set by syncRules. Empty = nothing to poll. */
  let rules: XRule[] = [];
  /**
   * ...and the to: shards, over the same handle set. PRIVATE: they are not
   * rules a monitor records (a row's provider_rule_id names the from: shard it
   * is polled in) — they are the recovery path's query, and nothing above this
   * file has any use for their ids.
   */
  let replyRules: XRule[] = [];

  async function get(path: string, params: Record<string, string>): Promise<unknown> {
    const url = new URL(`${base}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    meter.note();
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { 'X-API-Key': apiKey, accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // A transport failure carries the whole request in `cause`; only the
      // error's own name and message survive, and both are scrubbed downstream.
      throw new XApiError(0, err instanceof Error ? err.name : 'fetch failed');
    }
    if (!res.ok) {
      // Body first: the vendor puts the useful sentence in `msg`, and the
      // status alone cannot tell a missing account from a rejected key.
      const text = await res.text().catch(() => '');
      throw new XApiError(res.status, text.slice(0, 200));
    }
    return (await res.json().catch(() => null)) as unknown;
  }

  /** The cursor's instant in whole seconds, or the lookback when it has none. */
  function sinceSecondsFrom(cursor: string | null): number {
    const fallbackMs = Date.now() - XWATCH.lookbackMinutes * 60_000;
    const sinceMs = cursor === null ? fallbackMs : Number(cursor) * 1000;
    return Math.floor((Number.isFinite(sinceMs) ? sinceMs : fallbackMs) / 1000);
  }

  /**
   * One Latest search over a shard set, paged to the poll bound.
   *
   * Shared by the from: poll and the reply poll because they are the SAME read
   * with a different grammar: same paging bound, same de-dup, and the same
   * `truncated` answer — which the from: caller reads as "hold the cursor" and
   * the reply caller is free to ignore (runner.ts says why).
   */
  async function searchShards(shards: XRule[], sinceSeconds: number): Promise<XPollResult> {
    const posts: XPost[] = [];
    const seen = new Set<string>();
    let truncated = false;
    for (const rule of shards) {
      let nextCursor = '';
      for (let page = 0; page < XWATCH.maxPagesPerPoll; page++) {
        const body = (await get('/twitter/tweet/advanced_search', {
          // PARENTHESISED, because X binds AND tighter than OR: without the
          // brackets `to:a OR to:b since_time:N` means `to:a OR (to:b AND
          // since_time:N)` and the FIRST handle's whole history is pulled,
          // newest first, every poll — which on a to: shard is other people's
          // replies, so every page is spent and `wanted` fills with ancient
          // parent ids that then queue ahead of a live launch. The
          // parenthesised form is also the only one measured against the
          // provider (docs/research-x-monitor.md: "(from:a OR to:a OR from:b OR
          // to:b) since_time:<10 digits> is accepted").
          query: `(${rule.value}) since_time:${sinceSeconds}`,
          queryType: 'Latest',
          cursor: nextCursor,
        })) as {
          tweets?: RawTweet[] | null;
          has_next_page?: unknown;
          next_cursor?: unknown;
          msg?: unknown;
        } | null;
        // SAME RULE AS pollTop AND fetchPosts, and it matters MOST here: this
        // is the read whose cursor moves. A 200 carrying the vendor's own
        // failure ("rate limit", "internal error") has no tweets array, and
        // reading that as "no posts" lets runner.ts take its empty-result
        // branch and jump the cursor forward to the lookback floor — stepping
        // over exactly the backlog a catch-up poll after a back-off exists to
        // re-read. A throw leaves the cursor untouched.
        for (const raw of tweetsOrThrow(body)) {
          const post = toPost(raw);
          if (post === null || seen.has(post.id)) continue;
          seen.add(post.id);
          posts.push(post);
        }
        const more = body?.has_next_page === true;
        nextCursor = str(body?.next_cursor) ?? '';
        if (!more || nextCursor === '') break;
        // The bound is reached with the provider still offering more: the page
        // does NOT reach back to since_time, and the caller has to know.
        if (page === XWATCH.maxPagesPerPoll - 1) truncated = true;
      }
    }
    return { posts, truncated };
  }

  return {
    async resolveHandle(rawHandle) {
      const handle = normalizeHandle(rawHandle);
      if (handle === null) return { status: 'not_found' };
      let body: { status?: unknown; msg?: unknown; data?: RawUser | null } | null;
      try {
        body = (await get('/twitter/user/info', { userName: handle })) as typeof body;
      } catch (err) {
        if (err instanceof XApiError) {
          // 404 is the account, not the key: an answer, and the only failure
          // shape allowed to become a verdict.
          if (err.status === 404) {
            return saysSuspended(err.detail) ? { status: 'suspended' } : { status: 'not_found' };
          }
          // Everything else — 401/403/429/5xx/timeout — is the absence of an
          // answer. It must never flip a monitor's status.
          throw err;
        }
        throw err;
      }
      const profile = toProfile(body?.data ?? null, handle);
      if (profile !== null) return { status: 'ok', profile };
      const msg = str(body?.msg) ?? '';
      if (saysSuspended(msg)) return { status: 'suspended' };
      // A 200 with `status: 'error'` is only a VERDICT when the message says
      // the account is missing. The vendor uses that same envelope for its own
      // failures ("rate limit", "internal error"), and reading those as
      // not_found is how a bad ten minutes at the provider would mark a whole
      // watchlist renamed.
      if (saysMissing(msg)) return { status: 'not_found' };
      // A 200 that carried no user and said nothing useful is not evidence.
      return { status: 'error', detail: msg === '' ? 'no user in response' : msg };
    },

    async resolveUserId(userId) {
      // UNVERIFIED endpoint (see the header): every shape it does not answer in
      // is read as 'error', which changes nothing about anybody's account.
      const id = userId.trim();
      if (!/^\d{1,25}$/.test(id)) return { status: 'error', detail: 'not a user id' };
      let body: { data?: RawUser[] | RawUser | null; users?: RawUser[] | null; msg?: unknown } | null;
      try {
        body = (await get('/twitter/user/batch_info_by_ids', { userIds: id })) as typeof body;
      } catch (err) {
        if (err instanceof XApiError && err.status === 404) {
          return saysSuspended(err.detail) ? { status: 'suspended' } : { status: 'not_found' };
        }
        throw err;
      }
      const list = Array.isArray(body?.data)
        ? body.data
        : Array.isArray(body?.users)
          ? body.users
          : body?.data
            ? [body.data]
            : [];
      const profile = toProfile(list[0] ?? null, '');
      if (profile !== null) return { status: 'ok', profile };
      const msg = str(body?.msg) ?? '';
      if (saysSuspended(msg)) return { status: 'suspended' };
      if (saysMissing(msg)) return { status: 'not_found' };
      return { status: 'error', detail: msg === '' ? 'no user in response' : msg };
    },

    async syncRules(handles) {
      // Poll mode registers nothing at the vendor (see the header comment), so
      // this is pure: shard, remember, answer. It stays async because the
      // interface must also fit an adapter that DOES register rules. The shard
      // size is the SEARCH query's, not the filter rule's — one call carries
      // about 25 handles.
      rules = shardHandles(handles, XWATCH.searchQueryMaxChars);
      // The SAME handles, asked the other way round. Built here rather than in
      // the poll so a handle set that did not change costs no sharding, and so
      // the two shard sets can never drift apart.
      replyRules = shardHandles(handles, XWATCH.searchQueryMaxChars, toTerm);
      return rules;
    },

    async pollResults(cursor) {
      if (rules.length === 0) return { posts: [], truncated: false };
      // NO CURSOR IS RETURNED. The runner owns it and moves it only past posts
      // it has finished with; an adapter that jumped it to the newest post it
      // fetched would silently drop everything it had not handled yet.
      return searchShards(rules, sinceSecondsFrom(cursor));
    },

    async pollReplies(cursor) {
      if (replyRules.length === 0) return { posts: [], truncated: false };
      // Same read, same paging, its own cursor: these posts are OTHER PEOPLE'S
      // and the runner never processes them — it reads the parent ids off them.
      return searchShards(replyRules, sinceSecondsFrom(cursor));
    },

    async pollTop(sinceSeconds) {
      if (rules.length === 0) return [];
      const posts: XPost[] = [];
      const seen = new Set<string>();
      for (const rule of rules) {
        // ONE PAGE, NO CURSOR. Top is engagement-ranked, not chronological, so
        // paging it does not reach further back in time — it reaches further
        // down the ranking, which is not what the sweep is for. The window is
        // the whole bound (XWATCH.topLookbackMinutes), and the sweep is a
        // safety net rather than the primary read.
        const body = (await get('/twitter/tweet/advanced_search', {
          // Bracketed for the same reason searchShards is: on a shard holding
          // more than one handle an unparenthesised OR list binds `since_time:`
          // to the last term only.
          query: `(${rule.value}) since_time:${Math.floor(sinceSeconds)}`,
          queryType: 'Top',
        })) as { tweets?: RawTweet[] | null; msg?: unknown } | null;
        // Same rule as fetchPosts: a body with no tweets ARRAY is the provider
        // failing, and a sweep that silently became a no-op is the failure mode
        // this sweep exists to be the belt against.
        for (const raw of tweetsOrThrow(body)) {
          const post = toPost(raw);
          if (post === null || seen.has(post.id)) continue;
          seen.add(post.id);
          posts.push(post);
        }
      }
      return posts;
    },

    async fetchPosts(ids) {
      // An empty list is not a request: twitterapi.io bills a minimum per CALL,
      // and a poll that recovered no parent must cost nothing.
      const wanted = [...new Set(ids.map((id) => id.trim()).filter((id) => id !== ''))];
      if (wanted.length === 0) return [];
      const body = (await get('/twitter/tweets', { tweet_ids: wanted.join(',') })) as {
        tweets?: RawTweet[] | null;
        msg?: unknown;
      } | null;
      const posts: XPost[] = [];
      for (const raw of tweetsOrThrow(body)) {
        // A parent that will not parse is DROPPED, not guessed at: an id the
        // provider answered for with no author or no date is not a post the
        // detector can judge.
        const post = toPost(raw);
        if (post !== null) posts.push(post);
      }
      return posts;
    },

    meter: () => meter.snapshot(),
  };
}

/**
 * The watcher this deployment should use, or null when the X features are not
 * configured — the same shape (and the same meaning) as createChainClient.
 */
export function createTweetWatcher(env: {
  xApiKey: string | null;
  xApiBase: string | null;
}): TweetWatcher | null {
  if (!env.xApiKey) return null;
  return createTwitterApiWatcher(env.xApiKey, env.xApiBase);
}
