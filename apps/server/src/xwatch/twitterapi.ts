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
import { shardHandles } from './rules.js';

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
 *             inReplyToUserId, retweeted_tweet, quoted_tweet }],
 *             has_next_page, next_cursor }
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
  /** The shards in force, set by syncRules. Empty = nothing to poll. */
  let rules: XRule[] = [];

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
      return rules;
    },

    async pollResults(cursor) {
      if (rules.length === 0) return { posts: [], truncated: false };
      const fallbackMs = Date.now() - XWATCH.lookbackMinutes * 60_000;
      const sinceMs = cursor === null ? fallbackMs : Number(cursor) * 1000;
      const sinceSeconds = Math.floor((Number.isFinite(sinceMs) ? sinceMs : fallbackMs) / 1000);
      const posts: XPost[] = [];
      const seen = new Set<string>();
      let truncated = false;
      for (const rule of rules) {
        let nextCursor = '';
        for (let page = 0; page < XWATCH.maxPagesPerPoll; page++) {
          const body = (await get('/twitter/tweet/advanced_search', {
            query: `${rule.value} since_time:${sinceSeconds}`,
            queryType: 'Latest',
            cursor: nextCursor,
          })) as {
            tweets?: RawTweet[] | null;
            has_next_page?: unknown;
            next_cursor?: unknown;
          } | null;
          for (const raw of body?.tweets ?? []) {
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
      // NO CURSOR IS RETURNED. The runner owns it and moves it only past posts
      // it has finished with; an adapter that jumped it to the newest post it
      // fetched would silently drop everything it had not handled yet.
      return { posts, truncated };
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
