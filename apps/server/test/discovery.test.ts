import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Context } from 'grammy';
import { is, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { SQL as SQLClass } from 'drizzle-orm/sql/sql';
import {
  alerts,
  chainCursor,
  discoveryAlertDecisions,
  discoveryEvents,
  groups,
  tokens,
  watches,
  type Db,
} from '@groupie/db';
import {
  DISCOVERY,
  DISCOVERY_DEFAULTS,
  tradingLinks,
  type DiscoveryResponse,
} from '@groupie/shared';
import { createDiscoveryRoutes } from '../src/api/discovery.js';
import {
  deliverDiscoveryAlerts,
  insertDiscoveryAlert,
  qualifiesForChat,
  retireStaleDiscoveryAlerts,
} from '../src/discovery/alerts.js';
import {
  alertsSummary,
  discoverySummary,
  handleGroupieCommand,
  handleSet,
} from '../src/bot/bot.js';
import type { Config } from '../src/config.js';
import { discoverySettingsOf } from '../src/discovery/settings.js';
import { alertSettingsOf } from '../src/poller/alertLogic.js';
import type { ApiEnv, GroupRow } from '../src/api/membership.js';
import { subscribe, type GroupieEvent } from '../src/events.js';

/**
 * The discovery surfaces (docs/decisions.md rounds 18 and 20): what the route
 * hands over, what the chat is allowed to say, and what `/overseer set` writes.
 *
 * Same scripted-Drizzle style as watchlist.test.ts and alerts.test.ts — the
 * builder is faked and the assertions are about the statements attempted and
 * the payload produced.
 */

const dialect = new PgDialect();

const GROUP_ID = 1;
const USER_ID = 4242;
const OTHER_USER_ID = 9001;
const SLUG = 'hammertime';

interface DbCall {
  key: string;
  values?: unknown;
  set?: Record<string, unknown>;
  where?: SQL;
  limit?: unknown;
  /** For `execute`: the rendered statement and its parameters. */
  text?: string;
  params?: unknown[];
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
    if (table === discoveryEvents) return 'discoveryEvents';
    if (table === discoveryAlertDecisions) return 'decisions';
    if (table === chainCursor) return 'chainCursor';
    if (table === alerts) return 'alerts';
    if (table === watches) return 'watches';
    if (table === tokens) return 'tokens';
    if (table === groups) return 'groups';
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
    execute,
    // The discovery insert runs under an advisory lock, exactly like the
    // watchlist's; the fake just runs the body against the same builder.
    transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise.resolve(fn(db)),
  };
  return { db: db as unknown as Db, calls };
}

const find = (calls: DbCall[], key: string) => calls.filter((c) => c.key === key);
const whereSql = (call: DbCall | undefined): string =>
  call?.where ? dialect.sqlToQuery(call.where).sql : '';

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

function testApp(db: Db, running: boolean): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  app.use('/api/g/:slug/*', async (c, next) => {
    c.set('group', GROUP);
    c.set('userId', USER_ID);
    await next();
  });
  app.route('/', createDiscoveryRoutes(db, { running }));
  return app;
}

const LAUNCH_ADDRESS = '0xdd050541fc432d4ce93f3286246a3bd086440ccd';
const GRAD_ADDRESS = '0x446d76590389b371fbbf53a5d9649522d1946d7e';
const GRAD_ADDRESS_2 = '0x9f2c1c9b6f4a1e2d3c4b5a69788796a5b4c3d2e1';
const TICK_AT = new Date('2026-09-02T12:04:00.000Z');

function eventRow(over: Partial<typeof discoveryEvents.$inferSelect> = {}) {
  return {
    id: 1,
    kind: 'launch' as const,
    tokenAddress: LAUNCH_ADDRESS,
    poolAddress: '0x887c2718bfc9133ce881c09f0df18ba572189236',
    dex: 'uniswap-v2-robinhood',
    at: new Date('2026-09-02T12:00:00.000Z'),
    blockNumber: 52_218_000,
    txHash: '0xtx',
    initialLiquidityEth: 5.8,
    initialLiquidityUsd: 23_200,
    quoteSymbol: 'ETH' as 'ETH' | 'USDG' | null,
    symbol: 'RABBIT',
    name: 'Rabbit',
    imageUrl: null,
    twitterUrl: 'https://x.com/rabbit',
    websiteUrl: 'https://rabbit.xyz',
    mcapUsd: 23_000,
    liquidityUsd: 22_000,
    lpLockedPct: 0,
    launchBlockPct: 12,
    launchBlockWallets: 9,
    isStock: false,
    enrichedAt: new Date('2026-09-02T12:02:00.000Z'),
    dataAsOf: new Date('2026-09-02T12:02:00.000Z'),
    lockCheckedAt: new Date('2026-09-02T12:02:30.000Z'),
    alertedAt: null as Date | null,
    createdAt: new Date('2026-09-02T12:00:05.000Z'),
    ...over,
  };
}

/** A route script: launches, then graduations, then the cursor heartbeat. */
const routeScript = (launches: unknown[], graduations: unknown[] = [], rest: Script = {}) => ({
  'select:discoveryEvents': [launches, graduations],
  'select:chainCursor': [[{ updatedAt: TICK_AT }]],
  ...rest,
});

describe('GET /api/g/:slug/discovery', () => {
  it('says enabled:false and asks the database NOTHING when no listener runs here', async () => {
    const { db, calls } = makeDb();
    const res = await testApp(db, false).request(`/api/g/${SLUG}/discovery`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DiscoveryResponse;
    expect(body).toEqual({
      enabled: false,
      lastTickAt: null,
      hours: DISCOVERY.defaultHours,
      filters: { xWeb: true, noBundles: true, noStocks: true },
      bundleMaxPct: DISCOVERY_DEFAULTS.bundleMaxPct,
      launches: [],
      graduations: [],
    });
    // A dormant feature is dormant all the way down: no query, no watch load.
    expect(calls).toHaveLength(0);
  });

  it('maps a row into the contract, links and all', async () => {
    const { db } = makeDb(routeScript([eventRow()]));
    const res = await testApp(db, true).request(`/api/g/${SLUG}/discovery`);
    const body = (await res.json()) as DiscoveryResponse;
    expect(body.enabled).toBe(true);
    expect(body.graduations).toEqual([]);
    expect(body.launches).toHaveLength(1);
    expect(body.launches[0]).toEqual({
      kind: 'launch',
      address: LAUNCH_ADDRESS,
      symbol: 'RABBIT',
      name: 'Rabbit',
      imageUrl: null,
      poolAddress: '0x887c2718bfc9133ce881c09f0df18ba572189236',
      dex: 'uniswap-v2-robinhood',
      at: '2026-09-02T12:00:00.000Z',
      initialLiquidityUsd: 23_200,
      initialLiquidityEth: 5.8,
      quoteSymbol: 'ETH',
      mcapUsd: 23_000,
      liquidityUsd: 22_000,
      dataAsOf: '2026-09-02T12:02:00.000Z',
      lpLockedPct: 0,
      twitterUrl: 'https://x.com/rabbit',
      websiteUrl: 'https://rabbit.xyz',
      launchBlockPct: 12,
      launchBlockWallets: 9,
      isStock: false,
      alerted: false,
      watched: false,
      watchedByMe: false,
      links: tradingLinks(LAUNCH_ADDRESS),
    });
  });

  it('serves the listener heartbeat so a stalled feed is not an empty one', async () => {
    const { db } = makeDb(routeScript([eventRow()]));
    const body = (await (
      await testApp(db, true).request(`/api/g/${SLUG}/discovery`)
    ).json()) as DiscoveryResponse;
    expect(body.lastTickAt).toBe(TICK_AT.toISOString());
  });

  it('asks for each kind on its OWN query, so neither can starve the other', async () => {
    const { db, calls } = makeDb(
      routeScript([eventRow()], [eventRow({ id: 2, kind: 'graduation', tokenAddress: GRAD_ADDRESS })]),
    );
    const body = (await (
      await testApp(db, true).request(`/api/g/${SLUG}/discovery`)
    ).json()) as DiscoveryResponse;
    expect(find(calls, 'select:discoveryEvents')).toHaveLength(2);
    expect(find(calls, 'select:discoveryEvents')[0]?.limit).toBe(100);
    expect(body.launches.map((e) => e.address)).toEqual([LAUNCH_ADDRESS]);
    expect(body.graduations.map((e) => e.address)).toEqual([GRAD_ADDRESS]);
  });

  it('marks a watched coin, and says whose slot it is', async () => {
    const { db } = makeDb(
      routeScript(
        [eventRow()],
        [eventRow({ id: 2, kind: 'graduation', tokenAddress: GRAD_ADDRESS })],
        {
          'select:watches': [
            [
              { address: LAUNCH_ADDRESS, addedBy: USER_ID },
              { address: GRAD_ADDRESS, addedBy: OTHER_USER_ID },
            ],
          ],
        },
      ),
    );
    const body = (await (
      await testApp(db, true).request(`/api/g/${SLUG}/discovery`)
    ).json()) as DiscoveryResponse;
    expect(body.launches[0]).toMatchObject({ watched: true, watchedByMe: true });
    expect(body.graduations[0]).toMatchObject({ watched: true, watchedByMe: false });
  });

  it('reports `alerted` per GROUP, off the decision rows', async () => {
    const { db } = makeDb(
      routeScript([eventRow()], [], { 'select:decisions': [[{ eventId: 1 }]] }),
    );
    const body = (await (
      await testApp(db, true).request(`/api/g/${SLUG}/discovery`)
    ).json()) as DiscoveryResponse;
    expect(body.launches[0]?.alerted).toBe(true);
  });

  it('does NOT call an event alerted just because some other group was told', async () => {
    // The global alerted_at stamp is set; this group has no decision row.
    const { db } = makeDb(
      routeScript([eventRow({ alertedAt: new Date('2026-09-02T12:03:00.000Z') })]),
    );
    const body = (await (
      await testApp(db, true).request(`/api/g/${SLUG}/discovery`)
    ).json()) as DiscoveryResponse;
    expect(body.launches[0]?.alerted).toBe(false);
  });

  it('pushes the three filters into the WHERE clause, on by default', async () => {
    const { db, calls } = makeDb(routeScript([eventRow()]));
    const body = (await (
      await testApp(db, true).request(`/api/g/${SLUG}/discovery`)
    ).json()) as DiscoveryResponse;
    expect(body.filters).toEqual({ xWeb: true, noBundles: true, noStocks: true });
    const sql = whereSql(find(calls, 'select:discoveryEvents')[0]);
    expect(sql).toContain('"twitter_url" is not null');
    expect(sql).toContain('"website_url" is not null');
    expect(sql).toContain('"is_stock" = false');
    expect(sql).toContain('"launch_block_pct" is null');
  });

  it('drops exactly the filter a chip turned off, and echoes what it applied', async () => {
    const { db, calls } = makeDb(routeScript([eventRow()]));
    const body = (await (
      await testApp(db, true).request(`/api/g/${SLUG}/discovery?xweb=0`)
    ).json()) as DiscoveryResponse;
    expect(body.filters).toEqual({ xWeb: false, noBundles: true, noStocks: true });
    const sql = whereSql(find(calls, 'select:discoveryEvents')[0]);
    expect(sql).not.toContain('"twitter_url" is not null');
    expect(sql).toContain('"is_stock" = false');
  });

  it('turns every filter off only when every flag says 0', async () => {
    const { db, calls } = makeDb(routeScript([eventRow()]));
    const body = (await (
      await testApp(db, true).request(`/api/g/${SLUG}/discovery?xweb=0&bundles=0&stocks=0`)
    ).json()) as DiscoveryResponse;
    expect(body.filters).toEqual({ xWeb: false, noBundles: false, noStocks: false });
    const sql = whereSql(find(calls, 'select:discoveryEvents')[0]);
    expect(sql).not.toContain('"is_stock"');
    expect(sql).not.toContain('"launch_block_pct"');
  });

  it('keeps a flag ON for anything but an explicit 0', async () => {
    const { db } = makeDb(routeScript([eventRow()]));
    const body = (await (
      await testApp(db, true).request(`/api/g/${SLUG}/discovery?stocks=nope`)
    ).json()) as DiscoveryResponse;
    expect(body.filters.noStocks).toBe(true);
  });

  it('never hides an UNKNOWN launch block — unknown is not evidence', async () => {
    const { db, calls } = makeDb(routeScript([eventRow({ launchBlockPct: null })]));
    const body = (await (
      await testApp(db, true).request(`/api/g/${SLUG}/discovery`)
    ).json()) as DiscoveryResponse;
    expect(body.launches).toHaveLength(1);
    expect(whereSql(find(calls, 'select:discoveryEvents')[0])).toContain(
      '"launch_block_pct" is null or',
    );
  });

  /* ------------------------------------------ round 22: the graduation floor */

  const grad = (over: Partial<typeof discoveryEvents.$inferSelect> = {}) =>
    eventRow({ id: 2, kind: 'graduation', tokenAddress: GRAD_ADDRESS, ...over });

  it('drops a graduation that has fallen back under the floor, and keeps the one at it', async () => {
    const { db } = makeDb(
      routeScript(
        [],
        [
          grad({ mcapUsd: 12_000 }),
          grad({ id: 3, tokenAddress: GRAD_ADDRESS_2, mcapUsd: DISCOVERY.graduationMinMcapUsd }),
        ],
      ),
    );
    const body = (await (
      await testApp(db, true).request(`/api/g/${SLUG}/discovery`)
    ).json()) as DiscoveryResponse;
    // AT the floor is on the board; a dollar under it is not.
    expect(body.graduations.map((e) => e.address)).toEqual([GRAD_ADDRESS_2]);
  });

  it('applies the floor with every chip off too — a floor is not a filter chip', async () => {
    const { db, calls } = makeDb(
      routeScript(
        [],
        [grad({ mcapUsd: 12_000 }), grad({ id: 3, tokenAddress: GRAD_ADDRESS_2, mcapUsd: 40_000 })],
      ),
    );
    const body = (await (
      await testApp(db, true).request(`/api/g/${SLUG}/discovery?xweb=0&bundles=0&stocks=0`)
    ).json()) as DiscoveryResponse;
    expect(body.filters).toEqual({ xWeb: false, noBundles: false, noStocks: false });
    expect(body.graduations.map((e) => e.address)).toEqual([GRAD_ADDRESS_2]);
    expect(whereSql(find(calls, 'select:discoveryEvents')[1])).toContain('"mcap_usd"');
  });

  it('never hides a graduation whose mcap we could not read — unknown is not a verdict', async () => {
    const { db } = makeDb(routeScript([], [grad({ mcapUsd: null })]));
    const body = (await (
      await testApp(db, true).request(`/api/g/${SLUG}/discovery`)
    ).json()) as DiscoveryResponse;
    expect(body.graduations.map((e) => e.address)).toEqual([GRAD_ADDRESS]);
  });

  it('leaves LAUNCHES alone: a new pool legitimately opens under the floor', async () => {
    const { db, calls } = makeDb(routeScript([eventRow({ mcapUsd: 12_000 })]));
    const body = (await (
      await testApp(db, true).request(`/api/g/${SLUG}/discovery`)
    ).json()) as DiscoveryResponse;
    expect(body.launches).toHaveLength(1);
    expect(whereSql(find(calls, 'select:discoveryEvents')[0])).not.toContain('"mcap_usd"');
  });

  it('renders the floor on the GRADUATION query only, at the shared constant', async () => {
    const { db, calls } = makeDb(routeScript([eventRow()], [grad()]));
    await testApp(db, true).request(`/api/g/${SLUG}/discovery`);
    const [launchQuery, gradQuery] = find(calls, 'select:discoveryEvents');
    expect(whereSql(launchQuery)).not.toContain('"mcap_usd"');
    const rendered = dialect.sqlToQuery(gradQuery!.where!);
    expect(rendered.sql).toContain('"mcap_usd" is null or');
    expect(rendered.params).toContain(DISCOVERY.graduationMinMcapUsd);
    expect(DISCOVERY.graduationMinMcapUsd).toBe(15_000);
  });

  it('asks only for the kind requested', async () => {
    const { db, calls } = makeDb(routeScript([eventRow()]));
    await testApp(db, true).request(`/api/g/${SLUG}/discovery?kind=launch`);
    expect(find(calls, 'select:discoveryEvents')).toHaveLength(1);
    const where = dialect.sqlToQuery(find(calls, 'select:discoveryEvents')[0]!.where!);
    expect(where.params).toContain('launch');
    expect(where.params).not.toContain('graduation');
  });

  it('400s on a kind or an hours it cannot serve', async () => {
    const { db } = makeDb();
    const bad = await testApp(db, true).request(`/api/g/${SLUG}/discovery?kind=rumours`);
    expect(bad.status).toBe(400);
    const worse = await testApp(db, true).request(`/api/g/${SLUG}/discovery?hours=-3`);
    expect(worse.status).toBe(400);
  });

  it('clamps hours to what retention can actually back', async () => {
    const { db } = makeDb(routeScript([]));
    const body = (await (
      await testApp(db, true).request(`/api/g/${SLUG}/discovery?hours=99999`)
    ).json()) as DiscoveryResponse;
    expect(body.hours).toBe(DISCOVERY.maxHours);
    expect(DISCOVERY.maxHours / 24).toBeLessThanOrEqual(DISCOVERY.retentionDays);
  });
});

/* ------------------------------------------------------------- chat alerts */

const DEFAULT_DISCOVERY = { launchMinEth: 5, gradsOn: true };

describe('qualifiesForChat', () => {
  it('posts a launch above the group threshold that passes every filter', () => {
    expect(qualifiesForChat(eventRow(), DEFAULT_DISCOVERY)).toBe(true);
  });

  it('keeps a thin launch board-only', () => {
    expect(qualifiesForChat(eventRow({ initialLiquidityEth: 1.2 }), DEFAULT_DISCOVERY)).toBe(false);
  });

  it('is muted at launchMinEth 0, however big the launch', () => {
    expect(
      qualifiesForChat(eventRow({ initialLiquidityEth: 500 }), { launchMinEth: 0, gradsOn: true }),
    ).toBe(false);
  });

  it('posts a graduation only while grads are on', () => {
    const grad = eventRow({ kind: 'graduation', initialLiquidityEth: null });
    expect(qualifiesForChat(grad, DEFAULT_DISCOVERY)).toBe(true);
    expect(qualifiesForChat(grad, { launchMinEth: 5, gradsOn: false })).toBe(false);
  });

  it('never posts something the board itself would hide', () => {
    expect(qualifiesForChat(eventRow({ twitterUrl: null }), DEFAULT_DISCOVERY)).toBe(false);
    expect(qualifiesForChat(eventRow({ isStock: true }), DEFAULT_DISCOVERY)).toBe(false);
    expect(qualifiesForChat(eventRow({ launchBlockPct: 40 }), DEFAULT_DISCOVERY)).toBe(false);
  });

  it('refuses a graduation that has fallen back under the floor (round 22)', () => {
    const under = eventRow({ kind: 'graduation', initialLiquidityEth: null, mcapUsd: 12_000 });
    expect(qualifiesForChat(under, DEFAULT_DISCOVERY)).toBe(false);
    const over = eventRow({ kind: 'graduation', initialLiquidityEth: null, mcapUsd: 20_000 });
    expect(qualifiesForChat(over, DEFAULT_DISCOVERY)).toBe(true);
  });

  it('leaves an UNKNOWN mcap exactly where it was: the toggle is the only question', () => {
    const unknown = eventRow({ kind: 'graduation', initialLiquidityEth: null, mcapUsd: null });
    expect(qualifiesForChat(unknown, DEFAULT_DISCOVERY)).toBe(true);
    expect(qualifiesForChat(unknown, { launchMinEth: 5, gradsOn: false })).toBe(false);
  });

  it('never applies the floor to a launch — a new pool opens small', () => {
    expect(qualifiesForChat(eventRow({ mcapUsd: 12_000 }), DEFAULT_DISCOVERY)).toBe(true);
  });
});

describe('insertDiscoveryAlert', () => {
  const params = {
    groupId: GROUP_ID,
    type: 'launch' as const,
    mcapUsd: 23_000,
    poolAddress: '0xpool',
    alertsPerHour: 3,
    details: { pool: '0xpool' },
    nowMs: Date.UTC(2026, 8, 2, 12, 5),
  };

  it('serializes a group on an advisory lock, like the watchlist insert', async () => {
    const { db, calls } = makeDb({
      'select:alerts': [[], [{ n: 0 }]],
      'insert:alerts': [[{ id: 1 }]],
    });
    expect(await insertDiscoveryAlert(db, params)).toBe('inserted');
    expect(find(calls, 'execute')[0]?.text).toContain('pg_advisory_xact_lock');
  });

  it('tells a DUPLICATE apart from a CAP — they are different outcomes', async () => {
    const dup = makeDb({ 'select:alerts': [[{ id: 7 }]] });
    expect(await insertDiscoveryAlert(dup.db, params)).toBe('duplicate');
    // ...and it never even asked for the hourly count.
    expect(find(dup.calls, 'insert:alerts')).toHaveLength(0);

    const capped = makeDb({ 'select:alerts': [[], [{ n: 3 }]] });
    expect(await insertDiscoveryAlert(capped.db, params)).toBe('capped');
    expect(find(capped.calls, 'insert:alerts')).toHaveLength(0);
  });

  it('reads the count back as a number even when postgres sends a string', async () => {
    const { db } = makeDb({ 'select:alerts': [[], [{ n: '3' }]] });
    expect(await insertDiscoveryAlert(db, params)).toBe('capped');
  });

  it('reports a lost race as a duplicate: the unique index decides, not the SELECT', async () => {
    const { db } = makeDb({ 'select:alerts': [[], [{ n: 0 }]], 'insert:alerts': [[]] });
    expect(await insertDiscoveryAlert(db, params)).toBe('duplicate');
  });

  it('files the alert with NO token id — a discovery coin has no row', async () => {
    const { db, calls } = makeDb({
      'select:alerts': [[], [{ n: 0 }]],
      'insert:alerts': [[{ id: 1 }]],
    });
    await insertDiscoveryAlert(db, params);
    expect(find(calls, 'insert:alerts')[0]?.values).toMatchObject({ tokenId: null });
  });
});

/** Collect the events published while `run` was in flight. */
async function capture(run: () => Promise<unknown>): Promise<GroupieEvent[]> {
  const events: GroupieEvent[] = [];
  const stop = subscribe((event) => events.push(event));
  try {
    await run();
  } finally {
    stop();
  }
  return events;
}

describe('deliverDiscoveryAlerts', () => {
  const scriptFor = (
    rows: unknown[],
    over: { alerts?: unknown[][]; settings?: unknown } = {},
  ): Script => ({
    'select:groups': [[{ id: GROUP_ID, settings: over.settings ?? {} }]],
    'select:discoveryEvents': [rows],
    'select:decisions': [[]],
    'select:alerts': over.alerts ?? [[], [{ n: 0 }]],
    'insert:alerts': [[{ id: 1 }]],
  });

  it('posts one message, files a SENT decision, and publishes it with no token id', async () => {
    const { db, calls } = makeDb(scriptFor([eventRow()]));
    const events = await capture(() => deliverDiscoveryAlerts(db));
    expect(events).toEqual([
      {
        type: 'alert_fired',
        groupId: GROUP_ID,
        tokenId: null,
        alertType: 'launch',
        message: expect.stringContaining('RABBIT launched on Uniswap v2'),
      },
    ]);
    expect(find(calls, 'insert:decisions')[0]?.values).toMatchObject({
      eventId: 1,
      groupId: GROUP_ID,
      outcome: 'sent',
    });
  });

  it('files a CAPPED decision over the ceiling, and says nothing', async () => {
    const { db, calls } = makeDb(scriptFor([eventRow()], { alerts: [[], [{ n: 3 }]] }));
    const events = await capture(() => deliverDiscoveryAlerts(db));
    expect(events).toEqual([]);
    expect(find(calls, 'insert:decisions')[0]?.values).toMatchObject({ outcome: 'capped' });
  });

  it('files a FILTERED decision for a row the board itself would hide', async () => {
    const { db, calls } = makeDb(scriptFor([eventRow({ websiteUrl: null })]));
    const events = await capture(() => deliverDiscoveryAlerts(db));
    expect(events).toEqual([]);
    expect(find(calls, 'insert:decisions')[0]?.values).toMatchObject({ outcome: 'filtered' });
    // Nothing was attempted against `alerts` at all.
    expect(find(calls, 'insert:alerts')).toHaveLength(0);
  });

  /**
   * Round 22, owner: graduations are a BOARD surface. The default is off, so a
   * graduation that passes every filter and is minutes old still says nothing in
   * the chat until the group has opted in.
   */
  const GRAD_EVENT = () => eventRow({ kind: 'graduation', initialLiquidityEth: null });

  it('files a FILTERED decision for a graduation until the group opts in', async () => {
    const { db, calls } = makeDb(scriptFor([GRAD_EVENT()]));
    const events = await capture(() => deliverDiscoveryAlerts(db));
    expect(events).toEqual([]);
    expect(find(calls, 'insert:decisions')[0]?.values).toMatchObject({ outcome: 'filtered' });
    expect(find(calls, 'insert:alerts')).toHaveLength(0);
  });

  it('...and posts it once /overseer set grads on has written the opt-in', async () => {
    const { db } = makeDb(
      scriptFor([GRAD_EVENT()], { settings: { discovery: { gradsOn: true } } }),
    );
    const events = await capture(() => deliverDiscoveryAlerts(db));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ alertType: 'graduation' });
  });

  it('still refuses an opted-in graduation that has fallen under the floor', async () => {
    const { db, calls } = makeDb(
      scriptFor([eventRow({ kind: 'graduation', initialLiquidityEth: null, mcapUsd: 12_000 })], {
        settings: { discovery: { gradsOn: true } },
      }),
    );
    expect(await deliverDiscoveryAlerts(db)).toBe(0);
    expect(find(calls, 'insert:decisions')[0]?.values).toMatchObject({ outcome: 'filtered' });
  });

  it('short-circuits a group with alertsPerHour 0 BEFORE building a message', async () => {
    const { db, calls } = makeDb(
      scriptFor([eventRow()], { settings: { discovery: { alertsPerHour: 0 } } }),
    );
    await deliverDiscoveryAlerts(db);
    expect(find(calls, 'insert:decisions')[0]?.values).toMatchObject({ outcome: 'capped' });
    expect(find(calls, 'select:alerts')).toHaveLength(0);
  });

  it('sends the group its OWN cap, not the default', async () => {
    const { db, calls } = makeDb(
      scriptFor([eventRow()], { settings: { discovery: { alertsPerHour: 1 } } }),
    );
    await deliverDiscoveryAlerts(db);
    // The count read is the cap check; the insert only happens under it.
    expect(find(calls, 'insert:alerts')).toHaveLength(1);
  });

  it('files a DUPLICATE as sent, and publishes nothing a second time', async () => {
    // The insert lost the race (or the row was already there): the group HAS
    // been told, so the decision is 'sent' — but nothing may be published or
    // logged again, or one launch becomes two messages in the chat.
    const { db, calls } = makeDb({ ...scriptFor([eventRow()]), 'insert:alerts': [[]] });
    const events = await capture(() => deliverDiscoveryAlerts(db));
    expect(events).toEqual([]);
    expect(find(calls, 'insert:decisions')[0]?.values).toMatchObject({ outcome: 'sent' });
  });

  it('never re-considers a pair this group has already been answered about', async () => {
    const { db, calls } = makeDb({
      ...scriptFor([eventRow()]),
      'select:decisions': [[{ eventId: 1, groupId: GROUP_ID }]],
    });
    const events = await capture(() => deliverDiscoveryAlerts(db));
    expect(events).toEqual([]);
    expect(find(calls, 'insert:decisions')).toHaveLength(0);
  });

  it('only considers enriched rows inside the FIFTEEN-minute alert window', async () => {
    const { db, calls } = makeDb(scriptFor([]));
    await deliverDiscoveryAlerts(db);
    const where = whereSql(find(calls, 'select:discoveryEvents')[0]);
    expect(where).toContain('"enriched_at" is not null');
    // The window itself: 15 minutes, not the 60 the first cut shipped.
    expect(DISCOVERY.maxAlertAgeMinutes).toBe(15);
    const params = dialect.sqlToQuery(
      find(calls, 'select:discoveryEvents')[0]!.where!,
    ).params as unknown[];
    // The driver renders a Date parameter as an ISO string; either form is a
    // window bound, and the two of them are exactly the window apart.
    const bounds = params
      .filter(
        (p): p is Date | string =>
          p instanceof Date || (typeof p === 'string' && /^\d{4}-\d\d-\d\dT/.test(p)),
      )
      .map((p) => (p instanceof Date ? p.getTime() : Date.parse(p)));
    expect(Math.max(...bounds) - Math.min(...bounds)).toBe(
      DISCOVERY.maxAlertAgeMinutes * 60_000,
    );
  });

  it('says nothing at all when no group is active', async () => {
    const { db, calls } = makeDb({ 'select:groups': [[]] });
    expect(await deliverDiscoveryAlerts(db)).toBe(0);
    expect(find(calls, 'select:discoveryEvents')).toHaveLength(0);
  });
});

describe('retireStaleDiscoveryAlerts', () => {
  it('files ONE stale decision per (event, active group), and never a second', async () => {
    const { db, calls } = makeDb();
    await retireStaleDiscoveryAlerts(db);
    const statement = find(calls, 'execute')[0];
    expect(statement?.text).toContain('insert into "discovery_alert_decisions"');
    expect(statement?.text).toContain("'stale'");
    expect(statement?.text).toContain("g.status = 'active'");
    expect(statement?.text).toContain('on conflict (event_id, group_id) do nothing');
  });

  it('casts its bounds instead of handing a bare Date to raw SQL', async () => {
    const { db, calls } = makeDb();
    await retireStaleDiscoveryAlerts(db);
    const statement = find(calls, 'execute')[0];
    expect(statement?.text).toContain('::timestamptz');
    for (const param of statement?.params ?? []) {
      expect(param).toEqual(expect.any(String));
    }
  });
});

/* ------------------------------------------------------------ bot commands */

describe('/overseer set launch | grads', () => {
  const replies: string[] = [];
  const ctx = { reply: async (text: string) => void replies.push(text) } as unknown as Context;

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

  const set = async (db: Db, args: string[], enabled = true) => {
    replies.length = 0;
    await handleSet(db, ctx, GROUP, args, enabled);
    return replies;
  };

  it('writes the launch threshold under settings.discovery', async () => {
    const { db, calls } = makeDb({ 'update:groups': [[{ settings: {} }]] });
    await set(db, ['launch', '8']);
    const call = find(calls, 'update:groups')[0];
    expect(patchOf(call)).toEqual({ launchMinEth: 8 });
    expect(pathOf(call)).toContain("'{discovery}'");
  });

  it('accepts a decimal, and 0 as the mute', async () => {
    const decimal = makeDb({ 'update:groups': [[{ settings: {} }]] });
    await set(decimal.db, ['launch', '2.5']);
    expect(patchOf(find(decimal.calls, 'update:groups')[0])).toEqual({ launchMinEth: 2.5 });

    // The reply is read back off the RETURNING row, never off the patch — so
    // what the group is told is what the group now actually lives under.
    const muted = makeDb({
      'update:groups': [[{ settings: { discovery: { launchMinEth: 0 } } }]],
    });
    const [reply] = await set(muted.db, ['launch', '0']);
    expect(patchOf(find(muted.calls, 'update:groups')[0])).toEqual({ launchMinEth: 0 });
    expect(reply).toContain('launches muted');
  });

  it('clamps an absurd threshold instead of storing it', async () => {
    const { db, calls } = makeDb({ 'update:groups': [[{ settings: {} }]] });
    await set(db, ['launch', '99999']);
    expect(patchOf(find(calls, 'update:groups')[0])).toEqual({ launchMinEth: 1_000 });
  });

  it('toggles graduations on and off', async () => {
    const off = makeDb({ 'update:groups': [[{ settings: { discovery: { gradsOn: false } } }]] });
    const [reply] = await set(off.db, ['grads', 'off']);
    expect(patchOf(find(off.calls, 'update:groups')[0])).toEqual({ gradsOn: false });
    // Round 22: OFF is where graduations live by default, so the reply says
    // where they still are rather than implying they are gone.
    expect(reply).toContain('graduations board only');

    const on = makeDb({ 'update:groups': [[{ settings: { discovery: { gradsOn: true } } }]] });
    const [onReply] = await set(on.db, ['grads', 'on']);
    expect(patchOf(find(on.calls, 'update:groups')[0])).toEqual({ gradsOn: true });
    expect(onReply).toContain('graduations on');
  });

  it('STILL writes the setting when the feed is off, but says the feed is off', async () => {
    const { db, calls } = makeDb({ 'update:groups': [[{ settings: {} }]] });
    const [reply] = await set(db, ['launch', '8'], false);
    expect(patchOf(find(calls, 'update:groups')[0])).toEqual({ launchMinEth: 8 });
    expect(reply).toContain('off on this deployment');
  });

  it('answers with usage and writes NOTHING for a junk argument', async () => {
    for (const args of [['launch'], ['launch', 'lots'], ['launch', '-2'], ['grads'], ['grads', 'maybe']]) {
      const { db, calls } = makeDb();
      const [reply] = await set(db, args);
      expect(reply).toContain('Usage:');
      expect(reply).toContain('/overseer set launch');
      expect(calls).toHaveLength(0);
    }
  });

  it('does not disturb settings.alerts when it writes discovery', async () => {
    const { db, calls } = makeDb({ 'update:groups': [[{ settings: {} }]] });
    await set(db, ['grads', 'off']);
    expect(pathOf(find(calls, 'update:groups')[0])).not.toContain("'{alerts}'");
  });

  it('still writes the watchlist knobs under settings.alerts', async () => {
    const { db, calls } = makeDb({ 'update:groups': [[{ settings: {} }]] });
    await set(db, ['nuke', '50', '20']);
    const call = find(calls, 'update:groups')[0];
    expect(pathOf(call)).toContain("'{alerts}'");
    expect(patchOf(call)).toEqual({ nukeDropPct: 50, nukeWindowMin: 20 });
  });
});

/**
 * The wiring, not the helpers: `discoveryEnabled` reaches this process from
 * index.ts and has to survive the DISPATCH into both discovery replies. Calling
 * discoverySummary/handleSet directly cannot see a call site that forgot to
 * forward it, which is exactly the defect this pins.
 */
describe('/overseer dispatch carries discoveryEnabled', () => {
  const CONFIG = { miniAppUrl: null, webAppUrl: 'https://example.test' } as unknown as Config;

  const dispatch = async (db: Db, raw: string, enabled: boolean): Promise<string[]> => {
    const replies: string[] = [];
    const ctx = { reply: async (text: string) => void replies.push(text) } as unknown as Context;
    await handleGroupieCommand(db, CONFIG, ctx, GROUP, raw, USER_ID, enabled);
    return replies;
  };

  it('says the feed is off on /overseer alerts', async () => {
    const { db } = makeDb();
    const [reply] = await dispatch(db, 'alerts', false);
    expect(reply).toContain('off (not configured)');
    expect(reply).not.toContain('launches ≥');
  });

  it('...and still quotes the thresholds when the listener runs here', async () => {
    const { db } = makeDb();
    const [reply] = await dispatch(db, 'alerts', true);
    expect(reply).toContain('launches ≥5 ETH');
  });

  it('says the feed is off after /overseer set launch, having written it anyway', async () => {
    const { db, calls } = makeDb({ 'update:groups': [[{ settings: {} }]] });
    const [reply] = await dispatch(db, 'set launch 8', false);
    expect(reply).toContain('off on this deployment');
    expect(find(calls, 'update:groups')).toHaveLength(1);
  });
});

describe('discoverySummary', () => {
  it('names the threshold, the toggle and the cap', () => {
    const text = discoverySummary(discoverySettingsOf({}), true);
    expect(text).toContain('launches ≥5 ETH');
    // Round 22: the default is board-only, and the line says so in those words.
    expect(text).toContain('graduations board only');
    expect(discoverySummary({ launchMinEth: 5, gradsOn: true, alertsPerHour: 3 }, true)).toContain(
      'graduations on',
    );
    expect(text).toContain('max 3/h');
    expect(text).toContain('/overseer set launch');
    expect(text).toContain('/overseer set grads on|off');
  });

  it('says muted rather than "≥0 ETH"', () => {
    expect(
      discoverySummary({ launchMinEth: 0, gradsOn: true, alertsPerHour: 3 }, true),
    ).toContain(
      'launches muted',
    );
  });

  it('says OFF, and quotes no thresholds, when nothing is listening', () => {
    const text = discoverySummary(discoverySettingsOf({}), false);
    expect(text).toBe('Discovery: off (not configured)');
    expect(text).not.toContain('ETH');
  });

  it('is a SEPARATE line from the watchlist summary — two families, two rules', () => {
    expect(alertsSummary(alertSettingsOf({}))).not.toContain('graduations');
    expect(discoverySummary(discoverySettingsOf({}), true)).not.toContain('nuke');
  });
});
