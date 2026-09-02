import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Context } from 'grammy';
import { is, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { SQL as SQLClass } from 'drizzle-orm/sql/sql';
import {
  calls as callsTable,
  groupMembers,
  groups,
  mentions,
  tokens,
  watches,
  type Db,
} from '@groupie/db';
import {
  MEMBER_DEATH_REASON,
  ROBINHOOD_CHAIN_ID,
  UNNAMED_MEMBER,
  type BoardCard,
} from '@groupie/shared';
import { createBoardRoutes, toCard } from '../src/api/board.js';
import { handleDead, handleUndead } from '../src/bot/bot.js';
import type { ApiEnv, GroupRow } from '../src/api/membership.js';
import { subscribe, type GroupieEvent } from '../src/events.js';
import {
  findGroupCall,
  isMemberDeadCall,
  markCallDead,
  restoreCall,
} from '../src/verdict.js';

/**
 * Round 21's MEMBER VERDICT (docs/decisions.md round 21).
 *
 * The rules cannot see a coin that was dumped without its pool draining, so the
 * group is given the verdict directly — MARK DEAD on the card, `/overseer dead`
 * in the chat — with the same standing binning has: any member, group-wide.
 *
 * What these pin down is what the two surfaces must never disagree about: only
 * a LIVE call can be marked, only a MEMBER death can be restored, the marker's
 * name is stamped at the time, the group's watch slot comes back, and every
 * statement is scoped to the group so a call id from elsewhere is a 404.
 *
 * Harness style is watchlist.test.ts's: the Drizzle builder is faked and the
 * assertions are about the statements that were attempted.
 */

vi.mock('../src/poller/scheduler.js', () => ({ pollTokenNow: vi.fn(async () => undefined) }));

const dialect = new PgDialect();

const GROUP_ID = 1;
const OTHER_GROUP_ID = 2;
const TOKEN_ID = 7;
const CALL_ID = 500;
const USER_ID = 4242;
const SLUG = 'hammertime';
const ADDRESS = '0x00000000000000000000000000000000000000aa';

interface DbCall {
  key: string;
  values?: Record<string, unknown>;
  set?: Record<string, unknown>;
  where?: SQL;
  joinOn: SQL[];
}

type Script = Record<string, unknown[][]>;

function chain(call: DbCall, take: (key: string) => unknown[]) {
  const node: Record<string, unknown> = {
    then: (ok: (rows: unknown[]) => unknown, err: (e: unknown) => unknown) =>
      Promise.resolve()
        .then(() => take(call.key))
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
    'onConflictDoUpdate',
  ]) {
    node[method] = (...args: unknown[]) => {
      if (method === 'values') call.values = args[0] as Record<string, unknown>;
      if (method === 'set') call.set = args[0] as Record<string, unknown>;
      if (method === 'where') call.where = args[0] as SQL;
      if (method === 'innerJoin' || method === 'leftJoin') call.joinOn.push(args[1] as SQL);
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
    if (table === watches) return 'watches';
    if (table === tokens) return 'tokens';
    if (table === callsTable) return 'calls';
    if (table === mentions) return 'mentions';
    if (table === groupMembers) return 'groupMembers';
    if (table === groups) return 'groups';
    return 'unknown';
  };
  const start = (op: string, table: unknown) => {
    const call: DbCall = { key: `${op}:${nameOf(table)}`, joinOn: [] };
    calls.push(call);
    return chain(call, take);
  };
  const tx = {
    insert: (table: unknown) => start('insert', table),
    update: (table: unknown) => start('update', table),
    select: () => ({ from: (table: unknown) => start('select', table) }),
    selectDistinctOn: () => ({ from: (table: unknown) => start('select', table) }),
    execute: () => Promise.resolve([]),
  };
  const db = { ...tx, transaction: <T>(fn: (t: unknown) => Promise<T>) => fn(tx) };
  return { db: db as unknown as Db, calls };
}

const find = (calls: DbCall[], key: string) => calls.filter((c) => c.key === key);
const whereText = (call: DbCall | undefined): string =>
  call?.where ? dialect.sqlToQuery(call.where).sql : '';
const whereParams = (call: DbCall | undefined): unknown[] =>
  call?.where ? (dialect.sqlToQuery(call.where).params as unknown[]) : [];
const setText = (call: DbCall | undefined, key: string): string => {
  const value = call?.set?.[key];
  return is(value, SQLClass) ? dialect.sqlToQuery(value).sql : String(value);
};

/** Collect every event published while `run` executes. */
async function capture<T>(run: () => Promise<T>): Promise<{ result: T; events: GroupieEvent[] }> {
  const events: GroupieEvent[] = [];
  const off = subscribe((event) => events.push(event));
  try {
    return { result: await run(), events };
  } finally {
    off();
  }
}

/** The verdict landed: the guarded UPDATE hit its row. */
const MARKED: Script = { 'update:calls': [[{ id: CALL_ID, tokenId: TOKEN_ID }]] };

beforeEach(() => {
  vi.clearAllMocks();
});

/* --------------------------------------------------------- markCallDead */

describe('markCallDead', () => {
  it('stamps the whole death record in ONE guarded statement', async () => {
    const { db, calls } = makeDb(MARKED);
    expect(await markCallDead(db, GROUP_ID, CALL_ID, '@nelly')).toBe('marked');

    const update = find(calls, 'update:calls')[0];
    expect(update?.set?.status).toBe('died');
    expect(update?.set?.deathReason).toBe(MEMBER_DEATH_REASON);
    expect(update?.set?.deathMarkedBy).toBe('@nelly');
    expect(update?.set?.diedAt).toBeInstanceOf(Date);
    // The freshest cached reading, read from the token's own column — the same
    // convention markTokenDead follows, and unraceable by a stale caller row.
    expect(setText(update, 'mcapAtDeath')).toContain('mcap_usd');
    // Live-only, group-scoped, and both in the WHERE so two members pressing at
    // once cannot double-stamp.
    expect(whereText(update)).toContain('"status" =');
    expect(whereParams(update)).toEqual(expect.arrayContaining([CALL_ID, GROUP_ID, 'active']));
  });

  it('hands the group watch slot back, and only the GROUP’s', async () => {
    const { db, calls } = makeDb(MARKED);
    await markCallDead(db, GROUP_ID, CALL_ID, '@nelly');
    const release = find(calls, 'update:watches')[0];
    expect(release?.set?.active).toBe(false);
    // The token is alive — another group's watch on it is none of our business.
    expect(whereParams(release)).toEqual(expect.arrayContaining([GROUP_ID, TOKEN_ID, true]));
  });

  it('publishes call_marked_dead, group-scoped, so every open board refetches', async () => {
    const { db } = makeDb(MARKED);
    const { events } = await capture(() => markCallDead(db, GROUP_ID, CALL_ID, '@nelly'));
    expect(events).toContainEqual({
      type: 'call_marked_dead',
      tokenId: TOKEN_ID,
      callId: CALL_ID,
      groupId: GROUP_ID,
    });
  });

  it('a member we cannot name is still named as a member, never null', async () => {
    // null on death_marked_by is what tells the board a RULE killed the call.
    const { db, calls } = makeDb(MARKED);
    await markCallDead(db, GROUP_ID, CALL_ID, null);
    expect(find(calls, 'update:calls')[0]?.set?.deathMarkedBy).toBe(UNNAMED_MEMBER);
    const blank = makeDb(MARKED);
    await markCallDead(blank.db, GROUP_ID, CALL_ID, '   ');
    expect(find(blank.calls, 'update:calls')[0]?.set?.deathMarkedBy).toBe(UNNAMED_MEMBER);
  });

  it('a call that is not live is not_live — and writes nothing else', async () => {
    const { db, calls } = makeDb({ 'update:calls': [[]], 'select:calls': [[{ status: 'died' }]] });
    expect(await markCallDead(db, GROUP_ID, CALL_ID, '@nelly')).toBe('not_live');
    expect(find(calls, 'update:watches')).toHaveLength(0);
  });

  it('a call this group does not have is not_found, whatever its id', async () => {
    const { db, calls } = makeDb({ 'update:calls': [[]], 'select:calls': [[]] });
    expect(await markCallDead(db, GROUP_ID, CALL_ID, '@nelly')).toBe('not_found');
    // The existence probe is group-scoped too, so it cannot answer for another
    // group's call id.
    expect(whereParams(find(calls, 'select:calls')[0])).toEqual(
      expect.arrayContaining([CALL_ID, GROUP_ID]),
    );
  });

  it('publishes nothing when it changed nothing', async () => {
    const { db } = makeDb({ 'update:calls': [[]], 'select:calls': [[{ status: 'binned' }]] });
    const { events } = await capture(() => markCallDead(db, GROUP_ID, CALL_ID, '@nelly'));
    expect(events).toEqual([]);
  });
});

/* ----------------------------------------------------------- restoreCall */

describe('restoreCall', () => {
  it('erases the whole verdict, so the call is not quietly exempt for ever', async () => {
    const { db, calls } = makeDb(MARKED);
    expect(await restoreCall(db, GROUP_ID, CALL_ID)).toBe('restored');
    const update = find(calls, 'update:calls')[0];
    expect(update?.set).toEqual({
      status: 'active',
      diedAt: null,
      deathReason: null,
      mcapAtDeath: null,
      deathMarkedBy: null,
    });
  });

  it('only a member death, and only a died call — a bin taken later stands', async () => {
    const { db, calls } = makeDb(MARKED);
    await restoreCall(db, GROUP_ID, CALL_ID);
    expect(whereParams(find(calls, 'update:calls')[0])).toEqual(
      expect.arrayContaining([CALL_ID, GROUP_ID, 'died', MEMBER_DEATH_REASON]),
    );
  });

  it('a rule death is not a member’s to reverse', async () => {
    const { db } = makeDb({
      'update:calls': [[]],
      'select:calls': [[{ id: CALL_ID, status: 'died', deathReason: 'flatline', phase: 'curve' }]],
    });
    expect(await restoreCall(db, GROUP_ID, CALL_ID)).toBe('not_member_death');
  });

  it('refuses when the COIN has died since — there is nothing to restore it to', async () => {
    // Round 21 amendment (d). The verdict is intact; a rule killed the token
    // after it, and a call flipped back to 'active' over a dead token would
    // show as live on every board until the next dead poll swept it up.
    const { db, calls } = makeDb({
      'update:calls': [[]],
      'select:calls': [
        [{ id: CALL_ID, status: 'died', deathReason: MEMBER_DEATH_REASON, phase: 'dead' }],
      ],
    });
    expect(await restoreCall(db, GROUP_ID, CALL_ID)).toBe('token_dead');
    // The one guarded UPDATE matched nothing, and nothing else was attempted:
    // the refusal costs the call its restore and changes no other row.
    expect(find(calls, 'update:calls')).toHaveLength(1);
    expect(find(calls, 'update:tokens')).toHaveLength(0);
    expect(find(calls, 'update:watches')).toHaveLength(0);
  });

  it('carries the live-token requirement INSIDE the guarded statement', async () => {
    const { db, calls } = makeDb(MARKED);
    await restoreCall(db, GROUP_ID, CALL_ID);
    // In the same statement so the poll that kills the token cannot land
    // between the check and the write.
    const where = whereText(find(calls, 'update:calls')[0]);
    expect(where).toContain('exists');
    expect(where).toContain('"phase" <> ');
  });

  it('an unknown call is not_found', async () => {
    const { db } = makeDb({ 'update:calls': [[]], 'select:calls': [[]] });
    expect(await restoreCall(db, GROUP_ID, CALL_ID)).toBe('not_found');
  });

  it('publishes call_restored, group-scoped', async () => {
    const { db } = makeDb(MARKED);
    const { events } = await capture(() => restoreCall(db, GROUP_ID, CALL_ID));
    expect(events).toEqual([
      { type: 'call_restored', tokenId: TOKEN_ID, callId: CALL_ID, groupId: GROUP_ID },
    ]);
  });
});

/* ---------------------------------------------------------- findGroupCall */

describe('findGroupCall (the bot argument)', () => {
  const hit: Script = {
    'select:calls': [
      [
        {
          callId: CALL_ID,
          tokenId: TOKEN_ID,
          address: ADDRESS,
          symbol: 'VLR',
          status: 'active',
          deathReason: null,
        },
      ],
    ],
  };

  it('matches an address exactly, on this chain, in this group', async () => {
    const { db, calls } = makeDb(hit);
    expect((await findGroupCall(db, GROUP_ID, ADDRESS))?.callId).toBe(CALL_ID);
    expect(whereParams(find(calls, 'select:calls')[0])).toEqual(
      expect.arrayContaining([GROUP_ID, ROBINHOOD_CHAIN_ID, ADDRESS]),
    );
  });

  it('matches a symbol case-insensitively, with the chat’s leading $ stripped', async () => {
    const { db, calls } = makeDb(hit);
    expect((await findGroupCall(db, GROUP_ID, '$vlr'))?.symbol).toBe('VLR');
    const where = find(calls, 'select:calls')[0];
    expect(whereText(where)).toContain('lower(');
    expect(whereParams(where)).toContain('vlr');
  });

  it('newest activity wins when a ticker is shared', async () => {
    const { db, calls } = makeDb(hit);
    await findGroupCall(db, GROUP_ID, 'VLR');
    // ORDER BY last_mention_at DESC LIMIT 1 — the coin the member just watched
    // dump is the one they mean.
    expect(find(calls, 'select:calls')).toHaveLength(1);
  });

  it('an empty argument asks the database nothing', async () => {
    const { db, calls } = makeDb(hit);
    expect(await findGroupCall(db, GROUP_ID, '   ')).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});

describe('isMemberDeadCall', () => {
  it('is a died call whose reason is the member verdict, and nothing else', () => {
    expect(isMemberDeadCall({ status: 'died', deathReason: MEMBER_DEATH_REASON })).toBe(true);
    expect(isMemberDeadCall({ status: 'died', deathReason: 'liquidity_floor' })).toBe(false);
    expect(isMemberDeadCall({ status: 'died', deathReason: null })).toBe(false);
    expect(isMemberDeadCall({ status: 'active', deathReason: MEMBER_DEATH_REASON })).toBe(false);
  });
});

/* ---------------------------------------------------------------- routes */

const GROUP: GroupRow = {
  id: GROUP_ID,
  chatId: -1001234567890,
  title: 'hammertime',
  slug: SLUG,
  status: 'active',
  settings: {},
  addedAt: new Date('2026-09-01T00:00:00.000Z'),
};

/** requireMember's job, faked: reaching a route means the gate already passed. */
function testApp(db: Db): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  app.use('/api/g/:slug/*', async (c, next) => {
    c.set('group', GROUP);
    c.set('userId', USER_ID);
    await next();
  });
  app.route('/', createBoardRoutes(db));
  return app;
}

const NAMED: Script = { 'select:groupMembers': [[{ displayName: '@nelly' }]] };

describe('POST /api/g/:slug/calls/:callId/dead', () => {
  it('204s and stamps the SESSION member as the marker', async () => {
    const { db, calls } = makeDb({ ...NAMED, ...MARKED });
    const res = await testApp(db).request(`/api/g/${SLUG}/calls/${CALL_ID}/dead`, {
      method: 'POST',
    });
    expect(res.status).toBe(204);
    expect(find(calls, 'update:calls')[0]?.set?.deathMarkedBy).toBe('@nelly');
    expect(whereParams(find(calls, 'update:calls')[0])).toContain(GROUP_ID);
  });

  it('409s when the call is not live', async () => {
    const { db } = makeDb({ ...NAMED, 'update:calls': [[]], 'select:calls': [[{ status: 'died' }]] });
    const res = await testApp(db).request(`/api/g/${SLUG}/calls/${CALL_ID}/dead`, {
      method: 'POST',
    });
    expect(res.status).toBe(409);
  });

  it('404s for a call another group owns', async () => {
    // Every statement is group-scoped, so another group's call id simply finds
    // nothing — the response cannot become an existence oracle.
    const { db, calls } = makeDb({ ...NAMED, 'update:calls': [[]], 'select:calls': [[]] });
    const res = await testApp(db).request(`/api/g/${SLUG}/calls/${CALL_ID}/dead`, {
      method: 'POST',
    });
    expect(res.status).toBe(404);
    expect(whereParams(find(calls, 'select:calls')[0])).not.toContain(OTHER_GROUP_ID);
  });

  it('404s a path id that is not a positive int4, without touching the database', async () => {
    // A bigger number would reach Postgres, fail int4 coercion and 500.
    const { db, calls } = makeDb(NAMED);
    for (const id of ['9999999999', '0', '-3', 'abc']) {
      const res = await testApp(db).request(`/api/g/${SLUG}/calls/${id}/dead`, { method: 'POST' });
      expect(res.status).toBe(404);
    }
    expect(calls).toHaveLength(0);
  });

  it('falls back to the member’s last mention here when the cache has no name', async () => {
    const { db, calls } = makeDb({
      'select:groupMembers': [[{ displayName: null }]],
      'select:mentions': [[{ userName: '@fromchat' }]],
      ...MARKED,
    });
    const res = await testApp(db).request(`/api/g/${SLUG}/calls/${CALL_ID}/dead`, {
      method: 'POST',
    });
    expect(res.status).toBe(204);
    expect(find(calls, 'update:calls')[0]?.set?.deathMarkedBy).toBe('@fromchat');
  });
});

describe('DELETE /api/g/:slug/calls/:callId/dead', () => {
  it('204s on a member death', async () => {
    const { db } = makeDb(MARKED);
    const res = await testApp(db).request(`/api/g/${SLUG}/calls/${CALL_ID}/dead`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(204);
  });

  it('409s on a rule death — only a member verdict is a member’s to undo', async () => {
    const { db } = makeDb({
      'update:calls': [[]],
      'select:calls': [[{ id: CALL_ID, status: 'died', deathReason: 'flatline', phase: 'curve' }]],
    });
    const res = await testApp(db).request(`/api/g/${SLUG}/calls/${CALL_ID}/dead`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'only a member-marked death can be restored' });
  });

  it('409s with the COIN’s reason when the token has died since', async () => {
    const { db } = makeDb({
      'update:calls': [[]],
      'select:calls': [
        [{ id: CALL_ID, status: 'died', deathReason: MEMBER_DEATH_REASON, phase: 'dead' }],
      ],
    });
    const res = await testApp(db).request(`/api/g/${SLUG}/calls/${CALL_ID}/dead`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'the coin is dead — nothing to restore it to' });
  });

  it('404s for an unknown call and for a junk id', async () => {
    const { db } = makeDb({ 'update:calls': [[]], 'select:calls': [[]] });
    const app = testApp(db);
    expect(
      (await app.request(`/api/g/${SLUG}/calls/${CALL_ID}/dead`, { method: 'DELETE' })).status,
    ).toBe(404);
    expect(
      (await app.request(`/api/g/${SLUG}/calls/9999999999/dead`, { method: 'DELETE' })).status,
    ).toBe(404);
  });
});

/* -------------------------------------------------------- bot commands */

const HIT = (over: Record<string, unknown> = {}) => [
  {
    callId: CALL_ID,
    tokenId: TOKEN_ID,
    address: ADDRESS,
    symbol: 'VLR',
    status: 'active',
    deathReason: null,
    ...over,
  },
];

describe('/overseer dead — the chat half of the verdict', () => {
  const replies: string[] = [];
  const ctx = {
    reply: async (text: string) => void replies.push(text),
    from: { id: USER_ID, is_bot: false, first_name: 'Nelly', username: 'nelly' },
  } as unknown as Context;

  const dead = async (db: Db, args: string[]) => {
    replies.length = 0;
    await handleDead(db, ctx, GROUP, args, USER_ID);
    return replies;
  };

  it('resolves by symbol and answers in one line', async () => {
    const { db, calls } = makeDb({ 'select:calls': [HIT()], ...MARKED });
    expect(await dead(db, ['$vlr'])).toEqual(['VLR marked dead by @nelly.']);
    expect(find(calls, 'update:calls')[0]?.set?.deathReason).toBe(MEMBER_DEATH_REASON);
  });

  it('resolves by contract address too', async () => {
    const { db } = makeDb({ 'select:calls': [HIT()], ...MARKED });
    expect(await dead(db, [ADDRESS])).toEqual(['VLR marked dead by @nelly.']);
  });

  it('stamps the marker with the name the chat just handed us', async () => {
    const { db, calls } = makeDb({ 'select:calls': [HIT()], ...MARKED });
    await dead(db, ['VLR']);
    expect(find(calls, 'update:calls')[0]?.set?.deathMarkedBy).toBe('@nelly');
    // ...and keeps group_members current, the way `/overseer watch` does.
    expect(find(calls, 'insert:groupMembers')[0]?.values?.displayName).toBe('@nelly');
  });

  it('says why not, and says it once', async () => {
    const usage = await dead(makeDb().db, []);
    expect(usage[0]).toContain('Usage:');
    const missing = makeDb({ 'select:calls': [[]] });
    expect(await dead(missing.db, ['NOPE'])).toEqual(['No live call for NOPE.']);
    const dead2 = makeDb({
      'select:calls': [HIT({ status: 'died' }), [{ status: 'died' }]],
      'update:calls': [[]],
    });
    expect(await dead(dead2.db, ['VLR'])).toEqual(['No live call for VLR.']);
  });
});

describe('/overseer undead — the only way back', () => {
  const replies: string[] = [];
  const ctx = {
    reply: async (text: string) => void replies.push(text),
    from: { id: USER_ID, is_bot: false, first_name: 'Nelly', username: 'nelly' },
  } as unknown as Context;

  const undead = async (db: Db, args: string[]) => {
    replies.length = 0;
    await handleUndead(db, ctx, GROUP, args);
    return replies;
  };

  it('restores a member-marked death', async () => {
    const { db, calls } = makeDb({
      'select:calls': [HIT({ status: 'died', deathReason: MEMBER_DEATH_REASON })],
      ...MARKED,
    });
    expect(await undead(db, ['VLR'])).toEqual(['VLR restored.']);
    expect(find(calls, 'update:calls')[0]?.set?.status).toBe('active');
  });

  it('refuses a rule death in the same one line', async () => {
    const { db } = makeDb({
      'select:calls': [
        HIT({ status: 'died', deathReason: 'flatline' }),
        [{ id: CALL_ID, status: 'died', deathReason: 'flatline', phase: 'curve' }],
      ],
      'update:calls': [[]],
    });
    expect(await undead(db, ['VLR'])).toEqual([`VLR isn't a member-marked death.`]);
  });

  it('says the COIN is gone when a rule killed the token after the verdict', async () => {
    const { db } = makeDb({
      'select:calls': [
        HIT({ status: 'died', deathReason: MEMBER_DEATH_REASON }),
        [{ id: CALL_ID, status: 'died', deathReason: MEMBER_DEATH_REASON, phase: 'dead' }],
      ],
      'update:calls': [[]],
    });
    expect(await undead(db, ['VLR'])).toEqual([`VLR's coin has died since — nothing to restore.`]);
  });

  it('says so when the group never called the coin', async () => {
    const { db } = makeDb({ 'select:calls': [[]] });
    expect(await undead(db, ['NOPE'])).toEqual(['No call for NOPE here.']);
  });
});

/* ------------------------------------------------------------------ card */

type CallRow = typeof callsTable.$inferSelect;
type TokenRow = typeof tokens.$inferSelect;
const AT = new Date('2026-09-02T12:00:00.000Z');

function callRow(over: Partial<CallRow> = {}): CallRow {
  return {
    id: CALL_ID,
    groupId: GROUP_ID,
    tokenId: TOKEN_ID,
    callerUserId: USER_ID,
    callerName: '@caller',
    messageId: 10,
    calledAt: AT,
    mcapAtCall: 106_000,
    liquidityAtCall: 19_000,
    peakMcapSinceCall: 400_000,
    peakAt: AT,
    mentionsCount: 1,
    lastMentionAt: AT,
    status: 'active',
    diedAt: null,
    deathReason: null,
    mcapAtDeath: null,
    deathMarkedBy: null,
    binnedBy: null,
    binnedAt: null,
    reviveRequested: false,
    ...over,
  };
}

function tokenRow(over: Partial<TokenRow> = {}): TokenRow {
  return {
    id: TOKEN_ID,
    chainId: ROBINHOOD_CHAIN_ID,
    address: ADDRESS,
    symbol: 'VLR',
    name: 'Valor',
    imageUrl: null,
    socials: null,
    launchpad: null,
    phase: 'graduated',
    poolAddress: null,
    tokenCreatedAt: null,
    graduatedAt: null,
    diedAt: null,
    deathReason: null,
    mcapAtDeath: null,
    revivedAt: null,
    rugHiddenAt: null,
    revivingAt: null,
    priceUsd: null,
    mcapUsd: 46_000,
    liquidityUsd: 19_000,
    vol24Usd: 120,
    txns24: 3,
    flatSince: null,
    flatReadings: 0,
    flatLastAt: null,
    firstSeenAt: AT,
    lastPolledAt: AT,
    lastSnapshotAt: AT,
    ...over,
  };
}

const card = (over: Partial<CallRow> = {}, tokenOver: Partial<TokenRow> = {}): BoardCard =>
  toCard(callRow(over), tokenRow(tokenOver), [], false);

describe('BoardCard carries the round-21 fields', () => {
  it('names the marker on a member verdict', () => {
    const c = card({
      status: 'died',
      diedAt: AT,
      deathReason: MEMBER_DEATH_REASON,
      mcapAtDeath: 46_000,
      deathMarkedBy: '@nelly',
    });
    expect(c.deathMarkedBy).toBe('@nelly');
    expect(c.deathReason).toBe(MEMBER_DEATH_REASON);
    expect(c.mcapAtDeath).toBe(46_000);
  });

  it('leaves deathMarkedBy null for every rule death', () => {
    expect(card({ status: 'died', diedAt: AT, deathReason: 'flatline' }).deathMarkedBy).toBeNull();
    expect(card().deathMarkedBy).toBeNull();
  });

  it('serves the trade count beside the volume, and unknown as null', () => {
    expect(card().txns24).toBe(3);
    expect(card().vol24Usd).toBe(120);
    // Never 0: the card must print "unknown", not claim nothing traded.
    expect(card({}, { txns24: null }).txns24).toBeNull();
  });
});
