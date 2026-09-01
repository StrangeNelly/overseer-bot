import { describe, expect, it } from 'vitest';
import { calls, mentions, tokens, type Db } from '@groupie/db';
import { THRESHOLDS } from '@groupie/shared';
import { ingestMessage, isInertRemention } from '../src/bot/ingest.js';

/**
 * ingest.ts's decisions live in the SET payloads it builds, so these tests fake
 * the Drizzle query builder and assert on what it tried to write. That is the
 * only way to prove the round-6 item 5a rule without a database: an inert
 * re-mention must touch mentions_count and NOTHING else.
 */

const ADDRESS = '0x1111111111111111111111111111111111111111';
const TOKEN_ID = 7;
const CALL_ID = 55;

interface Write {
  /** `${op}:${table}` — e.g. 'update:calls'. */
  key: string;
  values?: Record<string, unknown>;
  set?: Record<string, unknown>;
}

type Results = Record<string, unknown[]>;

/**
 * A thenable that answers every builder method with itself and resolves to the
 * scripted rows, recording the values()/set() payload on the way through.
 */
function chain(results: Results, key: string, write: Write) {
  const node: Record<string, unknown> = {
    then: (ok: (rows: unknown[]) => unknown, err: (e: unknown) => unknown) =>
      Promise.resolve(results[key] ?? []).then(ok, err),
  };
  for (const method of [
    'values',
    'set',
    'from',
    'where',
    'limit',
    'returning',
    'onConflictDoNothing',
    'onConflictDoUpdate',
  ]) {
    node[method] = (arg: unknown) => {
      if (method === 'values') write.values = arg as Record<string, unknown>;
      if (method === 'set') write.set = arg as Record<string, unknown>;
      return node;
    };
  }
  return node;
}

function makeDb(results: Results): { db: Db; writes: Write[] } {
  const writes: Write[] = [];
  const nameOf = (table: unknown): string => {
    if (table === tokens) return 'tokens';
    if (table === calls) return 'calls';
    if (table === mentions) return 'mentions';
    return 'unknown';
  };
  const start = (op: string, table: unknown) => {
    const write: Write = { key: `${op}:${nameOf(table)}` };
    writes.push(write);
    return chain(results, write.key, write);
  };
  const tx = {
    insert: (table: unknown) => start('insert', table),
    update: (table: unknown) => start('update', table),
    // select() takes the projection; the table arrives on .from().
    select: () => ({ from: (table: unknown) => start('select', table) }),
  };
  const db = {
    ...tx,
    transaction: <T>(fn: (t: unknown) => Promise<T>) => fn(tx),
  };
  return { db: db as unknown as Db, writes };
}

const INPUT = {
  groupId: 1,
  messageId: 900,
  userId: 4242,
  userName: '@vera',
  at: new Date('2026-09-02T12:00:00.000Z'),
  texts: [`look at ${ADDRESS} again`],
};

/** A repost: both the token and the call already exist. */
function repostResults(mcapUsd: number | null, callStatus = 'active'): Results {
  return {
    'insert:tokens': [], // conflict — the token is known
    'select:tokens': [{ id: TOKEN_ID, symbol: 'RUG', mcapUsd }],
    'insert:calls': [], // conflict — the call is known
    'select:calls': [{ id: CALL_ID, status: callStatus }],
    'insert:mentions': [{ id: 1 }], // a genuinely new sighting
    'update:tokens': [{ id: TOKEN_ID }], // probation was on, and got cancelled
  };
}

const keys = (write: Write | undefined): string[] => Object.keys(write?.set ?? {}).sort();
const find = (writes: Write[], key: string) => writes.filter((w) => w.key === key);

describe('isInertRemention (docs/decisions.md round 6 item 5a)', () => {
  it('is inert under the floor', () => {
    expect(isInertRemention(THRESHOLDS.inertRementionMcapUsd - 1)).toBe(true);
    expect(isInertRemention(3_000)).toBe(true);
  });
  it('is not inert at or above it', () => {
    expect(isInertRemention(THRESHOLDS.inertRementionMcapUsd)).toBe(false);
    expect(isInertRemention(120_000)).toBe(false);
  });
  it('an unmeasured token is never inert — null is "we do not know", not "cheap"', () => {
    expect(isInertRemention(null)).toBe(false);
  });
  it('sits above the rug floor, so a coin at the floor cannot flip on every poll', () => {
    expect(THRESHOLDS.inertRementionMcapUsd).toBeGreaterThan(THRESHOLDS.rugFloorMcapUsd);
  });
});

describe('ingestMessage — inert re-mention', () => {
  it('records the sighting and bumps the count, and changes nothing else', async () => {
    const { db, writes } = makeDb(repostResults(4_200));
    const result = await ingestMessage(db, INPUT);

    expect(result.reposts).toEqual([ADDRESS]);
    expect(result.entries[0]).toMatchObject({
      tokenId: TOKEN_ID,
      isNew: false,
      inert: true,
      wasDied: false,
      wasBinned: false,
      wasHidden: false,
    });

    // The mention row is still written: history stays complete.
    expect(find(writes, 'insert:mentions')).toHaveLength(1);
    // ...and the ONLY column touched on the call is the counter.
    expect(keys(find(writes, 'update:calls')[0])).toEqual(['mentionsCount']);
    // Probation is untouched — no token write happened at all.
    expect(find(writes, 'update:tokens')).toHaveLength(0);
  });

  it('leaves a binned call binned and never asks for a revive', async () => {
    const { db, writes } = makeDb(repostResults(1_500, 'binned'));
    const result = await ingestMessage(db, INPUT);
    expect(result.entries[0]?.inert).toBe(true);
    expect(result.entries[0]?.wasBinned).toBe(false);
    expect(keys(find(writes, 'update:calls')[0])).toEqual(['mentionsCount']);
  });

  it('leaves a died call died and never asks for a revive', async () => {
    const { db, writes } = makeDb(repostResults(500, 'died'));
    const result = await ingestMessage(db, INPUT);
    expect(result.entries[0]?.inert).toBe(true);
    expect(result.entries[0]?.wasDied).toBe(false);
    expect(keys(find(writes, 'update:calls')[0])).toEqual(['mentionsCount']);
  });
});

describe('ingestMessage — live re-mention', () => {
  it('bumps activity, un-bins, requests a revive and cancels probation', async () => {
    const { db, writes } = makeDb(repostResults(120_000, 'binned'));
    const result = await ingestMessage(db, INPUT);

    expect(result.entries[0]).toMatchObject({ inert: false, wasBinned: true, wasHidden: true });
    expect(keys(find(writes, 'update:calls')[0])).toEqual([
      'binnedAt',
      'binnedBy',
      'lastMentionAt',
      'mentionsCount',
      'reviveRequested',
      'status',
    ]);
    // Probation cancelled: rug_hidden_at cleared, the comeback badge untouched.
    const tokenWrite = find(writes, 'update:tokens')[0];
    expect(keys(tokenWrite)).toEqual(['rugHiddenAt']);
    expect(tokenWrite?.set?.rugHiddenAt).toBeNull();
  });

  it('treats an unresolved token (null mcap) as a normal repost', async () => {
    const { db, writes } = makeDb(repostResults(null));
    expect((await ingestMessage(db, INPUT)).entries[0]?.inert).toBe(false);
    expect(keys(find(writes, 'update:calls')[0])).toContain('lastMentionAt');
  });

  it('is inert at one dollar below the threshold, live at exactly it', async () => {
    const below = makeDb(repostResults(THRESHOLDS.inertRementionMcapUsd - 1));
    expect((await ingestMessage(below.db, INPUT)).entries[0]?.inert).toBe(true);

    const at = makeDb(repostResults(THRESHOLDS.inertRementionMcapUsd));
    expect((await ingestMessage(at.db, INPUT)).entries[0]?.inert).toBe(false);
  });

  it('a redelivered update mutates nothing at all', async () => {
    // Telegram's at-least-once delivery: the mention insert conflicts, so the
    // whole repost path must be a no-op — inert or not.
    const { db, writes } = makeDb({ ...repostResults(120_000), 'insert:mentions': [] });
    const result = await ingestMessage(db, INPUT);
    expect(result.entries[0]).toMatchObject({ inert: false, wasBinned: false, wasHidden: false });
    expect(find(writes, 'update:calls')).toHaveLength(0);
    expect(find(writes, 'update:tokens')).toHaveLength(0);
  });
});

describe('ingestMessage — first call', () => {
  const firstCall: Results = {
    'insert:tokens': [{ id: TOKEN_ID, symbol: null, mcapUsd: 2_000 }],
    'insert:calls': [{ id: CALL_ID }],
    'insert:mentions': [],
    'update:tokens': [{ id: TOKEN_ID }],
  };

  it('is never inert, however cheap the token already is', async () => {
    const { db, writes } = makeDb(firstCall);
    const result = await ingestMessage(db, { ...INPUT, texts: [`new one: ${ADDRESS}`] });
    expect(result.newCalls).toEqual([ADDRESS]);
    expect(result.entries[0]).toMatchObject({ isNew: true, inert: false, wasHidden: true });
    // The founding mention is recorded and the call row carries the baselines.
    expect(find(writes, 'insert:mentions')).toHaveLength(1);
    expect(find(writes, 'update:calls')).toHaveLength(0);
  });
});
