import { afterEach, describe, expect, it } from 'vitest';
import type { Context } from 'grammy';
import { is, type SQL } from 'drizzle-orm';
import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';
import { SQL as SQLClass } from 'drizzle-orm/sql/sql';
import {
  alerts,
  deployerWatches,
  discoveryEvents,
  groupMembers,
  groups,
  mentions,
  tokens,
  watches,
  type Db,
} from '@groupie/db';
import { DEPLOYER_WATCH } from '@groupie/shared';
import {
  deployerSummary,
  handleDeployer,
  handleDeployers,
  handleGroupieCommand,
  handleSet,
  handleUndeployer,
} from '../src/bot/bot.js';
import type { Config } from '../src/config.js';
import type { ChainClient } from '../src/chain/client.js';
import { subscribe, type GroupieEvent } from '../src/events.js';
import { deliverDeployerHits, recoverDeployerHits } from '../src/discovery/alerts.js';
import {
  CREATE_CAVEAT,
  STILL_WATCHING,
  deployerHitMessage,
} from '../src/discovery/deployerMessage.js';
import type { DeployerHit } from '../src/discovery/deployerWatch.js';
import type { GroupRow } from '../src/api/membership.js';

/**
 * The deployer watch's CHAT half (docs/decisions.md round 26): the three
 * commands, the one message, and the delivery that writes the alert row before
 * it says anything out loud.
 *
 * Same scripted-Drizzle style as xwatch.test.ts — the chain client is a stub and
 * the assertions are about the statements attempted and the sentences produced.
 * Nothing here touches the detection pass; it hands this half the hits it won.
 */

const dialect = new PgDialect();

const GROUP_ID = 2;
const USER_ID = 4242;
const WATCH_ID = 77;
/** The @clubytech deploying wallet and its registry (verified on chain 2026-09-08). */
const WALLET = '0x9c5c4b4a985b0a60a1067a0d82020774661d074a';
const REGISTRY = '0xd0a32d0ba6efa91b2637af14fd1580fe3ddb337a';
const TOKEN = '0x8fcf98e1348d3ddee46cdd15a5c7d9a8d423077d';
const TX = '0x1111111111111111111111111111111111111111111111111111111111111111';
/** The wallet's nonce the day it was added: history below this must never fire. */
const NONCE = 163;

interface DbCall {
  key: string;
  values?: unknown;
  set?: Record<string, unknown>;
  where?: SQL;
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
    if (table === deployerWatches) return 'deployerWatches';
    if (table === alerts) return 'alerts';
    if (table === tokens) return 'tokens';
    if (table === watches) return 'watches';
    if (table === groups) return 'groups';
    if (table === groupMembers) return 'groupMembers';
    if (table === mentions) return 'mentions';
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
    execute,
    transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise.resolve(fn(db)),
  };
  return { db: db as unknown as Db, calls };
}

const find = (calls: DbCall[], key: string) => calls.filter((c) => c.key === key);

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

type WatchRow = typeof deployerWatches.$inferSelect;

function watchRow(over: Partial<WatchRow> = {}): WatchRow {
  return {
    id: WATCH_ID,
    groupId: GROUP_ID,
    address: WALLET,
    kind: 'eoa',
    addedBy: USER_ID,
    addedAt: new Date('2026-09-08T00:00:00.000Z'),
    note: null,
    status: 'active',
    lastNonce: NONCE,
    nonceCheckedAt: new Date('2026-09-08T00:00:00.000Z'),
    firedAddress: null,
    firedTokenId: null,
    firedAt: null,
    firedVia: null,
    firedTxHash: null,
    ...over,
  } as WatchRow;
}

/**
 * The only chain reads the COMMAND makes: one code read to tell a wallet from a
 * contract, and (for a wallet) one nonce read to mark where its history ends.
 */
function chainStub(over: Partial<ChainClient> = {}): ChainClient {
  return {
    getBlockNumber: async () => 1,
    getBlockTimestamp: async () => 1,
    getLogs: async () => [],
    call: async () => null,
    getCode: async () => '0x',
    getTransactionCount: async () => NONCE,
    getTransactionValue: async () => null,
    getTransactionLogs: async () => null,
    meter: () => ({ total: 0, windowCount: 0, totalCu: 0 }),
    ...over,
  } as ChainClient;
}

const replies: string[] = [];
const ctx = {
  reply: async (text: string) => void replies.push(text),
  message: { message_id: 900 },
  from: { id: USER_ID, is_bot: false, first_name: 'Cal', username: 'caller' },
} as unknown as Context;

const GROUP = { id: GROUP_ID, chatId: -100, slug: 'hammertime', settings: {} } as GroupRow;
const CONFIG = { miniAppUrl: null, webAppUrl: 'https://overseer.example' } as Config;

afterEach(() => {
  replies.length = 0;
});

/* --------------------------------------------------------------- the message */

describe('deployerHitMessage', () => {
  const base = {
    watchedAddress: WALLET,
    address: TOKEN,
    symbol: 'CLUBY',
    name: 'Cluby',
    mcapUsd: 412_000,
    liquidityUsd: 31_000,
    tokenCreatedAt: new Date('2026-09-08T11:56:00.000Z'),
    launchpad: 'pons-v2-dex',
    txHash: TX,
    note: null,
    nowMs: Date.parse('2026-09-08T12:00:00.000Z'),
  };

  it('names the signal that fired, in the owner\'s words', () => {
    expect(deployerHitMessage({ ...base, via: 'pons' })).toContain('launched on PONS');
    expect(deployerHitMessage({ ...base, via: 'pool' })).toContain('opened a pool');
    expect(deployerHitMessage({ ...base, via: 'create' })).toContain('deployed a contract');
    expect(deployerHitMessage({ ...base, via: 'registry' })).toContain(
      'published its official token',
    );
  });

  it('prints the watched address short and the new one in full, with the facts and the links', () => {
    const message = deployerHitMessage({ ...base, via: 'pons', name: 'Cluby Tech' });
    const lines = message.split('\n');
    expect(lines[0]).toBe('0x9c5c…074a launched on PONS.');
    // The address a reader pastes is never abbreviated.
    expect(lines[1]).toBe(`CLUBY · Cluby Tech · ${TOKEN}`);
    expect(lines[2]).toBe('mcap $412K · LP $31K · launched 4m ago · PONS');
    expect(message).toContain(`tx ${TX}`);
    expect(message).toContain(`dexscreener.com`);
  });

  it('drops a name that only repeats the symbol', () => {
    // 'Cluby' next to 'CLUBY' is a second copy of the same word, not a fact.
    expect(deployerHitMessage({ ...base, via: 'pons' }).split('\n')[1]).toBe(
      `CLUBY · ${TOKEN}`,
    );
  });

  it('carries the adder\'s own note, so a member knows WHICH watch fired', () => {
    const message = deployerHitMessage({ ...base, via: 'pons', note: 'cluby team' });
    expect(message.split('\n')[0]).toBe('0x9c5c…074a (cluby team) launched on PONS.');
  });

  it('says plainly that a raw deployment is not tradeable, and links nowhere', () => {
    const message = deployerHitMessage({ ...base, via: 'create', symbol: null, name: null });
    expect(message).toContain(CREATE_CAVEAT);
    // A predicted CREATE address has no pool, so three trading deep links under
    // "not tradeable" would point at nothing.
    expect(message).not.toContain('dexscreener.com');
    expect(message).not.toContain('axiom');
  });

  it('tells the reader the create road did NOT spend the watch', () => {
    const message = deployerHitMessage({ ...base, via: 'create', symbol: null, name: null });
    expect(message).toContain(STILL_WATCHING);
    // Only that road: a launch really has retired the watch, and saying
    // otherwise would invite a member to wait for a second message.
    expect(deployerHitMessage({ ...base, via: 'pons' })).not.toContain(STILL_WATCHING);
  });

  it('reads correctly when everything but the two addresses is unknown', () => {
    const message = deployerHitMessage({
      ...base,
      via: 'create',
      symbol: null,
      name: null,
      mcapUsd: null,
      liquidityUsd: null,
      tokenCreatedAt: null,
      launchpad: null,
      txHash: null,
    });
    const lines = message.split('\n');
    expect(lines[0]).toBe('0x9c5c…074a deployed a contract.');
    expect(lines[1]).toBe(TOKEN);
    expect(message).not.toContain('mcap');
    expect(message).not.toContain('tx ');
  });

  it('still fires on an unreadable event — the transaction, and no links to nothing', () => {
    const message = deployerHitMessage({
      ...base,
      via: 'registry',
      address: null,
      symbol: null,
      name: null,
      mcapUsd: null,
      liquidityUsd: null,
      tokenCreatedAt: null,
      launchpad: null,
    });
    expect(message).toContain('could not be read');
    expect(message).toContain(`tx ${TX}`);
    expect(message).not.toContain('dexscreener.com');
  });
});

/* -------------------------------------------------------- /overseer deployer */

describe('/overseer deployer', () => {
  it('refuses when this deployment has no chain listener, before touching the database', async () => {
    const { db, calls } = makeDb();
    await handleDeployer(db, ctx, GROUP, [WALLET], USER_ID, { chain: null });
    expect(replies[0]).toContain('needs the chain listener');
    expect(calls).toHaveLength(0);
  });

  it('refuses the zero address and shared infrastructure, without a chain read', async () => {
    let read = 0;
    const stub = chainStub({
      getCode: async () => {
        read += 1;
        return '0x';
      },
    });
    await handleDeployer(
      makeDb().db,
      ctx,
      GROUP,
      ['0x0000000000000000000000000000000000000000'],
      USER_ID,
      { chain: stub },
    );
    expect(replies.pop()).toContain('zero address');

    // WETH — every launch on this chain touches it (round 23's KNOWN_CONTRACTS).
    await handleDeployer(
      makeDb().db,
      ctx,
      GROUP,
      ['0x0bd7d308f8e1639fab988df18a8011f41eacad73'],
      USER_ID,
      { chain: stub },
    );
    expect(replies.pop()).toContain('shared infrastructure');
    expect(read).toBe(0);
  });

  it('asks for an address when given none', async () => {
    await handleDeployer(makeDb().db, ctx, GROUP, [], USER_ID, { chain: chainStub() });
    expect(replies[0]).toContain('Usage: /overseer deployer');
  });

  it('stamps the wallet\'s CURRENT nonce, so earlier contracts can never fire', async () => {
    const { db, calls } = makeDb({
      'select:deployerWatches': [[], []],
      'insert:deployerWatches': [[watchRow()]],
      'insert:groupMembers': [[]],
    });
    await handleDeployer(db, ctx, GROUP, [WALLET, 'cluby', 'team'], USER_ID, {
      chain: chainStub(),
    });
    const values = find(calls, 'insert:deployerWatches')[0]?.values as Record<string, unknown>;
    expect(values.kind).toBe('eoa');
    expect(values.address).toBe(WALLET);
    expect(values.lastNonce).toBe(NONCE);
    expect(values.note).toBe('cluby team');
    expect(replies[0]).toContain(`from nonce ${NONCE}`);
    expect(replies[0]).toContain('earlier contracts are ignored');
    // What it will actually catch, said at add time.
    expect(replies[0]).toContain('launches on PONS');
    expect(replies[0]).toContain('deploys a contract');
  });

  it('takes the per-group advisory lock before it counts anything', async () => {
    const { db, calls } = makeDb({
      'select:deployerWatches': [[], []],
      'insert:deployerWatches': [[watchRow()]],
      'insert:groupMembers': [[]],
    });
    await handleDeployer(db, ctx, GROUP, [WALLET], USER_ID, { chain: chainStub() });
    const lock = calls[0];
    expect(lock?.key).toBe('execute');
    expect(lock?.text).toContain('pg_advisory_xact_lock');
    expect(lock?.params).toContain(`deployer:${GROUP_ID}`);
  });

  it('stores no nonce it could not read, and says so instead of quoting one', async () => {
    const { db, calls } = makeDb({
      'select:deployerWatches': [[], []],
      'insert:deployerWatches': [[watchRow({ lastNonce: null })]],
      'insert:groupMembers': [[]],
    });
    await handleDeployer(db, ctx, GROUP, [WALLET], USER_ID, {
      chain: chainStub({ getTransactionCount: async () => null }),
    });
    const values = find(calls, 'insert:deployerWatches')[0]?.values as Record<string, unknown>;
    expect(values.lastNonce).toBeNull();
    expect(values.nonceCheckedAt).toBeNull();
    expect(replies[0]).toContain('nonce unread');
  });

  it('classifies a contract by its code, reads no nonce for it, and promises the registry road', async () => {
    let nonceReads = 0;
    const { db, calls } = makeDb({
      'select:deployerWatches': [[], []],
      'insert:deployerWatches': [[watchRow({ address: REGISTRY, kind: 'contract' })]],
      'insert:groupMembers': [[]],
    });
    await handleDeployer(db, ctx, GROUP, [REGISTRY], USER_ID, {
      chain: chainStub({
        getCode: async () => '0x6080604052',
        getTransactionCount: async () => {
          nonceReads += 1;
          return 1;
        },
      }),
    });
    const values = find(calls, 'insert:deployerWatches')[0]?.values as Record<string, unknown>;
    expect(values.kind).toBe('contract');
    // A contract is not nonce-predicted, so the read is not even attempted.
    expect(nonceReads).toBe(0);
    expect(replies[0]).toContain('publishes its official token');
    // ...and it does NOT promise the pool road: a transaction's sender is an
    // EOA by construction, so a contract watch can never match one.
    expect(replies[0]).not.toContain('opens a pool');
    // A WALLET still gets that promise, because it really is covered.
    replies.length = 0;
    const wallet = makeDb({
      'select:deployerWatches': [[], []],
      'insert:deployerWatches': [[watchRow()]],
      'insert:groupMembers': [[]],
    });
    await handleDeployer(wallet.db, ctx, GROUP, [WALLET], USER_ID, { chain: chainStub() });
    expect(replies[0]).toContain('opens a pool anywhere');
  });

  it('reads an EMPTY-STRING getCode as a wallet, the same as the CREATE scan does', async () => {
    const { db, calls } = makeDb({
      'select:deployerWatches': [[], []],
      'insert:deployerWatches': [[watchRow()]],
      'insert:groupMembers': [[]],
    });
    await handleDeployer(db, ctx, GROUP, [WALLET], USER_ID, {
      // Some nodes answer an empty account with '' rather than '0x'. Reading it
      // as bytecode here would arm the wrong roads for the rest of the watch.
      chain: chainStub({ getCode: async () => '' }),
    });
    const values = find(calls, 'insert:deployerWatches')[0]?.values as Record<string, unknown>;
    expect(values.kind).toBe('eoa');
  });

  it('treats an unreadable code answer as unknown, and writes nothing', async () => {
    const { db, calls } = makeDb();
    await handleDeployer(db, ctx, GROUP, [WALLET], USER_ID, {
      chain: chainStub({ getCode: async () => null }),
    });
    expect(replies[0]).toContain('Could not reach the chain');
    expect(calls).toHaveLength(0);
  });

  it('refuses over either cap, and names the way out', async () => {
    const groupCapped = makeDb({
      'select:deployerWatches': [
        [],
        Array.from({ length: DEPLOYER_WATCH.capPerGroup }, () => ({ addedBy: 1 })),
      ],
    });
    await handleDeployer(groupCapped.db, ctx, GROUP, [WALLET], USER_ID, { chain: chainStub() });
    expect(replies.pop()).toContain(`already watches ${DEPLOYER_WATCH.capPerGroup} addresses`);

    const mineCapped = makeDb({
      'select:deployerWatches': [
        [],
        Array.from({ length: DEPLOYER_WATCH.capPerMember }, () => ({ addedBy: USER_ID })),
      ],
    });
    await handleDeployer(mineCapped.db, ctx, GROUP, [WALLET], USER_ID, { chain: chainStub() });
    expect(replies.pop()).toContain(`You already watch ${DEPLOYER_WATCH.capPerMember} addresses`);
  });

  it('is idempotent: a live watch is reported, not duplicated', async () => {
    const { db, calls } = makeDb({ 'select:deployerWatches': [[watchRow()]] });
    await handleDeployer(db, ctx, GROUP, [WALLET], USER_ID, { chain: chainStub() });
    expect(replies[0]).toBe('Already watching 0x9c5c…074a.');
    expect(find(calls, 'insert:deployerWatches')).toHaveLength(0);
  });

  it('re-uses a FIRED row and clears the last launch off it', async () => {
    const { db, calls } = makeDb({
      'select:deployerWatches': [[watchRow({ status: 'fired', firedAddress: TOKEN })], []],
      'update:deployerWatches': [[watchRow()]],
      'insert:groupMembers': [[]],
    });
    await handleDeployer(db, ctx, GROUP, [WALLET], USER_ID, { chain: chainStub() });
    const set = find(calls, 'update:deployerWatches')[0]?.set as Record<string, unknown>;
    expect(set.status).toBe('active');
    expect(set.lastNonce).toBe(NONCE);
    expect(set.firedAddress).toBeNull();
    expect(set.firedVia).toBeNull();
    expect(find(calls, 'insert:deployerWatches')).toHaveLength(0);
  });
});

/* ------------------------------------------- /overseer deployers | undeployer */

describe('/overseer deployers', () => {
  it('lists one line per watch: address, kind, adder, age and what it did', async () => {
    const { db } = makeDb({
      'select:deployerWatches': [
        [
          watchRow(),
          watchRow({
            id: 78,
            address: REGISTRY,
            kind: 'contract',
            status: 'fired',
            firedVia: 'pons',
            firedAddress: TOKEN,
            firedAt: new Date('2026-09-08T01:00:00.000Z'),
          }),
        ],
      ],
      'select:groupMembers': [[{ displayName: '@caller' }]],
      'select:mentions': [[]],
    });
    await handleDeployers(db, ctx, GROUP, { chain: chainStub() });
    const [header, first, second] = replies[0]!.split('\n');
    // Two rows, ONE slot: a fired watch is listed and costs nobody one.
    expect(header).toBe(`Deployers 1/${DEPLOYER_WATCH.capPerGroup}:`);
    expect(first).toContain('0x9c5c…074a · wallet · added by @caller · ');
    expect(first).toContain('watching');
    expect(second).toContain('contract');
    expect(second).toContain('launched on PONS 0x8fcf…077d');
  });

  it('never prints "watching" over a watch that has already fired', async () => {
    const { db } = makeDb({
      // Fired, and the event's address could not be decoded — the one row where
      // the list could most easily lie about the state of the watch.
      'select:deployerWatches': [
        [watchRow({ status: 'fired', firedVia: null, firedAddress: null })],
      ],
      'select:groupMembers': [[]],
      'select:mentions': [[]],
    });
    await handleDeployers(db, ctx, GROUP, { chain: chainStub() });
    const [, first] = replies[0]!.split('\n');
    expect(first).toContain('fired');
    expect(first).not.toContain('watching');
  });

  it('says so in the header when nothing is checking', async () => {
    const { db } = makeDb({
      'select:deployerWatches': [[watchRow()]],
      'select:groupMembers': [[]],
      'select:mentions': [[]],
    });
    await handleDeployers(db, ctx, GROUP, { chain: null });
    expect(replies[0]).toContain('chain listener off — nothing is checking');
  });

  it('points at the command when the list is empty', async () => {
    const { db } = makeDb({ 'select:deployerWatches': [[]] });
    await handleDeployers(db, ctx, GROUP, { chain: chainStub() });
    expect(replies[0]).toContain('/overseer deployer <address>');
  });
});

describe('/overseer undeployer', () => {
  it('stops one, and says so when there was nothing to stop', async () => {
    const stopped = makeDb({ 'update:deployerWatches': [[watchRow()]] });
    await handleUndeployer(stopped.db, ctx, GROUP, [WALLET]);
    expect(replies.pop()).toBe('Stopped watching 0x9c5c…074a.');

    const nothing = makeDb({ 'update:deployerWatches': [[]] });
    await handleUndeployer(nothing.db, ctx, GROUP, [WALLET]);
    expect(replies.pop()).toBe("0x9c5c…074a wasn't watched.");
  });
});

/* ----------------------------------------------------- dispatch and settings */

describe('/overseer dispatch', () => {
  it('consumes the address on deployer/undeployer, so a wallet never lands as a call', async () => {
    const added = makeDb({
      'select:deployerWatches': [[], []],
      'insert:deployerWatches': [[watchRow()]],
      'insert:groupMembers': [[]],
    });
    expect(
      await handleGroupieCommand(
        added.db,
        CONFIG,
        ctx,
        GROUP,
        `deployer ${WALLET}`,
        USER_ID,
        false,
        { enabled: false, watcher: null },
        { chain: chainStub() },
      ),
    ).toBe(true);

    const removed = makeDb({ 'update:deployerWatches': [[watchRow()]] });
    expect(
      await handleGroupieCommand(
        removed.db,
        CONFIG,
        ctx,
        GROUP,
        `undeployer ${WALLET}`,
        USER_ID,
        false,
        { enabled: false, watcher: null },
        { chain: chainStub() },
      ),
    ).toBe(true);
  });

  it('carries no address on the list, so a CA pasted in the same message still ingests', async () => {
    const { db } = makeDb({ 'select:deployerWatches': [[]] });
    expect(
      await handleGroupieCommand(
        db,
        CONFIG,
        ctx,
        GROUP,
        'deployers',
        USER_ID,
        false,
        { enabled: false, watcher: null },
        { chain: chainStub() },
      ),
    ).toBe(false);
  });

  it('puts the deployer line on /overseer alerts, and says off without a listener', async () => {
    await handleGroupieCommand(
      makeDb().db,
      CONFIG,
      ctx,
      GROUP,
      'alerts',
      USER_ID,
      false,
      { enabled: false, watcher: null },
      { chain: null },
    );
    expect(replies[0]).toContain('Deployer watch: off (needs the chain listener)');
    replies.length = 0;

    await handleGroupieCommand(
      makeDb().db,
      CONFIG,
      ctx,
      GROUP,
      'alerts',
      USER_ID,
      false,
      { enabled: false, watcher: null },
      { chain: chainStub() },
    );
    // ON by default: the owner asked to be told, so silence would be the wrong
    // default for this one family.
    expect(replies[0]).toContain('Deployer watch: ping on');
  });

  it('summarises the caps', () => {
    expect(deployerSummary({}, true)).toContain(
      `${DEPLOYER_WATCH.capPerGroup} addresses per group, ${DEPLOYER_WATCH.capPerMember} per member`,
    );
  });
});

describe('/overseer set deployerping', () => {
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

  it('writes the toggle under settings.deployer', async () => {
    const { db, calls } = makeDb({
      'update:groups': [[{ settings: { deployer: { ping: false } } }]],
    });
    await handleSet(
      db,
      ctx,
      GROUP,
      ['deployerping', 'off'],
      false,
      { enabled: false, watcher: null },
      { chain: chainStub() },
    );
    const call = find(calls, 'update:groups')[0];
    expect(patchOf(call)).toEqual({ ping: false });
    expect(pathOf(call)).toContain("'{deployer}'");
    expect(replies[0]).toContain('ping off (board only)');
  });

  it('still writes when nothing is listening here, and says so', async () => {
    const { db } = makeDb({ 'update:groups': [[{ settings: { deployer: { ping: true } } }]] });
    await handleSet(
      db,
      ctx,
      GROUP,
      ['deployerping', 'on'],
      false,
      { enabled: false, watcher: null },
      { chain: null },
    );
    expect(replies[0]).toContain('The chain listener is off on this deployment.');
  });

  it('refuses a non-toggle with the usage line', async () => {
    const { db, calls } = makeDb();
    await handleSet(
      db,
      ctx,
      GROUP,
      ['deployerping', 'maybe'],
      false,
      { enabled: false, watcher: null },
      { chain: chainStub() },
    );
    expect(replies[0]).toContain('set deployerping on|off');
    expect(find(calls, 'update:groups')).toHaveLength(0);
  });
});

/* ------------------------------------------------------------- the delivery */

function hit(over: Partial<DeployerHit> = {}): DeployerHit {
  return {
    watchId: WATCH_ID,
    groupId: GROUP_ID,
    addedBy: USER_ID,
    watchedAddress: WALLET,
    tokenAddress: TOKEN,
    via: 'pons',
    txHash: TX,
    ...over,
  };
}

const ACTIVE_GROUP = [{ status: 'active', settings: {} }];

describe('deliverDeployerHits', () => {
  it('writes the alert row before publishing, with the watched address and the signal', async () => {
    const { db, calls } = makeDb({
      'select:groups': [ACTIVE_GROUP],
      'select:discoveryEvents': [
        [
          {
            symbol: 'CLUBY',
            name: 'Cluby',
            mcapUsd: 412_000,
            liquidityUsd: 31_000,
            dex: 'pons-v2-dex',
            at: new Date('2026-09-08T11:56:00.000Z'),
          },
        ],
      ],
      'insert:tokens': [[{ id: 51, symbol: 'CLUBY', mcapUsd: 412_000 }]],
      'select:deployerWatches': [[{ note: 'cluby team' }]],
      'insert:alerts': [[{ id: 9 }]],
    });
    const { result, events } = await capture(() => deliverDeployerHits(db, [hit()]));
    expect(result).toBe(1);

    const alert = find(calls, 'insert:alerts')[0]?.values as Record<string, unknown>;
    const details = alert.details as Record<string, unknown>;
    expect(alert.type).toBe('deployer_launch');
    expect(alert.tokenId).toBe(51);
    expect(details.watched).toBe(WALLET);
    expect(details.address).toBe(TOKEN);
    expect(details.via).toBe('pons');
    expect(details.txHash).toBe(TX);

    const fired = events.filter((e) => e.type === 'alert_fired');
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ groupId: GROUP_ID, alertType: 'deployer_launch' });
    // The message the chat gets is the one recorded on the row.
    expect((fired[0] as { message: string }).message).toBe(details.message);
    expect((fired[0] as { message: string }).message).toContain('launched on PONS');
  });

  it('says nothing twice: a refused insert is a chat that was already told', async () => {
    const { db } = makeDb({
      'select:groups': [ACTIVE_GROUP],
      'select:discoveryEvents': [[]],
      'insert:tokens': [[{ id: 51, symbol: null, mcapUsd: null }]],
      'select:deployerWatches': [[{ note: null }]],
      // The partial unique index refused it.
      'insert:alerts': [[]],
    });
    const { result, events } = await capture(() => deliverDeployerHits(db, [hit()]));
    expect(result).toBe(0);
    expect(events.filter((e) => e.type === 'alert_fired')).toHaveLength(0);
  });

  it('is silent for a group that muted the ping, and writes no alert row', async () => {
    const { db, calls } = makeDb({
      // The token upsert is scripted so delivery REACHES the mute check: without
      // it the pass threw on the upsert and every assertion below held for the
      // wrong reason — a test that passed with the mute check deleted.
      'select:groups': [[{ status: 'active', settings: { deployer: { ping: false } } }]],
      'insert:tokens': [[{ id: 51, symbol: null, mcapUsd: null }]],
    });
    const { result, events } = await capture(() => deliverDeployerHits(db, [hit()]));
    expect(result).toBe(0);
    expect(find(calls, 'insert:alerts')).toHaveLength(0);
    expect(events).toHaveLength(0);
    // Got past the upsert (so the mute is what stopped it), and the row is
    // stamped: a muted group owes this fire no further decision.
    expect(find(calls, 'insert:tokens')).toHaveLength(1);
    expect(
      find(calls, 'update:deployerWatches').some((c) => c.set?.notifiedAt instanceof Date),
    ).toBe(true);
  });

  it('says nothing to a group the bot is no longer in', async () => {
    const { db, calls } = makeDb({ 'select:groups': [[{ status: 'removed', settings: {} }]] });
    expect(await deliverDeployerHits(db, [hit()])).toBe(0);
    expect(find(calls, 'insert:alerts')).toHaveLength(0);
  });

  it('never creates a token row (or a watch) for a raw CREATE', async () => {
    const { db, calls } = makeDb({
      'select:groups': [ACTIVE_GROUP],
      'select:discoveryEvents': [[]],
      'select:deployerWatches': [[{ note: null }]],
      'insert:alerts': [[{ id: 10 }]],
    });
    const { result } = await capture(() => deliverDeployerHits(db, [hit({ via: 'create' })]));
    expect(result).toBe(1);
    // Nothing has proved this address is a coin: no tokens row for the poller
    // to chase, no watch slot spent, and the alert carries a null token id.
    expect(find(calls, 'insert:tokens')).toHaveLength(0);
    expect(find(calls, 'insert:watches')).toHaveLength(0);
    const alert = find(calls, 'insert:alerts')[0]?.values as Record<string, unknown>;
    expect(alert.tokenId).toBeNull();
  });

  it('still tells the chat when the event itself could not be decoded', async () => {
    const { db, calls } = makeDb({
      'select:groups': [ACTIVE_GROUP],
      'select:deployerWatches': [[{ note: null }]],
      'insert:alerts': [[{ id: 11 }]],
    });
    const { result } = await capture(() =>
      deliverDeployerHits(db, [hit({ via: 'registry', tokenAddress: null })]),
    );
    expect(result).toBe(1);
    // No address to look up, so no market read and no token row — just the news.
    expect(find(calls, 'select:discoveryEvents')).toHaveLength(0);
    expect(find(calls, 'insert:tokens')).toHaveLength(0);
    const alert = find(calls, 'insert:alerts')[0]?.values as Record<string, unknown>;
    expect((alert.details as Record<string, unknown>).address).toBeNull();
    expect((alert.details as { message: string }).message).toContain(`tx ${TX}`);
  });

  it('stamps the fired token on the watch, so the board can NAME the coin', async () => {
    const { db, calls } = makeDb({
      'select:groups': [ACTIVE_GROUP],
      'select:discoveryEvents': [[]],
      'insert:tokens': [[{ id: 51, symbol: 'CLUBY', mcapUsd: null }]],
      'select:deployerWatches': [[{ note: null }]],
      'insert:alerts': [[{ id: 9 }]],
    });
    await capture(() => deliverDeployerHits(db, [hit()]));

    const stamp = find(calls, 'update:deployerWatches').find(
      (c) => c.set?.firedTokenId !== undefined,
    );
    expect(stamp?.set?.firedTokenId).toBe(51);
    // Guarded, so a re-add landing between the flip and this write cannot be
    // labelled with the last coin: fired, and not already stamped.
    const where = stamp?.where ? dialect.sqlToQuery(stamp.where) : { sql: '', params: [] };
    expect(where.sql).toContain('is null');
    expect(where.params).toContain('fired');
  });

  it('stamps the token even for a group that muted the ping — the board still names it', async () => {
    const { db, calls } = makeDb({
      'select:groups': [[{ status: 'active', settings: { deployer: { ping: false } } }]],
      'insert:tokens': [[{ id: 51, symbol: 'CLUBY', mcapUsd: null }]],
    });
    const { result } = await capture(() => deliverDeployerHits(db, [hit()]));
    expect(result).toBe(0);
    expect(find(calls, 'insert:alerts')).toHaveLength(0);
    expect(
      find(calls, 'update:deployerWatches').some((c) => c.set?.firedTokenId === 51),
    ).toBe(true);
  });

  it('marks the row as dealt with on every outcome, so nothing re-sends it', async () => {
    const told = makeDb({
      'select:groups': [ACTIVE_GROUP],
      'select:discoveryEvents': [[]],
      'insert:tokens': [[{ id: 51, symbol: null, mcapUsd: null }]],
      'select:deployerWatches': [[{ note: null }]],
      'insert:alerts': [[{ id: 9 }]],
    });
    await capture(() => deliverDeployerHits(told.db, [hit()]));
    expect(
      find(told.calls, 'update:deployerWatches').some((c) => c.set?.notifiedAt instanceof Date),
    ).toBe(true);

    // ...including a group that muted it: nobody owes that row a decision.
    const muted = makeDb({
      'select:groups': [[{ status: 'active', settings: { deployer: { ping: false } } }]],
      'insert:tokens': [[{ id: 51, symbol: null, mcapUsd: null }]],
    });
    await capture(() => deliverDeployerHits(muted.db, [hit()]));
    expect(
      find(muted.calls, 'update:deployerWatches').some((c) => c.set?.notifiedAt instanceof Date),
    ).toBe(true);
  });

  it('stamps nothing for a CREATE: that road claims no row to reconcile', async () => {
    const { db, calls } = makeDb({
      'select:groups': [ACTIVE_GROUP],
      'select:discoveryEvents': [[]],
      'select:deployerWatches': [[{ note: null }]],
      'insert:alerts': [[{ id: 10 }]],
    });
    await capture(() => deliverDeployerHits(db, [hit({ via: 'create' })]));
    expect(
      find(calls, 'update:deployerWatches').some((c) => c.set?.notifiedAt !== undefined),
    ).toBe(false);
  });

  it('leaves a THROWN hit unstamped, so the sweep tries it again', async () => {
    const { db, calls } = makeDb({
      'select:groups': [[new Error('db down')]],
    });
    expect(await deliverDeployerHits(db, [hit()])).toBe(0);
    expect(find(calls, 'update:deployerWatches')).toHaveLength(0);
  });

  it('isolates a failing hit, so one broken row cannot silence the rest', async () => {
    const { db } = makeDb({
      'select:groups': [[new Error('db down')], ACTIVE_GROUP],
      'select:discoveryEvents': [[]],
      'insert:tokens': [[{ id: 51, symbol: null, mcapUsd: null }]],
      'select:deployerWatches': [[{ note: null }]],
      'insert:alerts': [[{ id: 12 }]],
    });
    const { result } = await capture(() =>
      deliverDeployerHits(db, [hit(), hit({ watchId: 78, watchedAddress: REGISTRY })]),
    );
    expect(result).toBe(1);
  });
});

describe('alerts_deployer_uq', () => {
  it('keys on the SIGNAL as well, so a create cannot swallow the launch', () => {
    const index = getTableConfig(alerts).indexes.find(
      (entry) => entry.config.name === 'alerts_deployer_uq',
    );
    const parts = (index?.config.columns ?? []).map((column) =>
      is(column, SQLClass)
        ? dialect.sqlToQuery(column as SQL).sql
        : ((column as { name?: string }).name ?? ''),
    );
    // A 'create' hit's details.address is the PREDICTED CONTRACT, not null — so
    // without `via` in the key the same wallet's later launch of that very
    // contract was refused as a duplicate and the chat was never told. The
    // dedupe this feature actually wants is per (group, watched, contract,
    // signal); the recovery sweep re-sends the same `via` and still conflicts.
    expect(parts).toHaveLength(5);
    expect(parts.join(' | ')).toContain("'via'");
    expect(parts.join(' | ')).toContain("'watched'");
    expect(parts.join(' | ')).toContain("'address'");
  });
});

describe('recoverDeployerHits', () => {
  const firedRow = watchRow({
    status: 'fired',
    firedAddress: TOKEN,
    firedVia: 'pons',
    firedTxHash: TX,
    firedAt: new Date('2026-09-08T12:00:00.000Z'),
    notifiedAt: null,
  });

  it('re-sends a fired row whose message was lost, and then marks it told', async () => {
    const { db, calls } = makeDb({
      'select:deployerWatches': [[firedRow], [{ note: null }]],
      'select:groups': [ACTIVE_GROUP],
      'select:discoveryEvents': [[]],
      'insert:tokens': [[{ id: 51, symbol: 'CLUBY', mcapUsd: null }]],
      'insert:alerts': [[{ id: 13 }]],
    });
    const { result, events } = await capture(() => recoverDeployerHits(db));

    expect(result).toBe(1);
    expect(events.filter((e) => e.type === 'alert_fired')).toHaveLength(1);
    // Read against the fired-but-untold rows only, inside the recovery window.
    const read = find(calls, 'select:deployerWatches')[0];
    const where = read?.where ? dialect.sqlToQuery(read.where) : { sql: '', params: [] };
    expect(where.params).toContain('fired');
    expect(where.sql).toContain('is null');
    expect(
      find(calls, 'update:deployerWatches').some((c) => c.set?.notifiedAt instanceof Date),
    ).toBe(true);
  });

  it('sends nothing a second time: the alert index answers "already told"', async () => {
    const { db, calls } = makeDb({
      'select:deployerWatches': [[firedRow], [{ note: null }]],
      'select:groups': [ACTIVE_GROUP],
      'select:discoveryEvents': [[]],
      'insert:tokens': [[{ id: 51, symbol: null, mcapUsd: null }]],
      // The partial unique index refused it — the chat already has this message.
      'insert:alerts': [[]],
    });
    const { result, events } = await capture(() => recoverDeployerHits(db));
    expect(result).toBe(0);
    expect(events.filter((e) => e.type === 'alert_fired')).toHaveLength(0);
    // ...and the row is stamped anyway, so the sweep stops looking at it.
    expect(
      find(calls, 'update:deployerWatches').some((c) => c.set?.notifiedAt instanceof Date),
    ).toBe(true);
  });

  it('costs one SELECT when nothing was lost', async () => {
    const { db, calls } = makeDb({ 'select:deployerWatches': [[]] });
    expect(await recoverDeployerHits(db)).toBe(0);
    expect(find(calls, 'select:deployerWatches')).toHaveLength(1);
    expect(find(calls, 'select:groups')).toHaveLength(0);
  });
});
