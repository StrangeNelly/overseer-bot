import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { is, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { SQL as SQLClass } from 'drizzle-orm/sql/sql';
import { tokens, watches, type Db } from '@groupie/db';
import { WATCH_CAP_PER_MEMBER, watchCapMessage } from '@groupie/shared';
import { createBoardRoutes } from '../src/api/board.js';
import type { ApiEnv, GroupRow } from '../src/api/membership.js';
import { subscribe, type GroupieEvent } from '../src/events.js';
import { activeWatchCount, addWatch, removeWatch } from '../src/watchlist.js';

/**
 * The watch button and `/overseer watch` share one implementation
 * (docs/decisions.md round 15), and its guarantees live in the statements it
 * builds: which rows it counts, what it refuses, and what the conflict clause
 * preserves. So these fake the Drizzle builder — like ingest.test.ts and
 * handoff.test.ts — and assert on the SQL that was attempted.
 */

const dialect = new PgDialect();

const GROUP_ID = 1;
const TOKEN_ID = 7;
const USER_ID = 4242;
const OTHER_USER_ID = 9001;
const SLUG = 'hammertime';

interface DbCall {
  /** `${op}:${table}` — e.g. 'insert:watches'. */
  key: string;
  values?: Record<string, unknown>;
  set?: Record<string, unknown>;
  where?: SQL;
  conflict?: { set?: Record<string, unknown> };
}

/** Result sets for one key, consumed in call order; the last one repeats. */
type Script = Record<string, unknown[][]>;

function renderSql(value: unknown): string {
  return is(value, SQLClass) ? dialect.sqlToQuery(value).sql : String(value);
}

function whereParams(call: DbCall | undefined): unknown[] {
  if (!call?.where) return [];
  return dialect.sqlToQuery(call.where).params as unknown[];
}

function whereText(call: DbCall | undefined): string {
  return call?.where ? dialect.sqlToQuery(call.where).sql : '';
}

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
    'orderBy',
    'limit',
    'returning',
    'onConflictDoNothing',
    'onConflictDoUpdate',
  ]) {
    node[method] = (arg: unknown) => {
      if (method === 'values') call.values = arg as Record<string, unknown>;
      if (method === 'set') call.set = arg as Record<string, unknown>;
      if (method === 'where') call.where = arg as SQL;
      if (method === 'onConflictDoUpdate') call.conflict = arg as { set?: Record<string, unknown> };
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
    return 'unknown';
  };
  const start = (op: string, table: unknown) => {
    const call: DbCall = { key: `${op}:${nameOf(table)}` };
    calls.push(call);
    return chain(call, take);
  };
  const tx = {
    insert: (table: unknown) => start('insert', table),
    update: (table: unknown) => start('update', table),
    select: () => ({ from: (table: unknown) => start('select', table) }),
    execute: (statement: unknown) => {
      calls.push({ key: 'execute', where: statement as SQL });
      return Promise.resolve([]);
    },
  };
  const db = { ...tx, transaction: <T>(fn: (t: unknown) => Promise<T>) => fn(tx) };
  return { db: db as unknown as Db, calls };
}

const find = (calls: DbCall[], key: string) => calls.filter((c) => c.key === key);

/** count(*) comes back from postgres-js as a string — script it as one. */
const count = (n: number): unknown[][] => [[{ n: String(n) }]];

/** The existence probe answers first, the cap count second. */
function watchScript(options: { existing?: { active: boolean }; held: number }): Script {
  return {
    'select:watches': [options.existing ? [options.existing] : [], [{ n: String(options.held) }]],
    'insert:watches': [[]],
  };
}

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

describe('watchCapMessage (docs/decisions.md round 15)', () => {
  it('names the cap and the way out', () => {
    expect(watchCapMessage(3)).toBe('You already have 3 coins on watch — unwatch one first.');
  });

  it('defaults to the shipped cap, so bot and API cannot drift', () => {
    expect(watchCapMessage()).toBe(watchCapMessage(WATCH_CAP_PER_MEMBER));
    expect(WATCH_CAP_PER_MEMBER).toBe(3);
  });
});

describe('activeWatchCount', () => {
  it('counts only this member ACTIVE rows in this group', async () => {
    const { db, calls } = makeDb({ 'select:watches': count(2) });
    expect(await activeWatchCount(db, GROUP_ID, USER_ID)).toBe(2);
    const params = whereParams(find(calls, 'select:watches')[0]);
    expect(params).toContain(GROUP_ID);
    expect(params).toContain(USER_ID);
    expect(params).toContain(true);
  });

  it('reads the driver string count as a number, and an empty answer as zero', async () => {
    const { db } = makeDb({ 'select:watches': count(3) });
    expect(await activeWatchCount(db, GROUP_ID, USER_ID)).toBe(3);
    const empty = makeDb({ 'select:watches': [[]] });
    expect(await activeWatchCount(empty.db, GROUP_ID, USER_ID)).toBe(0);
  });

  it('never reports NaN from a junk count', async () => {
    const { db } = makeDb({ 'select:watches': [[{ n: 'not-a-number' }]] });
    expect(await activeWatchCount(db, GROUP_ID, USER_ID)).toBe(0);
  });
});

describe('addWatch — the per-member cap', () => {
  it('adds the third watch', async () => {
    const { db, calls } = makeDb(watchScript({ held: 2 }));
    const outcome = await addWatch(db, GROUP_ID, TOKEN_ID, USER_ID);
    expect(outcome).toEqual({ ok: true, alreadyActive: false });
    expect(find(calls, 'insert:watches')[0]?.values).toEqual({
      groupId: GROUP_ID,
      tokenId: TOKEN_ID,
      addedBy: USER_ID,
    });
  });

  it('refuses the fourth, and writes NOTHING', async () => {
    const { db, calls } = makeDb(watchScript({ held: WATCH_CAP_PER_MEMBER }));
    const outcome = await addWatch(db, GROUP_ID, TOKEN_ID, USER_ID);
    expect(outcome).toEqual({ ok: false, reason: 'cap', cap: WATCH_CAP_PER_MEMBER });
    expect(find(calls, 'insert:watches')).toHaveLength(0);
  });

  it('refuses above the cap too, not only exactly at it', async () => {
    // Rows predating the cap (or a race that slipped one through) must not
    // leave a member permanently able to add more.
    const { db } = makeDb(watchScript({ held: WATCH_CAP_PER_MEMBER + 2 }));
    expect(await addWatch(db, GROUP_ID, TOKEN_ID, USER_ID)).toEqual({
      ok: false,
      reason: 'cap',
      cap: WATCH_CAP_PER_MEMBER,
    });
  });

  it('honours an explicit cap, so the rule is one number in one place', async () => {
    const { db } = makeDb(watchScript({ held: 1 }));
    expect(await addWatch(db, GROUP_ID, TOKEN_ID, USER_ID, 1)).toEqual({
      ok: false,
      reason: 'cap',
      cap: 1,
    });
  });

  it('re-watching a coin the GROUP already watches is a success, even at cap', async () => {
    // It consumes no slot: round 4's conflict clause leaves credit and clock
    // alone, so refusing here would lie about the state of the board.
    const { db, calls } = makeDb(
      watchScript({ existing: { active: true }, held: WATCH_CAP_PER_MEMBER }),
    );
    expect(await addWatch(db, GROUP_ID, TOKEN_ID, USER_ID)).toEqual({
      ok: true,
      alreadyActive: true,
    });
    expect(find(calls, 'insert:watches')).toHaveLength(0);
    // The existence probe answered; the cap was never asked.
    expect(find(calls, 'select:watches')).toHaveLength(1);
  });

  it('re-activating a STOPPED watch does cost a slot', async () => {
    const { db } = makeDb(
      watchScript({ existing: { active: false }, held: WATCH_CAP_PER_MEMBER }),
    );
    expect(await addWatch(db, GROUP_ID, TOKEN_ID, USER_ID)).toEqual({
      ok: false,
      reason: 'cap',
      cap: WATCH_CAP_PER_MEMBER,
    });
  });

  it('serializes one member inside one group, so the cap cannot be raced', async () => {
    const { db, calls } = makeDb(watchScript({ held: 0 }));
    await addWatch(db, GROUP_ID, TOKEN_ID, USER_ID);
    const lock = find(calls, 'execute')[0];
    expect(lock).toBeDefined();
    const rendered = renderSql(lock?.where);
    expect(rendered).toContain('pg_advisory_xact_lock');
    // The key is (group, member): two different members never wait on each
    // other, and the same member's two clients do.
    expect(dialect.sqlToQuery(lock?.where as SQL).params).toContain(`${GROUP_ID}:${USER_ID}`);
    // ...and it is taken BEFORE anything is read, or it would guard nothing.
    expect(calls[0]?.key).toBe('execute');
  });

  it('probes the exact (group, token) row, not the member', async () => {
    const { db, calls } = makeDb(watchScript({ held: 0 }));
    await addWatch(db, GROUP_ID, TOKEN_ID, USER_ID);
    const params = whereParams(find(calls, 'select:watches')[0]);
    expect(params).toEqual([GROUP_ID, TOKEN_ID]);
  });
});

describe('addWatch — row semantics kept from round 4', () => {
  it('the conflict clause keeps the original credit and clock when active', async () => {
    const { db, calls } = makeDb(watchScript({ held: 0 }));
    await addWatch(db, GROUP_ID, TOKEN_ID, USER_ID);
    const set = find(calls, 'insert:watches')[0]?.conflict?.set ?? {};
    expect(Object.keys(set).sort()).toEqual(['active', 'addedAt', 'addedBy']);
    expect(set.active).toBe(true);
    // SET expressions see the OLD row: only a stopped watch takes new credit.
    expect(renderSql(set.addedBy)).toContain('case when');
    expect(renderSql(set.addedAt)).toContain('case when');
  });

  it('publishes watch_changed for a real add, scoped to the group', async () => {
    // groupId is what lets the SSE layer deliver this only to THIS group's
    // boards — a watch is one group's state, not the token's.
    const { db } = makeDb(watchScript({ held: 0 }));
    const { events } = await capture(() => addWatch(db, GROUP_ID, TOKEN_ID, USER_ID));
    expect(events).toEqual([{ type: 'watch_changed', tokenId: TOKEN_ID, groupId: GROUP_ID }]);
  });

  it('publishes nothing when the watch was already on — nothing changed', async () => {
    const { db } = makeDb(watchScript({ existing: { active: true }, held: 0 }));
    const { events } = await capture(() => addWatch(db, GROUP_ID, TOKEN_ID, USER_ID));
    expect(events).toEqual([]);
  });

  it('publishes nothing when the cap refused it', async () => {
    const { db } = makeDb(watchScript({ held: WATCH_CAP_PER_MEMBER }));
    const { events } = await capture(() => addWatch(db, GROUP_ID, TOKEN_ID, USER_ID));
    expect(events).toEqual([]);
  });
});

describe('removeWatch — any member may stop any watch', () => {
  it('deactivates the row and says it stopped one', async () => {
    const { db, calls } = makeDb({ 'update:watches': [[{ id: 3 }]] });
    expect(await removeWatch(db, GROUP_ID, TOKEN_ID)).toBe(true);
    const update = find(calls, 'update:watches')[0];
    // The row survives as history (round 4): deactivated, never deleted.
    expect(update?.set).toEqual({ active: false });
    expect(whereParams(update)).toEqual([GROUP_ID, TOKEN_ID, true]);
  });

  it('does NOT filter by who added it — the watchlist is the group s', async () => {
    const { db, calls } = makeDb({ 'update:watches': [[{ id: 3 }]] });
    await removeWatch(db, GROUP_ID, TOKEN_ID);
    expect(whereParams(find(calls, 'update:watches')[0])).not.toContain(OTHER_USER_ID);
    expect(whereText(find(calls, 'update:watches')[0])).not.toContain('added_by');
  });

  it('is a no-op on a coin nobody is watching, and publishes nothing', async () => {
    const { db } = makeDb({ 'update:watches': [[]] });
    const { result, events } = await capture(() => removeWatch(db, GROUP_ID, TOKEN_ID));
    expect(result).toBe(false);
    expect(events).toEqual([]);
  });

  it('publishes watch_changed when it really stopped one, scoped to the group', async () => {
    const { db } = makeDb({ 'update:watches': [[{ id: 3 }]] });
    const { events } = await capture(() => removeWatch(db, GROUP_ID, TOKEN_ID));
    expect(events).toEqual([{ type: 'watch_changed', tokenId: TOKEN_ID, groupId: GROUP_ID }]);
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

const KNOWN_TOKEN = [[{ id: TOKEN_ID, address: '0xabc', symbol: 'TKN' }]];

describe('POST /api/g/:slug/tokens/:tokenId/watch', () => {
  it('204s and records the session member as the adder', async () => {
    const { db, calls } = makeDb({ ...watchScript({ held: 0 }), 'select:tokens': KNOWN_TOKEN });
    const res = await testApp(db).request(`/api/g/${SLUG}/tokens/${TOKEN_ID}/watch`, {
      method: 'POST',
    });
    expect(res.status).toBe(204);
    expect(find(calls, 'insert:watches')[0]?.values?.addedBy).toBe(USER_ID);
  });

  it('409s over cap with the same sentence the bot sends', async () => {
    const { db } = makeDb({
      ...watchScript({ held: WATCH_CAP_PER_MEMBER }),
      'select:tokens': KNOWN_TOKEN,
    });
    const res = await testApp(db).request(`/api/g/${SLUG}/tokens/${TOKEN_ID}/watch`, {
      method: 'POST',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: watchCapMessage(WATCH_CAP_PER_MEMBER),
      cap: WATCH_CAP_PER_MEMBER,
    });
  });

  it('404s an unknown token without touching watches', async () => {
    const { db, calls } = makeDb({ 'select:tokens': [[]] });
    const res = await testApp(db).request(`/api/g/${SLUG}/tokens/${TOKEN_ID}/watch`, {
      method: 'POST',
    });
    expect(res.status).toBe(404);
    expect(find(calls, 'insert:watches')).toHaveLength(0);
  });

  it('scopes the token lookup to the group, so foreign ids are not an oracle', async () => {
    // A token another group called must answer exactly like one that does not
    // exist — otherwise 404-vs-204 walks the global id space (round 15 review).
    const { db, calls } = makeDb({ ...watchScript({ held: 0 }), 'select:tokens': KNOWN_TOKEN });
    await testApp(db).request(`/api/g/${SLUG}/tokens/${TOKEN_ID}/watch`, { method: 'POST' });
    const lookup = find(calls, 'select:tokens')[0];
    expect(whereText(lookup)).toContain('exists');
    expect(whereParams(lookup)).toContain(GROUP_ID);
  });

  it('404s a junk token id before any query at all', async () => {
    // '3000000000' is a well-formed number past int4 — letting it through
    // would be a driver range error (a 500), not a not-found.
    for (const raw of ['abc', '-1', '0', '1.5', '3000000000']) {
      const { db, calls } = makeDb();
      const res = await testApp(db).request(`/api/g/${SLUG}/tokens/${raw}/watch`, {
        method: 'POST',
      });
      expect(res.status).toBe(404);
      expect(calls).toHaveLength(0);
    }
  });
});

describe('DELETE /api/g/:slug/tokens/:tokenId/watch', () => {
  it('204s and stops the group s watch', async () => {
    const { db, calls } = makeDb({ 'update:watches': [[{ id: 3 }]] });
    const res = await testApp(db).request(`/api/g/${SLUG}/tokens/${TOKEN_ID}/watch`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(204);
    expect(find(calls, 'update:watches')[0]?.set).toEqual({ active: false });
  });

  it('204s when nothing was watched — unwatching is idempotent', async () => {
    const { db } = makeDb({ 'update:watches': [[]] });
    const res = await testApp(db).request(`/api/g/${SLUG}/tokens/${TOKEN_ID}/watch`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(204);
  });

  it('404s a junk token id, out-of-int4-range included', async () => {
    for (const raw of ['nope', '3000000000']) {
      const { db, calls } = makeDb();
      const res = await testApp(db).request(`/api/g/${SLUG}/tokens/${raw}/watch`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(404);
      expect(calls).toHaveLength(0);
    }
  });
});
