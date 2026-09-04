import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Context } from 'grammy';
import { is, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { SQL as SQLClass } from 'drizzle-orm/sql/sql';
import {
  alerts,
  calls as callsTable,
  discoveryEvents,
  groupMembers,
  groups,
  launchCandidates,
  launchMonitors,
  mentions,
  tokens,
  watches,
  type Db,
} from '@groupie/db';
import { XWATCH, type ProjectsResponse } from '@groupie/shared';
import { createUpcomingRoutes } from '../src/api/upcoming.js';
import type { ApiEnv, GroupRow } from '../src/api/membership.js';
import {
  handleGroupieCommand,
  handleSet,
  handleTrack,
  handleTracking,
  handleUntrack,
  xwatchSummary,
} from '../src/bot/bot.js';
import type { Config } from '../src/config.js';
import { subscribe, type GroupieEvent } from '../src/events.js';
import { fireLaunch } from '../src/xwatch/alerts.js';
import {
  XApiError,
  type TweetWatcher,
  type XPollResult,
  type XPost,
} from '../src/xwatch/client.js';
import { findTokenLaunch } from '../src/discovery/scan.js';
import { confirmAddress, type ConfirmedToken } from '../src/xwatch/confirm.js';
import { resolveLaunchClock } from '../src/xwatch/launchClock.js';
import {
  applyProfileRefresh,
  expireMonitors,
  lastCheckAt,
  listCandidates,
  profileRefreshQueue,
  recordPost,
  trackMonitor,
  untrackMonitor,
  type MonitorRow,
} from '../src/xwatch/monitors.js';
import {
  queuePendingConfirmation,
  runPendingConfirmations,
  type CandidateRow,
} from '../src/xwatch/pending.js';
import { startXWatch } from '../src/xwatch/runner.js';
import { scanLaunchCandidates } from '../src/xwatch/tierB.js';

/**
 * The X launch monitor's stateful halves (docs/decisions.md round 23): the caps
 * and the lock behind them, what a fire writes, what the route serves, and what
 * the chat is told.
 *
 * Same scripted-Drizzle style as watchlist.test.ts and discovery.test.ts — the
 * builder is faked and the assertions are about the statements attempted.
 */

/**
 * The chain/market confirmation is the one thing in the runner that would reach
 * the network, so it is the one thing mocked here: the default answer is the
 * silent one ('no_chain'), and a test that wants a launch says so.
 */
vi.mock('../src/xwatch/confirm.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/xwatch/confirm.js')>()),
  confirmAddress: vi.fn(async () => ({ ok: false, reason: 'no_chain' as const })),
}));

/**
 * ...and the PONS launch hunt, for the same reason: it starts with a
 * DexScreener lookup. Mocked to "the chain cannot say" unless a test says
 * otherwise, which is the answer the launch clock must survive.
 */
vi.mock('../src/discovery/scan.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/discovery/scan.js')>()),
  findTokenLaunch: vi.fn(async () => null),
}));

const dialect = new PgDialect();

const GROUP_ID = 2;
const USER_ID = 4242;
const OTHER_USER_ID = 9001;
const SLUG = 'hammertime';
const HANDLE = 'legsdotfun';
const X_USER_ID = '1500000000000000001';
const CA = '0xb2790f5f4d4c1e1a2f0e2b7a9c4d6e8f0a1b260c';
const MESSAGE_ID = 777;
const POST_ID = '1900000000000000001';

interface DbCall {
  key: string;
  values?: unknown;
  set?: Record<string, unknown>;
  where?: SQL;
  orderBy?: unknown[];
  limit?: unknown;
  text?: string;
  params?: unknown[];
}

type Script = Record<string, unknown[][]>;

function chain(call: DbCall, take: (key: string) => unknown[]) {
  const node: Record<string, unknown> = {
    then: (ok: (rows: unknown[]) => unknown, err: (e: unknown) => unknown) =>
      Promise.resolve()
        .then(() => {
          const rows = take(call.key);
          // A scripted Error is a statement that FAILS — the only way to stage a
          // mid-page failure and watch what the cursor does about it.
          if (rows[0] instanceof Error) throw rows[0];
          return rows;
        })
        .then(ok, err),
  };
  for (const method of [
    'values',
    'set',
    'from',
    'where',
    'innerJoin',
    'leftJoin',
    'orderBy',
    'limit',
    'returning',
    'onConflictDoNothing',
    'onConflictDoUpdate',
  ]) {
    node[method] = (...args: unknown[]) => {
      if (method === 'values') call.values = args[0];
      if (method === 'set') call.set = args[0] as Record<string, unknown>;
      if (method === 'where') call.where = args[0] as SQL;
      if (method === 'orderBy') call.orderBy = args;
      if (method === 'limit') call.limit = args[0];
      return node;
    };
  }
  return node;
}

function makeDb(script: Script = {}): { db: Db; calls: DbCall[] } {
  const calls: DbCall[] = [];
  const cursor = new Map<string, number>();
  const take = (key: string): unknown[] => {
    const sets = script[key];
    if (!sets || sets.length === 0) return [];
    const index = Math.min(cursor.get(key) ?? 0, sets.length - 1);
    cursor.set(key, index + 1);
    return sets[index] ?? [];
  };
  const nameOf = (table: unknown): string => {
    if (table === launchMonitors) return 'launchMonitors';
    if (table === launchCandidates) return 'launchCandidates';
    if (table === alerts) return 'alerts';
    if (table === tokens) return 'tokens';
    if (table === watches) return 'watches';
    if (table === groups) return 'groups';
    if (table === groupMembers) return 'groupMembers';
    if (table === mentions) return 'mentions';
    if (table === callsTable) return 'calls';
    if (table === discoveryEvents) return 'discoveryEvents';
    return 'unknown';
  };
  const start = (op: string, table: unknown) => {
    const call: DbCall = { key: `${op}:${nameOf(table)}` };
    calls.push(call);
    return chain(call, take);
  };
  const execute = (statement: unknown) => {
    const rendered = is(statement, SQLClass)
      ? dialect.sqlToQuery(statement)
      : { sql: String(statement), params: [] };
    calls.push({ key: 'execute', text: rendered.sql, params: rendered.params as unknown[] });
    return Promise.resolve(take('execute'));
  };
  const db: Record<string, unknown> = {
    insert: (table: unknown) => start('insert', table),
    update: (table: unknown) => start('update', table),
    delete: (table: unknown) => start('delete', table),
    select: () => ({ from: (table: unknown) => start('select', table) }),
    selectDistinct: () => ({ from: (table: unknown) => start('select', table) }),
    selectDistinctOn: () => ({ from: (table: unknown) => start('select', table) }),
    execute,
    transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise.resolve(fn(db)),
  };
  return { db: db as unknown as Db, calls };
}

const find = (calls: DbCall[], key: string) => calls.filter((c) => c.key === key);
const whereSql = (call: DbCall | undefined): string =>
  call?.where ? dialect.sqlToQuery(call.where).sql : '';
const whereParams = (call: DbCall | undefined): unknown[] =>
  call?.where ? (dialect.sqlToQuery(call.where).params as unknown[]) : [];

/**
 * The post id a statement recorded. recordPost writes `last_tweet_id` through
 * the SAME CASE guard as `last_post_via` — written plainly, an older post
 * recorded after a newer one would desync the two columns and let the next
 * re-read of the newer post restamp its source — so the id arrives as the
 * expression's last bound parameter (the ELSE branch is the column itself).
 * The launch flip and a track's reset still write the column plainly.
 */
const tweetIdOf = (call: DbCall | undefined): unknown => {
  const value = call?.set?.lastTweetId;
  if (value === undefined || value === null || !is(value, SQLClass)) return value;
  const params = dialect.sqlToQuery(value).params as unknown[];
  return params[params.length - 1];
};

async function capture<T>(run: () => Promise<T>): Promise<{ result: T; events: GroupieEvent[] }> {
  const events: GroupieEvent[] = [];
  const off = subscribe((event) => events.push(event));
  try {
    return { result: await run(), events };
  } finally {
    off();
  }
}

/* ------------------------------------------------------------- the fixtures */

function monitorRow(over: Partial<MonitorRow> = {}): MonitorRow {
  return {
    id: 11,
    groupId: GROUP_ID,
    xHandle: HANDLE,
    addedBy: USER_ID,
    addedAt: new Date('2026-09-01T00:00:00.000Z'),
    status: 'active',
    xUserId: X_USER_ID,
    displayName: 'legs',
    avatarUrl: 'https://pbs.example/a.jpg',
    bio: 'soon',
    followers: 1_890,
    followersAtAdd: 1_882,
    accountCreatedAt: new Date('2025-01-06T12:00:00.000Z'),
    note: null,
    addedMessageId: MESSAGE_ID,
    lastCheckedAt: new Date('2026-09-03T11:59:00.000Z'),
    lastPostAt: new Date('2026-09-03T11:50:00.000Z'),
    lastPostVia: 'search',
    lastTweetId: '1899',
    providerRuleId: 'shard:abc',
    launchedAddress: null,
    launchedTokenId: null,
    launchedAt: null,
    launchTweetId: null,
    launchTweetUrl: null,
    launchPinged: false,
    launchedHoldReason: null,
    launchedTokenCreatedAt: null,
    profileRefreshedAt: null,
    expiresAt: new Date('2026-11-01T00:00:00.000Z'),
    ...over,
  } as MonitorRow;
}

const PROFILE = {
  userId: X_USER_ID,
  handle: HANDLE,
  displayName: 'legs',
  avatarUrl: 'https://pbs.example/a.jpg',
  bio: 'soon',
  followers: 1_882,
  accountCreatedAt: new Date('2025-01-06T12:00:00.000Z'),
};

function watcherStub(over: Partial<TweetWatcher> = {}): TweetWatcher {
  return {
    resolveHandle: async () => ({ status: 'ok', profile: PROFILE }) as const,
    syncRules: async () => [],
    pollResults: async () => ({ posts: [], truncated: false }),
    meter: () => ({ total: 0, windowCount: 0 }),
    ...over,
  };
}

/* ------------------------------------------------------------ track / caps */

describe('trackMonitor', () => {
  it('resolves the handle on X BEFORE touching the database', async () => {
    const { db, calls } = makeDb();
    const outcome = await trackMonitor(db, watcherStub({ resolveHandle: async () => ({ status: 'not_found' }) }), {
      groupId: GROUP_ID,
      userId: USER_ID,
      handle: '@ghostaccount',
    });
    expect(outcome).toEqual({ ok: false, reason: 'not_found' });
    expect(calls).toHaveLength(0);
  });

  it('reports a suspended account as suspended, and a provider failure as neither', async () => {
    const suspended = makeDb();
    expect(
      await trackMonitor(suspended.db, watcherStub({ resolveHandle: async () => ({ status: 'suspended' }) }), {
        groupId: GROUP_ID,
        userId: USER_ID,
        handle: HANDLE,
      }),
    ).toEqual({ ok: false, reason: 'suspended' });

    const down = makeDb();
    const outcome = await trackMonitor(
      down.db,
      watcherStub({
        resolveHandle: async () => {
          throw new XApiError(429, 'slow down');
        },
      }),
      { groupId: GROUP_ID, userId: USER_ID, handle: HANDLE },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('provider');
    expect(down.calls).toHaveLength(0);
  });

  it('refuses a handle that is not a handle, without asking X', async () => {
    let asked = false;
    const outcome = await trackMonitor(
      makeDb().db,
      watcherStub({
        resolveHandle: async () => {
          asked = true;
          return { status: 'ok', profile: PROFILE } as const;
        },
      }),
      { groupId: GROUP_ID, userId: USER_ID, handle: 'not a handle' },
    );
    expect(outcome).toEqual({ ok: false, reason: 'invalid' });
    expect(asked).toBe(false);
  });

  it('says the feature is off when no provider is configured', async () => {
    expect(
      await trackMonitor(makeDb().db, null, {
        groupId: GROUP_ID,
        userId: USER_ID,
        handle: HANDLE,
      }),
    ).toEqual({ ok: false, reason: 'disabled' });
  });

  it('takes the per-group advisory lock before it counts anything', async () => {
    const { db, calls } = makeDb({
      'select:launchMonitors': [[], []],
      'insert:launchMonitors': [[monitorRow()]],
    });
    await trackMonitor(db, watcherStub(), {
      groupId: GROUP_ID,
      userId: USER_ID,
      handle: HANDLE,
      messageId: MESSAGE_ID,
    });
    const lock = calls[0];
    expect(lock?.key).toBe('execute');
    expect(lock?.text).toContain('pg_advisory_xact_lock');
    expect(lock?.params).toContain(`xwatch:${GROUP_ID}`);
  });

  it('stores the identity, the follower baseline, the note, the reply target and the expiry', async () => {
    const { db, calls } = makeDb({
      'select:launchMonitors': [[], []],
      'insert:launchMonitors': [[monitorRow()]],
    });
    const before = Date.now();
    const outcome = await trackMonitor(db, watcherStub(), {
      groupId: GROUP_ID,
      userId: USER_ID,
      handle: '@LegsDotFun',
      note: '  presale soon  ',
      messageId: MESSAGE_ID,
    });
    expect(outcome.ok).toBe(true);
    const values = find(calls, 'insert:launchMonitors')[0]?.values as Record<string, unknown>;
    expect(values.xHandle).toBe(HANDLE);
    expect(values.xUserId).toBe(X_USER_ID);
    expect(values.followersAtAdd).toBe(1_882);
    expect(values.followers).toBe(1_882);
    expect(values.note).toBe('presale soon');
    expect(values.addedMessageId).toBe(MESSAGE_ID);
    expect(values.status).toBe('active');
    // The resolve above WAS a refresh: a null here would put this row at the
    // front of the oldest-first rotation and re-read it seconds later.
    expect(values.profileRefreshedAt).toBe(values.addedAt);
    const expiresAt = values.expiresAt as Date;
    const days = (expiresAt.getTime() - before) / 86_400_000;
    expect(days).toBeGreaterThan(XWATCH.expireDays - 1);
    // `before` is read a tick before trackMonitor takes its own clock, so the
    // expiry is sixty days plus however long that tick was: the bound has to
    // carry a second of it, or the assertion fails on whichever run happens to
    // straddle a millisecond.
    expect(days).toBeLessThanOrEqual(XWATCH.expireDays + 1 / 86_400);
  });

  it('refuses a duplicate — and a launched monitor is a duplicate too', async () => {
    for (const status of ['active', 'launched', 'suspended'] as const) {
      const { db, calls } = makeDb({
        'select:launchMonitors': [[monitorRow({ status })]],
      });
      const outcome = await trackMonitor(db, watcherStub(), {
        groupId: GROUP_ID,
        userId: USER_ID,
        handle: HANDLE,
      });
      expect(outcome).toEqual({ ok: false, reason: 'duplicate', status });
      expect(find(calls, 'insert:launchMonitors')).toHaveLength(0);
    }
  });

  it('refuses the member past three slots, and writes nothing', async () => {
    const held = Array.from({ length: XWATCH.capPerMember }, () => ({ addedBy: USER_ID }));
    const { db, calls } = makeDb({ 'select:launchMonitors': [[], held] });
    const outcome = await trackMonitor(db, watcherStub(), {
      groupId: GROUP_ID,
      userId: USER_ID,
      handle: HANDLE,
    });
    expect(outcome).toEqual({ ok: false, reason: 'cap_member', cap: XWATCH.capPerMember });
    expect(find(calls, 'insert:launchMonitors')).toHaveLength(0);
  });

  it('refuses the group past twelve, whoever is asking', async () => {
    const held = Array.from({ length: XWATCH.capPerGroup }, () => ({ addedBy: OTHER_USER_ID }));
    const { db, calls } = makeDb({ 'select:launchMonitors': [[], held] });
    const outcome = await trackMonitor(db, watcherStub(), {
      groupId: GROUP_ID,
      userId: USER_ID,
      handle: HANDLE,
    });
    expect(outcome).toEqual({ ok: false, reason: 'cap_group', cap: XWATCH.capPerGroup });
    expect(find(calls, 'insert:launchMonitors')).toHaveLength(0);
  });

  it('re-uses a removed row and carries NO launch history into the new monitor', async () => {
    const { db, calls } = makeDb({
      'select:launchMonitors': [
        [monitorRow({ status: 'removed', launchedAddress: CA, launchPinged: true })],
        [],
      ],
      'update:launchMonitors': [[monitorRow()]],
    });
    const outcome = await trackMonitor(db, watcherStub(), {
      groupId: GROUP_ID,
      userId: OTHER_USER_ID,
      handle: HANDLE,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.reactivated).toBe(true);
    const set = find(calls, 'update:launchMonitors')[0]?.set ?? {};
    expect(set.status).toBe('active');
    expect(set.addedBy).toBe(OTHER_USER_ID);
    expect(set.launchedAddress).toBeNull();
    expect(set.launchPinged).toBe(false);
    expect(set.lastTweetId).toBeNull();
    // POST HISTORY GOES WITH THE POST. A stale 'replies' on a row that now holds
    // no post at all would print a fact about X's index this monitor has never
    // had evidence for, and would silence the operator's one hidden-account
    // warning for it.
    expect(set.lastPostAt).toBeNull();
    expect(set.lastPostVia).toBeNull();
    // ...but the profile clock is stamped by THIS track's resolve, not cleared.
    expect(set.profileRefreshedAt).toBe(set.addedAt);
    expect(set.profileRefreshedAt).toBeInstanceOf(Date);
    expect(find(calls, 'insert:launchMonitors')).toHaveLength(0);
  });
});

describe('untrackMonitor', () => {
  it('stops one by handle, group-scoped, and only a live one', async () => {
    const { db, calls } = makeDb({ 'update:launchMonitors': [[monitorRow({ status: 'removed' })]] });
    const stopped = await untrackMonitor(db, GROUP_ID, { handle: '@LegsDotFun' });
    expect(stopped?.xHandle).toBe(HANDLE);
    const call = find(calls, 'update:launchMonitors')[0];
    expect(call?.set).toEqual({ status: 'removed' });
    expect(whereSql(call)).toContain('lower');
    expect(whereParams(call)).toContain(GROUP_ID);
    expect(whereParams(call)).toContain(HANDLE);
  });

  it('reports nothing stopped when the row was already gone', async () => {
    const { db } = makeDb({ 'update:launchMonitors': [[]] });
    expect(await untrackMonitor(db, GROUP_ID, { id: 11 })).toBeUndefined();
  });

  it('refuses a target it cannot name', async () => {
    const { db, calls } = makeDb();
    expect(await untrackMonitor(db, GROUP_ID, { handle: 'not a handle' })).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('takes an EXPIRED row off the board too', async () => {
    const { db, calls } = makeDb({ 'update:launchMonitors': [[monitorRow({ status: 'removed' })]] });
    await untrackMonitor(db, GROUP_ID, { id: 11 });
    expect(whereParams(find(calls, 'update:launchMonitors')[0])).toContain('expired');
  });
});

describe('the monitor list clocks', () => {
  it('records a post and pushes the expiry sixty days past it', async () => {
    const { db, calls } = makeDb();
    const at = new Date('2026-09-03T12:00:00.000Z');
    await recordPost(db, 11, { at, id: '1900', via: 'search' });
    const set = find(calls, 'update:launchMonitors')[0]?.set ?? {};
    const expires = dialect.sqlToQuery(set.expiresAt as SQL);
    // greatest(), so an out-of-order page can never pull either clock back.
    expect(expires.sql).toContain('greatest');
    expect(expires.params).toContain(
      new Date(at.getTime() + XWATCH.expireDays * 86_400_000).toISOString(),
    );
  });

  it('stamps the SOURCE only for a strictly newer post, or a different one in the same second', async () => {
    const { db, calls } = makeDb();
    const at = new Date('2026-09-03T12:00:00.000Z');
    await recordPost(db, 11, { at, id: '1900', via: 'replies' });
    const via = dialect.sqlToQuery(
      find(calls, 'update:launchMonitors')[0]?.set?.lastPostVia as SQL,
    );
    // Compared against the OLD row, in the same statement `greatest` guards the
    // clocks in: reply recovery can hand us a post OLDER than the one already
    // recorded, and stamping 'replies' over a newer post's 'search' would call
    // an account hidden on the strength of a read that arrived late.
    expect(via.sql).toContain('case');
    expect(via.sql).toContain('is null');
    // STRICT. The equal case is the SAME post arriving twice by a slower road —
    // the seen set is in-process only, and X's createdAt is second-precision, so
    // after a restart a recovered re-read carries a byte-identical `at`. Only
    // the id clause lets a genuinely second post inside that second through.
    expect(via.sql).not.toContain('<=');
    expect(via.sql).toContain('coalesce');
    expect(via.params).toEqual([at.toISOString(), at.toISOString(), '1900', 'replies']);
  });

  it('guards the tweet id with the SAME rule, so the two columns cannot disagree', async () => {
    const { db, calls } = makeDb();
    const at = new Date('2026-09-03T12:00:00.000Z');
    await recordPost(db, 11, { at, id: '1900', via: 'replies' });
    const set = find(calls, 'update:launchMonitors')[0]?.set ?? {};
    const tweetId = dialect.sqlToQuery(set.lastTweetId as SQL);
    // Written unconditionally, an OLDER post recorded after a newer one (reply
    // recovery walks its sixty-minute window oldest-first) would leave the id
    // pointing at the old post while last_post_at still held the newer one —
    // and the next re-read of the newer post would read "same second, different
    // id" off that desync and restamp the source, which is exactly the wrong
    // "X search hides this account" claim the via guard exists to prevent.
    expect(tweetId.sql).toContain('case');
    expect(tweetId.sql).not.toContain('<=');
    expect(tweetId.params).toEqual([at.toISOString(), at.toISOString(), '1900', '1900']);
    // Byte-for-byte the same condition as the via guard, minus its two payloads.
    const via = dialect.sqlToQuery(set.lastPostVia as SQL);
    const condition = (text: string): string => text.slice(0, text.lastIndexOf('then'));
    expect(condition(tweetId.sql)).toBe(condition(via.sql));
  });

  it('caps candidates PER MONITOR, so one hunted handle cannot crowd the board', async () => {
    const { db, calls } = makeDb({ 'select:launchCandidates': [[]] });
    await listCandidates(db, [11, 12]);
    const query = find(calls, 'select:launchCandidates')[0];
    const text = whereSql(query).toLowerCase();
    // A plain global LIMIT would let one impostor-magnet handle fill the page.
    expect(text).toContain('count(*)');
    expect(text).toContain('coalesce(newer.posted_at, newer.seen_at)');
    expect(whereParams(query)).toContain(XWATCH.candidatesPerMonitor);
  });

  it('reads the stall clock off the monitors still being polled', async () => {
    const { db, calls } = makeDb({ 'select:launchMonitors': [[{ at: null }]] });
    expect(await lastCheckAt(db, GROUP_ID)).toBeNull();
    const params = whereParams(find(calls, 'select:launchMonitors')[0]);
    expect(params).toContain('active');
    expect(params).not.toContain('launched');
  });

  it('refreshes the stalest profiles first, nulls before dates', async () => {
    const { db, calls } = makeDb({ 'select:launchMonitors': [[monitorRow()]] });
    await profileRefreshQueue(db);
    // The ordering IS the query: a rotation that re-read whichever rows the id
    // order puts first would never reach the twelfth handle.
    const query = find(calls, 'select:launchMonitors')[0];
    const order = (query?.orderBy ?? [])
      .map((clause) => (is(clause, SQLClass) ? dialect.sqlToQuery(clause).sql : String(clause)))
      .join(' ');
    expect(order.toLowerCase()).toContain('nulls first');
    expect(query?.limit).toBe(XWATCH.profilesPerPass);
  });
});

/* ------------------------------------------------- pending confirmations */

function candidateRow(over: Partial<CandidateRow> = {}): CandidateRow {
  return {
    id: 7,
    monitorId: 11,
    tokenAddress: CA,
    symbol: null,
    seenAt: new Date('2026-09-03T12:00:05.000Z'),
    kind: 'posted',
    postId: POST_ID,
    postUrl: `https://x.com/${HANDLE}/status/${POST_ID}`,
    postedAt: new Date('2026-09-03T12:00:00.000Z'),
    attempts: 1,
    nextAttemptAt: new Date('2026-09-03T12:00:45.000Z'),
    lastReason: 'unresolved',
    ...over,
  } as CandidateRow;
}

const NOW_MS = Date.UTC(2026, 8, 3, 12, 1, 0);

describe('queuePendingConfirmation', () => {
  it('writes a posted row on the fast rung, upgrading a Tier-B claim in place', async () => {
    const { db, calls } = makeDb();
    await queuePendingConfirmation(db, {
      monitorId: 11,
      address: CA.toUpperCase(),
      post: {
        id: POST_ID,
        url: `https://x.com/${HANDLE}/status/${POST_ID}`,
        createdAt: new Date(NOW_MS),
      },
      reason: 'unresolved',
      nowMs: NOW_MS,
    });
    const values = find(calls, 'insert:launchCandidates')[0]?.values as Record<string, unknown>;
    expect(values.kind).toBe('posted');
    expect(values.tokenAddress).toBe(CA);
    expect(values.lastReason).toBe('unresolved');
    expect((values.nextAttemptAt as Date).getTime()).toBe(NOW_MS + 45_000);
  });
});

describe('runPendingConfirmations', () => {
  const monitorScript = (over: Script = {}): Script => ({
    'select:launchCandidates': [[candidateRow()]],
    'select:launchMonitors': [[monitorRow()]],
    'select:groups': [[{ settings: {}, status: 'active' }]],
    ...over,
  });

  it('reschedules an unknown answer on the next rung and never gives a verdict', async () => {
    const { db, calls } = makeDb(monitorScript());
    const result = await runPendingConfirmations(db, {
      chain: null,
      nowMs: NOW_MS,
      confirm: async () => ({ ok: false, reason: 'unresolved' }) as const,
    });
    expect(result).toEqual({ attempted: 1, fired: 0, stopped: 0 });
    const set = find(calls, 'update:launchCandidates')[0]?.set ?? {};
    expect(set.lastReason).toBe('unresolved');
    expect((set.nextAttemptAt as Date).getTime()).toBe(NOW_MS + 45_000);
  });

  it('stops on a definitive rejection', async () => {
    const { db, calls } = makeDb(monitorScript());
    const result = await runPendingConfirmations(db, {
      chain: null,
      nowMs: NOW_MS,
      confirm: async () => ({ ok: false, reason: 'known_contract' }) as const,
    });
    expect(result.stopped).toBe(1);
    expect(find(calls, 'update:launchCandidates')[0]?.set?.nextAttemptAt).toBeNull();
  });

  it('retries a thrown read rather than reading it as an answer', async () => {
    const { db, calls } = makeDb(monitorScript());
    const result = await runPendingConfirmations(db, {
      chain: null,
      nowMs: NOW_MS,
      confirm: async () => {
        throw new XApiError(500, 'upstream');
      },
    });
    expect(result.stopped).toBe(0);
    const set = find(calls, 'update:launchCandidates')[0]?.set ?? {};
    expect(String(set.lastReason)).toContain('error:');
    expect(set.nextAttemptAt).toBeInstanceOf(Date);
  });

  it('ages a post out at the launch window and asks nobody', async () => {
    let asked = false;
    const old = new Date(NOW_MS - (XWATCH.launchMaxPoolAgeHours + 1) * 3_600_000);
    const { db, calls } = makeDb(
      monitorScript({ 'select:launchCandidates': [[candidateRow({ postedAt: old })]] }),
    );
    const result = await runPendingConfirmations(db, {
      chain: null,
      nowMs: NOW_MS,
      confirm: async () => {
        asked = true;
        return { ok: false, reason: 'unresolved' } as const;
      },
    });
    expect(asked).toBe(false);
    expect(result.stopped).toBe(1);
    const set = find(calls, 'update:launchCandidates')[0]?.set ?? {};
    expect(set.lastReason).toBe('aged_out');
    expect(set.nextAttemptAt).toBeNull();
  });

  it('keeps a no_code row on the ladder long after the fast rung', async () => {
    // Twenty minutes after the post: the old rule called this dead. A deploy
    // that landed late, or a node a block behind, reads exactly like this.
    const { db, calls } = makeDb(
      monitorScript({
        'select:launchCandidates': [
          [candidateRow({ postedAt: new Date(NOW_MS - 20 * 60_000), attempts: 12 })],
        ],
      }),
    );
    const result = await runPendingConfirmations(db, {
      chain: null,
      nowMs: NOW_MS,
      confirm: async () => ({ ok: false, reason: 'no_code' }) as const,
    });
    expect(result).toEqual({ attempted: 1, fired: 0, stopped: 0 });
    const set = find(calls, 'update:launchCandidates')[0]?.set ?? {};
    expect(set.lastReason).toBe('no_code');
    // ...on the slow rung, because the post is past the fast window.
    expect((set.nextAttemptAt as Date).getTime()).toBe(NOW_MS + 300_000);
  });

  it('settles a row whose fire path THREW and still runs the rest of the pass', async () => {
    const { db, calls } = makeDb(
      monitorScript({
        'select:launchCandidates': [[candidateRow(), candidateRow({ id: 8, postId: '1900002' })]],
      }),
    );
    let fires = 0;
    const result = await runPendingConfirmations(db, {
      chain: null,
      nowMs: NOW_MS,
      confirm: async () => ({ ok: true, token: CONFIRMED }) as const,
      fire: async () => {
        fires += 1;
        if (fires === 1) throw new Error('send failed');
        return 'pinged';
      },
    });
    expect(fires).toBe(2);
    // The first row is back on the ladder with the failure named — a launch
    // post is never silenced by a transient failure...
    const settled = find(calls, 'update:launchCandidates')[0]?.set ?? {};
    expect(String(settled.lastReason)).toContain('error:');
    expect(settled.nextAttemptAt).toBeInstanceOf(Date);
    // ...and the SECOND row was still confirmed and dropped.
    expect(result.fired).toBe(1);
    expect(result.attempted).toBe(2);
    expect(find(calls, 'delete:launchCandidates')).toHaveLength(1);
  });

  it('never throws out of the pass, even when the settle itself fails', async () => {
    const { db } = makeDb(
      monitorScript({
        'select:launchMonitors': [[new Error('db down')]],
        'update:launchCandidates': [[new Error('db down')]],
      }),
    );
    await expect(
      runPendingConfirmations(db, { chain: null, nowMs: NOW_MS }),
    ).resolves.toEqual({ attempted: 1, fired: 0, stopped: 0 });
  });

  it('stops a row whose monitor is no longer active', async () => {
    const { db, calls } = makeDb(
      monitorScript({ 'select:launchMonitors': [[monitorRow({ status: 'launched' })]] }),
    );
    const result = await runPendingConfirmations(db, { chain: null, nowMs: NOW_MS });
    expect(result.stopped).toBe(1);
    expect(find(calls, 'update:launchCandidates')[0]?.set?.lastReason).toBe('monitor_inactive');
  });

  it('takes the normal fire path on a confirmation and drops the row', async () => {
    const { db, calls } = makeDb(monitorScript());
    let fired: unknown = null;
    const result = await runPendingConfirmations(db, {
      chain: null,
      nowMs: NOW_MS,
      confirm: async () => ({ ok: true, token: CONFIRMED }) as const,
      fire: async (_db, params) => {
        fired = params;
        return 'pinged';
      },
    });
    expect(result.fired).toBe(1);
    expect(fired).toMatchObject({ settings: { launchPing: true } });
    expect(find(calls, 'delete:launchCandidates')).toHaveLength(1);
  });
});

describe('expireMonitors', () => {
  it('reads expires_at as the single source, cast as a timestamptz', async () => {
    const { db, calls } = makeDb({ 'update:launchMonitors': [[{ id: 11 }]] });
    const now = Date.UTC(2026, 8, 3, 12, 0, 0);
    expect(await expireMonitors(db, now)).toBe(1);
    const call = find(calls, 'update:launchMonitors')[0];
    expect(call?.set).toEqual({ status: 'expired' });
    const sqlText = whereSql(call);
    expect(sqlText).toContain('expires_at');
    expect(sqlText).toContain('::timestamptz');
    const params = whereParams(call);
    expect(params).toContain(new Date(now).toISOString());
    // ...and the fallback clause for a row written before the column existed.
    expect(params).toContain(new Date(now - XWATCH.expireDays * 86_400_000).toISOString());
  });

  it('sweeps renamed and suspended too, so a broken monitor frees its slot', async () => {
    const { db, calls } = makeDb({ 'update:launchMonitors': [[{ id: 11 }]] });
    await expireMonitors(db, Date.UTC(2026, 8, 3, 12, 0, 0));
    const params = whereParams(find(calls, 'update:launchMonitors')[0]);
    expect(params).toContain('active');
    expect(params).toContain('renamed');
    expect(params).toContain('suspended');
    // A launched monitor is finished, not expired.
    expect(params).not.toContain('launched');
  });
});

describe('applyProfileRefresh — a monitor never repoints', () => {
  /** The three columns the refresh reads, as the rotation hands them over. */
  const tracked = { id: 11, xUserId: X_USER_ID, status: 'active' as const, xHandle: HANDLE };

  it('marks a handle that changed hands as renamed, keeping the stored id', async () => {
    const { db, calls } = makeDb({ 'update:launchMonitors': [[]] });
    const verdict = await applyProfileRefresh(
      db,
      tracked,
      { status: 'ok', profile: { ...PROFILE, userId: '999' } },
    );
    expect(verdict).toBe('renamed');
    const set = find(calls, 'update:launchMonitors')[0]?.set ?? {};
    expect(set).toEqual({ status: 'renamed' });
    expect(set.xUserId).toBeUndefined();
  });

  it('calls a handle that stopped resolving RENAMED, never suspended', async () => {
    const { db, calls } = makeDb({ 'update:launchMonitors': [[]] });
    expect(await applyProfileRefresh(db, tracked, { status: 'not_found' })).toBe('renamed');
    expect(find(calls, 'update:launchMonitors')[0]?.set).toEqual({ status: 'renamed' });
  });

  it('says suspended only when the provider does', async () => {
    const { db } = makeDb({ 'update:launchMonitors': [[]] });
    expect(await applyProfileRefresh(db, tracked, { status: 'suspended' })).toBe('suspended');
  });

  it('asks the stored id when the handle went missing, and believes only that', async () => {
    const { db, calls } = makeDb({ 'update:launchMonitors': [[]] });
    // The id answers under THIS VERY HANDLE: the two lookups contradict each
    // other, and a contradiction is not evidence about anybody's account.
    expect(
      await applyProfileRefresh(db, tracked, { status: 'not_found' }, { status: 'ok', profile: PROFILE }),
    ).toBe('ignored');
    expect(calls).toHaveLength(0);

    // The id answers under a DIFFERENT handle: the account renamed itself.
    expect(
      await applyProfileRefresh(
        db,
        tracked,
        { status: 'not_found' },
        { status: 'ok', profile: { ...PROFILE, handle: 'legsdotfun2' } },
      ),
    ).toBe('renamed');
    expect(find(calls, 'update:launchMonitors')[0]?.set).toEqual({ status: 'renamed' });

    // The id is suspended: that word may be used.
    expect(
      await applyProfileRefresh(db, tracked, { status: 'not_found' }, { status: 'suspended' }),
    ).toBe('suspended');

    // No id opinion at all is still a rename — the weaker, honest label.
    expect(await applyProfileRefresh(db, tracked, { status: 'not_found' })).toBe('renamed');
  });

  it('writes nothing when the id lookup itself could not answer', async () => {
    const { db, calls } = makeDb();
    expect(
      await applyProfileRefresh(
        db,
        tracked,
        { status: 'not_found' },
        { status: 'error', detail: 'timeout' },
      ),
    ).toBe('ignored');
    expect(calls).toHaveLength(0);
  });

  it('writes NOTHING when the provider could not answer', async () => {
    const { db, calls } = makeDb();
    expect(
      await applyProfileRefresh(db, tracked, { status: 'error', detail: 'timeout' }),
    ).toBe('ignored');
    expect(calls).toHaveLength(0);
  });

  it('updates the profile when the id still matches', async () => {
    const { db, calls } = makeDb({ 'update:launchMonitors': [[]] });
    expect(
      await applyProfileRefresh(db, tracked, {
        status: 'ok',
        profile: { ...PROFILE, followers: 2_100 },
      }),
    ).toBe('updated');
    const set = find(calls, 'update:launchMonitors')[0]?.set ?? {};
    expect(set.followers).toBe(2_100);
    // The baseline is never re-stamped: the delta since ADD is the curve.
    expect(set.followersAtAdd).toBeUndefined();
  });
});

/* ------------------------------------------------------------- the fire path */

const CONFIRMED: ConfirmedToken = {
  address: CA,
  symbol: 'LEGS',
  poolAddress: '0xpool',
  tokenCreatedAt: new Date('2026-09-03T11:56:00.000Z'),
  clockSource: 'pool',
  mcapUsd: 31_000,
  liquidityUsd: 31_000,
  launchpad: 'pons-v2-dex',
  hijack: false,
};

const POST = {
  id: POST_ID,
  url: `https://x.com/${HANDLE}/status/${POST_ID}`,
  createdAt: new Date('2026-09-03T12:00:00.000Z'),
};

function fireScript(over: Script = {}): Script {
  return {
    'insert:tokens': [[{ id: 55, symbol: null, mcapUsd: null }]],
    'select:watches': [[], [{ n: '0' }]],
    'select:tokens': [[{ mcapUsd: 31_000, phase: 'curve', lastSnapshotAt: new Date() }]],
    'insert:watches': [[{ mcapAtWatch: 31_000 }]],
    'update:launchMonitors': [[{ id: 11 }]],
    'select:discoveryEvents': [[{ pct: 18, wallets: 2 }]],
    'insert:alerts': [[{ id: 3 }]],
    ...over,
  };
}

describe('fireLaunch', () => {
  it('upserts the token, auto-watches it, flips the monitor and pings the chat', async () => {
    const { db, calls } = makeDb(fireScript());
    const { result, events } = await capture(() =>
      fireLaunch(db, {
        monitor: monitorRow(),
        token: CONFIRMED,
        post: POST,
        settings: { launchPing: true },
      }),
    );
    expect(result).toBe('pinged');
    expect(find(calls, 'insert:tokens')).toHaveLength(1);
    expect(find(calls, 'insert:watches')).toHaveLength(1);

    const flip = find(calls, 'update:launchMonitors')[0];
    expect(flip?.set?.status).toBe('launched');
    expect(flip?.set?.launchedAddress).toBe(CA);
    expect(flip?.set?.launchPinged).toBe(true);
    // Guarded, so two passes cannot both announce the same launch.
    expect(whereParams(flip)).toContain('active');

    const alert = find(calls, 'insert:alerts')[0]?.values as Record<string, unknown>;
    expect(alert.type).toBe('x_launch');
    expect(alert.tokenId).toBe(55);
    const details = alert.details as Record<string, unknown>;
    // The two columns the partial unique index dedupes on.
    expect(details.handle).toBe(HANDLE);
    expect(details.address).toBe(CA);
    expect(details.hijack).toBe(false);

    const fired = events.find((e) => e.type === 'alert_fired');
    expect(fired).toMatchObject({
      type: 'alert_fired',
      groupId: GROUP_ID,
      tokenId: 55,
      alertType: 'x_launch',
      // The reply lands on the message that added the monitor.
      replyToMessageId: MESSAGE_ID,
    });
    expect(fired && 'message' in fired ? fired.message : '').toContain('@legsdotfun posted a contract address.');
  });

  it('holds the ping when the token predates the post (the hijack case)', async () => {
    const { db, calls } = makeDb(fireScript());
    const { result, events } = await capture(() =>
      fireLaunch(db, {
        monitor: monitorRow(),
        token: { ...CONFIRMED, hijack: true },
        post: POST,
        settings: { launchPing: true },
      }),
    );
    expect(result).toBe('held');
    const flip = find(calls, 'update:launchMonitors')[0];
    expect(flip?.set?.launchPinged).toBe(false);
    expect(flip?.set?.launchedHoldReason).toBe('hijack');
    expect(find(calls, 'insert:alerts')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'alert_fired')).toHaveLength(0);
    // A held launch takes NO watch slot: nobody asked to be alerted about it.
    expect(find(calls, 'insert:watches')).toHaveLength(0);
  });

  it('records the launch and stays silent when the group muted the ping', async () => {
    const { db, calls } = makeDb(fireScript());
    const { result } = await capture(() =>
      fireLaunch(db, {
        monitor: monitorRow(),
        token: CONFIRMED,
        post: POST,
        settings: { launchPing: false },
      }),
    );
    expect(result).toBe('muted');
    expect(find(calls, 'update:launchMonitors')[0]?.set?.status).toBe('launched');
    expect(find(calls, 'update:launchMonitors')[0]?.set?.launchedHoldReason).toBe('muted');
    expect(find(calls, 'insert:alerts')).toHaveLength(0);
    expect(find(calls, 'insert:watches')).toHaveLength(0);
  });

  it('pings anyway when the adder holds no free watch slot', async () => {
    const { db, calls } = makeDb(
      fireScript({ 'select:watches': [[], [{ n: '3' }]], 'insert:watches': [[]] }),
    );
    const { result } = await capture(() =>
      fireLaunch(db, {
        monitor: monitorRow(),
        token: CONFIRMED,
        post: POST,
        settings: { launchPing: true },
      }),
    );
    expect(result).toBe('pinged');
    expect(find(calls, 'insert:watches')).toHaveLength(0);
    expect(find(calls, 'insert:alerts')).toHaveLength(1);
  });

  it('says nothing when the monitor was no longer active', async () => {
    const { db, calls } = makeDb(fireScript({ 'update:launchMonitors': [[]] }));
    const { result, events } = await capture(() =>
      fireLaunch(db, {
        monitor: monitorRow(),
        token: CONFIRMED,
        post: POST,
        settings: { launchPing: true },
      }),
    );
    expect(result).toBe('inactive');
    // The alert row is written FIRST (it is the dedupe authority), but nothing
    // is published and no slot is taken once the flip finds the monitor gone.
    expect(find(calls, 'insert:alerts')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'alert_fired')).toHaveLength(0);
    expect(find(calls, 'insert:watches')).toHaveLength(0);
  });

  it('treats a lost race on the unique index as already delivered', async () => {
    const { db, calls } = makeDb(fireScript({ 'insert:alerts': [[]] }));
    const { result, events } = await capture(() =>
      fireLaunch(db, {
        monitor: monitorRow(),
        token: CONFIRMED,
        post: POST,
        settings: { launchPing: true },
      }),
    );
    expect(result).toBe('duplicate');
    expect(events.filter((e) => e.type === 'alert_fired')).toHaveLength(0);
    expect(find(calls, 'insert:alerts')).toHaveLength(1);
    // The board must not claim a ping the unique index refused.
    expect(find(calls, 'update:launchMonitors')[0]?.set?.launchPinged).toBe(false);
  });

  it('sends a fresh message when the monitor was added from the board', async () => {
    const { db } = makeDb(fireScript());
    const { events } = await capture(() =>
      fireLaunch(db, {
        monitor: monitorRow({ addedMessageId: null }),
        token: CONFIRMED,
        post: POST,
        settings: { launchPing: true },
      }),
    );
    const fired = events.find((e) => e.type === 'alert_fired');
    expect(fired && 'replyToMessageId' in fired ? fired.replyToMessageId : undefined).toBeNull();
  });
});

/* ------------------------------------------------------------------ routes */

const GROUP: GroupRow = {
  id: GROUP_ID,
  chatId: -1001234567890,
  title: 'hammertime',
  slug: SLUG,
  status: 'active',
  settings: {},
  addedAt: new Date('2026-09-01T00:00:00.000Z'),
};

function testApp(db: Db, xwatch: { running: boolean; watcher: TweetWatcher | null }): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  app.use('/api/g/:slug/*', async (c, next) => {
    c.set('group', GROUP);
    c.set('userId', USER_ID);
    await next();
  });
  app.route('/', createUpcomingRoutes(db, xwatch));
  return app;
}

describe('GET /api/g/:slug/upcoming', () => {
  it('says enabled:false without a watcher, and still serves the group list', async () => {
    const { db } = makeDb({
      'select:launchMonitors': [[monitorRow()], []],
      'select:groupMembers': [[]],
      'select:mentions': [[]],
      'select:launchCandidates': [[]],
    });
    const res = await testApp(db, { running: false, watcher: null }).request(
      `/api/g/${SLUG}/upcoming`,
    );
    const body = (await res.json()) as ProjectsResponse;
    expect(res.status).toBe(200);
    expect(body.enabled).toBe(false);
    expect(body.capPerGroup).toBe(XWATCH.capPerGroup);
    expect(body.capPerMember).toBe(XWATCH.capPerMember);
    expect(body.projects).toHaveLength(1);
  });

  it('serves the project, its adder, its launch and its tier-B candidates', async () => {
    const launched = monitorRow({
      status: 'launched',
      launchedAddress: CA,
      launchedTokenId: 55,
      launchedAt: new Date('2026-09-03T12:00:30.000Z'),
      launchTweetUrl: POST.url,
      launchPinged: true,
    });
    const { db } = makeDb({
      'select:launchMonitors': [[launched], [{ at: new Date('2026-09-03T11:59:00.000Z') }]],
      'select:groupMembers': [[{ userId: USER_ID, displayName: '@caller' }]],
      'select:mentions': [[]],
      'select:launchCandidates': [
        [
          {
            id: 1,
            monitorId: 11,
            tokenAddress: CA.toUpperCase(),
            symbol: null,
            seenAt: new Date('2026-09-03T11:00:00.000Z'),
            kind: 'claims',
            postId: null,
            postUrl: null,
            postedAt: null,
            attempts: 0,
            nextAttemptAt: null,
            lastReason: null,
          },
        ],
      ],
      'select:tokens': [[{ id: 55, symbol: 'LEGS' }]],
      'select:discoveryEvents': [
        [
          {
            address: CA,
            symbol: 'IMPOSTOR',
            mcapUsd: 31_000,
            at: new Date('2026-09-03T11:00:00.000Z'),
          },
        ],
      ],
    });
    const res = await testApp(db, { running: true, watcher: watcherStub() }).request(
      `/api/g/${SLUG}/upcoming`,
    );
    const body = (await res.json()) as ProjectsResponse;
    const project = body.projects[0]!;
    expect(body.enabled).toBe(true);
    expect(project.handle).toBe(HANDLE);
    expect(project.addedByMe).toBe(true);
    expect(project.addedByName).toBe('@caller');
    expect(project.followers).toBe(1_890);
    expect(project.followersAtAdd).toBe(1_882);
    expect(project.launched?.address).toBe(CA);
    expect(project.launched?.symbol).toBe('LEGS');
    expect(project.launched?.pinged).toBe(true);
    expect(project.launched?.links.dexscreener).toContain(CA);
    expect(project.candidates).toHaveLength(1);
    expect(project.candidates[0]?.kind).toBe('claims');
    expect(project.candidates[0]?.address).toBe(CA);
    expect(project.candidates[0]?.symbol).toBe('IMPOSTOR');
    expect(project.candidates[0]?.mcapUsd).toBe(31_000);
  });

  it('serves a PENDING post as a candidate: the post, its time and why it waits', async () => {
    const { db } = makeDb({
      'select:launchMonitors': [[monitorRow()], [{ at: new Date('2026-09-03T11:59:00.000Z') }]],
      'select:groupMembers': [[]],
      'select:mentions': [[]],
      'select:launchCandidates': [
        [
          {
            id: 2,
            monitorId: 11,
            tokenAddress: CA,
            symbol: null,
            seenAt: new Date('2026-09-03T12:01:00.000Z'),
            kind: 'posted',
            postId: POST.id,
            postUrl: POST.url,
            postedAt: POST.createdAt,
            attempts: 3,
            nextAttemptAt: new Date('2026-09-03T12:05:00.000Z'),
            lastReason: 'unresolved',
          },
        ],
      ],
      'select:discoveryEvents': [[]],
    });
    const res = await testApp(db, { running: true, watcher: watcherStub() }).request(
      `/api/g/${SLUG}/upcoming`,
    );
    const body = (await res.json()) as ProjectsResponse;
    const candidate = body.projects[0]?.candidates[0];
    expect(candidate?.kind).toBe('posted');
    // Dated by the POST, not by the row that records it.
    expect(candidate?.at).toBe(POST.createdAt.toISOString());
    expect(candidate?.tweetUrl).toBe(POST.url);
    expect(candidate?.lastReason).toBe('unresolved');
    expect(candidate?.mcapUsd).toBeNull();
  });

  it('counts SLOTS, not rows, and the member share of them', async () => {
    const { db } = makeDb({
      'select:launchMonitors': [
        [
          monitorRow(),
          monitorRow({ id: 12, xHandle: 'someproject', addedBy: OTHER_USER_ID }),
          monitorRow({ id: 13, xHandle: 'gone', status: 'launched' }),
          monitorRow({ id: 14, xHandle: 'quiet', status: 'expired' }),
          monitorRow({ id: 15, xHandle: 'sold', status: 'renamed' }),
        ],
        [],
      ],
      'select:groupMembers': [[]],
      'select:mentions': [[]],
      'select:launchCandidates': [[]],
      'select:tokens': [[]],
      'select:discoveryEvents': [[]],
    });
    const res = await testApp(db, { running: true, watcher: watcherStub() }).request(
      `/api/g/${SLUG}/upcoming`,
    );
    const body = (await res.json()) as ProjectsResponse;
    expect(body.projects).toHaveLength(5);
    // active + active + renamed; launched and expired hold nothing.
    expect(body.slotsUsed).toBe(3);
    expect(body.slotsUsedByMe).toBe(2);
  });

  it('serves the token own clock and why a launch was not pinged', async () => {
    const held = monitorRow({
      status: 'launched',
      launchedAddress: CA,
      launchedTokenId: 55,
      launchedAt: POST.createdAt,
      launchedTokenCreatedAt: new Date('2026-09-03T11:14:00.000Z'),
      launchPinged: false,
      launchedHoldReason: 'hijack',
    });
    const { db } = makeDb({
      'select:launchMonitors': [[held], []],
      'select:groupMembers': [[]],
      'select:mentions': [[]],
      'select:launchCandidates': [[]],
      'select:tokens': [[{ id: 55, symbol: 'LEGS' }]],
      'select:discoveryEvents': [[]],
    });
    const res = await testApp(db, { running: true, watcher: watcherStub() }).request(
      `/api/g/${SLUG}/upcoming`,
    );
    const body = (await res.json()) as ProjectsResponse;
    expect(body.projects[0]?.launched?.at).toBe(POST.createdAt.toISOString());
    expect(body.projects[0]?.launched?.tokenCreatedAt).toBe('2026-09-03T11:14:00.000Z');
    expect(body.projects[0]?.launched?.pinged).toBe(false);
    expect(body.projects[0]?.launched?.heldReason).toBe('hijack');
  });

  it('marks another member project as not mine', async () => {
    const { db } = makeDb({
      'select:launchMonitors': [[monitorRow({ addedBy: OTHER_USER_ID })], []],
      'select:groupMembers': [[]],
      'select:mentions': [[]],
      'select:launchCandidates': [[]],
    });
    const res = await testApp(db, { running: true, watcher: watcherStub() }).request(
      `/api/g/${SLUG}/upcoming`,
    );
    const body = (await res.json()) as ProjectsResponse;
    expect(body.projects[0]?.addedByMe).toBe(false);
    expect(body.projects[0]?.addedByName).toBeNull();
  });
});

describe('POST /api/g/:slug/upcoming', () => {
  const track = async (
    db: Db,
    body: unknown,
    xwatch: { running: boolean; watcher: TweetWatcher | null } = {
      running: true,
      watcher: watcherStub(),
    },
  ) =>
    testApp(db, xwatch).request(`/api/g/${SLUG}/upcoming`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('creates the monitor and answers 201 with the entry', async () => {
    const { db } = makeDb({
      'select:launchMonitors': [[], []],
      'insert:launchMonitors': [[monitorRow({ addedMessageId: null })]],
      'select:groupMembers': [[]],
      'select:mentions': [[]],
    });
    const res = await track(db, { handle: '@LegsDotFun', note: 'presale' });
    expect(res.status).toBe(201);
    const entry = (await res.json()) as { handle: string; candidates: unknown[] };
    expect(entry.handle).toBe(HANDLE);
    expect(entry.candidates).toEqual([]);
  });

  it('404s a handle X does not know, and says a different sentence for a suspended one', async () => {
    const missing = await track(makeDb().db, { handle: '@ghostaccount' }, {
      running: true,
      watcher: watcherStub({ resolveHandle: async () => ({ status: 'not_found' }) }),
    });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: string }).error).toBe('X has no account @ghostaccount');

    const suspended = await track(makeDb().db, { handle: '@ghostaccount' }, {
      running: true,
      watcher: watcherStub({ resolveHandle: async () => ({ status: 'suspended' }) }),
    });
    expect(suspended.status).toBe(404);
    expect(((await suspended.json()) as { error: string }).error).toBe(
      '@ghostaccount is suspended on X',
    );
  });

  it('409s a duplicate and a full cap, echoing the cap', async () => {
    const dup = makeDb({ 'select:launchMonitors': [[monitorRow()]] });
    expect((await track(dup.db, { handle: HANDLE })).status).toBe(409);

    const capped = makeDb({
      'select:launchMonitors': [
        [],
        Array.from({ length: XWATCH.capPerMember }, () => ({ addedBy: USER_ID })),
      ],
    });
    const res = await track(capped.db, { handle: HANDLE });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { cap: number }).cap).toBe(XWATCH.capPerMember);
  });

  it('400s a body with no handle, and 503s when the feature is not configured', async () => {
    expect((await track(makeDb().db, { note: 'x' })).status).toBe(400);
    expect((await track(makeDb().db, { handle: 'x y' })).status).toBe(400);
    const off = await track(makeDb().db, { handle: HANDLE }, { running: false, watcher: null });
    expect(off.status).toBe(503);
  });

  it('503s (never 404s) when X could not be reached', async () => {
    const res = await track(makeDb().db, { handle: HANDLE }, {
      running: true,
      watcher: watcherStub({
        resolveHandle: async () => ({ status: 'error', detail: 'timeout' }),
      }),
    });
    expect(res.status).toBe(503);
  });
});

describe('DELETE /api/g/:slug/upcoming/:id', () => {
  it('204s, group-scoped', async () => {
    const { db, calls } = makeDb({ 'update:launchMonitors': [[monitorRow()]] });
    const res = await testApp(db, { running: true, watcher: watcherStub() }).request(
      `/api/g/${SLUG}/upcoming/11`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(204);
    expect(whereParams(find(calls, 'update:launchMonitors')[0])).toContain(GROUP_ID);
  });

  it('204s for an id this group does not hold — never an existence oracle', async () => {
    const { db } = makeDb({ 'update:launchMonitors': [[]] });
    const res = await testApp(db, { running: true, watcher: watcherStub() }).request(
      `/api/g/${SLUG}/upcoming/12345`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(204);
  });

  it('404s a path id the int4 column could not take', async () => {
    const { db, calls } = makeDb();
    for (const id of ['abc', '0', '9999999999999']) {
      const res = await testApp(db, { running: true, watcher: watcherStub() }).request(
        `/api/g/${SLUG}/upcoming/${id}`,
        { method: 'DELETE' },
      );
      expect(res.status).toBe(404);
    }
    expect(calls).toHaveLength(0);
  });
});

/* --------------------------------------------------------------- bot replies */

const replies: string[] = [];
const ctx = {
  reply: async (text: string) => void replies.push(text),
  message: { message_id: MESSAGE_ID },
  from: { id: USER_ID, is_bot: false, first_name: 'Cal', username: 'caller' },
} as unknown as Context;

const CONFIG = { miniAppUrl: null, webAppUrl: 'https://groupie.example' } as Config;

afterEach(() => {
  replies.length = 0;
});

describe('/overseer track | untrack | tracking', () => {
  it('names the account, its followers and the slots used', async () => {
    const { db } = makeDb({
      'select:launchMonitors': [[], []],
      'insert:launchMonitors': [[monitorRow({ followers: 1_882 })]],
      'insert:groupMembers': [[]],
    });
    await handleTrack(db, ctx, GROUP, ['@LegsDotFun'], USER_ID, {
      enabled: true,
      watcher: watcherStub(),
    });
    expect(replies[0]).toBe('Tracking @legsdotfun (1.9K followers). 1 of 3 slots used.');
  });

  it('carries the chat message id, so the ping replies to the right message', async () => {
    const { db, calls } = makeDb({
      'select:launchMonitors': [[], []],
      'insert:launchMonitors': [[monitorRow()]],
      'insert:groupMembers': [[]],
    });
    await handleTrack(db, ctx, GROUP, [HANDLE], USER_ID, { enabled: true, watcher: watcherStub() });
    const values = find(calls, 'insert:launchMonitors')[0]?.values as Record<string, unknown>;
    expect(values.addedMessageId).toBe(MESSAGE_ID);
  });

  it('says so when the account does not exist, when the cap is full, and when the key is missing', async () => {
    const missing = makeDb();
    await handleTrack(missing.db, ctx, GROUP, ['ghostaccount'], USER_ID, {
      enabled: true,
      watcher: watcherStub({ resolveHandle: async () => ({ status: 'not_found' }) }),
    });
    expect(replies.pop()).toBe('X has no account @ghostaccount.');

    const capped = makeDb({
      'select:launchMonitors': [
        [],
        Array.from({ length: XWATCH.capPerMember }, () => ({ addedBy: USER_ID })),
      ],
    });
    await handleTrack(capped.db, ctx, GROUP, [HANDLE], USER_ID, {
      enabled: true,
      watcher: watcherStub(),
    });
    expect(replies.pop()).toContain('You already track 3 accounts');

    const off = makeDb();
    await handleTrack(off.db, ctx, GROUP, [HANDLE], USER_ID, { enabled: false, watcher: null });
    expect(replies.pop()).toContain('off on this deployment');
    expect(off.calls).toHaveLength(0);
  });

  it('asks for a handle when given none', async () => {
    await handleTrack(makeDb().db, ctx, GROUP, [], USER_ID, {
      enabled: true,
      watcher: watcherStub(),
    });
    expect(replies[0]).toBe('Usage: /overseer track @handle [note]');
  });

  it('untracks, and says so when there was nothing to untrack', async () => {
    const stopped = makeDb({ 'update:launchMonitors': [[monitorRow()]] });
    await handleUntrack(stopped.db, ctx, GROUP, ['@LegsDotFun']);
    expect(replies.pop()).toBe('Stopped tracking @legsdotfun.');

    const nothing = makeDb({ 'update:launchMonitors': [[]] });
    await handleUntrack(nothing.db, ctx, GROUP, ['legsdotfun']);
    expect(replies.pop()).toBe("@legsdotfun wasn't tracked.");
  });

  it('lists one line per monitor: handle, followers, status, adder and age', async () => {
    const { db } = makeDb({
      'select:launchMonitors': [[monitorRow(), monitorRow({ id: 12, xHandle: 'someproject', status: 'launched', followers: null })]],
      'select:groupMembers': [[{ displayName: '@caller' }]],
      'select:mentions': [[]],
    });
    await handleTracking(db, ctx, GROUP, { enabled: true, watcher: watcherStub() });
    const [header, first, second] = replies[0]!.split('\n');
    // Two rows, one slot: the launched monitor is listed and costs nobody one.
    expect(header).toBe(`Tracking 1/${XWATCH.capPerGroup}:`);
    expect(first).toContain('@legsdotfun · 1.9K followers · active · added by @caller · ');
    // An unknown follower count prints no clause at all.
    expect(second).toContain('@someproject · launched · added by @caller · ');
    expect(second).not.toContain('followers');
  });

  it('says the monitor is off in the header when no key is configured', async () => {
    const { db } = makeDb({
      'select:launchMonitors': [[monitorRow()]],
      'select:groupMembers': [[]],
      'select:mentions': [[]],
    });
    await handleTracking(db, ctx, GROUP, { enabled: false, watcher: null });
    expect(replies[0]).toContain('(monitor off — no X key)');
  });

  it('has nothing to say about an empty list, and points at the command', async () => {
    const { db } = makeDb({ 'select:launchMonitors': [[]] });
    await handleTracking(db, ctx, GROUP, { enabled: true, watcher: watcherStub() });
    expect(replies[0]).toContain('/overseer track @handle');
  });
});

describe('/overseer set launchping', () => {
  const patchOf = (call: DbCall | undefined): Record<string, unknown> => {
    const value = call?.set?.settings;
    if (!is(value, SQLClass)) return {};
    const json = (dialect.sqlToQuery(value).params as unknown[]).find(
      (p) => typeof p === 'string' && p.startsWith('{'),
    ) as string | undefined;
    return json ? (JSON.parse(json) as Record<string, unknown>) : {};
  };
  const pathOf = (call: DbCall | undefined): string =>
    is(call?.set?.settings, SQLClass) ? dialect.sqlToQuery(call!.set!.settings as SQL).sql : '';

  it('writes the toggle under settings.xwatch', async () => {
    const { db, calls } = makeDb({ 'update:groups': [[{ settings: { xwatch: { launchPing: false } } }]] });
    await handleSet(db, ctx, GROUP, ['launchping', 'off'], true, {
      enabled: true,
      watcher: watcherStub(),
    });
    const call = find(calls, 'update:groups')[0];
    expect(patchOf(call)).toEqual({ launchPing: false });
    expect(pathOf(call)).toContain("'{xwatch}'");
    expect(replies[0]).toContain('ping off (board only)');
  });

  it('still writes when the feature is off here, and says so', async () => {
    const { db } = makeDb({ 'update:groups': [[{ settings: { xwatch: { launchPing: true } } }]] });
    await handleSet(db, ctx, GROUP, ['launchping', 'on'], true, { enabled: false, watcher: null });
    expect(replies[0]).toContain('The launch monitor is off on this deployment.');
  });

  it('refuses a non-toggle with the usage line', async () => {
    const { db, calls } = makeDb();
    await handleSet(db, ctx, GROUP, ['launchping', 'maybe'], true, {
      enabled: true,
      watcher: watcherStub(),
    });
    expect(replies[0]).toContain('set launchping on|off');
    expect(find(calls, 'update:groups')).toHaveLength(0);
  });
});

describe('/overseer alerts carries the launch-monitor line', () => {
  it('says off when nothing is configured, and the ping state when it is', async () => {
    const off = await capture(async () => {
      await handleGroupieCommand(makeDb().db, CONFIG, ctx, GROUP, 'alerts', USER_ID, false, {
        enabled: false,
        watcher: null,
      });
    });
    expect(off.result).toBeUndefined();
    expect(replies[0]).toContain('Launch monitor: off (not configured)');
    replies.length = 0;

    await handleGroupieCommand(makeDb().db, CONFIG, ctx, GROUP, 'alerts', USER_ID, true, {
      enabled: true,
      watcher: watcherStub(),
    });
    expect(replies[0]).toContain('Launch monitor: ping on');
  });

  it('summarises the caps', () => {
    expect(xwatchSummary({ launchPing: true }, true)).toContain(
      `${XWATCH.capPerGroup} handles per group, ${XWATCH.capPerMember} per member`,
    );
  });

  it('dispatches track/untrack/tracking without consuming a call address', async () => {
    const { db } = makeDb({ 'select:launchMonitors': [[]] });
    const consumed = await handleGroupieCommand(
      db,
      CONFIG,
      ctx,
      GROUP,
      'tracking',
      USER_ID,
      false,
      { enabled: true, watcher: watcherStub() },
    );
    expect(consumed).toBe(false);
  });
});

/* ------------------------------------------------------------------ runner */

describe('startXWatch', () => {
  it('is dormant without a provider: no timers, running false', () => {
    vi.useFakeTimers();
    try {
      const { db, calls } = makeDb();
      const handle = startXWatch(db, null, null);
      expect(handle.running).toBe(false);
      vi.advanceTimersByTime(10 * 60_000);
      expect(calls).toHaveLength(0);
      handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('backs off after a provider refusal instead of polling into a 429', async () => {
    vi.useFakeTimers();
    try {
      let polls = 0;
      const watcher = watcherStub({
        syncRules: async () => [{ id: 'shard:1', value: 'from:legsdotfun', handles: [HANDLE] }],
        pollResults: async () => {
          polls += 1;
          throw new XApiError(429, 'slow down');
        },
      });
      const { db } = makeDb({ 'select:launchMonitors': [[monitorRow()]] });
      const handle = startXWatch(db, watcher, null);
      await vi.advanceTimersByTimeAsync(XWATCH.pollSeconds * 1000 + 10);
      expect(polls).toBe(1);
      // The cadence tick inside the pause is skipped: the pause is two of them.
      await vi.advanceTimersByTimeAsync(XWATCH.pollSeconds * 1000);
      expect(polls).toBe(1);
      // ...and the first tick past it asks again.
      await vi.advanceTimersByTimeAsync(XWATCH.pollSeconds * 1000);
      expect(polls).toBe(2);
      handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('still confirms and fires the pending queue while the provider is paused', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(CLOCK);
    try {
      // The pause is a back-off against X. This queue reads the chain and our
      // own tables, and a launch that confirmed must not wait out a 429.
      vi.mocked(confirmAddress).mockResolvedValueOnce({ ok: true, token: CONFIRMED });
      let polls = 0;
      const watcher = watcherStub({
        syncRules: async (handles) => [{ id: 'shard:1', value: 'from:legsdotfun', handles }],
        pollResults: async () => {
          polls += 1;
          throw new XApiError(429, 'slow down');
        },
      });
      const { db, calls } = makeDb({
        'select:launchMonitors': [[monitorRow()]],
        // Nothing is due on the tick before the poll refuses; the row falls due
        // while the provider is paused.
        'select:launchCandidates': [[], [candidateRow()]],
        'select:groups': [[{ settings: {}, status: 'active' }]],
        ...fireScript(),
      });
      const handle = startXWatch(db, watcher, null);
      // 45s: nothing due. 60s: the poll refuses and pauses for two cadences.
      // 90s: paused — and the queue runs anyway.
      await vi.advanceTimersByTimeAsync(100_000);
      expect(polls).toBe(1);
      expect(find(calls, 'insert:alerts')).toHaveLength(1);
      expect(find(calls, 'delete:launchCandidates')).toHaveLength(1);
      handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stamps a profile refresh that THREW and carries on down the rotation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(CLOCK);
    try {
      const second = monitorRow({ id: 12, xHandle: 'otherproject', xUserId: '2500000000000000002' });
      const asked: string[] = [];
      const watcher = watcherStub({
        syncRules: async (handles) => [{ id: 'shard:1', value: 'from:legsdotfun', handles }],
        resolveHandle: async (handle) => {
          asked.push(handle);
          // One handle the provider will not answer for. It changes no status,
          // and it must not cost the rest of the pass.
          if (handle === HANDLE) throw new XApiError(500, 'upstream');
          return { status: 'ok', profile: { ...PROFILE, userId: second.xUserId ?? '' } };
        },
      });
      const { db, calls } = makeDb({ 'select:launchMonitors': [[monitorRow(), second]] });
      const handle = startXWatch(db, watcher, null);
      await vi.advanceTimersByTimeAsync(XWATCH.refreshProfileMinutes * 60_000 + 60_000);
      expect(asked).toEqual([HANDLE, 'otherproject']);
      // BOTH are stamped: an account nothing can read rotates to the back of
      // the queue instead of holding its front forever.
      const stamps = find(calls, 'update:launchMonitors').filter((c) => c.set?.profileRefreshedAt);
      expect(stamps).toHaveLength(2);
      handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('polls, syncs the rule shards and stamps the check', async () => {
    vi.useFakeTimers();
    try {
      let synced: string[] = [];
      const watcher = watcherStub({
        syncRules: async (handles) => {
          synced = [...handles];
          return [{ id: 'shard:1', value: 'from:legsdotfun', handles }];
        },
      });
      const { db, calls } = makeDb({ 'select:launchMonitors': [[monitorRow()]] });
      const handle = startXWatch(db, watcher, null);
      await vi.advanceTimersByTimeAsync(XWATCH.pollSeconds * 1000 + 10);
      expect(synced).toEqual([HANDLE]);
      const stamped = find(calls, 'update:launchMonitors').find((c) => c.set?.lastCheckedAt);
      expect(stamped?.set?.lastCheckedAt).toBeInstanceOf(Date);
      handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ----------------------------------------------------- the cursor discipline */

const CLOCK = new Date('2026-09-03T12:00:00.000Z');

function xpost(over: Partial<XPost> = {}): XPost {
  return {
    id: POST_ID,
    authorUserId: X_USER_ID,
    authorHandle: HANDLE,
    text: 'soon',
    urls: [],
    createdAt: new Date(CLOCK.getTime() - 60_000),
    isRetweet: false,
    isQuote: false,
    inReplyToId: null,
    inReplyToHandle: null,
    permalink: `https://x.com/${HANDLE}/status/${POST_ID}`,
    ...over,
  };
}

/**
 * One poll cycle with a scripted page, answering with the cursors the runner
 * asked with. `pages` is consumed one poll at a time.
 */
async function pollCycles(
  script: Script,
  pages: XPollResult[],
  polls: number,
): Promise<{ cursors: (string | null)[]; calls: DbCall[] }> {
  vi.useFakeTimers();
  vi.setSystemTime(CLOCK);
  try {
    const cursors: (string | null)[] = [];
    let page = 0;
    const watcher = watcherStub({
      syncRules: async (handles) => [{ id: 'shard:abc', value: 'from:legsdotfun', handles }],
      pollResults: async (cursor) => {
        cursors.push(cursor);
        return pages[Math.min(page++, pages.length - 1)] ?? { posts: [], truncated: false };
      },
    });
    const { db, calls } = makeDb(script);
    const handle = startXWatch(db, watcher, null);
    for (let i = 0; i < polls; i++) {
      await vi.advanceTimersByTimeAsync(XWATCH.pollSeconds * 1000 + 10);
    }
    handle.stop();
    return { cursors, calls };
  } finally {
    vi.useRealTimers();
  }
}

const monitorPage = (over: Script = {}): Script => ({
  'select:launchMonitors': [[monitorRow()]],
  ...over,
});

describe('the poll cursor', () => {
  it('processes oldest-first and resumes one second under the last post', async () => {
    const older = xpost({ id: '1', createdAt: new Date(CLOCK.getTime() - 120_000) });
    const newer = xpost({ id: '2', createdAt: new Date(CLOCK.getTime() - 60_000) });
    const { cursors, calls } = await pollCycles(
      monitorPage(),
      // Served newest-first, the way a search endpoint answers.
      [{ posts: [newer, older], truncated: false }, { posts: [], truncated: false }],
      2,
    );
    expect(cursors[0]).toBeNull();
    expect(cursors[1]).toBe(String(Math.floor(newer.createdAt.getTime() / 1000) - 1));
    // Both posts were recorded, oldest first.
    const recorded = find(calls, 'update:launchMonitors').filter((c) => c.set?.lastTweetId);
    expect(recorded.map(tweetIdOf)).toEqual(['1', '2']);
  });

  it('stops the page on a throw and leaves the cursor at the last post it finished', async () => {
    const first = xpost({ id: '1', createdAt: new Date(CLOCK.getTime() - 180_000) });
    const second = xpost({ id: '2', createdAt: new Date(CLOCK.getTime() - 120_000) });
    const third = xpost({ id: '3', createdAt: new Date(CLOCK.getTime() - 60_000) });
    const { cursors, calls } = await pollCycles(
      monitorPage({
        // setRuleIds, post 1, then post 2 fails.
        'update:launchMonitors': [[], [], [new Error('write failed')], []],
      }),
      [{ posts: [third, second, first], truncated: false }, { posts: [], truncated: false }],
      2,
    );
    expect(cursors[1]).toBe(String(Math.floor(first.createdAt.getTime() / 1000) - 1));
    // The third post was never touched: the page stopped at the failure.
    const recorded = find(calls, 'update:launchMonitors').filter((c) => c.set?.lastTweetId);
    expect(recorded.map(tweetIdOf)).toEqual(['1', '2']);
  });

  it('HOLDS the cursor on a truncated page — the unread stretch is the older one', async () => {
    const older = xpost({ id: '1', createdAt: new Date(CLOCK.getTime() - 120_000) });
    const newer = xpost({ id: '2', createdAt: new Date(CLOCK.getTime() - 60_000) });
    const { cursors } = await pollCycles(
      monitorPage(),
      [
        // A clean page first, so there is a cursor to hold.
        { posts: [older], truncated: false },
        { posts: [newer], truncated: true },
        { posts: [], truncated: false },
      ],
      3,
    );
    const afterClean = cursors[1];
    expect(afterClean).toBe(String(Math.floor(older.createdAt.getTime() / 1000) - 1));
    // The truncated page moved it NOWHERE: everything under `newer` is unread,
    // and the whole window is re-read next poll.
    expect(cursors[2]).toBe(afterClean);
  });

  it('does not advance a truncated page whose posts all failed to parse', async () => {
    const first = xpost({ id: '1', createdAt: new Date(CLOCK.getTime() - 120_000) });
    const { cursors } = await pollCycles(
      monitorPage(),
      [
        { posts: [first], truncated: false },
        // Nothing survived the parse, and there is still more to serve. Held
        // for twelve polls, the cursor falls behind the lookback floor — and
        // the "never rewind" clause must NOT step it forward over the gap.
        { posts: [], truncated: true },
      ],
      13,
    );
    const afterClean = cursors[1];
    expect(afterClean).toBe(String(Math.floor(first.createdAt.getTime() / 1000) - 1));
    expect(Number(afterClean)).toBeLessThan(
      Math.floor((CLOCK.getTime() + 13 * 60_000 - XWATCH.lookbackMinutes * 60_000) / 1000),
    );
    expect(cursors.at(-1)).toBe(afterClean);
  });

  it('never rewinds on an empty poll', async () => {
    const { cursors } = await pollCycles(monitorPage(), [{ posts: [], truncated: false }], 3);
    expect(cursors[0]).toBeNull();
    const second = Number(cursors[1]);
    const third = Number(cursors[2]);
    expect(second).toBeGreaterThan(0);
    // Forward only, and no one-second overlap when nothing was seen.
    expect(third).toBeGreaterThanOrEqual(second);
  });

  it('ignores a post older than the lookback floor, but still steps past it', async () => {
    const ancient = xpost({
      id: '1',
      createdAt: new Date(CLOCK.getTime() - (XWATCH.lookbackMinutes + 5) * 60_000),
    });
    const { cursors, calls } = await pollCycles(
      monitorPage(),
      [{ posts: [ancient], truncated: false }, { posts: [], truncated: false }],
      2,
    );
    expect(find(calls, 'update:launchMonitors').filter((c) => c.set?.lastTweetId)).toHaveLength(0);
    expect(cursors[1]).toBe(String(Math.floor(ancient.createdAt.getTime() / 1000) - 1));
  });

  it('honours a stale cursor after a long back-off instead of clipping to the lookback', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(CLOCK);
    try {
      let mode: 'first' | 'down' | 'backlog' = 'first';
      const first = xpost({ id: '1', createdAt: new Date(CLOCK.getTime() - 30_000) });
      // Posted DURING the outage. By the time the provider answers again it is
      // far outside the ten-minute lookback, and the lookback alone would throw
      // away exactly the backlog this cursor exists to carry.
      const backlog = xpost({ id: '2', createdAt: new Date(CLOCK.getTime() + 10 * 60_000) });
      const watcher = watcherStub({
        syncRules: async (handles) => [{ id: 'shard:abc', value: 'from:legsdotfun', handles }],
        pollResults: async () => {
          if (mode === 'first') {
            mode = 'down';
            return { posts: [first], truncated: false };
          }
          if (mode === 'down') throw new XApiError(429, 'slow down');
          return { posts: [backlog], truncated: false };
        },
      });
      const { db, calls } = makeDb({ 'select:launchMonitors': [[monitorRow()]] });
      const handle = startXWatch(db, watcher, null);
      await vi.advanceTimersByTimeAsync(XWATCH.pollSeconds * 1000 + 10);
      // Forty minutes of 429s: the cursor is held where the first poll left it.
      await vi.advanceTimersByTimeAsync(40 * 60_000);
      mode = 'backlog';
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      const recorded = find(calls, 'update:launchMonitors').filter((c) => c.set?.lastTweetId);
      expect(recorded.map(tweetIdOf)).toEqual(['1', '2']);
      handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a post from before the handle was tracked', async () => {
    const beforeAdd = xpost({
      id: '1',
      // Inside the lookback window, but the monitor was added a minute ago.
      createdAt: new Date(CLOCK.getTime() - 120_000),
    });
    const { calls } = await pollCycles(
      {
        'select:launchMonitors': [
          [monitorRow({ addedAt: new Date(CLOCK.getTime() - 60_000) })],
        ],
      },
      [{ posts: [beforeAdd], truncated: false }],
      1,
    );
    expect(find(calls, 'update:launchMonitors').filter((c) => c.set?.lastTweetId)).toHaveLength(0);
  });
});

/* -------------------------------------------------------- the launch clock */

describe('resolveLaunchClock — earliest evidence wins', () => {
  const POOL_AT = new Date('2026-09-03T12:00:00.000Z');
  const chainStub = (launchSeconds: number | null) =>
    ({
      getBlockNumber: async () => 5_000,
      getBlockTimestamp: async () => launchSeconds,
    }) as unknown as Parameters<typeof resolveLaunchClock>[2]['chain'];

  it('prefers OUR OWN discovery row when it predates the pool', async () => {
    const seen = new Date(POOL_AT.getTime() - 20 * 60_000);
    const { db } = makeDb({ 'select:discoveryEvents': [[{ at: seen.toISOString() }]] });
    const clock = await resolveLaunchClock(CA, POOL_AT, { db, chain: null });
    expect(clock).toEqual({ at: seen, source: 'discovery' });
  });

  it('ignores a discovery row LATER than the pool — that dates a migration', async () => {
    const { db } = makeDb({
      'select:discoveryEvents': [[{ at: new Date(POOL_AT.getTime() + 60_000).toISOString() }]],
    });
    vi.mocked(findTokenLaunch).mockResolvedValueOnce(null);
    const clock = await resolveLaunchClock(CA, POOL_AT, { db, chain: chainStub(null) });
    expect(clock).toEqual({ at: POOL_AT, source: 'pool' });
  });

  it('falls to the PONS launch block when it is earlier than the pool', async () => {
    const launched = new Date(POOL_AT.getTime() - 46 * 60_000);
    const { db } = makeDb({ 'select:discoveryEvents': [[]] });
    vi.mocked(findTokenLaunch).mockResolvedValueOnce({ launchBlock: 4_900, curve: '0xcurve' });
    const clock = await resolveLaunchClock(CA, POOL_AT, {
      db,
      chain: chainStub(Math.floor(launched.getTime() / 1000)),
    });
    expect(clock).toEqual({ at: launched, source: 'chain' });
  });

  it('answers the POOL clock when neither of the two above can say', async () => {
    const { db } = makeDb({ 'select:discoveryEvents': [[]] });
    vi.mocked(findTokenLaunch).mockResolvedValueOnce(null);
    const clock = await resolveLaunchClock(CA, POOL_AT, { db, chain: chainStub(null) });
    expect(clock).toEqual({ at: POOL_AT, source: 'pool' });
  });
});

/* ------------------------------------------------------------------ Tier B */

describe('scanLaunchCandidates', () => {
  const socials = (values: string[]): string => {
    const word = (n: number): string => n.toString(16).padStart(64, '0');
    const head: string[] = [];
    const body: string[] = [];
    let offset = values.length * 32;
    for (const value of values) {
      head.push(word(offset));
      const hex = Buffer.from(value, 'utf8').toString('hex');
      const padded = hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
      body.push(word(value.length) + padded);
      offset += 32 + padded.length / 2;
    }
    return `0x${head.join('')}${body.join('')}`;
  };

  const scanDb = () =>
    makeDb({
      'select:launchMonitors': [[{ id: 11, handle: HANDLE }]],
      'select:discoveryEvents': [[{ address: CA.toUpperCase(), symbol: 'LEGS' }]],
      'insert:launchCandidates': [[{ id: 1 }]],
    });

  it('records a claim when socials() index 0 names a tracked handle', async () => {
    const { db, calls } = scanDb();
    const written = await scanLaunchCandidates(
      db,
      {
        call: async () => socials([`https://x.com/${HANDLE}`, '', '', 'https://legs.fun/', '']),
      } as unknown as Parameters<typeof scanLaunchCandidates>[1],
      Date.now(),
      new Set(),
    );
    expect(written).toBe(1);
    const values = find(calls, 'insert:launchCandidates')[0]?.values as Record<string, unknown>;
    expect(values.kind).toBe('claims');
    expect(values.tokenAddress).toBe(CA);
  });

  it('says nothing about a token whose socials() reverts', async () => {
    const { db, calls } = scanDb();
    const written = await scanLaunchCandidates(
      db,
      { call: async () => null } as unknown as Parameters<typeof scanLaunchCandidates>[1],
      Date.now(),
      new Set(),
    );
    expect(written).toBe(0);
    expect(find(calls, 'insert:launchCandidates')).toHaveLength(0);
  });

  it('asks each address once', async () => {
    const { db } = scanDb();
    let reads = 0;
    const chainStub = {
      call: async () => {
        reads += 1;
        return socials([`https://x.com/${HANDLE}`, '', '', '', '']);
      },
    } as unknown as Parameters<typeof scanLaunchCandidates>[1];
    const seen = new Set<string>();
    await scanLaunchCandidates(db, chainStub, Date.now(), seen);
    await scanLaunchCandidates(db, chainStub, Date.now(), seen);
    expect(reads).toBe(1);
  });

  it('retires an address only after three null answers — a null can be the RPC', async () => {
    // ChainClient.call answers null for a revert AND for a failed read. Retiring
    // on the first would let one blip hide a real claim for good.
    let reads = 0;
    const nullThenClaim = {
      call: async () => {
        reads += 1;
        return reads <= 2 ? null : socials([`https://x.com/${HANDLE}`, '', '', '', '']);
      },
    } as unknown as Parameters<typeof scanLaunchCandidates>[1];
    const seen = new Set<string>();
    const misses = new Map<string, number>();
    expect(await scanLaunchCandidates(scanDb().db, nullThenClaim, Date.now(), seen, misses)).toBe(0);
    expect(await scanLaunchCandidates(scanDb().db, nullThenClaim, Date.now(), seen, misses)).toBe(0);
    // The third read answers, and the claim lands.
    expect(await scanLaunchCandidates(scanDb().db, nullThenClaim, Date.now(), seen, misses)).toBe(1);
    expect(reads).toBe(3);
    // Retired on the CHAIN's own key: "this token has no socials() to read" is
    // not "we know who this coin names", so a DexScreener twitter_url landing
    // hours later is still free for the enrichment pass to answer with.
    expect(seen.has(`chain:${CA.toLowerCase()}`)).toBe(true);
    expect(seen.has(CA.toLowerCase())).toBe(false);
    expect(misses.size).toBe(0);
  });

  it('stops asking about an address that has answered nothing three times', async () => {
    let reads = 0;
    const alwaysNull = {
      call: async () => {
        reads += 1;
        return null;
      },
    } as unknown as Parameters<typeof scanLaunchCandidates>[1];
    const seen = new Set<string>();
    const misses = new Map<string, number>();
    for (let pass = 0; pass < 5; pass++) {
      await scanLaunchCandidates(scanDb().db, alwaysNull, Date.now(), seen, misses);
    }
    expect(reads).toBe(XWATCH.tierBNullReadsToRetire);
    expect(misses.size).toBe(0);
  });
});

/* --------------------------------------------- round 25: the recovery reads */

/**
 * The @legsdotfun case, measured 2026-09-04 with the production key: the
 * account posted its launch (2026-09-03 21:05:19Z, 288 replies) and the from:
 * poll never saw it — `from:legsdotfun` with queryType=Latest returned zero
 * posts for every window and for all time, and last_tweets was empty too —
 * while `to:legsdotfun` returned every reply to that post within seconds.
 *
 * So the runner reads the replies for their PARENT IDS, fetches those parents
 * by id, and puts them through the very same detector. These tests are about
 * that road, and about it never being allowed to damage the from: road.
 */

const LAUNCH_ID = '2095619171002593725';
const REPLY_ID = '2095981212414144517';

/** One poll cycle against a watcher the test built itself. */
async function runPolls(script: Script, watcher: TweetWatcher, polls: number): Promise<DbCall[]> {
  vi.useFakeTimers();
  vi.setSystemTime(CLOCK);
  try {
    const { db, calls } = makeDb(script);
    const handle = startXWatch(db, watcher, null);
    for (let i = 0; i < polls; i++) {
      await vi.advanceTimersByTimeAsync(XWATCH.pollSeconds * 1000 + 10);
    }
    handle.stop();
    return calls;
  } finally {
    vi.useRealTimers();
  }
}

/** A reply BY somebody else TO the tracked account, naming the parent post. */
function replyTo(parentId: string, over: Partial<XPost> = {}): XPost {
  return xpost({
    id: REPLY_ID,
    authorUserId: '9999',
    authorHandle: 'rndrflame',
    text: '@legsdotfun 500M runner, yessir',
    createdAt: new Date(CLOCK.getTime() - 30_000),
    isReply: true,
    inReplyToId: parentId,
    inReplyToUserId: X_USER_ID,
    inReplyToHandle: HANDLE,
    ...over,
  });
}

/** ...and the post it answers: the account's own, carrying the address. */
const launchPost = (over: Partial<XPost> = {}): XPost =>
  xpost({
    id: LAUNCH_ID,
    text: `$LEGS is now live on Robinhood Chain. CA: ${CA}`,
    createdAt: new Date(CLOCK.getTime() - 130_000),
    ...over,
  });

/** The via CASE's bound parameters, as the statement carries them. */
const viaParams = (call: DbCall | undefined): unknown[] =>
  call?.set?.lastPostVia
    ? (dialect.sqlToQuery(call.set.lastPostVia as SQL).params as unknown[])
    : [];

/**
 * The recordPost statements, and only those: the LAUNCH FLIP writes
 * `lastTweetId` too (it is the post that launched), so the source column — which
 * nothing but recordPost touches — is what tells the two apart.
 */
const recordedPosts = (calls: DbCall[]): DbCall[] =>
  find(calls, 'update:launchMonitors').filter((c) => c.set?.lastPostVia !== undefined);

describe('reply recovery — the hidden account', () => {
  it('fetches the parent a reply names and fires the launch off it', async () => {
    vi.mocked(confirmAddress).mockResolvedValueOnce({ ok: true, token: CONFIRMED });
    const asked: string[][] = [];
    const watcher = watcherStub({
      syncRules: async (handles) => [{ id: 'shard:abc', value: 'from:legsdotfun', handles }],
      // The from: search is BLIND to this account — the whole point.
      pollResults: async () => ({ posts: [], truncated: false }),
      pollReplies: async () => ({ posts: [replyTo(LAUNCH_ID)], truncated: false }),
      fetchPosts: async (ids) => {
        asked.push([...ids]);
        return ids.includes(LAUNCH_ID) ? [launchPost()] : [];
      },
    });
    const calls = await runPolls(
      {
        'select:launchMonitors': [[monitorRow({ lastPostVia: 'search' })]],
        'select:groups': [[{ settings: {}, status: 'active' }]],
        ...fireScript(),
      },
      watcher,
      1,
    );
    expect(asked).toEqual([[LAUNCH_ID]]);
    const recorded = recordedPosts(calls);
    expect(recorded.map(tweetIdOf)).toEqual([LAUNCH_ID]);
    // Recorded as what actually found it, so the board and the logs can say the
    // account is only reachable this way.
    expect(viaParams(recorded[0])).toContain('replies');
    // ...and it is judged exactly like a directly observed post: confirmed, and
    // announced.
    expect(find(calls, 'insert:alerts')).toHaveLength(1);
  });

  it('never fetches a parent the from: poll already handled, and leaves it "search"', async () => {
    const asked: string[][] = [];
    const parent = launchPost({ text: 'soon' });
    const watcher = watcherStub({
      syncRules: async (handles) => [{ id: 'shard:abc', value: 'from:legsdotfun', handles }],
      pollResults: async () => ({ posts: [parent], truncated: false }),
      pollReplies: async () => ({ posts: [replyTo(LAUNCH_ID)], truncated: false }),
      fetchPosts: async (ids) => {
        asked.push([...ids]);
        return [parent];
      },
    });
    const calls = await runPolls(monitorPage(), watcher, 1);
    // The id was in the seen set before recovery ran: no id to fetch, and
    // twitterapi.io bills a minimum per call.
    expect(asked).toEqual([]);
    const recorded = recordedPosts(calls);
    expect(recorded).toHaveLength(1);
    expect(viaParams(recorded[0])).toContain('search');
  });

  it('ignores a reply pointing at somebody else post', async () => {
    const asked: string[][] = [];
    const watcher = watcherStub({
      syncRules: async (handles) => [{ id: 'shard:abc', value: 'from:legsdotfun', handles }],
      pollReplies: async () => ({
        // A `to:` shard also matches a reply that merely MENTIONS the handle.
        posts: [replyTo('7777', { inReplyToUserId: '4040', inReplyToHandle: 'someoneelse' })],
        truncated: false,
      }),
      fetchPosts: async (ids) => {
        asked.push([...ids]);
        return [];
      },
    });
    await runPolls(monitorPage(), watcher, 1);
    expect(asked).toEqual([]);
  });

  it('discards a recovered parent older than the recovery window', async () => {
    vi.mocked(confirmAddress).mockClear();
    const watcher = watcherStub({
      syncRules: async (handles) => [{ id: 'shard:abc', value: 'from:legsdotfun', handles }],
      pollReplies: async () => ({ posts: [replyTo(LAUNCH_ID)], truncated: false }),
      fetchPosts: async () => [
        launchPost({
          // A day-old post somebody is still replying to. The recovery floor is
          // an hour: a parent this old is not the launch this poll is hunting.
          createdAt: new Date(CLOCK.getTime() - (XWATCH.parentLookbackMinutes + 1) * 60_000),
        }),
      ],
    });
    const calls = await runPolls(monitorPage(), watcher, 1);
    expect(recordedPosts(calls)).toHaveLength(0);
    expect(vi.mocked(confirmAddress)).not.toHaveBeenCalled();
  });

  it('advances the reply cursor even on a truncated page, and holds the from: cursor', async () => {
    const fromCursors: (string | null)[] = [];
    const replyCursors: (string | null)[] = [];
    const reply = replyTo(LAUNCH_ID);
    const own = xpost({ id: '5', createdAt: new Date(CLOCK.getTime() - 90_000) });
    const watcher = watcherStub({
      syncRules: async (handles) => [{ id: 'shard:abc', value: 'from:legsdotfun', handles }],
      pollResults: async (cursor) => {
        fromCursors.push(cursor);
        return { posts: fromCursors.length === 1 ? [own] : [], truncated: false };
      },
      pollReplies: async (cursor) => {
        replyCursors.push(cursor);
        // Truncated, and it does NOT hold this cursor: any one of a post's
        // replies names the same parent, so re-reading the window buys nothing
        // and holding it would pin one viral thread open forever.
        return { posts: [reply], truncated: true };
      },
      fetchPosts: async () => [launchPost({ text: 'soon' })],
    });
    await runPolls(monitorPage(), watcher, 2);
    expect(replyCursors[0]).toBeNull();
    expect(replyCursors[1]).toBe(String(Math.floor(reply.createdAt.getTime() / 1000) - 1));
    // The from: cursor is the from: poll's own business, untouched by any of it.
    expect(fromCursors[1]).toBe(String(Math.floor(own.createdAt.getTime() / 1000) - 1));
  });

  it('keeps the ids when the fetch fails, and asks for them again next poll', async () => {
    const asked: string[][] = [];
    let attempts = 0;
    let replyPolls = 0;
    const watcher = watcherStub({
      syncRules: async (handles) => [{ id: 'shard:abc', value: 'from:legsdotfun', handles }],
      pollReplies: async () => {
        replyPolls += 1;
        // THE WINDOW REALLY MOVES ON. Re-serving the same reply on poll 2 would
        // let the id be re-derived from scratch, and the test would pass with
        // the pendingParents requeue deleted.
        return { posts: replyPolls === 1 ? [replyTo(LAUNCH_ID)] : [], truncated: false };
      },
      fetchPosts: async (ids) => {
        asked.push([...ids]);
        attempts += 1;
        if (attempts === 1) throw new Error('provider hiccup');
        return [launchPost({ text: 'soon' })];
      },
    });
    const calls = await runPolls(monitorPage(), watcher, 2);
    // The reply window has moved on, so the IDS are the only record that the
    // work is outstanding.
    expect(asked).toEqual([[LAUNCH_ID], [LAUNCH_ID]]);
    expect(recordedPosts(calls).map(tweetIdOf)).toEqual([LAUNCH_ID]);
  });

  it('judges the account own post on the reply page, instead of dropping it', async () => {
    // A `to:` shard returns the tracked account's SELF-REPLIES too (a reply to
    // its own post is a reply "to" the account), and the CA dropped under the
    // announcement is the launch pattern. Reading it only as a pointer to its
    // parent would need a stranger to reply to that exact post.
    vi.mocked(confirmAddress).mockResolvedValueOnce({ ok: true, token: CONFIRMED });
    const asked: string[][] = [];
    const selfReply = xpost({
      id: '2095619171002593999',
      text: `CA: ${CA}`,
      createdAt: new Date(CLOCK.getTime() - 60_000),
      isReply: true,
      inReplyToId: LAUNCH_ID,
      inReplyToUserId: X_USER_ID,
      inReplyToHandle: HANDLE,
    });
    const watcher = watcherStub({
      syncRules: async (handles) => [{ id: 'shard:abc', value: 'from:legsdotfun', handles }],
      // The from: road is blind to this account — the whole point of the round.
      pollResults: async () => ({ posts: [], truncated: false }),
      pollReplies: async () => ({ posts: [selfReply], truncated: false }),
      fetchPosts: async (ids) => {
        asked.push([...ids]);
        // The announcement it answers carries no address at all.
        return [launchPost({ text: 'something big tonight' })];
      },
    });
    const calls = await runPolls(
      {
        'select:launchMonitors': [[monitorRow({ lastPostVia: 'search' })]],
        'select:groups': [[{ settings: {}, status: 'active' }]],
        ...fireScript(),
      },
      watcher,
      1,
    );
    // The parent is still fetched (it is unseen), and the self-reply is what
    // fired: the address was only ever in its text.
    expect(asked).toEqual([[LAUNCH_ID]]);
    expect(recordedPosts(calls).map(tweetIdOf)).toContain(selfReply.id);
    expect(find(calls, 'insert:alerts')).toHaveLength(1);
  });

  it('still sweeps Top on the fifth poll while the reply read is being refused', async () => {
    // The reply read pages hardest, so it is the likeliest to draw a 429 — and a
    // sweep cadence counted behind it would never run once, taking the last road
    // to a hidden account nobody replies to with it.
    const tops: number[] = [];
    const watcher = watcherStub({
      syncRules: async (handles) => [{ id: 'shard:abc', value: 'from:legsdotfun', handles }],
      pollResults: async () => ({ posts: [], truncated: false }),
      pollReplies: async () => {
        throw new XApiError(429, 'slow down');
      },
      fetchPosts: async () => [],
      pollTop: async (since) => {
        tops.push(since);
        return [];
      },
    });
    vi.useFakeTimers();
    vi.setSystemTime(CLOCK);
    try {
      const { db } = makeDb(monitorPage());
      const handle = startXWatch(db, watcher, null);
      // Every poll draws the 429, so each one is followed by a back-off pause;
      // five ANSWERED from: polls is what the sweep counts.
      for (let i = 0; i < 40; i++) {
        await vi.advanceTimersByTimeAsync(XWATCH.pollSeconds * 1000 + 10);
      }
      handle.stop();
    } finally {
      vi.useRealTimers();
    }
    expect(tops.length).toBeGreaterThan(0);
  });

  it('backs the whole watcher off when the reply read is refused', async () => {
    let polls = 0;
    const watcher = watcherStub({
      syncRules: async (handles) => [{ id: 'shard:abc', value: 'from:legsdotfun', handles }],
      pollResults: async () => {
        polls += 1;
        return { posts: [], truncated: false };
      },
      pollReplies: async () => {
        throw new XApiError(429, 'slow down');
      },
      fetchPosts: async () => [],
    });
    vi.useFakeTimers();
    vi.setSystemTime(CLOCK);
    try {
      const { db } = makeDb(monitorPage());
      const handle = startXWatch(db, watcher, null);
      await vi.advanceTimersByTimeAsync(XWATCH.pollSeconds * 1000 + 10);
      expect(polls).toBe(1);
      // A 429 is a 429 whichever read drew it: the pause is two cadences.
      await vi.advanceTimersByTimeAsync(XWATCH.pollSeconds * 1000);
      expect(polls).toBe(1);
      await vi.advanceTimersByTimeAsync(XWATCH.pollSeconds * 1000);
      expect(polls).toBe(2);
      handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the Top sweep', () => {
  it('runs on every fifth poll, records via top, and moves no cursor', async () => {
    const tops: number[] = [];
    const fromCursors: (string | null)[] = [];
    const topPost = xpost({ id: '77', createdAt: new Date(CLOCK.getTime() + 4 * 60_000) });
    const watcher = watcherStub({
      syncRules: async (handles) => [{ id: 'shard:abc', value: 'from:legsdotfun', handles }],
      pollResults: async (cursor) => {
        fromCursors.push(cursor);
        return { posts: [], truncated: false };
      },
      pollTop: async (since) => {
        tops.push(since);
        return [topPost];
      },
    });
    const calls = await runPolls(monitorPage(), watcher, 6);
    // Six polls, one sweep — the fifth.
    expect(tops).toHaveLength(1);
    expect(tops[0]).toBe(
      Math.floor((CLOCK.getTime() + 5 * XWATCH.pollSeconds * 1000) / 1000) -
        XWATCH.topLookbackMinutes * 60,
    );
    const recorded = recordedPosts(calls);
    expect(recorded.map(tweetIdOf)).toEqual(['77']);
    expect(viaParams(recorded[0])).toContain('top');
    // Top is ENGAGEMENT-ranked, so the newest thing it returned says nothing
    // about where the chronological read has got to: the cursor never sees it.
    expect(fromCursors).not.toContain(String(Math.floor(topPost.createdAt.getTime() / 1000) - 1));
  });
});

describe('an adapter with none of the recovery reads', () => {
  it('polls exactly as it did before round 25', async () => {
    const { cursors, calls } = await pollCycles(
      monitorPage(),
      [
        { posts: [xpost()], truncated: false },
        { posts: [], truncated: false },
      ],
      2,
    );
    // The from: road, unchanged: read the monitors, stamp the shard, record the
    // post, stamp the check — and nothing else asked, because nothing else can
    // be asked of an adapter that does not offer it.
    expect(calls.map((c) => c.key)).toEqual([
      // 45s: the housekeeping tick's confirmation queue (it reads our tables,
      // never the provider). Then 60s: the poll.
      'select:launchCandidates',
      'select:launchMonitors',
      'update:launchMonitors',
      'update:launchMonitors',
      'update:launchMonitors',
      // ...and the second poll, which found nothing to record.
      'select:launchCandidates',
      'select:launchMonitors',
      'update:launchMonitors',
    ]);
    expect(cursors[1]).toBe(String(Math.floor(xpost().createdAt.getTime() / 1000) - 1));
  });
});
