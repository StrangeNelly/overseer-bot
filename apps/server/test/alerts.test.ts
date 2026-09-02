import { describe, expect, it } from 'vitest';
import { is, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { SQL as SQLClass } from 'drizzle-orm/sql/sql';
import { alerts, watches, type Db } from '@groupie/db';
import { runAlertPass } from '../src/poller/alerts.js';
import { subscribe, type GroupieEvent } from '../src/events.js';

/**
 * The alert pass END TO END (docs/decisions.md round 19): what the watch row
 * carries into the rule, what the backfill hands back mid-pass, what an alert
 * row actually stores, and what the armed flag is written as afterwards.
 *
 * Same scripted-Drizzle style as watchlist.test.ts: the builder is faked and
 * the assertions are about the statements the pass attempted. `execute` is
 * routed by the statement it was handed, because the pass uses it for three
 * different things (the backfill, the series load, the guarded insert).
 */

const dialect = new PgDialect();

const GROUP_ID = 1;
const TOKEN_ID = 7;
const WATCH_ID = 55;
const WATCHED_AT = 120_000;

interface Recorded {
  key: string;
  set?: Record<string, unknown>;
  where?: SQL;
  /** For `execute`: the rendered statement. */
  text?: string;
  statement?: SQL;
}

function chain(record: Recorded, rows: () => unknown[]) {
  const node: Record<string, unknown> = {
    then: (ok: (r: unknown[]) => unknown, err: (e: unknown) => unknown) =>
      Promise.resolve()
        .then(rows)
        .then(ok, err),
  };
  for (const method of ['set', 'from', 'where', 'innerJoin', 'groupBy', 'orderBy', 'returning']) {
    node[method] = (...args: unknown[]) => {
      if (method === 'set') record.set = args[0] as Record<string, unknown>;
      if (method === 'where') record.where = args[0] as SQL;
      return node;
    };
  }
  return node;
}

interface Scenario {
  /** loadWatches' rows, as the join hands them over. */
  watchRows: Array<Record<string, unknown>>;
  /** backfillBaselines' RETURNING rows — driver strings, like the real one. */
  backfill?: Array<Record<string, unknown>>;
  series?: Array<Record<string, unknown>>;
  lastFired?: Array<Record<string, unknown>>;
  /** false = the atomic cooldown guard swallowed the insert. */
  inserts?: boolean;
}

function makeDb(scenario: Scenario): { db: Db; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const push = (record: Recorded): Recorded => {
    calls.push(record);
    return record;
  };
  const db = {
    select: () => ({
      from: (table: unknown) => {
        const record = push({ key: table === alerts ? 'select:alerts' : 'select:watches' });
        return chain(record, () =>
          table === alerts ? (scenario.lastFired ?? []) : scenario.watchRows,
        );
      },
    }),
    update: (table: unknown) => {
      const record = push({ key: table === watches ? 'update:watches' : 'update:unknown' });
      return chain(record, () => []);
    },
    execute: (statement: unknown) => {
      const text = is(statement, SQLClass) ? dialect.sqlToQuery(statement).sql : String(statement);
      push({ key: 'execute', text, statement: statement as SQL });
      if (text.includes('update "watches"')) return Promise.resolve(scenario.backfill ?? []);
      if (text.includes('insert into "alerts"')) {
        return Promise.resolve(scenario.inserts === false ? [] : [{ id: 1 }]);
      }
      return Promise.resolve(scenario.series ?? []);
    },
  };
  return { db: db as unknown as Db, calls };
}

/** One row of loadWatches, defaulted to an armed watch with a live baseline. */
function watchRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    watchId: WATCH_ID,
    groupId: GROUP_ID,
    groupSettings: {},
    tokenId: TOKEN_ID,
    symbol: 'TKN',
    address: `0x${'1'.repeat(40)}`,
    mcapUsd: 82_000,
    liquidityUsd: 30_000,
    mcapAtWatch: WATCHED_AT,
    buyOppArmed: true,
    ...over,
  };
}

const find = (calls: Recorded[], key: string) => calls.filter((c) => c.key === key);

/** The INSERT the pass attempted, as its parameters. */
function insertedAlert(calls: Recorded[]): { type: string; mcapUsd: number; details: Record<string, unknown> } | undefined {
  const call = find(calls, 'execute').find((c) => c.text?.includes('insert into "alerts"'));
  if (!call?.statement) return undefined;
  const params = dialect.sqlToQuery(call.statement).params as unknown[];
  const json = params.find((p) => typeof p === 'string' && p.startsWith('{')) as string;
  return {
    type: params[2] as string,
    mcapUsd: params[3] as number,
    details: JSON.parse(json) as Record<string, unknown>,
  };
}

async function capture<T>(run: () => Promise<T>): Promise<{ result: T; events: GroupieEvent[] }> {
  const events: GroupieEvent[] = [];
  const off = subscribe((event) => events.push(event));
  try {
    return { result: await run(), events };
  } finally {
    off();
  }
}

describe('runAlertPass — BUY OPP off the watch baseline (round 19)', () => {
  it('fires once, stores the drawdown from the baseline, and disarms the watch', async () => {
    const { db, calls } = makeDb({ watchRows: [watchRow()] });
    const { result, events } = await capture(() => runAlertPass(db));
    expect(result).toBe(1);

    const alert = insertedAlert(calls);
    expect(alert?.type).toBe('buy_opp');
    expect(alert?.mcapUsd).toBe(82_000);
    // -31.7% from the WATCH baseline, with no peak fields at all: a buy-opp row
    // points at the member's entry point, never at a high nobody watched.
    expect(Object.keys(alert?.details ?? {}).sort()).toEqual([
      'dropPct',
      'liquidityUsd',
      'mcapAtWatch',
      'message',
    ]);
    expect(alert?.details.mcapAtWatch).toBe(WATCHED_AT);
    expect(alert?.details.dropPct).toBeCloseTo(31.67, 2);
    expect(alert?.details.liquidityUsd).toBe(30_000);
    expect(alert?.details.message).toBe('🟢 BUY OPP: TKN -32% since watched ($120K → $82K) · LP $30K');

    // ...and the flag moves with it, so the next pass cannot repeat the message.
    const update = find(calls, 'update:watches')[0];
    expect(update?.set).toEqual({ buyOppArmed: false });
    const params = dialect.sqlToQuery(update?.where as SQL).params as unknown[];
    expect(params).toContain(WATCH_ID);
    // The guard: only a row that still says `true` is touched.
    expect(params).toContain(false);

    expect(events).toEqual([
      {
        type: 'alert_fired',
        groupId: GROUP_ID,
        tokenId: TOKEN_ID,
        alertType: 'buy_opp',
        message: alert?.details.message,
      },
    ]);
  });

  it('says nothing about a disarmed watch, and writes no flag', async () => {
    const { db, calls } = makeDb({ watchRows: [watchRow({ buyOppArmed: false })] });
    const { result, events } = await capture(() => runAlertPass(db));
    expect(result).toBe(0);
    expect(insertedAlert(calls)).toBeUndefined();
    expect(find(calls, 'update:watches')).toHaveLength(0);
    expect(events).toEqual([]);
  });

  it('re-arms on a recovery above the line without posting anything', async () => {
    const { db, calls } = makeDb({
      watchRows: [watchRow({ mcapUsd: 130_000, buyOppArmed: false })],
    });
    expect(await runAlertPass(db)).toBe(0);
    expect(insertedAlert(calls)).toBeUndefined();
    const update = find(calls, 'update:watches')[0];
    expect(update?.set).toEqual({ buyOppArmed: true });
    const params = dialect.sqlToQuery(update?.where as SQL).params as unknown[];
    expect(params).toContain(WATCH_ID);
    expect(params).toContain(true);
  });

  it('judges a watch the backfill stamped in this same pass', async () => {
    // The whole point of RETURNING the filled rows: a watch taken before we had
    // a price must not wait a tick to be judged.
    const { db, calls } = makeDb({
      watchRows: [watchRow({ mcapAtWatch: null })],
      // db.execute bypasses the column decoders: postgres-js hands back strings.
      backfill: [{ group_id: String(GROUP_ID), token_id: String(TOKEN_ID), mcap_at_watch: '120000' }],
    });
    expect(await runAlertPass(db)).toBe(1);
    expect(insertedAlert(calls)?.details.mcapAtWatch).toBe(WATCHED_AT);
  });

  it('merges a backfilled baseline by GROUP and token, never by token alone', async () => {
    // Two groups watch the same coin. Only the first has a baseline to fill;
    // keying by token would stamp it onto the second group's watch as well.
    const { db, calls } = makeDb({
      watchRows: [
        watchRow({ mcapAtWatch: null }),
        watchRow({ watchId: 56, groupId: 2, mcapAtWatch: null }),
      ],
      backfill: [{ group_id: String(GROUP_ID), token_id: String(TOKEN_ID), mcap_at_watch: '120000' }],
    });
    expect(await runAlertPass(db)).toBe(1);
    const fired = find(calls, 'execute').filter((c) => c.text?.includes('insert into "alerts"'));
    expect(fired).toHaveLength(1);
    expect((dialect.sqlToQuery(fired[0]?.statement as SQL).params as unknown[])[0]).toBe(GROUP_ID);
    // The unbaselined group is not judged, and its flag is left alone.
    expect(find(calls, 'update:watches')).toHaveLength(1);
  });

  it('asks for no backfill when every watch already has a baseline', async () => {
    const { db, calls } = makeDb({ watchRows: [watchRow()] });
    await runAlertPass(db);
    expect(find(calls, 'execute').filter((c) => c.text?.includes('update "watches"'))).toHaveLength(
      0,
    );
  });

  it('leaves the flag alone when there is no baseline to judge against', async () => {
    const { db, calls } = makeDb({ watchRows: [watchRow({ mcapAtWatch: null })], backfill: [] });
    expect(await runAlertPass(db)).toBe(0);
    expect(find(calls, 'update:watches')).toHaveLength(0);
  });

  it('disarms even when the cooldown swallows the message', async () => {
    // The flag records that this fall has had its message; the cooldown is the
    // backstop, not the state. Leaving it armed would re-post on the next pass.
    const { db, calls } = makeDb({ watchRows: [watchRow()], inserts: false });
    expect(await runAlertPass(db)).toBe(0);
    expect(find(calls, 'update:watches')[0]?.set).toEqual({ buyOppArmed: false });
  });

  it('batches the flags: one statement per value, whatever the watch count', async () => {
    const { db, calls } = makeDb({
      watchRows: [
        watchRow(),
        watchRow({ watchId: 56, groupId: 2, tokenId: 8 }),
        watchRow({ watchId: 57, groupId: 3, tokenId: 9, mcapUsd: 130_000, buyOppArmed: false }),
      ],
    });
    await runAlertPass(db);
    const updates = find(calls, 'update:watches');
    expect(updates).toHaveLength(2);
    const disarm = updates.find((u) => u.set?.buyOppArmed === false);
    const params = dialect.sqlToQuery(disarm?.where as SQL).params as unknown[];
    expect(params).toContain(55);
    expect(params).toContain(56);
    expect(params).not.toContain(57);
  });

  /**
   * Round 19 review: a token whose poll has stalled (a GT hold, a failed fetch)
   * shows the same numbers on every pass for hours. The flag — not the cooldown
   * — is what stops the message repeating once the cooldown releases.
   */
  it('does not re-fire a stalled series after the cooldown has released', async () => {
    const firstPass = makeDb({ watchRows: [watchRow()] });
    expect(await runAlertPass(firstPass.db)).toBe(1);
    expect(find(firstPass.calls, 'update:watches')[0]?.set).toEqual({ buyOppArmed: false });

    // Two hours later: identical readings, the default 60m cooldown long gone,
    // and the row now carries the flag the first pass wrote.
    const stalled = makeDb({ watchRows: [watchRow({ buyOppArmed: false })], lastFired: [] });
    expect(await runAlertPass(stalled.db)).toBe(0);
    expect(insertedAlert(stalled.calls)).toBeUndefined();
  });

  it('asks nothing at all when nobody is watching', async () => {
    const { db, calls } = makeDb({ watchRows: [] });
    expect(await runAlertPass(db)).toBe(0);
    expect(calls.map((c) => c.key)).toEqual(['select:watches']);
  });
});
