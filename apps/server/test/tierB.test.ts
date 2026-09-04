import { describe, expect, it } from 'vitest';
import { is, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { SQL as SQLClass } from 'drizzle-orm/sql/sql';
import {
  alerts,
  calls as callsTable,
  discoveryEvents,
  launchCandidates,
  launchMonitors,
  tokens,
  watches,
  type Db,
} from '@groupie/db';
import { subscribe, type GroupieEvent } from '../src/events.js';
import { scanLaunchCandidates } from '../src/xwatch/tierB.js';

/**
 * TIER B AFTER ROUND 25 — what it scans, and what it can never do.
 *
 * Round 23's version read `discovery_events` rows with kind='launch' only, and
 * in production that meant it read nothing at all: a PONS token — the only kind
 * whose `socials()` it can decode — never produces a 'launch' row, it produces a
 * 'graduation'. So the pass that was meant to catch a coin claiming a tracked
 * handle never wrote a single row, and the LEGS graduation (2026-09-03
 * 21:03:56Z) sat there carrying `twitter_url = https://x.com/legsdotfun` from
 * enrichment while nothing looked at it.
 *
 * Three passes now: enrichment (free), chain (bounded), and the group's own
 * calls (free, group-scoped). Every one of them writes a 'claims' row and
 * NOTHING ELSE — no alert row, no published event, no message. That last
 * property is the one the whole trust frame rests on, so it is asserted
 * explicitly rather than assumed from the absence of an import.
 *
 * Same scripted-Drizzle harness as xwatch.test.ts: the builder is faked and the
 * assertions are about the statements attempted.
 */

const dialect = new PgDialect();

const GROUP_ID = 2;
const OTHER_GROUP_ID = 3;
const HANDLE = 'legsdotfun';
const CA = '0x8fcf98e1348d3ddee46cdd15a5c7d9a8d423077d';
const OTHER_CA = '0xb2790f5f4d4c1e1a2f0e2b7a9c4d6e8f0a1b260c';
const MONITOR_ID = 11;

/** The chain pass's per-pass read bound (tierB.ts SCAN_LIMIT), pinned here. */
const SCAN_LIMIT = 20;

interface DbCall {
  key: string;
  values?: unknown;
  where?: SQL;
  /** Which builder methods the statement actually used — onConflict included. */
  methods: string[];
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
    'onConflictDoNothing',
    'onConflictDoUpdate',
  ]) {
    node[method] = (...args: unknown[]) => {
      call.methods.push(method);
      if (method === 'values') call.values = args[0];
      if (method === 'where') call.where = args[0] as SQL;
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
    if (table === callsTable) return 'calls';
    if (table === discoveryEvents) return 'discoveryEvents';
    return 'unknown';
  };
  const start = (op: string, table: unknown) => {
    const call: DbCall = { key: `${op}:${nameOf(table)}`, methods: [] };
    calls.push(call);
    return chain(call, take);
  };
  const db: Record<string, unknown> = {
    insert: (table: unknown) => start('insert', table),
    update: (table: unknown) => start('update', table),
    delete: (table: unknown) => start('delete', table),
    select: () => ({ from: (table: unknown) => start('select', table) }),
    execute: (statement: unknown) => {
      const rendered = is(statement, SQLClass)
        ? dialect.sqlToQuery(statement)
        : { sql: String(statement), params: [] };
      calls.push({ key: 'execute', methods: [], where: undefined, values: rendered.sql });
      return Promise.resolve(take('execute'));
    },
    transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise.resolve(fn(db)),
  };
  return { db: db as unknown as Db, calls };
}

const find = (calls: DbCall[], key: string) => calls.filter((c) => c.key === key);
const whereParams = (call: DbCall | undefined): unknown[] =>
  call?.where ? (dialect.sqlToQuery(call.where).params as unknown[]) : [];

type ChainStub = Parameters<typeof scanLaunchCandidates>[1];

/** The five ABI strings PONS v2's `socials()` returns, encoded as it returns them. */
function socials(values: string[]): string {
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
}

/** A chain client that counts what it was asked, so "free" can be asserted. */
function chainStub(answer: (address: string) => string | null): {
  chain: ChainStub;
  reads: () => number;
} {
  let reads = 0;
  return {
    chain: {
      call: async (address: string) => {
        reads += 1;
        return answer(address);
      },
    } as unknown as ChainStub,
    reads: () => reads,
  };
}

const CLAIMS_HANDLE = socials([`https://x.com/${HANDLE}`, '', '', 'https://legs.fun/', '']);

/**
 * `tokens.socials` as the calls pass now reads it — the raw jsonb, through the
 * shared `twitterUrlFrom`.
 *
 * KEYED 'x', DELIBERATELY. That column is written verbatim from DexScreener's
 * own `type` strings (market/dexscreener.ts: `socials[s.type] = s.url`), so the
 * old `socials->>'twitter'` in SQL read a row like this as "no socials yet" — on
 * the one pass that is the whole of Tier B for a deployment with no chain key.
 */
const SOCIALS_JSONB = { x: `https://x.com/${HANDLE}`, website: 'https://legs.fun/' };

function monitorRows() {
  return [{ id: MONITOR_ID, groupId: GROUP_ID, handle: HANDLE }];
}

/** A discovery row as the scan selects it. */
function event(over: Partial<Record<string, unknown>> = {}) {
  return {
    address: CA.toUpperCase(),
    symbol: 'LEGS',
    at: new Date('2026-09-03T21:03:56.000Z'),
    twitterUrl: null,
    ...over,
  };
}

/* ------------------------------------------------------- (a) what is scanned */

describe('scanLaunchCandidates — the candidate pool', () => {
  it('scans GRADUATIONS as well as launches — a PONS token is only ever the former', () => {
    // The round-23 bug in one assertion: kind='launch' alone can never see the
    // launchpad this file was built to read.
    //
    // ONE QUERY PER KIND, each with its own limit (api/discovery.ts learned this
    // in production): a shared cap let a busy launch hour push every graduation
    // out of the pool, and the graduation is the only row a PONS token writes.
    const { db, calls } = makeDb({
      'select:launchMonitors': [monitorRows()],
      'select:discoveryEvents': [[event({ twitterUrl: `https://x.com/${HANDLE}` })]],
      'insert:launchCandidates': [[{ id: 1 }]],
    });
    return scanLaunchCandidates(db, null, Date.now(), new Set(), new Map()).then(() => {
      const reads = find(calls, 'select:discoveryEvents');
      expect(reads).toHaveLength(2);
      const params = reads.flatMap((call) => whereParams(call));
      expect(params).toContain('launch');
      expect(params).toContain('graduation');
      // Each read carries its own bound, so neither kind can crowd the other.
      for (const read of reads) expect(read.methods).toContain('limit');
    });
  });

  it('does nothing at all when the group tracks nobody', async () => {
    const { db, calls } = makeDb({ 'select:launchMonitors': [[]] });
    expect(await scanLaunchCandidates(db, null, Date.now(), new Set(), new Map())).toBe(0);
    // Not even the candidate read is spent.
    expect(find(calls, 'select:discoveryEvents')).toHaveLength(0);
  });
});

/* ------------------------------------------------------ (b) enrichment pass */

describe('scanLaunchCandidates — the enrichment pass', () => {
  it('claims off the stored twitter_url without spending a chain read', async () => {
    const stub = chainStub(() => CLAIMS_HANDLE);
    const { db, calls } = makeDb({
      'select:launchMonitors': [monitorRows()],
      'select:discoveryEvents': [[event({ twitterUrl: `https://x.com/${HANDLE}` })]],
      'insert:launchCandidates': [[{ id: 1 }]],
    });
    const written = await scanLaunchCandidates(db, stub.chain, Date.now(), new Set(), new Map());
    expect(written).toBe(1);
    expect(stub.reads()).toBe(0);
    const values = find(calls, 'insert:launchCandidates')[0]?.values as Record<string, unknown>;
    expect(values.kind).toBe('claims');
    // Addresses are stored lowercase, whatever casing the row carried.
    expect(values.tokenAddress).toBe(CA);
    expect(values.monitorId).toBe(MONITOR_ID);
  });

  it('does NOT retire a row that has no twitter_url yet — enrichment lands late', async () => {
    // LEGS: the graduation row existed at 21:03:56Z and was enriched at
    // 21:06:17Z. Treating "not enriched" as "names nobody" would have retired
    // the row two minutes before the answer arrived.
    const stub = chainStub(() => CLAIMS_HANDLE);
    const { db } = makeDb({
      'select:launchMonitors': [monitorRows()],
      'select:discoveryEvents': [[event({ twitterUrl: null })]],
      'insert:launchCandidates': [[{ id: 1 }]],
    });
    const written = await scanLaunchCandidates(db, stub.chain, Date.now(), new Set(), new Map());
    expect(stub.reads()).toBe(1);
    expect(written).toBe(1);
  });

  it('does NOT retire a row whose twitter_url names a stranger — the tracked set changes', async () => {
    // "I saw a coin claiming @foo, so I tracked @foo" is the flow this tier
    // serves. Retiring the address the first time nobody tracked that handle
    // would answer that flow never, and re-reading costs nothing: this pass is a
    // bounded SELECT that already ran, and a stored URL keeps the row off the
    // chain either way.
    const stub = chainStub(() => CLAIMS_HANDLE);
    const seen = new Set<string>();
    const stranger: Script = {
      'select:launchMonitors': [monitorRows()],
      'select:discoveryEvents': [[event({ twitterUrl: 'https://x.com/someoneelse' })]],
      'insert:launchCandidates': [[{ id: 1 }]],
    };
    expect(
      await scanLaunchCandidates(makeDb(stranger).db, stub.chain, Date.now(), seen, new Map()),
    ).toBe(0);
    expect(stub.reads()).toBe(0);
    expect(seen.size).toBe(0);

    // The member tracks the handle the coin was naming all along, and the very
    // next pass writes the claim.
    const tracked: Script = {
      ...stranger,
      'select:discoveryEvents': [[event({ twitterUrl: `https://x.com/${HANDLE}` })]],
    };
    expect(
      await scanLaunchCandidates(makeDb(tracked).db, stub.chain, Date.now(), seen, new Map()),
    ).toBe(1);
    expect(stub.reads()).toBe(0);
    // ...and NOW it is finished: an answer for a monitor on this board retires it.
    expect(seen.has(CA)).toBe(true);
  });
});

/* ----------------------------------------------------------- (c) chain pass */

describe('scanLaunchCandidates — the chain pass', () => {
  it('never reads more than SCAN_LIMIT new addresses in one pass', async () => {
    const rows = Array.from({ length: SCAN_LIMIT + 5 }, (_, i) => ({
      address: `0x${(i + 1).toString(16).padStart(40, '0')}`,
      symbol: `T${i}`,
      at: new Date('2026-09-03T21:03:56.000Z'),
      twitterUrl: null,
    }));
    // Every read reverts, which is what most of the chain does — so nothing is
    // retired and the bound is the only thing stopping the pass.
    const stub = chainStub(() => null);
    const { db } = makeDb({
      'select:launchMonitors': [monitorRows()],
      'select:discoveryEvents': [rows],
    });
    await scanLaunchCandidates(db, stub.chain, Date.now(), new Set(), new Map());
    expect(stub.reads()).toBe(SCAN_LIMIT);
  });

  it('runs the free passes with no chain client at all', async () => {
    // A deployment without ALCHEMY_API_KEY has no chain client and no discovery
    // rows; the calls pass is the whole of Tier B there, and it must still work.
    const { db, calls } = makeDb({
      'select:launchMonitors': [monitorRows()],
      'select:discoveryEvents': [[]],
      'select:calls': [
        [{ address: CA, symbol: 'LEGS', groupId: GROUP_ID, socials: SOCIALS_JSONB }],
      ],
      'insert:launchCandidates': [[{ id: 7 }]],
    });
    expect(await scanLaunchCandidates(db, null, Date.now(), new Set(), new Map())).toBe(1);
    expect(find(calls, 'insert:launchCandidates')).toHaveLength(1);
  });
});

/* ----------------------------------------------------------- (d) calls pass */

describe('scanLaunchCandidates — the calls pass', () => {
  it('claims only for monitors in the SAME group as the call', async () => {
    // A call is a fact about one group's chat. Another group's monitor must not
    // learn that this group called a coin naming its handle.
    const { db, calls } = makeDb({
      'select:launchMonitors': [monitorRows()],
      'select:discoveryEvents': [[]],
      'select:calls': [
        [
          {
            address: OTHER_CA.toUpperCase(),
            symbol: 'OTHER',
            groupId: OTHER_GROUP_ID,
            socials: SOCIALS_JSONB,
          },
          {
            address: CA,
            symbol: 'LEGS',
            groupId: GROUP_ID,
            socials: SOCIALS_JSONB,
          },
        ],
      ],
      'insert:launchCandidates': [[{ id: 9 }]],
    });
    expect(await scanLaunchCandidates(db, null, Date.now(), new Set(), new Map())).toBe(1);
    const writes = find(calls, 'insert:launchCandidates');
    expect(writes).toHaveLength(1);
    const values = writes[0]?.values as Record<string, unknown>;
    expect(values.tokenAddress).toBe(CA);
    expect(values.monitorId).toBe(MONITOR_ID);
  });

  it('leaves a called token with no socials for the next pass, rather than retiring it', async () => {
    const seen = new Set<string>();
    const script: Script = {
      'select:launchMonitors': [monitorRows()],
      'select:discoveryEvents': [[]],
      'select:calls': [[{ address: CA, symbol: 'LEGS', groupId: GROUP_ID, socials: null }]],
      'insert:launchCandidates': [[{ id: 9 }]],
    };
    expect(await scanLaunchCandidates(makeDb(script).db, null, Date.now(), seen, new Map())).toBe(0);
    expect(seen.size).toBe(0);
  });
});

/* --------------------------------------------------- the two absolute rules */

describe('scanLaunchCandidates — what a claim can never become', () => {
  it('leaves an existing row alone: a posted candidate outranks a claim', async () => {
    // The unique index refuses the insert and returns nothing; the pass counts
    // what it actually wrote, and the 'posted' row (the account itself spoke)
    // keeps the coin.
    const { db, calls } = makeDb({
      'select:launchMonitors': [monitorRows()],
      'select:discoveryEvents': [[event({ twitterUrl: `https://x.com/${HANDLE}` })]],
      'insert:launchCandidates': [[]],
    });
    expect(await scanLaunchCandidates(db, null, Date.now(), new Set(), new Map())).toBe(0);
    const write = find(calls, 'insert:launchCandidates')[0];
    expect(write?.methods).toContain('onConflictDoNothing');
    expect(write?.methods).not.toContain('onConflictDoUpdate');
  });

  it('never writes an alert row and never publishes an event — Tier B is board only', async () => {
    // What a PING is, in this codebase (xwatch/alerts.ts): an `alerts` row plus
    // a published 'alert_fired' event, which is what the bot listens to. Tier B
    // must do neither, on any of its three passes.
    const { db, calls } = makeDb({
      'select:launchMonitors': [monitorRows()],
      'select:discoveryEvents': [[event({ twitterUrl: `https://x.com/${HANDLE}` })]],
      'select:calls': [
        [
          {
            address: OTHER_CA,
            symbol: 'LEGS2',
            groupId: GROUP_ID,
            socials: SOCIALS_JSONB,
          },
        ],
      ],
      'insert:launchCandidates': [[{ id: 1 }], [{ id: 2 }]],
    });
    const events: GroupieEvent[] = [];
    const off = subscribe((e) => events.push(e));
    try {
      const stub = chainStub(() => CLAIMS_HANDLE);
      expect(await scanLaunchCandidates(db, stub.chain, Date.now(), new Set(), new Map())).toBe(2);
    } finally {
      off();
    }
    expect(events).toHaveLength(0);
    expect(find(calls, 'insert:alerts')).toHaveLength(0);
    expect(find(calls, 'update:launchMonitors')).toHaveLength(0);
    expect(find(calls, 'insert:watches')).toHaveLength(0);
    // The only table it writes.
    const writes = calls.filter((c) => c.key.startsWith('insert:'));
    expect(new Set(writes.map((c) => c.key))).toEqual(new Set(['insert:launchCandidates']));
  });
});
