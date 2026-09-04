import { afterEach, describe, expect, it, vi } from 'vitest';
import { XWATCH, XWATCH_DEFAULTS, tradingLinks } from '@groupie/shared';
import { WETH } from '../src/chain/addresses.js';
import type { ChainClient } from '../src/chain/client.js';
import {
  XApiError,
  normalizeHandle,
  shouldPauseXPolling,
  summarizeXError,
  xRefusalStatus,
  type XPost,
} from '../src/xwatch/client.js';
import { KNOWN_CONTRACTS, confirmAddress } from '../src/xwatch/confirm.js';
import { detectTierA, isAuthoredBy, type TrackedAccount } from '../src/xwatch/detect.js';
import { launchPingMessage } from '../src/xwatch/message.js';
import { ruleIdByHandle, shardHandles, toTerm } from '../src/xwatch/rules.js';
import { mergeXWatchSettings, xwatchSettingsOf } from '../src/xwatch/settings.js';
import { decodeSocials, handleFromSocialUrl } from '../src/xwatch/tierB.js';
import {
  confirmIntervalSeconds,
  isAgedOut,
  isDefinitiveRejection,
} from '../src/xwatch/pending.js';
import {
  createTwitterApiWatcher,
  parseXDate,
  toPost,
  toProfile,
} from '../src/xwatch/twitterapi.js';
import type { Resolution } from '../src/market/resolve.js';

/**
 * The X launch monitor's pure halves (docs/decisions.md round 23): what counts
 * as an announcement, what a confirmation proves, how the handle set is sharded
 * into provider rules, and exactly what the one message says.
 */

const CA = '0xb2790f5f4d4c1e1a2f0e2b7a9c4d6e8f0a1b260c';
const HANDLE = 'legsdotfun';
const USER_ID = '1500000000000000001';
const NOW = Date.UTC(2026, 8, 3, 12, 0, 0);

const ACCOUNT: TrackedAccount = {
  monitorId: 1,
  groupId: 2,
  handle: HANDLE,
  xUserId: USER_ID,
};

function post(overrides: Partial<XPost> = {}): XPost {
  return {
    id: '1900000000000000001',
    authorUserId: USER_ID,
    authorHandle: HANDLE,
    text: `live ${CA}`,
    urls: [],
    createdAt: new Date(NOW),
    isRetweet: false,
    isQuote: false,
    inReplyToId: null,
    inReplyToHandle: null,
    permalink: `https://x.com/${HANDLE}/status/1900000000000000001`,
    ...overrides,
  };
}

/* --------------------------------------------------------------- rule shards */

describe('shardHandles — the provider 255-character rule value', () => {
  it('keeps a small set in one rule', () => {
    const rules = shardHandles(['legsdotfun', 'someproject']);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.value).toBe('from:legsdotfun OR from:someproject');
    expect(rules[0]?.handles).toEqual(['legsdotfun', 'someproject']);
  });

  it('never builds a rule longer than the cap', () => {
    // 15-character handles: the longest X allows, so the worst shard case.
    const handles = Array.from({ length: 30 }, (_, i) => `handle${String(i).padStart(9, '0')}`);
    const rules = shardHandles(handles);
    expect(rules.length).toBeGreaterThan(1);
    for (const rule of rules) {
      expect(rule.value.length).toBeLessThanOrEqual(XWATCH.ruleValueMaxChars);
    }
    // Every handle lands in exactly one shard.
    expect(rules.flatMap((r) => r.handles).sort()).toEqual([...handles].sort());
  });

  it('is stable under insertion order and de-duplicates', () => {
    const a = shardHandles(['b', 'a', 'a']);
    const b = shardHandles(['A', 'B']);
    expect(a).toEqual(b);
    expect(a[0]?.handles).toEqual(['a', 'b']);
  });

  it('answers nothing for an empty set', () => {
    expect(shardHandles([])).toEqual([]);
    expect(shardHandles(['   '])).toEqual([]);
  });

  it('maps every handle to the rule it is polled in', () => {
    const rules = shardHandles(['alpha', 'beta']);
    const map = ruleIdByHandle(rules);
    expect(map.get('alpha')).toBe(rules[0]?.id);
    expect(map.get('beta')).toBe(rules[0]?.id);
  });

  it('fits about 25 handles in ONE search query, room left for since_time', () => {
    // Ten characters, the ordinary handle length the cost table assumes.
    const handles = Array.from({ length: 25 }, (_, i) => `hndl${String(i).padStart(6, '0')}`);
    const rules = shardHandles(handles, XWATCH.searchQueryMaxChars);
    expect(rules).toHaveLength(1);
    // What the adapter actually sends: the shard in brackets, then
    // ' since_time:' plus ten digits.
    expect(`(${rules[0]?.value ?? ''}) since_time:1788000000`.length).toBeLessThanOrEqual(512);
    for (const rule of shardHandles(
      Array.from({ length: 60 }, (_, i) => `h${String(i).padStart(14, '0')}`),
      XWATCH.searchQueryMaxChars,
    )) {
      expect(rule.value.length).toBeLessThanOrEqual(XWATCH.searchQueryMaxChars);
    }
  });
});

/* ------------------------------------------------- the confirmation ladder */

describe('pending confirmations — the round-17b ladder', () => {
  const posted = (minutesAgo: number): Date => new Date(NOW - minutesAgo * 60_000);

  it('retries every 45s for the first fifteen minutes', () => {
    expect(confirmIntervalSeconds(posted(0), NOW)).toBe(45);
    expect(confirmIntervalSeconds(posted(14), NOW)).toBe(45);
  });

  it('drops to five minutes for the next six hours', () => {
    expect(confirmIntervalSeconds(posted(15), NOW)).toBe(300);
    expect(confirmIntervalSeconds(posted(5 * 60), NOW)).toBe(300);
  });

  it('and to hourly after that', () => {
    expect(confirmIntervalSeconds(posted(6 * 60), NOW)).toBe(3_600);
    expect(confirmIntervalSeconds(posted(20 * 60), NOW)).toBe(3_600);
  });

  it('treats a row it cannot date as brand new', () => {
    expect(confirmIntervalSeconds(null, NOW)).toBe(45);
  });

  it('ages a post out at the launch window, and not before', () => {
    expect(isAgedOut(posted(XWATCH.launchMaxPoolAgeHours * 60 - 1), NOW)).toBe(false);
    expect(isAgedOut(posted(XWATCH.launchMaxPoolAgeHours * 60 + 1), NOW)).toBe(true);
    expect(isAgedOut(null, NOW)).toBe(false);
  });

  it('stops only on the two DEFINITIVE rejections', () => {
    expect(isDefinitiveRejection('known_contract')).toBe(true);
    expect(isDefinitiveRejection('pool_too_old')).toBe(true);
    // Unknown is never a verdict: all of these stay on the ladder.
    for (const reason of ['unresolved', 'unreadable', 'not_erc20', 'pool_unknown', 'no_chain'] as const) {
      expect(isDefinitiveRejection(reason)).toBe(false);
    }
  });

  it('keeps an address with NO CODE on the ladder — a deploy can still land', () => {
    // The launch announced seconds before its deploy transaction, and the node
    // one block behind, read identically. Only the 24h age-out ends this row.
    expect(isDefinitiveRejection('no_code')).toBe(false);
    expect(isAgedOut(posted(20), NOW)).toBe(false);
  });
});

/* ------------------------------------------------------------------- Tier A */

describe('detectTierA — only an authored post can fire', () => {
  it('fires on an authored post carrying an address', () => {
    expect(detectTierA(post(), ACCOUNT)).toEqual({ fires: true, addresses: [CA] });
  });

  it('fires on a self-reply (the CA dropped under the announcement)', () => {
    expect(detectTierA(post({ inReplyToUserId: USER_ID }), ACCOUNT).fires).toBe(true);
  });

  it('does not fire on a retweet, whatever it carries', () => {
    expect(detectTierA(post({ isRetweet: true }), ACCOUNT)).toEqual({
      fires: false,
      reason: 'retweet',
    });
  });

  it('reads the RT prefix as a retweet even when the provider flags nothing', () => {
    expect(detectTierA(post({ text: `RT @somebody: live ${CA}` }), ACCOUNT)).toEqual({
      fires: false,
      reason: 'retweet',
    });
  });

  it('still fires on an authored post that merely mentions RT-shaped text', () => {
    expect(detectTierA(post({ text: `we do not RT @anyone: ${CA}` }), ACCOUNT).fires).toBe(true);
  });

  it('is silent on a reply the provider named no parent for', () => {
    expect(detectTierA(post({ isReply: true, inReplyToUserId: null }), ACCOUNT)).toEqual({
      fires: false,
      reason: 'reply_unattributable',
    });
  });

  it('does not fire on a reply to somebody else', () => {
    expect(detectTierA(post({ inReplyToUserId: '999' }), ACCOUNT)).toEqual({
      fires: false,
      reason: 'reply_to_other',
    });
  });

  it('refuses to guess about a reply when the monitor has no stored user id', () => {
    const account = { ...ACCOUNT, xUserId: null };
    expect(detectTierA(post({ inReplyToUserId: '999' }), account)).toEqual({
      fires: false,
      reason: 'reply_unattributable',
    });
  });

  it('does not fire on a quote of someone else CA — the address is not in its own text', () => {
    const quote = post({ isQuote: true, text: 'this looks early', quotedAuthorUserId: '999' });
    expect(detectTierA(quote, ACCOUNT)).toEqual({ fires: false, reason: 'no_address' });
  });

  it('DOES fire on a quote whose own text carries the address', () => {
    const quote = post({ isQuote: true, text: `confirmed: ${CA}`, quotedAuthorUserId: '999' });
    expect(detectTierA(quote, ACCOUNT)).toEqual({ fires: true, addresses: [CA] });
  });

  it('does not fire on somebody else post', () => {
    expect(detectTierA(post({ authorUserId: '999', authorHandle: 'impostor' }), ACCOUNT)).toEqual({
      fires: false,
      reason: 'other_author',
    });
  });

  it('does not fire on a bare tweet', () => {
    expect(detectTierA(post({ text: 'soon' }), ACCOUNT)).toEqual({
      fires: false,
      reason: 'no_address',
    });
  });

  it('matches by handle when either side has no id, and by id when both do', () => {
    expect(isAuthoredBy(post({ authorUserId: null }), ACCOUNT)).toBe(true);
    // Same handle, different id: the id wins, because the handle was sold.
    expect(isAuthoredBy(post({ authorUserId: '777' }), ACCOUNT)).toBe(false);
  });
});

/* ----------------------------------------------------------------- confirm */

function chainStub(overrides: Partial<ChainClient> = {}): ChainClient {
  return {
    getBlockNumber: async () => 1,
    getBlockTimestamp: async () => 1,
    getLogs: async () => [],
    call: async () => '0x0000000000000000000000000000000000000000000000000000000000000012',
    getCode: async () => '0x60806040',
    getTransactionValue: async () => 0n,
    getTransactionLogs: async () => [],
    meter: () => ({ total: 0, windowCount: 0, totalCu: 0 }),
    ...overrides,
  } as ChainClient;
}

function resolution(overrides: Partial<{ createdAt: Date | null; token: unknown }> = {}) {
  const createdAt =
    overrides.createdAt === undefined ? new Date(NOW - 4 * 60_000) : overrides.createdAt;
  return async (): Promise<Resolution> => ({
    token: {
      symbol: 'LEGS',
      name: 'Legs',
      imageUrl: null,
      socials: null,
      launchpad: 'pons-v2-dex',
      phase: 'curve',
      poolAddress: '0xpool',
      tokenCreatedAt: createdAt,
      snapshot: {
        priceUsd: 0.00003,
        mcapUsd: 31_000,
        liquidityUsd: 31_000,
        vol24Usd: 1_000,
        txns24: 40,
      },
    },
    unknownOnChain: false,
  });
}

describe('confirmAddress', () => {
  it('confirms a fresh ERC-20 with a young pool', async () => {
    const result = await confirmAddress(CA, new Date(NOW), {
      chain: chainStub(),
      resolve: resolution(),
      nowMs: NOW,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.token.symbol).toBe('LEGS');
      expect(result.token.mcapUsd).toBe(31_000);
      expect(result.token.hijack).toBe(false);
    }
  });

  it('refuses a known infrastructure contract without touching the chain', async () => {
    let called = false;
    const result = await confirmAddress(WETH, new Date(NOW), {
      chain: chainStub({
        getCode: async () => {
          called = true;
          return '0x60';
        },
      }),
      resolve: resolution(),
      nowMs: NOW,
    });
    expect(result).toEqual({ ok: false, reason: 'known_contract' });
    expect(called).toBe(false);
    expect(KNOWN_CONTRACTS.has(WETH)).toBe(true);
  });

  it('says nothing when there is no chain client', async () => {
    const result = await confirmAddress(CA, new Date(NOW), { chain: null, nowMs: NOW });
    expect(result).toEqual({ ok: false, reason: 'no_chain' });
  });

  it('reads a failed code read as UNKNOWN, not as "no contract"', async () => {
    const result = await confirmAddress(CA, new Date(NOW), {
      chain: chainStub({ getCode: async () => null }),
      resolve: resolution(),
      nowMs: NOW,
    });
    expect(result).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('rejects an address with no code', async () => {
    const result = await confirmAddress(CA, new Date(NOW), {
      chain: chainStub({ getCode: async () => '0x' }),
      resolve: resolution(),
      nowMs: NOW,
    });
    expect(result).toEqual({ ok: false, reason: 'no_code' });
  });

  it('rejects a contract that does not answer as an ERC-20', async () => {
    const result = await confirmAddress(CA, new Date(NOW), {
      chain: chainStub({ call: async () => null }),
      resolve: resolution(),
      nowMs: NOW,
    });
    expect(result).toEqual({ ok: false, reason: 'not_erc20' });
  });

  it('is silent when no market source can resolve it', async () => {
    const result = await confirmAddress(CA, new Date(NOW), {
      chain: chainStub(),
      resolve: async () => ({ token: null, unknownOnChain: true }),
      nowMs: NOW,
    });
    expect(result).toEqual({ ok: false, reason: 'unresolved' });
  });

  it('is silent when the pool carries no creation date', async () => {
    const result = await confirmAddress(CA, new Date(NOW), {
      chain: chainStub(),
      resolve: resolution({ createdAt: null }),
      nowMs: NOW,
    });
    expect(result).toEqual({ ok: false, reason: 'pool_unknown' });
  });

  it('refuses a pool older than the launch window', async () => {
    const old = new Date(NOW - (XWATCH.launchMaxPoolAgeHours + 1) * 3_600_000);
    const result = await confirmAddress(CA, new Date(NOW), {
      chain: chainStub(),
      resolve: resolution({ createdAt: old }),
      nowMs: NOW,
    });
    expect(result).toEqual({ ok: false, reason: 'pool_too_old' });
  });

  it('flags the HIJACK HOLD when the token predates the post', async () => {
    const created = new Date(NOW - (XWATCH.hijackHoldMinutes + 36) * 60_000);
    const result = await confirmAddress(CA, new Date(NOW), {
      chain: chainStub(),
      resolve: resolution({ createdAt: created }),
      nowMs: NOW,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.token.hijack).toBe(true);
  });

  it('judges the age and the hold on the EARLIEST evidence, not on the pool', async () => {
    // A pool minutes old, but our own launch row dates the token two days back.
    const earliest = new Date(NOW - 48 * 3_600_000);
    const result = await confirmAddress(CA, new Date(NOW), {
      chain: chainStub(),
      resolve: resolution(),
      clock: async () => ({ at: earliest, source: 'discovery' as const }),
      nowMs: NOW,
    });
    expect(result).toEqual({ ok: false, reason: 'pool_too_old' });
  });

  it('holds a fresh-looking pool whose token was minted before the post', async () => {
    const minted = new Date(NOW - 46 * 60_000);
    const result = await confirmAddress(CA, new Date(NOW), {
      chain: chainStub(),
      resolve: resolution(),
      clock: async () => ({ at: minted, source: 'chain' as const }),
      nowMs: NOW,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.token.hijack).toBe(true);
      expect(result.token.tokenCreatedAt).toEqual(minted);
      expect(result.token.clockSource).toBe('chain');
    }
  });

  it('does not flag a token created just inside the hold', async () => {
    const created = new Date(NOW - (XWATCH.hijackHoldMinutes - 1) * 60_000);
    const result = await confirmAddress(CA, new Date(NOW), {
      chain: chainStub(),
      resolve: resolution({ createdAt: created }),
      nowMs: NOW,
    });
    expect(result.ok && result.token.hijack).toBe(false);
  });
});

/* ----------------------------------------------------------------- the ping */

describe('launchPingMessage', () => {
  const base = {
    handle: HANDLE,
    address: CA,
    symbol: 'LEGS',
    mcapUsd: 31_000,
    liquidityUsd: 31_000,
    tokenCreatedAt: new Date(NOW - 4 * 60_000),
    launchpad: 'pons-v2-dex',
    launchBlockPct: 18,
    launchBlockWallets: 2,
    tweetUrl: `https://x.com/${HANDLE}/status/1900000000000000001`,
    nowMs: NOW,
  };

  it('says who posted, what the coin is, the numbers, the receipt and the links', () => {
    const lines = launchPingMessage(base).split('\n');
    expect(lines[0]).toBe('@legsdotfun posted a contract address.');
    expect(lines[1]).toBe('LEGS · 0xb279…260c');
    expect(lines[2]).toBe('mcap $31K · LP $31K · launched 4m ago · PONS · launch block 18% · 2 wallets');
    expect(lines[3]).toBe(base.tweetUrl);
    expect(lines[4]).toBe(
      [tradingLinks(CA).axiom, tradingLinks(CA).gmgn, tradingLinks(CA).dexscreener].join(' · '),
    );
  });

  it('drops every unknown clause rather than printing a zero', () => {
    const message = launchPingMessage({
      ...base,
      symbol: null,
      mcapUsd: null,
      liquidityUsd: null,
      launchBlockPct: null,
      launchBlockWallets: null,
      tweetUrl: null,
    });
    expect(message).not.toContain('$0');
    expect(message).not.toContain('launch block');
    expect(message).not.toContain('mcap');
    expect(message.split('\n')[1]).toBe('0xb279…260c');
    expect(message).toContain('launched 4m ago · PONS');
  });

  it('prints one wallet in the singular', () => {
    expect(launchPingMessage({ ...base, launchBlockWallets: 1 })).toContain('1 wallet');
  });

  it('drops the whole facts line when nothing is known', () => {
    const message = launchPingMessage({
      ...base,
      mcapUsd: null,
      liquidityUsd: null,
      tokenCreatedAt: null,
      launchpad: null,
      launchBlockPct: null,
      launchBlockWallets: null,
      tweetUrl: null,
    });
    expect(message.split('\n')).toHaveLength(3);
  });

  it('carries no markdown, so a symbol with _ or * cannot break the send', () => {
    expect(launchPingMessage({ ...base, symbol: 'A_B*C' })).toContain('A_B*C');
  });
});

/* --------------------------------------------------------------- settings */

describe('xwatch settings', () => {
  it('ships with the ping on', () => {
    expect(mergeXWatchSettings(undefined)).toEqual({ launchPing: true });
    expect(XWATCH_DEFAULTS.launchPing).toBe(true);
  });

  it('honours an explicit off and ignores junk', () => {
    expect(mergeXWatchSettings({ launchPing: false })).toEqual({ launchPing: false });
    expect(mergeXWatchSettings({ launchPing: 'no' })).toEqual({ launchPing: true });
    expect(mergeXWatchSettings('nonsense')).toEqual({ launchPing: true });
  });

  it('reads the key out of a whole settings blob', () => {
    expect(xwatchSettingsOf({ alerts: {}, xwatch: { launchPing: false } })).toEqual({
      launchPing: false,
    });
    expect(xwatchSettingsOf(null)).toEqual({ launchPing: true });
  });
});

/* -------------------------------------------------------- provider parsing */

describe('twitterapi response parsing', () => {
  it('reads a post, its expanded links and its author', () => {
    const parsed = toPost({
      id: '123',
      text: `live ${CA}`,
      url: 'https://x.com/legsdotfun/status/123',
      createdAt: 'Wed Sep 03 12:00:00 +0000 2026',
      author: { id: USER_ID, userName: 'LegsDotFun' },
      entities: { urls: [{ url: 'https://t.co/abc', expanded_url: 'https://ponsfamily.com/x' }] },
    });
    expect(parsed?.authorHandle).toBe(HANDLE);
    expect(parsed?.authorUserId).toBe(USER_ID);
    expect(parsed?.urls).toEqual(['https://ponsfamily.com/x']);
    expect(parsed?.isRetweet).toBe(false);
    expect(parsed?.createdAt.toISOString()).toBe('2026-09-03T12:00:00.000Z');
  });

  it('marks retweets and quotes, and never carries the other post text', () => {
    const rt = toPost({
      id: '1',
      text: 'RT',
      createdAt: '2026-09-03T12:00:00Z',
      author: { id: USER_ID, userName: HANDLE },
      retweeted_tweet: { id: '9', text: `someone else ${CA}` },
    });
    expect(rt?.isRetweet).toBe(true);
    expect(rt?.text).toBe('RT');
    const qt = toPost({
      id: '2',
      text: 'look',
      createdAt: '2026-09-03T12:00:00Z',
      author: { id: USER_ID, userName: HANDLE },
      quoted_tweet: { author: { id: '999' } },
    });
    expect(qt?.isQuote).toBe(true);
    expect(qt?.quotedAuthorUserId).toBe('999');
  });

  it('reads an EMPTY retweeted_tweet as a retweet — the key is the flag', () => {
    const bare = toPost({
      id: '3',
      // No RT prefix either: the provider carried the key and nothing in it.
      text: `look at this ${CA}`,
      createdAt: '2026-09-03T12:00:00Z',
      author: { id: USER_ID, userName: HANDLE },
      retweeted_tweet: {},
    });
    expect(bare?.isRetweet).toBe(true);
    // ...and an absent key is still an authored post.
    const own = toPost({
      id: '4',
      text: `mine ${CA}`,
      createdAt: '2026-09-03T12:00:00Z',
      author: { id: USER_ID, userName: HANDLE },
    });
    expect(own?.isRetweet).toBe(false);
    // A null key is the provider saying "not a retweet", explicitly.
    const nulled = toPost({
      id: '5',
      text: `mine ${CA}`,
      createdAt: '2026-09-03T12:00:00Z',
      author: { id: USER_ID, userName: HANDLE },
      retweeted_tweet: null,
    });
    expect(nulled?.isRetweet).toBe(false);
    // The RT prefix alone is enough, whatever the provider carried.
    const prefixed = toPost({
      id: '6',
      text: `RT @someone: ${CA}`,
      createdAt: '2026-09-03T12:00:00Z',
      author: { id: USER_ID, userName: HANDLE },
    });
    expect(prefixed?.isRetweet).toBe(true);
  });

  it('drops a post with no id, author or date rather than inventing one', () => {
    expect(toPost({ text: 'x' })).toBeNull();
    expect(toPost({ id: '1', author: { userName: HANDLE } })).toBeNull();
    expect(parseXDate('not a date')).toBeNull();
  });

  it('builds a permalink when the provider carried none', () => {
    const parsed = toPost({
      id: '55',
      text: '',
      createdAt: '2026-09-03T12:00:00Z',
      author: { id: USER_ID, userName: HANDLE },
    });
    expect(parsed?.permalink).toBe(`https://x.com/${HANDLE}/status/55`);
  });

  it('reads a profile, and refuses one with no id', () => {
    const profile = toProfile(
      {
        id: USER_ID,
        userName: 'LegsDotFun',
        name: 'legs',
        profilePicture: 'https://pbs.example/a.jpg',
        description: 'soon',
        followers: 1_882,
        createdAt: 'Mon Jan 06 12:00:00 +0000 2025',
      },
      HANDLE,
    );
    expect(profile?.userId).toBe(USER_ID);
    expect(profile?.handle).toBe(HANDLE);
    expect(profile?.followers).toBe(1_882);
    expect(toProfile({ userName: HANDLE }, HANDLE)).toBeNull();
  });
});

describe('the twitterapi adapter — a 200 that carries no user', () => {
  const answer = (body: unknown): void => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
  };
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads status:error as NOT FOUND only when the message says the user is missing', async () => {
    answer({ status: 'error', msg: 'user not found', data: null });
    expect(await createTwitterApiWatcher('k').resolveHandle(HANDLE)).toEqual({ status: 'not_found' });
  });

  it('keeps the vendor OWN failures as errors, which change no monitor status', async () => {
    // The same envelope carries the vendor's own bad minute. Reading this as a
    // verdict is how an outage would mark a whole watchlist renamed.
    answer({ status: 'error', msg: 'rate limit exceeded', data: null });
    expect(await createTwitterApiWatcher('k').resolveHandle(HANDLE)).toEqual({
      status: 'error',
      detail: 'rate limit exceeded',
    });
    answer({ status: 'error', data: null });
    expect(await createTwitterApiWatcher('k').resolveHandle(HANDLE)).toEqual({
      status: 'error',
      detail: 'no user in response',
    });
  });

  it('still says suspended when the body says suspended', async () => {
    answer({ status: 'error', msg: 'this account is suspended', data: null });
    expect(await createTwitterApiWatcher('k').resolveHandle(HANDLE)).toEqual({ status: 'suspended' });
  });
});

describe('handles and provider errors', () => {
  it('normalises a handle and refuses a non-handle', () => {
    expect(normalizeHandle('@LegsDotFun')).toBe(HANDLE);
    expect(normalizeHandle('  legs_fun ')).toBe('legs_fun');
    expect(normalizeHandle('has spaces')).toBeNull();
    expect(normalizeHandle('waytoolongforahandle')).toBeNull();
    expect(normalizeHandle('')).toBeNull();
  });

  it('never prints a URL (a base URL can carry a key)', () => {
    const line = summarizeXError(new XApiError(401, 'bad key at https://api.example/v2/SECRET'));
    expect(line).toContain('status=401');
    expect(line).not.toContain('SECRET');
    expect(line).toContain('[url redacted]');
  });

  it('pauses polling only on the refusals the next poll cannot fix', () => {
    expect(xRefusalStatus(new XApiError(429, 'slow down'))).toBe(429);
    expect(xRefusalStatus(new XApiError(403, 'forbidden'))).toBe(403);
    expect(xRefusalStatus(new XApiError(500, 'boom'))).toBeNull();
    expect(shouldPauseXPolling(new XApiError(401, 'nope'))).toBe(true);
    expect(shouldPauseXPolling(new Error('network'))).toBe(false);
  });
});

/* ------------------------------------------------------------------ Tier B */

/** The five ABI strings `socials()` answers with, encoded as the node returns them. */
function encodeSocials(values: string[]): string {
  const word = (n: number): string => n.toString(16).padStart(64, '0');
  const head: string[] = [];
  const body: string[] = [];
  let offset = values.length * 32;
  for (const value of values) {
    head.push(word(offset));
    const hex = Buffer.from(value, 'utf8').toString('hex');
    const padded = hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
    body.push(word(value.length) + padded);
    offset += 32 + (padded.length / 2);
  }
  return `0x${head.join('')}${body.join('')}`;
}

describe('tier B — the verified socials() layout', () => {
  // Read on a public RPC 2026-09-03: Stride (0x446d7659...6d7e), a PONS v2 token.
  const STRIDE = ['https://x.com/playstridexyz', '', '', 'https://playstride.xyz/', ''];

  it('decodes the five strings, X first and the website fourth', () => {
    const decoded = decodeSocials(encodeSocials(STRIDE));
    expect(decoded).toEqual(STRIDE);
    expect(handleFromSocialUrl(decoded?.[0])).toBe('playstridexyz');
    expect(decoded?.[3]).toBe('https://playstride.xyz/');
  });

  it('reads a revert as "not a PONS v2 token", never as a claim', () => {
    // chain.call answers null on a revert — Cummingtonite (long.xyz) does.
    expect(decodeSocials(null)).toBeNull();
  });

  it('answers null for return data that is not five strings', () => {
    expect(decodeSocials('0x')).toBeNull();
    expect(decodeSocials(`0x${'00'.repeat(32)}`)).toBeNull();
    expect(decodeSocials('0xzz')).toBeNull();
  });

  it('carries an empty X field as no handle at all', () => {
    const decoded = decodeSocials(encodeSocials(['', '', '', 'https://x.example/', '']));
    expect(decoded?.[0]).toBe('');
    expect(handleFromSocialUrl(decoded?.[0])).toBeNull();
  });

  it('takes the first path segment, and never one of X own pages', () => {
    expect(handleFromSocialUrl('https://twitter.com/LegsDotFun/status/19')).toBe(HANDLE);
    expect(handleFromSocialUrl('https://x.com/i/status/19')).toBeNull();
    expect(handleFromSocialUrl('@LegsDotFun')).toBe(HANDLE);
    expect(handleFromSocialUrl('https://legs.fun')).toBeNull();
  });
});

/* ------------------------------------------ round 25: the recovery reads */

/**
 * The real shapes, copied from the production provider on 2026-09-04.
 *
 * The launch post is @legsdotfun's own (2026-09-03 21:05:19Z) as GET
 * /twitter/tweets answers for it: a NON-reply carries EMPTY STRINGS in all
 * three inReplyTo fields rather than omitting them, which is the one detail the
 * parser has to get right — an "" read as a parent id would put an unfetchable
 * id on the recovery queue every single poll.
 */
const LEGS_LAUNCH_RAW = {
  id: '2095619171002593725',
  createdAt: 'Thu Sep 03 21:05:19 +0000 2026',
  author: { id: '2094468493223620608', userName: 'legsdotfun' },
  isReply: false,
  inReplyToId: '',
  inReplyToUserId: '',
  inReplyToUsername: '',
  entities: { hashtags: [], symbols: [{ indices: [0, 5], text: 'LEGS' }], urls: [] },
  text: `$LEGS is now live on Robinhood Chain.\n\nCA:   ${CA}\n\nBuild short-term parlays.`,
};

/** ...and one of the 288 replies to it, as advanced_search answers. */
const LEGS_REPLY_RAW = {
  id: '2095981212414144517',
  text: '@legsdotfun 500M runner, yessir',
  createdAt: 'Fri Sep 04 21:03:57 +0000 2026',
  author: { id: '1234', userName: 'rndrflame' },
  isReply: true,
  inReplyToId: '2095619171002593725',
  inReplyToUsername: 'LegsDotFun',
  inReplyToUserId: '2094468493223620608',
  entities: { urls: [] },
};

describe('the parent pointer a reply carries', () => {
  it('reads the parent id and handle off a reply', () => {
    const parsed = toPost(LEGS_REPLY_RAW);
    expect(parsed?.inReplyToId).toBe('2095619171002593725');
    // Stored the way every handle is stored: lowercase, no @.
    expect(parsed?.inReplyToHandle).toBe(HANDLE);
    expect(parsed?.inReplyToUserId).toBe('2094468493223620608');
    expect(parsed?.isReply).toBe(true);
  });

  it('reads the provider EMPTY STRINGS as no parent at all', () => {
    const parsed = toPost(LEGS_LAUNCH_RAW);
    expect(parsed?.id).toBe('2095619171002593725');
    expect(parsed?.authorHandle).toBe(HANDLE);
    expect(parsed?.inReplyToId).toBeNull();
    expect(parsed?.inReplyToHandle).toBeNull();
    expect(parsed?.inReplyToUserId).toBeNull();
    // ...which is also what keeps a top-level post from being read as a reply.
    expect(parsed?.isReply).toBe(false);
    expect(parsed?.text).toContain(CA);
  });
});

describe('shardHandles — the to: grammar', () => {
  it('shards the same handles the other way round, under the same cap', () => {
    const from = shardHandles([HANDLE, 'gaiadotfinance'], XWATCH.searchQueryMaxChars);
    const to = shardHandles([HANDLE, 'gaiadotfinance'], XWATCH.searchQueryMaxChars, toTerm);
    expect(to[0]?.value).toBe('to:gaiadotfinance OR to:legsdotfun');
    expect(to[0]?.handles).toEqual(['gaiadotfinance', HANDLE]);
    // DIFFERENT ids for the same handles: a monitor's recorded shard is the
    // from: one, and the reply shard must never be mistaken for it.
    expect(to[0]?.id).not.toBe(from[0]?.id);
  });

  it('fits a whole group watchlist in one query, either way round', () => {
    const handles = Array.from({ length: XWATCH.capPerGroup }, (_, i) => `hndl${String(i).padStart(9, '0')}`);
    for (const shards of [
      shardHandles(handles, XWATCH.searchQueryMaxChars),
      shardHandles(handles, XWATCH.searchQueryMaxChars, toTerm),
    ]) {
      expect(shards).toHaveLength(1);
      expect(shards[0]?.value.length).toBeLessThanOrEqual(XWATCH.searchQueryMaxChars);
    }
    // ...and a set too big for one query still splits, on both grammars.
    const many = Array.from({ length: 60 }, (_, i) => `h${String(i).padStart(14, '0')}`);
    for (const rule of shardHandles(many, XWATCH.searchQueryMaxChars, toTerm)) {
      expect(rule.value.length).toBeLessThanOrEqual(XWATCH.searchQueryMaxChars);
    }
  });
});

describe('the twitterapi adapter — the three recovery reads', () => {
  const KEY = 'not-a-real-key-0001';
  const requests: string[] = [];
  const sentHeaders: string[] = [];
  const serve = (body: unknown): void => {
    vi.stubGlobal('fetch', async (url: unknown, init?: { headers?: Record<string, string> }) => {
      requests.push(String(url));
      sentHeaders.push(JSON.stringify(init?.headers ?? {}));
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
  };
  afterEach(() => {
    requests.length = 0;
    sentHeaders.length = 0;
    vi.unstubAllGlobals();
  });

  it('asks the to: shard for replies, from the cursor instant', async () => {
    serve({ tweets: [LEGS_REPLY_RAW], has_next_page: false, next_cursor: '' });
    const watcher = createTwitterApiWatcher(KEY);
    // Nothing is asked before the handles are known — an empty shard set is not
    // a query with no terms in it.
    expect(await watcher.pollReplies?.(null)).toEqual({ posts: [], truncated: false });
    expect(requests).toHaveLength(0);

    await watcher.syncRules([HANDLE]);
    const result = await watcher.pollReplies?.('1788000000');
    expect(requests).toHaveLength(1);
    const url = new URL(requests[0] ?? '');
    expect(url.pathname).toBe('/twitter/tweet/advanced_search');
    expect(url.searchParams.get('query')).toBe(`(to:${HANDLE}) since_time:1788000000`);
    expect(url.searchParams.get('queryType')).toBe('Latest');
    expect(result?.posts[0]?.inReplyToId).toBe('2095619171002593725');
  });

  it('asks the from: shard with queryType=Top, one page and no cursor', async () => {
    // The provider says there is another page: Top is ranked rather than
    // chronological, so a second page reaches further DOWN, not further back.
    serve({ tweets: [LEGS_LAUNCH_RAW], has_next_page: true, next_cursor: 'more' });
    const watcher = createTwitterApiWatcher(KEY);
    await watcher.syncRules([HANDLE]);
    const posts = await watcher.pollTop?.(1_788_000_000);
    expect(requests).toHaveLength(1);
    const url = new URL(requests[0] ?? '');
    expect(url.searchParams.get('query')).toBe(`(from:${HANDLE}) since_time:1788000000`);
    expect(url.searchParams.get('queryType')).toBe('Top');
    expect(url.searchParams.has('cursor')).toBe(false);
    expect(posts?.[0]?.id).toBe('2095619171002593725');
  });

  it('reads parents by id in one call, and asks nothing for an empty list', async () => {
    serve({ tweets: [LEGS_LAUNCH_RAW], status: 'success', msg: 'success' });
    const watcher = createTwitterApiWatcher(KEY);
    expect(await watcher.fetchPosts?.([])).toEqual([]);
    expect(await watcher.fetchPosts?.(['  '])).toEqual([]);
    // twitterapi.io bills a minimum per CALL, so a poll with no parent to
    // recover must cost nothing at all.
    expect(requests).toHaveLength(0);

    const posts = await watcher.fetchPosts?.(['2095619171002593725', '2095619171002593725', '77']);
    expect(requests).toHaveLength(1);
    const url = new URL(requests[0] ?? '');
    expect(url.pathname).toBe('/twitter/tweets');
    // De-duplicated, comma-joined, one request.
    expect(url.searchParams.get('tweet_ids')).toBe('2095619171002593725,77');
    expect(posts?.[0]?.authorHandle).toBe(HANDLE);
    expect(posts?.[0]?.text).toContain(CA);
  });

  it('tells "those ids are gone" from "the provider failed"', async () => {
    // The vendor answers its OWN failures with the success envelope minus the
    // payload — the shape resolveHandle has read since round 23. Reading that as
    // "no posts" would let the runner mark the ids seen and drop them forever,
    // while the reply cursor has already advanced past the replies that named
    // them: one garbled 200 in a launch minute loses the post this path exists
    // to recover. A THROW is requeued.
    serve({ status: 'error', msg: 'rate limit' });
    const watcher = createTwitterApiWatcher(KEY);
    await expect(watcher.fetchPosts?.(['77'])).rejects.toThrow(XApiError);
    await watcher.syncRules([HANDLE]);
    await expect(watcher.pollTop?.(1_788_000_000)).rejects.toThrow(XApiError);
    // Status 0: not a refusal, so this requeues and logs rather than backing the
    // whole watcher off (client.ts pauses on 401/403/429 only).
    await watcher.fetchPosts?.(['77']).catch((err: unknown) => {
      expect(shouldPauseXPolling(err)).toBe(false);
    });
  });

  it('brackets a MULTI-HANDLE shard so since_time binds to the whole OR list', async () => {
    // X binds AND tighter than OR, so `to:a OR to:b since_time:N` time-bounds
    // `to:b` ONLY and pulls @a's entire reply history, newest first, every
    // poll. The parenthesised form is also the only one measured against the
    // provider (docs/research-x-monitor.md).
    serve({ tweets: [], has_next_page: false, next_cursor: '' });
    const watcher = createTwitterApiWatcher(KEY);
    await watcher.syncRules([HANDLE, 'gaiadotfinance']);
    await watcher.pollResults('1788000000');
    await watcher.pollReplies?.('1788000000');
    await watcher.pollTop?.(1_788_000_000);
    expect(requests.map((raw) => new URL(raw).searchParams.get('query'))).toEqual([
      `(from:gaiadotfinance OR from:${HANDLE}) since_time:1788000000`,
      `(to:gaiadotfinance OR to:${HANDLE}) since_time:1788000000`,
      `(from:gaiadotfinance OR from:${HANDLE}) since_time:1788000000`,
    ]);
  });

  it('reads an error envelope on the LATEST searches as a failure, not as silence', async () => {
    // The from: read is the one whose CURSOR MOVES: an empty answer takes
    // runner.ts's "nothing came back" branch and jumps the cursor forward to
    // the lookback floor, stepping over exactly the backlog a catch-up poll
    // after a back-off exists to re-read. A throw leaves it where it was.
    serve({ status: 'error', msg: 'rate limit' });
    const watcher = createTwitterApiWatcher(KEY);
    await watcher.syncRules([HANDLE]);
    await expect(watcher.pollResults('1788000000')).rejects.toThrow(XApiError);
    await expect(watcher.pollReplies?.('1788000000')).rejects.toThrow(XApiError);
  });

  it('keeps an EMPTY array as a real answer — a deleted post is gone, not unread', async () => {
    serve({ tweets: [], status: 'success', msg: 'success' });
    const watcher = createTwitterApiWatcher(KEY);
    expect(await watcher.fetchPosts?.(['77'])).toEqual([]);
  });

  it('never puts the key in a URL — it travels in the header', async () => {
    serve({ tweets: [], has_next_page: false });
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const watcher = createTwitterApiWatcher(KEY);
    await watcher.syncRules([HANDLE]);
    await watcher.pollReplies?.(null);
    await watcher.pollTop?.(1_788_000_000);
    await watcher.fetchPosts?.(['77']);
    expect(requests).toHaveLength(3);
    expect(requests.some((url) => url.includes(KEY))).toBe(false);
    expect(sentHeaders.every((headers) => headers.includes(KEY))).toBe(true);
    const printed = [...logged.mock.calls, ...warned.mock.calls].flat().join(' ');
    expect(printed).not.toContain(KEY);
    logged.mockRestore();
    warned.mockRestore();
  });
});
