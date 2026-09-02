import { describe, expect, it } from 'vitest';
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
  sleeperEntries,
  sleeperSeen,
  tokens,
  watches,
  type Db,
} from '@groupie/db';
import {
  ALERT_DEFAULTS,
  ROBINHOOD_CHAIN_ID,
  WATCH_CAP_PER_MEMBER,
  tradingLinks,
  watchCapMessage,
  type BoardResponse,
  type SleepersResponse,
} from '@groupie/shared';
import { createBoardRoutes, parseAddress } from '../src/api/board.js';
import { alertsSummary, handleSet, handleWatch } from '../src/bot/bot.js';
import { createSleeperRoutes } from '../src/api/sleepers.js';
import type { ApiEnv, GroupRow } from '../src/api/membership.js';
import { subscribe, type GroupieEvent } from '../src/events.js';
import { activeWatchCount, addWatch, removeWatch } from '../src/watchlist.js';
import { backfillBaselines } from '../src/poller/alerts.js';

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
  orderBy?: unknown;
  conflict?: { set?: Record<string, unknown> };
  /** ON conditions, in join order — the predicates a join carries are guarantees too. */
  joinOn: SQL[];
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

/** The nth join's ON clause, in the order the query declared its joins. */
function joinText(call: DbCall | undefined, index: number): string {
  const on = call?.joinOn[index];
  return on ? dialect.sqlToQuery(on).sql : '';
}

function joinParams(call: DbCall | undefined, index: number): unknown[] {
  const on = call?.joinOn[index];
  return on ? (dialect.sqlToQuery(on).params as unknown[]) : [];
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
    'innerJoin',
    'leftJoin',
    'orderBy',
    'limit',
    'returning',
    'onConflictDoNothing',
    'onConflictDoUpdate',
  ]) {
    node[method] = (...args: unknown[]) => {
      const arg = args[0];
      if (method === 'values') call.values = arg as Record<string, unknown>;
      if (method === 'set') call.set = arg as Record<string, unknown>;
      if (method === 'where') call.where = arg as SQL;
      if (method === 'orderBy') call.orderBy = arg;
      if (method === 'onConflictDoUpdate') call.conflict = arg as { set?: Record<string, unknown> };
      // leftJoin(table, on) / innerJoin(table, on): the ON clause is where the
      // watchlist's group scope and its non-binned rule actually live.
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
    if (table === sleeperEntries) return 'sleeperEntries';
    if (table === sleeperSeen) return 'sleeperSeen';
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
    selectDistinct: () => ({ from: (table: unknown) => start('select', table) }),
    selectDistinctOn: () => ({ from: (table: unknown) => start('select', table) }),
    execute: (statement: unknown) => {
      calls.push({ key: 'execute', where: statement as SQL, joinOn: [] });
      return Promise.resolve([]);
    },
  };
  const db = { ...tx, transaction: <T>(fn: (t: unknown) => Promise<T>) => fn(tx) };
  return { db: db as unknown as Db, calls };
}

const find = (calls: DbCall[], key: string) => calls.filter((c) => c.key === key);

/** count(*) comes back from postgres-js as a string — script it as one. */
const count = (n: number): unknown[][] => [[{ n: String(n) }]];

/**
 * The existence probe answers first, the cap count second; `select:tokens` is
 * addWatch's own read of the cached market state (the round-19 baseline, which
 * is only stamped when that cache is contemporaneous). `existing` may carry the
 * row's stored baseline, which an ACTIVE row keeps.
 */
function watchScript(options: {
  existing?: { active: boolean; mcapAtWatch?: number | null };
  held: number;
  mcapUsd?: number | null;
  phase?: string;
  lastSnapshotAt?: Date | string | null;
}): Script {
  return {
    'select:watches': [options.existing ? [options.existing] : [], [{ n: String(options.held) }]],
    'select:tokens': [
      [
        {
          mcapUsd: options.mcapUsd ?? null,
          phase: options.phase ?? 'graduated',
          lastSnapshotAt:
            options.lastSnapshotAt === undefined ? new Date() : options.lastSnapshotAt,
        },
      ],
    ],
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
    expect(outcome).toEqual({ ok: true, alreadyActive: false, mcapAtWatch: null });
    expect(find(calls, 'insert:watches')[0]?.values).toEqual({
      groupId: GROUP_ID,
      tokenId: TOKEN_ID,
      addedBy: USER_ID,
      mcapAtWatch: null,
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
      watchScript({
        existing: { active: true, mcapAtWatch: 120_000 },
        held: WATCH_CAP_PER_MEMBER,
      }),
    );
    expect(await addWatch(db, GROUP_ID, TOKEN_ID, USER_ID)).toEqual({
      ok: true,
      alreadyActive: true,
      // The ORIGINAL baseline: nothing about an active watch moves.
      mcapAtWatch: 120_000,
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
  it('the conflict clause keeps the original credit, clock and baseline when active', async () => {
    const { db, calls } = makeDb(watchScript({ held: 0 }));
    await addWatch(db, GROUP_ID, TOKEN_ID, USER_ID);
    const set = find(calls, 'insert:watches')[0]?.conflict?.set ?? {};
    expect(Object.keys(set).sort()).toEqual([
      'active',
      'addedAt',
      'addedBy',
      'buyOppArmed',
      'mcapAtWatch',
    ]);
    expect(set.active).toBe(true);
    // SET expressions see the OLD row: only a stopped watch takes new credit.
    expect(renderSql(set.addedBy)).toContain('case when');
    expect(renderSql(set.addedAt)).toContain('case when');
    // Round 19: the baseline moves with them, and only with them.
    expect(renderSql(set.mcapAtWatch)).toContain('case when');
    expect(renderSql(set.mcapAtWatch)).toContain('double precision');
    // ...and so does the armed flag: a re-taken slot starts able to fire.
    expect(renderSql(set.buyOppArmed)).toContain('case when');
    expect(renderSql(set.buyOppArmed)).toContain('else true end');
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

/**
 * The BUY OPP baseline (docs/decisions.md round 19). A watch is stamped with
 * the coin's cached market cap the moment it is ACTIVATED, and the alert
 * measures its drawdown from that number — never from a peak.
 */
describe('addWatch — the round-19 baseline', () => {
  it('stamps the token s cached mcap on a fresh watch', async () => {
    const { db, calls } = makeDb(watchScript({ held: 0, mcapUsd: 120_000 }));
    const outcome = await addWatch(db, GROUP_ID, TOKEN_ID, USER_ID);
    expect(outcome).toEqual({ ok: true, alreadyActive: false, mcapAtWatch: 120_000 });
    expect(find(calls, 'insert:watches')[0]?.values).toMatchObject({ mcapAtWatch: 120_000 });
  });

  it('reads the token s phase and as-of marker alongside it', async () => {
    // The cache is only the member's entry point when it is a reading from just
    // now: a dead coin's cache is frozen, and a quiet coin's is up to an hour
    // old (POLL_TIERS.idleSeconds), so neither may be stamped as a baseline.
    const { db } = makeDb(
      watchScript({
        held: 0,
        mcapUsd: 6_000,
        phase: 'dead',
        lastSnapshotAt: new Date(),
      }),
    );
    expect(await addWatch(db, GROUP_ID, TOKEN_ID, USER_ID)).toMatchObject({ mcapAtWatch: null });
  });

  it('refuses a stale cache — the number the member never saw', async () => {
    // 2 x POLL_TIERS.freshSeconds is the whole allowance; five minutes is an
    // active-tier coin, and the immediate poll lands a real reading in seconds.
    const { db, calls } = makeDb(
      watchScript({
        held: 0,
        mcapUsd: 120_000,
        lastSnapshotAt: new Date(Date.now() - 5 * 60_000),
      }),
    );
    expect(await addWatch(db, GROUP_ID, TOKEN_ID, USER_ID)).toMatchObject({ mcapAtWatch: null });
    expect(find(calls, 'insert:watches')[0]?.values).toMatchObject({ mcapAtWatch: null });
  });

  it('accepts a cache inside the allowance, as a Date or as a driver string', async () => {
    const at = new Date(Date.now() - 60_000);
    for (const lastSnapshotAt of [at, at.toISOString()]) {
      const { db } = makeDb(watchScript({ held: 0, mcapUsd: 120_000, lastSnapshotAt }));
      expect(await addWatch(db, GROUP_ID, TOKEN_ID, USER_ID)).toMatchObject({
        mcapAtWatch: 120_000,
      });
    }
  });

  it('refuses a cache with no as-of marker at all', async () => {
    for (const lastSnapshotAt of [null, 'not-a-date']) {
      const { db } = makeDb(watchScript({ held: 0, mcapUsd: 120_000, lastSnapshotAt }));
      expect(await addWatch(db, GROUP_ID, TOKEN_ID, USER_ID)).toMatchObject({ mcapAtWatch: null });
    }
  });

  it('reads that mcap inside the transaction, for THIS token', async () => {
    const { db, calls } = makeDb(watchScript({ held: 0, mcapUsd: 120_000 }));
    await addWatch(db, GROUP_ID, TOKEN_ID, USER_ID);
    const read = find(calls, 'select:tokens')[0];
    expect(whereParams(read)).toEqual([TOKEN_ID]);
    // ...under the same advisory lock as the cap check, before the insert.
    expect(calls.map((c) => c.key)).toEqual([
      'execute',
      'select:watches',
      'select:watches',
      'select:tokens',
      'insert:watches',
    ]);
  });

  it('stamps null for a coin nobody has priced yet — the pass backfills it', async () => {
    const { db, calls } = makeDb(watchScript({ held: 0, mcapUsd: null }));
    expect(await addWatch(db, GROUP_ID, TOKEN_ID, USER_ID)).toMatchObject({ mcapAtWatch: null });
    expect(find(calls, 'insert:watches')[0]?.values).toMatchObject({ mcapAtWatch: null });
  });

  it('treats a zero or junk market cap as unknown, never as a baseline', async () => {
    // A $0 baseline would make every later reading an infinite drawdown.
    for (const mcapUsd of [0, -1, Number.NaN]) {
      const { db } = makeDb(watchScript({ held: 0, mcapUsd }));
      expect(await addWatch(db, GROUP_ID, TOKEN_ID, USER_ID)).toMatchObject({
        mcapAtWatch: null,
      });
    }
  });

  it('re-stamps when a STOPPED watch is re-activated — new watch, new baseline', async () => {
    const { db, calls } = makeDb(
      watchScript({
        existing: { active: false, mcapAtWatch: 500_000 },
        held: 0,
        mcapUsd: 80_000,
      }),
    );
    expect(await addWatch(db, GROUP_ID, TOKEN_ID, USER_ID)).toMatchObject({
      mcapAtWatch: 80_000,
    });
    // The conflict clause carries today's number for the else branch.
    const set = find(calls, 'insert:watches')[0]?.conflict?.set ?? {};
    expect(dialect.sqlToQuery(set.mcapAtWatch as SQL).params).toContain(80_000);
  });

  it('does NOT re-stamp a watch that is already active, and reads no token at all', async () => {
    const { db, calls } = makeDb(
      watchScript({ existing: { active: true, mcapAtWatch: 500_000 }, held: 0, mcapUsd: 80_000 }),
    );
    expect(await addWatch(db, GROUP_ID, TOKEN_ID, USER_ID)).toEqual({
      ok: true,
      alreadyActive: true,
      mcapAtWatch: 500_000,
    });
    expect(find(calls, 'select:tokens')).toHaveLength(0);
    expect(find(calls, 'insert:watches')).toHaveLength(0);
  });

  it('reports the baseline the DATABASE landed on, not the one it computed', async () => {
    // Two members racing onto the same token: the loser's insert is a no-op and
    // the winner's baseline is what the row holds, so that is what is reported.
    const { db } = makeDb({
      ...watchScript({ held: 0, mcapUsd: 80_000 }),
      'insert:watches': [[{ mcapAtWatch: 500_000 }]],
    });
    expect(await addWatch(db, GROUP_ID, TOKEN_ID, USER_ID)).toMatchObject({
      mcapAtWatch: 500_000,
    });
  });

  it('reads a driver string baseline as a number', async () => {
    const { db } = makeDb({
      ...watchScript({ held: 0 }),
      'select:tokens': [[{ mcapUsd: '120000', phase: 'graduated', lastSnapshotAt: new Date() }]],
    });
    expect(await addWatch(db, GROUP_ID, TOKEN_ID, USER_ID)).toMatchObject({
      mcapAtWatch: 120_000,
    });
  });
});

/**
 * A watch taken on a coin nobody had priced yet has no baseline, so the alert
 * pass fills it from the first reading AFTER the watch (round 19) — the same
 * honesty as mcap-at-call, and the closest measurement to the moment the member
 * asked for the coin.
 */
describe('backfillBaselines', () => {
  const statement = async (tokenIds: number[] = [TOKEN_ID]) => {
    const { db, calls } = makeDb();
    await backfillBaselines(db, tokenIds);
    const execs = find(calls, 'execute');
    expect(execs).toHaveLength(1);
    return dialect.sqlToQuery(execs[0]?.where as SQL);
  };

  /**
   * Round 19 review, the finding that killed every alert pass: Postgres hides
   * the UPDATE target from subqueries in the FROM list, so an `update watches
   * ... from lateral (... where snapshots.token_id = watches.token_id)` is a
   * parse error — and the pass throws before judging any nuke either. The
   * statement may only name `watches` from SET and WHERE.
   */
  it('never joins the target table into a FROM clause', async () => {
    const { sql: text } = await statement();
    expect(text).not.toContain('lateral');
    expect(text.slice(text.indexOf('set '))).not.toContain(' from "watches"');
    // The correlation lives in a scalar subquery, guarded by the same EXISTS so
    // a watch with no reading yet is not "filled" with null.
    expect(text).toContain('exists (');
  });

  it('never overwrites a baseline that is already stamped', async () => {
    const { sql: text } = await statement();
    expect(text).toContain('update "watches"');
    expect(text).toContain('"watches"."mcap_at_watch" is null');
  });

  it('takes the FIRST reading at or after the watch was added', async () => {
    const { sql: text } = await statement();
    expect(text).toContain('"snapshots"."at" >= "watches"."added_at"');
    expect(text).toContain('order by "snapshots"."at"');
    expect(text).toContain('limit 1');
    // A null or zero reading is not a market cap: it would poison the line.
    expect(text).toContain('"snapshots"."mcap_usd" is not null');
    expect(text).toContain('"snapshots"."mcap_usd" > 0');
  });

  it('touches only ACTIVE watches, and narrows to the tokens in play', async () => {
    const { sql: text, params } = await statement([TOKEN_ID, 88]);
    expect(text).toContain('"watches"."active"');
    expect(params).toContain(TOKEN_ID);
    expect(params).toContain(88);
  });

  it('hands back what it filled, so this pass can judge the watch it stamped', async () => {
    const { sql: text } = await statement();
    expect(text).toContain('returning');
    expect(text).toContain('"watches"."mcap_at_watch"');
  });

  it('is one statement, not one per watch', async () => {
    const { db, calls } = makeDb();
    await backfillBaselines(db, [1, 2, 3, 4]);
    expect(calls).toHaveLength(1);
  });

  it('asks nothing when no watch needs a baseline', async () => {
    const { db, calls } = makeDb();
    expect(await backfillBaselines(db, [])).toEqual(new Map());
    expect(calls).toHaveLength(0);
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
  app.route('/', createSleeperRoutes(db));
  return app;
}

/**
 * findGroupToken's hit, then nothing: addWatch's own market read finds no row
 * (so the baseline stays null) and pollTokenNow's read finds nothing to poll.
 */
const KNOWN_TOKEN = [[{ id: TOKEN_ID, address: '0xabc', symbol: 'TKN' }], []];

/** Let the route's fire-and-forget immediate poll reach the database fake. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

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

  /**
   * Round 19 review: a card's coin can be minutes behind its poll tier, and the
   * baseline is only stamped from a contemporaneous reading — so this route
   * kicks the same immediate poll the address route and the bot do, and the
   * backfill stamps the reading it lands.
   */
  it('kicks an immediate poll of the token it just watched', async () => {
    const { db, calls } = makeDb({ ...watchScript({ held: 0 }), 'select:tokens': KNOWN_TOKEN });
    const res = await testApp(db).request(`/api/g/${SLUG}/tokens/${TOKEN_ID}/watch`, {
      method: 'POST',
    });
    expect(res.status).toBe(204);
    await settle();
    // the group-scoped lookup, addWatch's market read, then the poll's own.
    const reads = find(calls, 'select:tokens');
    expect(reads).toHaveLength(3);
    expect(whereParams(reads[2])).toEqual([TOKEN_ID]);
    expect(whereText(reads[2])).not.toContain('exists');
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

/* ------------------------------------------------- watch by address (r16) */

const ADDRESS = '0x1111111111111111111111111111111111111111';
/** Mixed case that passes EIP-55, to prove the checksum path is the live one. */
const CHECKSUMMED = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359';

describe('parseAddress â€” the body/path address, normalised like ingest', () => {
  it('lowercases a well-formed address', () => {
    expect(parseAddress(`  ${ADDRESS}  `)).toBe(ADDRESS);
  });

  it('accepts a checksummed address and stores it lowercase', () => {
    expect(parseAddress(CHECKSUMMED)).toBe(CHECKSUMMED.toLowerCase());
  });

  it('refuses a mixed-case address that fails EIP-55 â€” a corrupted paste', () => {
    const broken = '0xFb6916095ca1df60bB79Ce92cE3Ea74c37c5d359';
    expect(parseAddress(broken)).toBeNull();
  });

  it('refuses junk, wrong lengths, and non-strings', () => {
    for (const raw of [
      '',
      'nope',
      '0x123',
      `${ADDRESS}00`,
      42,
      null,
      undefined,
      { address: ADDRESS },
    ]) {
      expect(parseAddress(raw)).toBeNull();
    }
  });

  it('refuses an address buried in other text â€” a field is not a sentence', () => {
    expect(parseAddress(`buy ${ADDRESS} now`)).toBeNull();
  });
});

async function post(db: Db, body: unknown): Promise<Response> {
  return testApp(db).request(`/api/g/${SLUG}/watch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/g/:slug/watch (by address)', () => {
  it('400s a malformed address and writes nothing at all', async () => {
    for (const body of [{ address: 'nope' }, { address: 42 }, {}, [ADDRESS]]) {
      const { db, calls } = makeDb();
      const res = await post(db, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toHaveProperty('error');
      expect(calls).toHaveLength(0);
    }
  });

  it('400s an unparseable body without touching the database', async () => {
    const { db, calls } = makeDb();
    const res = await testApp(db).request(`/api/g/${SLUG}/watch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('413s a body past the limit before reading it', async () => {
    // The whole expected body is ~60 bytes; a member's session must not be
    // usable to make the process buffer an arbitrary amount of memory.
    const { db, calls } = makeDb();
    const res = await testApp(db).request(`/api/g/${SLUG}/watch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: ADDRESS, padding: 'x'.repeat(2048) }),
    });
    expect(res.status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it('accepts a body at the small end of the limit', async () => {
    const { db } = makeDb({
      'select:tokens': [[]],
      'select:watches': [[{ n: '0' }], [], [{ n: '0' }]],
      'insert:tokens': [[{ id: TOKEN_ID, symbol: null, mcapUsd: null }]],
      'insert:watches': [[]],
    });
    expect((await post(db, { address: ADDRESS })).status).toBe(204);
  });

  it('204s: upserts the token, then adds the watch under the SESSION member', async () => {
    const { db, calls } = makeDb({
      // the by-address lookup misses, then: pre-check count, addWatch's
      // existence probe, and its own count.
      'select:tokens': [[]],
      'select:watches': [[{ n: '0' }], [], [{ n: '0' }]],
      'insert:tokens': [[{ id: TOKEN_ID, symbol: null, mcapUsd: null }]],
      'insert:watches': [[]],
    });
    const res = await post(db, { address: CHECKSUMMED });
    expect(res.status).toBe(204);
    // Stored lowercase, exactly like an address ingested from chat.
    expect(find(calls, 'insert:tokens')[0]?.values).toEqual({
      chainId: ROBINHOOD_CHAIN_ID,
      address: CHECKSUMMED.toLowerCase(),
    });
    expect(find(calls, 'insert:watches')[0]?.values).toEqual({
      groupId: GROUP_ID,
      tokenId: TOKEN_ID,
      addedBy: USER_ID,
      mcapAtWatch: null,
    });
  });

  it('checks the cap BEFORE upserting, so a refusal leaves no orphan token', async () => {
    // The round-15 orphan guard: a tokens row with no call and no watch would
    // be polled at the fresh tier for a day for nothing.
    const { db, calls } = makeDb({
      'select:tokens': [[]],
      'select:watches': count(WATCH_CAP_PER_MEMBER),
    });
    const res = await post(db, { address: ADDRESS });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: watchCapMessage(WATCH_CAP_PER_MEMBER),
      cap: WATCH_CAP_PER_MEMBER,
    });
    expect(find(calls, 'insert:tokens')).toHaveLength(0);
    expect(find(calls, 'insert:watches')).toHaveLength(0);
    // ...and nothing but the coin lookup ran before it.
    expect(calls.map((c) => c.key)).toEqual(['select:tokens', 'select:watches']);
  });

  /**
   * Round 16 review: pressing WATCH on a coin the GROUP already watches
   * consumes no slot — addWatch answers ok/alreadyActive, and the card route
   * 204s — so a member at their cap must not be refused here. It is reachable:
   * a Sleepers payload is not refetched when another member watches a row, so
   * the pill still reads WATCH long after the coin was taken.
   */
  it('204s an already-watched coin at cap, without consulting the cap at all', async () => {
    const { db, calls } = makeDb({
      'select:tokens': [[{ id: TOKEN_ID, symbol: 'TKN' }]],
      // The isWatched probe answers yes; the cap count is never reached.
      'select:watches': [[{ id: 3 }]],
    });
    const res = await post(db, { address: ADDRESS });
    expect(res.status).toBe(204);
    expect(calls.map((c) => c.key)).toEqual(['select:tokens', 'select:watches']);
    expect(find(calls, 'insert:tokens')).toHaveLength(0);
    expect(find(calls, 'insert:watches')).toHaveLength(0);
  });

  it('...and publishes nothing: the board did not change', async () => {
    const { db } = makeDb({
      'select:tokens': [[{ id: TOKEN_ID, symbol: 'TKN' }]],
      'select:watches': [[{ id: 3 }]],
    });
    const { events } = await capture(() => post(db, { address: ADDRESS }));
    expect(events).toEqual([]);
  });

  it('still refuses at cap when the known coin is NOT watched — that costs a slot', async () => {
    const { db, calls } = makeDb({
      'select:tokens': [[{ id: TOKEN_ID, symbol: 'TKN' }]],
      // isWatched: no, then the cap pre-check.
      'select:watches': [[], count(WATCH_CAP_PER_MEMBER)[0] ?? []],
    });
    const res = await post(db, { address: ADDRESS });
    expect(res.status).toBe(409);
    expect(find(calls, 'insert:watches')).toHaveLength(0);
  });

  it('skips the upsert for a coin we already have — the row exists', async () => {
    const { db, calls } = makeDb({
      'select:tokens': [[{ id: TOKEN_ID, symbol: 'TKN' }]],
      'select:watches': [[], [{ n: '0' }], [], [{ n: '0' }]],
      'insert:watches': [[]],
    });
    expect((await post(db, { address: ADDRESS })).status).toBe(204);
    expect(find(calls, 'insert:tokens')).toHaveLength(0);
    expect(find(calls, 'insert:watches')[0]?.values).toEqual({
      groupId: GROUP_ID,
      tokenId: TOKEN_ID,
      addedBy: USER_ID,
      mcapAtWatch: null,
    });
  });

  it('409s when the authoritative locked check refuses, after the upsert', async () => {
    // The pre-check passed (a stale/racing count); addWatch is the real gate.
    const { db } = makeDb({
      'select:tokens': [[]],
      'select:watches': [[{ n: '0' }], [], [{ n: String(WATCH_CAP_PER_MEMBER) }]],
      'insert:tokens': [[{ id: TOKEN_ID, symbol: null, mcapUsd: null }]],
    });
    const res = await post(db, { address: ADDRESS });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: watchCapMessage(WATCH_CAP_PER_MEMBER),
      cap: WATCH_CAP_PER_MEMBER,
    });
  });

  it('publishes watch_changed for the group, like the card-id route', async () => {
    const { db } = makeDb({
      'select:tokens': [[]],
      'select:watches': [[{ n: '0' }], [], [{ n: '0' }]],
      'insert:tokens': [[{ id: TOKEN_ID, symbol: null, mcapUsd: null }]],
      'insert:watches': [[]],
    });
    const { events } = await capture(() => post(db, { address: ADDRESS }));
    expect(events).toEqual([{ type: 'watch_changed', tokenId: TOKEN_ID, groupId: GROUP_ID }]);
  });
});

/**
 * The chat command is the third surface on the same rule (docs/decisions.md
 * round 16 review): `/overseer watch <ca>` for a coin the group already watches
 * must not be refused for cap either — nothing about it consumes a slot.
 */
describe('/overseer watch — the bot mirrors the cap rule', () => {
  const replies: string[] = [];
  const ctx = { reply: async (text: string) => void replies.push(text) } as unknown as Context;

  const watch = async (db: Db) => {
    replies.length = 0;
    await handleWatch(db, ctx, GROUP, [ADDRESS], USER_ID);
    return replies;
  };

  it('confirms a coin the group already watches, even at cap', async () => {
    const { db, calls } = makeDb({
      // lookup hit, then pollTokenNow's own read finds nothing to poll.
      'select:tokens': [[{ id: TOKEN_ID, symbol: 'TKN' }], []],
      // isWatched: yes; addWatch's probe: active; then the slots-held count.
      'select:watches': [[{ id: 3 }], [{ active: true }], count(WATCH_CAP_PER_MEMBER)[0] ?? []],
    });
    const [reply] = await watch(db);
    expect(reply).toContain('Watching');
    expect(reply).not.toContain('unwatch one first');
    expect(find(calls, 'insert:tokens')).toHaveLength(0);
  });

  it('still refuses a NEW coin at cap, and writes no orphan token', async () => {
    const { db, calls } = makeDb({
      'select:tokens': [[]],
      'select:watches': count(WATCH_CAP_PER_MEMBER),
    });
    const [reply] = await watch(db);
    expect(reply).toContain(watchCapMessage(WATCH_CAP_PER_MEMBER));
    expect(find(calls, 'insert:tokens')).toHaveLength(0);
    expect(find(calls, 'insert:watches')).toHaveLength(0);
  });

  /**
   * Round 19: the confirmation names the baseline every later BUY OPP is
   * measured against, so the member knows what the alert will compare to.
   */
  it('names the baseline it just stamped', async () => {
    const { db } = makeDb({
      // by-address lookup, addWatch's mcap read, then pollTokenNow finds nothing.
      'select:tokens': [
        [{ id: TOKEN_ID, symbol: 'TKN' }],
        [{ mcapUsd: 120_000, phase: 'graduated', lastSnapshotAt: new Date() }],
        [],
      ],
      // isWatched: no; pre-check count; addWatch's probe; its count; slots held.
      'select:watches': [[], count(0)[0] ?? [], [], count(0)[0] ?? [], count(1)[0] ?? []],
      'insert:watches': [[]],
    });
    const [reply] = await watch(db);
    expect(reply).toContain('Watching TKN from $120K');
    expect(reply).toContain('buy-opp ≥30% below the mcap at watch');
    // The retired peak window must not be quoted at anyone any more.
    expect(reply).not.toContain('24h');
    expect(reply).not.toContain('retrace over');
  });

  it('omits the baseline clause when the coin has never been priced', async () => {
    const { db } = makeDb({
      'select:tokens': [
        [{ id: TOKEN_ID, symbol: 'TKN' }],
        [{ mcapUsd: null, phase: 'graduated', lastSnapshotAt: new Date() }],
        [],
      ],
      'select:watches': [[], count(0)[0] ?? [], [], count(0)[0] ?? [], count(1)[0] ?? []],
      'insert:watches': [[]],
    });
    const [reply] = await watch(db);
    expect(reply).toContain('Watching TKN (1/3 of your slots)');
    expect(reply).not.toContain('from $');
  });

  it('asks for the usage line when the argument is not an address', async () => {
    const { db, calls } = makeDb();
    replies.length = 0;
    await handleWatch(db, ctx, GROUP, ['nope'], USER_ID);
    expect(replies[0]).toContain('Usage:');
    expect(calls).toHaveLength(0);
  });
});

/**
 * Round 19 retired the buy-opp peak window from the RULE, but the settings key
 * survives so stored blobs and old `/overseer set buyopp <pct> <hours>` muscle
 * memory still work. What must never happen is storing that trailing number as
 * a knob: it would read like a live setting nothing consults.
 */
describe('/overseer set buyopp — the round-19 shape', () => {
  const replies: string[] = [];
  const ctx = { reply: async (text: string) => void replies.push(text) } as unknown as Context;

  /** The `settings` patch the update carried, as the merged jsonb parameter. */
  const patchOf = (call: DbCall | undefined): Record<string, unknown> => {
    const value = call?.set?.settings;
    if (!is(value, SQLClass)) return {};
    const json = (dialect.sqlToQuery(value).params as unknown[]).find(
      (p) => typeof p === 'string' && p.startsWith('{'),
    ) as string | undefined;
    return json ? (JSON.parse(json) as Record<string, unknown>) : {};
  };

  const set = async (db: Db, args: string[]) => {
    replies.length = 0;
    await handleSet(db, ctx, GROUP, args, true);
    return replies;
  };

  it('persists the percentage, and nothing else', async () => {
    const { db, calls } = makeDb({ 'update:groups': [[{ settings: {} }]] });
    await set(db, ['buyopp', '35']);
    expect(patchOf(find(calls, 'update:groups')[0])).toEqual({ buyRetracePct: 35 });
  });

  it('accepts the legacy <hours> argument and drops it on the floor', async () => {
    const { db, calls } = makeDb({ 'update:groups': [[{ settings: {} }]] });
    await set(db, ['buyopp', '35', '24']);
    const patch = patchOf(find(calls, 'update:groups')[0]);
    expect(patch).toEqual({ buyRetracePct: 35 });
    expect(patch).not.toHaveProperty('buyPeakWindowHours');
    expect(patch).not.toHaveProperty('buyMinDeclineHours');
  });

  it('clamps a percentage out of range instead of storing it', async () => {
    const { db, calls } = makeDb({ 'update:groups': [[{ settings: {} }]] });
    await set(db, ['buyopp', '999']);
    expect(patchOf(find(calls, 'update:groups')[0])).toEqual({ buyRetracePct: 95 });
  });

  it('answers with the usage line and writes nothing without a percentage', async () => {
    for (const args of [['buyopp'], ['buyopp', 'lots'], ['nonsense', '35']]) {
      const { db, calls } = makeDb();
      const [reply] = await set(db, args);
      expect(reply).toContain('Usage:');
      expect(reply).toContain('/overseer set buyopp <pct 5-95>');
      expect(calls).toHaveLength(0);
    }
  });

  it('still takes both arguments for nuke', async () => {
    const { db, calls } = makeDb({ 'update:groups': [[{ settings: {} }]] });
    await set(db, ['nuke', '50', '20']);
    expect(patchOf(find(calls, 'update:groups')[0])).toEqual({
      nukeDropPct: 50,
      nukeWindowMin: 20,
    });
  });

  it('replies with the summary the group now lives under', async () => {
    const { db } = makeDb({ 'update:groups': [[{ settings: { alerts: { buyRetracePct: 35 } } }]] });
    const [reply] = await set(db, ['buyopp', '35']);
    expect(reply).toContain('buy-opp ≥35% below the mcap at watch');
  });
});

describe('/overseer alerts — the summary text', () => {
  it('names the watch baseline and never a peak window', () => {
    const summary = alertsSummary(ALERT_DEFAULTS);
    expect(summary).toContain('below the mcap at watch');
    for (const retired of ['h high', '24h', 'retrace from', 'maxHours']) {
      expect(summary).not.toContain(retired);
    }
  });

  it('offers buyopp with one argument, and nuke with two', () => {
    const summary = alertsSummary(ALERT_DEFAULTS);
    expect(summary).toContain('/overseer set buyopp <pct>');
    expect(summary).toContain('/overseer set nuke <pct> <minutes>');
  });
});

describe('DELETE /api/g/:slug/watch/:address', () => {
  it('204s and stops the group s watch on the named coin', async () => {
    const { db, calls } = makeDb({
      'select:tokens': [[{ id: TOKEN_ID }]],
      'update:watches': [[{ id: 3 }]],
    });
    const res = await testApp(db).request(`/api/g/${SLUG}/watch/${CHECKSUMMED}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(204);
    // Looked up by (chain, lowercase address) â€” the bot's unwatch lookup.
    expect(whereParams(find(calls, 'select:tokens')[0])).toEqual([
      ROBINHOOD_CHAIN_ID,
      CHECKSUMMED.toLowerCase(),
    ]);
    expect(find(calls, 'update:watches')[0]?.set).toEqual({ active: false });
  });

  it('never filters by who added it â€” the watchlist is the group s', async () => {
    const { db, calls } = makeDb({
      'select:tokens': [[{ id: TOKEN_ID }]],
      'update:watches': [[{ id: 3 }]],
    });
    await testApp(db).request(`/api/g/${SLUG}/watch/${ADDRESS}`, { method: 'DELETE' });
    const update = find(calls, 'update:watches')[0];
    expect(whereParams(update)).toEqual([GROUP_ID, TOKEN_ID, true]);
    expect(whereText(update)).not.toContain('added_by');
  });

  it('204s a coin we have never seen â€” no existence oracle', async () => {
    const { db, calls } = makeDb({ 'select:tokens': [[]] });
    const res = await testApp(db).request(`/api/g/${SLUG}/watch/${ADDRESS}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(find(calls, 'update:watches')).toHaveLength(0);
  });

  it('204s a malformed address without querying anything', async () => {
    const { db, calls } = makeDb();
    const res = await testApp(db).request(`/api/g/${SLUG}/watch/not-an-address`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(204);
    expect(calls).toHaveLength(0);
  });
});

/* ------------------------------------------ BoardResponse.watchlist (r16) */

type TokenRow = typeof tokens.$inferSelect;
type CallRow = typeof callsTable.$inferSelect;

const AT = new Date('2026-09-02T12:00:00.000Z');

function tokenRow(over: Partial<TokenRow> = {}): TokenRow {
  return {
    id: TOKEN_ID,
    chainId: ROBINHOOD_CHAIN_ID,
    address: ADDRESS,
    symbol: 'TKN',
    name: 'Token',
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
    mcapUsd: 120_000,
    liquidityUsd: 30_000,
    vol24Usd: 10_000,
    firstSeenAt: AT,
    lastPolledAt: AT,
    lastSnapshotAt: AT,
    ...over,
  };
}

function callRow(over: Partial<CallRow> = {}): CallRow {
  return {
    id: 500,
    groupId: GROUP_ID,
    tokenId: TOKEN_ID,
    callerUserId: USER_ID,
    callerName: '@caller',
    messageId: 10,
    calledAt: AT,
    mcapAtCall: 60_000,
    liquidityAtCall: 20_000,
    peakMcapSinceCall: 120_000,
    peakAt: AT,
    mentionsCount: 1,
    lastMentionAt: AT,
    status: 'active',
    diedAt: null,
    deathReason: null,
    mcapAtDeath: null,
    binnedBy: null,
    binnedAt: null,
    reviveRequested: false,
    ...over,
  };
}

/** One row of loadWatchlistRows, as the fake hands it back. */
function watchRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    token: tokenRow({ id: 88 }),
    addedBy: USER_ID,
    addedAt: AT,
    mcapAtWatch: null,
    callId: null,
    callStatus: null,
    ...over,
  };
}

/**
 * Script a board GET: board rows then the two count queries, all on `calls`;
 * `names` answers the mention-name fallback (mentions joined to calls) and
 * `memberNames` the cached group_members display names, which win.
 */
function boardScript(options: {
  cards?: Array<{ call: CallRow; token: TokenRow }>;
  watchlist?: unknown[];
  names?: Array<{ userId: number; userName: string }>;
  memberNames?: Array<{ userId: number; displayName: string | null }>;
}): Script {
  return {
    'select:calls': [options.cards ?? [], [{ n: '0' }], [{ n: '0' }]],
    'select:watches': [options.watchlist ?? []],
    'select:mentions': [options.names ?? []],
    'select:groupMembers': [options.memberNames ?? []],
  };
}

const board = async (db: Db): Promise<BoardResponse> => {
  const res = await testApp(db).request(`/api/g/${SLUG}/board`);
  expect(res.status).toBe(200);
  return (await res.json()) as BoardResponse;
};

describe('BoardResponse.watchlist', () => {
  it('is present and empty when the group watches nothing', async () => {
    const { db } = makeDb(boardScript({}));
    expect((await board(db)).watchlist).toEqual([]);
  });

  it('carries a watched coin that has NO call on this board', async () => {
    const token = tokenRow({ id: 88, address: ADDRESS, symbol: 'SLPR' });
    const { db } = makeDb(boardScript({ watchlist: [watchRow({ token })] }));
    const body = await board(db);
    expect(body.watchlist).toHaveLength(1);
    const entry = body.watchlist[0]!;
    expect(entry).toMatchObject({
      tokenId: 88,
      address: ADDRESS,
      symbol: 'SLPR',
      phase: 'graduated',
      rugHiddenAt: null,
      callStatus: null,
      mcapUsd: 120_000,
      liquidityUsd: 30_000,
      dataAsOf: AT.toISOString(),
      addedBy: USER_ID,
      addedByName: null,
      addedAt: AT.toISOString(),
      watchedByMe: true,
      callId: null,
      twitterUrl: null,
      websiteUrl: null,
    });
    expect(entry.links).toEqual(tradingLinks(ADDRESS));
    expect(entry.sparkline).toEqual([]);
  });

  it('marks another member s slot as not mine, and joins the call when there is one', async () => {
    const { db } = makeDb(
      boardScript({
        watchlist: [watchRow({ addedBy: OTHER_USER_ID, callId: 500, callStatus: 'active' })],
      }),
    );
    const entry = (await board(db)).watchlist[0];
    expect(entry?.watchedByMe).toBe(false);
    expect(entry?.addedBy).toBe(OTHER_USER_ID);
    expect(entry?.callId).toBe(500);
  });

  /**
   * Round 16 review: a watched coin the sections do not contain is on rug
   * probation, or died, or simply older than the window — the row has to be
   * able to say which instead of printing "no call" at a called coin.
   */
  it('serves rugHiddenAt and the joined call s status', async () => {
    const hiddenAt = new Date('2026-09-02T09:00:00.000Z');
    const { db } = makeDb(
      boardScript({
        watchlist: [
          watchRow({
            token: tokenRow({ id: 88, rugHiddenAt: hiddenAt }),
            callId: 500,
            callStatus: 'died',
          }),
        ],
      }),
    );
    const entry = (await board(db)).watchlist[0];
    expect(entry?.rugHiddenAt).toBe(hiddenAt.toISOString());
    expect(entry?.callStatus).toBe('died');
  });

  /**
   * Round 19: the ON WATCH row shows the drawdown the BUY OPP alert measures,
   * so it needs the same baseline the alert uses — the mcap at the watch.
   */
  it('serves mcapAtWatch, the baseline the alert measures from', async () => {
    const { db } = makeDb(boardScript({ watchlist: [watchRow({ mcapAtWatch: 120_000 })] }));
    expect((await board(db)).watchlist[0]?.mcapAtWatch).toBe(120_000);
  });

  it('serves null while the baseline is unmeasured — never a guess', async () => {
    const { db } = makeDb(boardScript({ watchlist: [watchRow()] }));
    expect((await board(db)).watchlist[0]?.mcapAtWatch).toBeNull();
  });

  it('leaves callStatus null when the coin has no call at all', async () => {
    const { db } = makeDb(boardScript({ watchlist: [watchRow()] }));
    const entry = (await board(db)).watchlist[0];
    expect(entry?.callId).toBeNull();
    expect(entry?.callStatus).toBeNull();
  });

  /**
   * The call join is the payload's only claim about "the group's call": it must
   * be THIS group's, and never a binned one (a binned card is not on the board,
   * so an id to join against would dangle). `calls` is unique per (group, token)
   * but not per token, so dropping the group predicate would silently serve
   * another group's call id.
   */
  it('scopes the call join to this group and excludes binned calls', async () => {
    const { db, calls } = makeDb(boardScript({}));
    await board(db);
    const query = find(calls, 'select:watches')[0];
    // joins in declared order: tokens (innerJoin), then calls (leftJoin).
    expect(joinText(query, 0)).toContain('"tokens"."id"');
    const on = joinText(query, 1);
    expect(on).toContain('"calls"."group_id"');
    expect(on).toContain('<>');
    expect(joinParams(query, 1)).toEqual([GROUP_ID, 'binned']);
  });

  it('does not window the watchlist — it is the slot inventory, not a section', async () => {
    const { db, calls } = makeDb(boardScript({}));
    await board(db);
    const query = find(calls, 'select:watches')[0];
    // The window predicate the sections carry (last_mention_at >= since) must
    // not appear here, or a quiet coin's slot would vanish from the one surface
    // that can free it.
    expect(whereText(query)).not.toContain('last_mention_at');
    expect(whereText(query)).not.toContain('>=');
    expect(whereParams(query)).toEqual([GROUP_ID, true]);
  });

  it('asks for the group s ACTIVE watches, newest slot first', async () => {
    const { db, calls } = makeDb(boardScript({}));
    await board(db);
    const query = find(calls, 'select:watches')[0];
    expect(whereParams(query)).toEqual([GROUP_ID, true]);
    // Ordering is the database's, so nothing downstream can re-sort it.
    expect(renderSql(query?.orderBy)).toContain('desc');
    expect(renderSql(query?.orderBy)).toContain('added_at');
  });

  it('marks a watched CARD watched, and mine, off the same rows', async () => {
    const token = tokenRow();
    const { db, calls } = makeDb(
      boardScript({
        cards: [{ call: callRow(), token }],
        watchlist: [watchRow({ token, callId: 500, callStatus: 'active' })],
      }),
    );
    const body = await board(db);
    const card = body.sections.fresh[0];
    expect(card?.watched).toBe(true);
    expect(card?.watchedByMe).toBe(true);
    // ...and ONE watches query served both the cards and the watchlist.
    expect(find(calls, 'select:watches')).toHaveLength(1);
  });

  it('a card watched by someone else is watched, but not mine', async () => {
    const token = tokenRow();
    const { db } = makeDb(
      boardScript({
        cards: [{ call: callRow(), token }],
        watchlist: [watchRow({ token, addedBy: OTHER_USER_ID, callId: 500, callStatus: 'active' })],
      }),
    );
    const card = (await board(db)).sections.fresh[0];
    expect(card?.watched).toBe(true);
    expect(card?.watchedByMe).toBe(false);
  });

  it('fetches sparklines for cards AND watchlist rows in one query', async () => {
    const { db, calls } = makeDb(
      boardScript({
        cards: [{ call: callRow(), token: tokenRow() }],
        watchlist: [watchRow()],
      }),
    );
    await board(db);
    const sparkQueries = find(calls, 'execute');
    expect(sparkQueries).toHaveLength(1);
    const params = dialect.sqlToQuery(sparkQueries[0]?.where as SQL).params;
    expect(params).toContain(TOKEN_ID);
    expect(params).toContain(88);
  });
});

/**
 * Whose slot is this (docs/decisions.md round 16 review)? `watches.added_by`
 * and `mentions.user_id` are the same Telegram user id, so a slot holder's own
 * most recent mention in THIS group is the freshest display name we hold for
 * them. "@member's slot" is what makes the cap actionable — "unwatch one
 * first", but whose?
 */
describe('WatchlistEntry.addedByName', () => {
  it('names the slot holder from their own latest mention in this group', async () => {
    const { db } = makeDb(
      boardScript({
        watchlist: [watchRow({ addedBy: OTHER_USER_ID })],
        names: [{ userId: OTHER_USER_ID, userName: '@pwnzssg' }],
      }),
    );
    expect((await board(db)).watchlist[0]?.addedByName).toBe('@pwnzssg');
  });

  it('stays null for a member who has never posted here — never a guess', async () => {
    const { db } = makeDb(
      boardScript({
        watchlist: [watchRow({ addedBy: OTHER_USER_ID })],
        names: [{ userId: 12345, userName: '@someone-else' }],
      }),
    );
    expect((await board(db)).watchlist[0]?.addedByName).toBeNull();
  });

  it('asks once for every slot holder, scoped to this group s calls', async () => {
    const { db, calls } = makeDb(
      boardScript({
        watchlist: [
          watchRow({ addedBy: USER_ID }),
          watchRow({ token: tokenRow({ id: 89 }), addedBy: OTHER_USER_ID }),
          watchRow({ token: tokenRow({ id: 90 }), addedBy: USER_ID }),
        ],
        names: [{ userId: USER_ID, userName: '@caller' }],
      }),
    );
    const body = await board(db);
    expect(body.watchlist.map((e) => e.addedByName)).toEqual(['@caller', null, '@caller']);
    const queries = find(calls, 'select:mentions');
    expect(queries).toHaveLength(1);
    // Group-scoped, and asked for each DISTINCT holder exactly once.
    const params = whereParams(queries[0]);
    expect(params).toEqual([GROUP_ID, USER_ID, OTHER_USER_ID]);
  });

  it('asks nothing at all when the group watches nothing', async () => {
    const { db, calls } = makeDb(boardScript({}));
    await board(db);
    expect(find(calls, 'select:mentions')).toHaveLength(0);
    expect(find(calls, 'select:groupMembers')).toHaveLength(0);
  });

  it('prefers the cached display name over the mention name', async () => {
    // The membership check writes the name Telegram reports today; a mention
    // is whatever they typed under weeks ago.
    const { db } = makeDb(
      boardScript({
        watchlist: [watchRow({ addedBy: OTHER_USER_ID })],
        names: [{ userId: OTHER_USER_ID, userName: '@old-handle' }],
        memberNames: [{ userId: OTHER_USER_ID, displayName: '@friend' }],
      }),
    );
    expect((await board(db)).watchlist[0]?.addedByName).toBe('@friend');
  });

  it('names a member who never posted a call, from the membership cache alone', async () => {
    const { db } = makeDb(
      boardScript({
        watchlist: [watchRow({ addedBy: OTHER_USER_ID })],
        memberNames: [{ userId: OTHER_USER_ID, displayName: '@friend' }],
      }),
    );
    expect((await board(db)).watchlist[0]?.addedByName).toBe('@friend');
  });

  it('falls back to the mention name when the cached name is null', async () => {
    const { db } = makeDb(
      boardScript({
        watchlist: [watchRow({ addedBy: OTHER_USER_ID })],
        names: [{ userId: OTHER_USER_ID, userName: '@pwnzssg' }],
        memberNames: [{ userId: OTHER_USER_ID, displayName: null }],
      }),
    );
    expect((await board(db)).watchlist[0]?.addedByName).toBe('@pwnzssg');
  });
});

/* ----------------------------------------------- SleeperEntry watch flags */

type SleeperRow = typeof sleeperEntries.$inferSelect;

function sleeperRow(over: Partial<SleeperRow> = {}): SleeperRow {
  return {
    id: 1,
    scanAt: AT,
    bandLoUsd: 50_000,
    bandHiUsd: 100_000,
    rank: 1,
    address: ADDRESS,
    symbol: 'SLPR',
    name: 'Sleeper',
    imageUrl: null,
    twitterUrl: 'https://x.com/sleeper',
    websiteUrl: null,
    poolAddress: '0xpool',
    mcapUsd: 80_000,
    vol24Usd: 40_000,
    liquidityUsd: 20_000,
    txns24: 100,
    turnover: 0.5,
    inBandHours: 12,
    residencyMeasuredAt: AT,
    isStock: false,
    poolCreatedAt: new Date(AT.getTime() - 48 * 3_600_000),
    ...over,
  };
}

async function sleepers(db: Db, query = ''): Promise<SleepersResponse> {
  const res = await testApp(db).request(`/api/g/${SLUG}/sleepers${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as SleepersResponse;
}

/** The scan rows, the group's called addresses, the seen ledger, the watches. */
function sleeperScript(options: { rows?: SleeperRow[]; watches?: unknown[] }): Script {
  return {
    'select:sleeperEntries': [options.rows ?? []],
    'select:calls': [[]],
    'select:sleeperSeen': [[]],
    'select:watches': [options.watches ?? []],
  };
}

const firstEntry = (body: SleepersResponse) => body.bands[0]?.entries[0];

describe('SleeperEntry.watched / watchedByMe', () => {
  it('is unwatched when the group watches nothing', async () => {
    const { db } = makeDb(sleeperScript({ rows: [sleeperRow()] }));
    const entry = firstEntry(await sleepers(db));
    expect(entry?.address).toBe(ADDRESS);
    expect(entry?.watched).toBe(false);
    expect(entry?.watchedByMe).toBe(false);
  });

  it('marks the reader s own slot, matching on address whatever its case', async () => {
    const { db } = makeDb(
      sleeperScript({
        rows: [sleeperRow()],
        // A sleeper has no token id here: the address is all the two share.
        watches: [{ address: ADDRESS.toUpperCase().replace('0X', '0x'), addedBy: USER_ID }],
      }),
    );
    const entry = firstEntry(await sleepers(db));
    expect(entry?.watched).toBe(true);
    expect(entry?.watchedByMe).toBe(true);
  });

  it('marks another member s watch watched but not mine', async () => {
    const { db } = makeDb(
      sleeperScript({ rows: [sleeperRow()], watches: [{ address: ADDRESS, addedBy: OTHER_USER_ID }] }),
    );
    const entry = firstEntry(await sleepers(db));
    expect(entry?.watched).toBe(true);
    expect(entry?.watchedByMe).toBe(false);
  });

  it('leaves an unwatched row in the same payload unwatched', async () => {
    const other = `0x${'2'.repeat(40)}`;
    const { db } = makeDb(
      sleeperScript({
        rows: [sleeperRow(), sleeperRow({ id: 2, rank: 2, address: other })],
        watches: [{ address: ADDRESS, addedBy: USER_ID }],
      }),
    );
    const entries = (await sleepers(db)).bands[0]?.entries ?? [];
    expect(entries.map((e) => e.watched)).toEqual([true, false]);
  });

  it('asks for the group s active watches ONCE, not per row', async () => {
    const { db, calls } = makeDb(
      sleeperScript({
        rows: [sleeperRow(), sleeperRow({ id: 2, rank: 2, address: `0x${'2'.repeat(40)}` })],
        watches: [{ address: ADDRESS, addedBy: USER_ID }],
      }),
    );
    await sleepers(db);
    const queries = find(calls, 'select:watches');
    expect(queries).toHaveLength(1);
    expect(whereParams(queries[0])).toEqual([GROUP_ID, true]);
  });
});

/* --------------------------------------------- Sleepers stocks toggle (r17) */

/** A stock and a coin in the same band, the stock ranked first on turnover. */
const stockRows = (): SleeperRow[] => [
  sleeperRow({ id: 1, rank: 1, symbol: 'QQQ', name: 'Invesco QQQ • Robinhood Token', isStock: true }),
  sleeperRow({ id: 2, rank: 2, address: `0x${'2'.repeat(40)}`, symbol: 'SLPR', isStock: false }),
];

describe('GET /api/g/:slug/sleepers — the no-stocks default', () => {
  it('excludes tokenized stocks when nothing is asked for, and says so', async () => {
    const { db } = makeDb(sleeperScript({ rows: stockRows() }));
    const body = await sleepers(db);
    expect(body.excludeStocks).toBe(true);
    expect(body.bands[0]?.entries.map((e) => e.symbol)).toEqual(['SLPR']);
  });

  it('includes them on stocks=1, flagged, behind the coins, and echoes the toggle', async () => {
    const { db } = makeDb(sleeperScript({ rows: stockRows() }));
    const body = await sleepers(db, '?stocks=1');
    expect(body.excludeStocks).toBe(false);
    // QQQ outranks SLPR on turnover, but the band leads with its coins: the
    // reader asked to SEE stocks, not to have them take the top of the band.
    expect(body.bands[0]?.entries.map((e) => e.symbol)).toEqual(['SLPR', 'QQQ']);
    expect(body.bands[0]?.entries.map((e) => e.isStock)).toEqual([false, true]);
  });

  it('treats any other value as the default, never as "show them"', async () => {
    for (const query of ['?stocks=0', '?stocks=true', '?stocks=', '?stocks=11']) {
      const { db } = makeDb(sleeperScript({ rows: stockRows() }));
      const body = await sleepers(db, query);
      expect(body.excludeStocks).toBe(true);
      expect(body.bands[0]?.entries.map((e) => e.symbol)).toEqual(['SLPR']);
    }
  });
});

/* ------------------------------------ Sleepers: the serve cut is per kind */

/** One band whose top three turnover ranks are equities, with a coin under them. */
const stockHeavyBand = (): SleeperRow[] => [
  sleeperRow({ id: 1, rank: 1, address: `0x${'a'.repeat(40)}`, symbol: 'QQQ', isStock: true }),
  sleeperRow({ id: 2, rank: 2, address: `0x${'b'.repeat(40)}`, symbol: 'TSM', isStock: true }),
  sleeperRow({ id: 3, rank: 3, address: `0x${'c'.repeat(40)}`, symbol: 'PLTR', isStock: true }),
  sleeperRow({ id: 4, rank: 4, address: `0x${'d'.repeat(40)}`, symbol: 'SLPR', isStock: false }),
  sleeperRow({ id: 5, rank: 5, address: `0x${'e'.repeat(40)}`, symbol: 'MRNA', isStock: true }),
];

describe('GET /api/g/:slug/sleepers — servePerBand applies per kind', () => {
  it('serves the coin under three equities when stocks are excluded', async () => {
    const { db } = makeDb(sleeperScript({ rows: stockHeavyBand() }));
    expect((await sleepers(db)).bands[0]?.entries.map((e) => e.symbol)).toEqual(['SLPR']);
  });

  it('adds up to three stocks WITHOUT displacing that coin', async () => {
    // The whole point of the toggle: turning stocks on may only ever add rows.
    // A single union-wide top-3 cut would have served QQQ/TSM/PLTR and dropped
    // the one coin the default view showed.
    const { db } = makeDb(sleeperScript({ rows: stockHeavyBand() }));
    const symbols = (await sleepers(db, '?stocks=1')).bands[0]?.entries.map((e) => e.symbol);
    expect(symbols).toEqual(['SLPR', 'QQQ', 'TSM', 'PLTR']);
  });
});

/* ------------------------------------------- Sleepers: the xOnly echo (r17) */

describe('GET /api/g/:slug/sleepers — the X-only echo', () => {
  it('reports the twitter-required default', async () => {
    const { db } = makeDb(sleeperScript({ rows: [sleeperRow()] }));
    expect((await sleepers(db)).xOnly).toBe(true);
  });

  it('reports all=1, and serves the entries with no X account', async () => {
    const { db } = makeDb(
      sleeperScript({ rows: [sleeperRow({ symbol: 'NOX', twitterUrl: null })] }),
    );
    const body = await sleepers(db, '?all=1');
    expect(body.xOnly).toBe(false);
    expect(body.bands[0]?.entries.map((e) => e.symbol)).toEqual(['NOX']);
  });
});
