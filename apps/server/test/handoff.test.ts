import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { is, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { SQL as SQLClass } from 'drizzle-orm/sql/sql';
import { handoffTokens, type Db } from '@groupie/db';
import { createApi } from '../src/api/app.js';
import { verifySession } from '../src/api/auth.js';
import {
  createHandoffRoutes,
  generateHandoffToken,
  handoffUrl,
  hashHandoffToken,
} from '../src/api/handoff.js';
import type { ApiEnv, GroupRow } from '../src/api/membership.js';
import type { Config } from '../src/config.js';

/**
 * The handoff's guarantees live in SQL (a one-shot conditional UPDATE) and in
 * what is written at rest (a digest, never the secret), so these tests fake the
 * Drizzle builder — like ingest.test.ts — and assert on the statements the
 * routes tried to run, rendering each WHERE through the real PgDialect so the
 * claim conditions are checked as SQL rather than as object identity.
 */

const dialect = new PgDialect();

const USER_ID = 4242;
const SLUG = 'hammertime';
const WEB_APP_URL = 'https://groupie.example';
const SESSION_SECRET = 'test-session-secret';

const CONFIG: Config = {
  botToken: '7654321:AA-not-a-real-bot-token',
  databaseUrl: 'postgres://unused',
  webAppUrl: WEB_APP_URL,
  port: 3000,
  sessionSecret: SESSION_SECRET,
  miniAppUrl: null,
  devAuthUserId: null,
};

const GROUP: GroupRow = {
  id: 1,
  chatId: -1001234567890,
  title: 'hammertime',
  slug: SLUG,
  status: 'active',
  settings: {},
  addedAt: new Date('2026-09-01T00:00:00.000Z'),
};

interface DbCall {
  /** `${op}:${table}` — e.g. 'update:handoff_tokens'. */
  key: string;
  values?: Record<string, unknown>;
  set?: Record<string, unknown>;
  where?: SQL;
  offset?: unknown;
}

type Handler = (call: DbCall) => unknown[];

/** The recorded WHERE as real SQL text + bound parameters. */
function whereQuery(call: DbCall): { sql: string; params: unknown[] } {
  if (!call.where) return { sql: '', params: [] };
  const query = dialect.sqlToQuery(call.where);
  return { sql: query.sql, params: query.params as unknown[] };
}

function renderSql(value: unknown): string {
  return is(value, SQLClass) ? dialect.sqlToQuery(value).sql : String(value);
}

/**
 * A thenable that answers every builder method with itself and, only once
 * awaited (so the whole chain is recorded first), asks the scripted handler
 * what the database would have returned.
 */
function chain(call: DbCall, respond: Handler) {
  const node: Record<string, unknown> = {
    then: (ok: (rows: unknown[]) => unknown, err: (e: unknown) => unknown) =>
      Promise.resolve()
        .then(() => respond(call))
        .then(ok, err),
  };
  for (const method of ['values', 'set', 'from', 'where', 'orderBy', 'limit', 'offset', 'returning']) {
    node[method] = (arg: unknown) => {
      if (method === 'values') call.values = arg as Record<string, unknown>;
      if (method === 'set') call.set = arg as Record<string, unknown>;
      if (method === 'where') call.where = arg as SQL;
      if (method === 'offset') call.offset = arg;
      return node;
    };
  }
  return node;
}

function makeDb(handlers: Record<string, Handler> = {}): { db: Db; calls: DbCall[] } {
  const calls: DbCall[] = [];
  const nameOf = (table: unknown): string =>
    table === handoffTokens ? 'handoff_tokens' : 'unknown';
  const start = (op: string, table: unknown) => {
    const call: DbCall = { key: `${op}:${nameOf(table)}` };
    calls.push(call);
    return chain(call, (c) => handlers[c.key]?.(c) ?? []);
  };
  const db = {
    insert: (table: unknown) => start('insert', table),
    update: (table: unknown) => start('update', table),
    delete: (table: unknown) => start('delete', table),
    select: () => ({ from: (table: unknown) => start('select', table) }),
  };
  return { db: db as unknown as Db, calls };
}

/** requireMember's job, faked: reaching the mint means the gate already passed. */
function testApp(db: Db): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  app.use('/api/g/:slug/*', async (c, next) => {
    c.set('group', GROUP);
    c.set('userId', USER_ID);
    await next();
  });
  app.route('/', createHandoffRoutes(db, CONFIG));
  return app;
}

const find = (calls: DbCall[], key: string) => calls.filter((c) => c.key === key);

function tokenFromUrl(url: string): string {
  return new URL(url).searchParams.get('token') ?? '';
}

/** One stored row that enforces the claim's own conditions, so redemption is really one-shot. */
function storedToken(options: { hash: string; expired?: boolean }) {
  const state = { used: false };
  const handlers: Record<string, Handler> = {
    'update:handoff_tokens': (call) => {
      if (!whereQuery(call).params.includes(options.hash)) return [];
      // Exactly the conditions the UPDATE's WHERE carries: unused and unexpired.
      if (state.used || options.expired === true) return [];
      state.used = true;
      return [{ userId: USER_ID, slug: SLUG }];
    },
    'select:handoff_tokens': (call) =>
      whereQuery(call).params.includes(options.hash) ? [{ slug: SLUG }] : [],
  };
  return { handlers, state };
}

function sessionCookie(res: Response): string | null {
  const header = res.headers.get('set-cookie');
  const match = header ? /groupie_session=([^;]+)/.exec(header) : null;
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

describe('generateHandoffToken', () => {
  it('is 32 random bytes as base64url — URL-safe, no padding', () => {
    const { raw } = generateHandoffToken();
    expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(raw, 'base64url')).toHaveLength(32);
  });

  it('never repeats', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(generateHandoffToken().raw);
    expect(seen.size).toBe(200);
  });

  it('pairs the raw token with its own sha256, not with itself', () => {
    const { raw, hash } = generateHandoffToken();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(raw);
    // Independent implementation: proves the digest, not self-consistency.
    expect(hash).toBe(createHash('sha256').update(raw).digest('hex'));
  });
});

describe('hashHandoffToken', () => {
  it('is stable and input-sensitive', () => {
    expect(hashHandoffToken('abc')).toBe(hashHandoffToken('abc'));
    expect(hashHandoffToken('abc')).not.toBe(hashHandoffToken('abd'));
  });
});

describe('handoffUrl', () => {
  it('builds <webAppUrl>/auth/handoff?token=<raw>', () => {
    expect(handoffUrl(WEB_APP_URL, 'tok')).toBe(`${WEB_APP_URL}/auth/handoff?token=tok`);
  });

  it('tolerates a trailing slash on the configured base', () => {
    expect(handoffUrl(`${WEB_APP_URL}/`, 'tok')).toBe(`${WEB_APP_URL}/auth/handoff?token=tok`);
  });
});

describe('POST /api/g/:slug/handoff (mint)', () => {
  it('returns a handoff url on the configured origin', async () => {
    const { db } = makeDb();
    const res = await testApp(db).request(`/api/g/${SLUG}/handoff`, { method: 'POST' });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { url: string };
    expect(body.url.startsWith(`${WEB_APP_URL}/auth/handoff?token=`)).toBe(true);
    expect(tokenFromUrl(body.url)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // A bearer credential must not sit in any cache.
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('stores the sha256 at rest and never the raw token', async () => {
    const { db, calls } = makeDb();
    const res = await testApp(db).request(`/api/g/${SLUG}/handoff`, { method: 'POST' });
    const { url } = (await res.json()) as { url: string };
    const raw = tokenFromUrl(url);

    const insert = find(calls, 'insert:handoff_tokens')[0];
    expect(insert?.values?.tokenHash).toBe(hashHandoffToken(raw));
    expect(insert?.values?.userId).toBe(USER_ID);
    // Nothing anywhere in the row can be replayed as a link.
    expect(JSON.stringify(insert?.values ?? {})).not.toContain(raw);
  });

  it('stamps the TTL on the database clock, not a JS Date', async () => {
    const { db, calls } = makeDb();
    await testApp(db).request(`/api/g/${SLUG}/handoff`, { method: 'POST' });

    const expiresAt = find(calls, 'insert:handoff_tokens')[0]?.values?.expiresAt;
    expect(expiresAt).not.toBeInstanceOf(Date);
    expect(renderSql(expiresAt)).toBe("now() + 60 * interval '1 second'");
  });

  it('records the gated group slug, not the raw path parameter', async () => {
    const { db, calls } = makeDb();
    await testApp(db).request('/api/g/SOME-OTHER-SLUG/handoff', { method: 'POST' });
    expect(find(calls, 'insert:handoff_tokens')[0]?.values?.slug).toBe(SLUG);
  });

  it('sweeps rows older than an hour on the way through', async () => {
    const { db, calls } = makeDb();
    await testApp(db).request(`/api/g/${SLUG}/handoff`, { method: 'POST' });

    const sweep = whereQuery(find(calls, 'delete:handoff_tokens')[0] ?? { key: '' });
    expect(sweep.sql).toContain('"created_at"');
    expect(sweep.sql).toContain("interval '1 hour'");
  });

  it('evicts the oldest live tokens beyond the per-user cap', async () => {
    const { db, calls } = makeDb({
      // Two rows sit past the cap.
      'select:handoff_tokens': () => [{ id: 11 }, { id: 12 }],
    });
    await testApp(db).request(`/api/g/${SLUG}/handoff`, { method: 'POST' });

    // Only unused, unexpired rows count toward the cap, newest kept.
    const survey = find(calls, 'select:handoff_tokens')[0];
    const surveyWhere = whereQuery(survey ?? { key: '' });
    expect(surveyWhere.params).toContain(USER_ID);
    expect(surveyWhere.sql).toContain('"used_at" is null');
    expect(surveyWhere.sql).toContain('"expires_at" > now()');
    // Cap is 10 and this mint adds one, so 9 survive.
    expect(survey?.offset).toBe(9);

    const eviction = find(calls, 'delete:handoff_tokens')[1];
    expect(whereQuery(eviction ?? { key: '' }).params).toEqual(expect.arrayContaining([11, 12]));
  });

  it('deletes nothing extra when the user is under the cap', async () => {
    const { db, calls } = makeDb({ 'select:handoff_tokens': () => [] });
    await testApp(db).request(`/api/g/${SLUG}/handoff`, { method: 'POST' });
    // Just the age sweep.
    expect(find(calls, 'delete:handoff_tokens')).toHaveLength(1);
  });

  it('still mints when housekeeping fails', async () => {
    const { db, calls } = makeDb({
      'delete:handoff_tokens': () => {
        throw new Error('housekeeping exploded');
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const res = await testApp(db).request(`/api/g/${SLUG}/handoff`, { method: 'POST' });
      expect(res.status).toBe(200);
      expect(find(calls, 'insert:handoff_tokens')).toHaveLength(1);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('GET /auth/handoff (redeem)', () => {
  it('claims the token in ONE conditional UPDATE', async () => {
    const { raw, hash } = generateHandoffToken();
    const { handlers } = storedToken({ hash });
    const { db, calls } = makeDb(handlers);
    await testApp(db).request(`/auth/handoff?token=${raw}`);

    const updates = find(calls, 'update:handoff_tokens');
    expect(updates).toHaveLength(1);
    const claim = whereQuery(updates[0] ?? { key: '' });
    // The check and the write are the same statement: two browsers racing one
    // link cannot both win.
    expect(claim.sql).toContain('"token_hash" =');
    expect(claim.sql).toContain('"used_at" is null');
    expect(claim.sql).toContain('"expires_at" > now()');
    expect(renderSql(updates[0]?.set?.usedAt)).toBe('now()');
    // Lookup is by digest; the secret itself never reaches the database.
    expect(claim.params).toContain(hash);
    expect(claim.params).not.toContain(raw);
  });

  it('signs the browser in and lands it on the board', async () => {
    const { raw, hash } = generateHandoffToken();
    const { db } = makeDb(storedToken({ hash }).handlers);
    const res = await testApp(db).request(`/auth/handoff?token=${raw}`);

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/g/${SLUG}`);
    expect(res.headers.get('cache-control')).toBe('no-store');

    const cookie = sessionCookie(res);
    expect(cookie).not.toBeNull();
    // Exactly the cookie auth.ts mints: same signature, same user.
    expect(verifySession(cookie ?? '', SESSION_SECRET)?.userId).toBe(USER_ID);
    expect(res.headers.get('set-cookie')).toContain('HttpOnly');
  });

  it('redeems exactly once — a replay gets the expired wall', async () => {
    const { raw, hash } = generateHandoffToken();
    const { handlers, state } = storedToken({ hash });
    const { db } = makeDb(handlers);
    const app = testApp(db);

    const first = await app.request(`/auth/handoff?token=${raw}`);
    expect(first.headers.get('location')).toBe(`/g/${SLUG}`);
    expect(state.used).toBe(true);

    const second = await app.request(`/auth/handoff?token=${raw}`);
    expect(second.status).toBe(302);
    expect(second.headers.get('location')).toBe(`/g/${SLUG}?handoff=expired`);
    expect(sessionCookie(second)).toBeNull();
  });

  it('rejects an expired token and sends it to that board’s login wall', async () => {
    const { raw, hash } = generateHandoffToken();
    const { db } = makeDb(storedToken({ hash, expired: true }).handlers);
    const res = await testApp(db).request(`/auth/handoff?token=${raw}`);

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/g/${SLUG}?handoff=expired`);
    expect(sessionCookie(res)).toBeNull();
  });

  it('sends an unknown token to the root — never a dead end', async () => {
    const { db } = makeDb();
    const res = await testApp(db).request('/auth/handoff?token=not-a-real-token');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    expect(sessionCookie(res)).toBeNull();
  });

  it('redirects a missing or oversized token without touching the database', async () => {
    const { db, calls } = makeDb();
    const app = testApp(db);
    for (const path of ['/auth/handoff', '/auth/handoff?token=', `/auth/handoff?token=${'x'.repeat(300)}`]) {
      const res = await app.request(path);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/');
    }
    expect(calls).toHaveLength(0);
  });

  it('escapes the slug it redirects to', async () => {
    const { raw, hash } = generateHandoffToken();
    const { db } = makeDb({
      'update:handoff_tokens': (call) =>
        whereQuery(call).params.includes(hash) ? [{ userId: USER_ID, slug: 'a b/c' }] : [],
    });
    const res = await testApp(db).request(`/auth/handoff?token=${raw}`);
    expect(res.headers.get('location')).toBe('/g/a%20b%2Fc');
  });
});

/**
 * The redeem route lives outside /api on purpose, so the only thing standing
 * between it and the SPA catch-all is registration order in app.ts. These run
 * against the REAL createApi so a reorder there fails here.
 */
describe('wiring in createApi', () => {
  const botApi = {} as unknown as Parameters<typeof createApi>[1];

  it('answers /auth/handoff itself instead of serving the SPA shell', async () => {
    const { db } = makeDb();
    const res = await createApi(db, botApi, CONFIG).request('/auth/handoff?token=nope');
    // The SPA fallback would be a 200 (index.html or the not-built notice).
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
  });

  it('keeps the mint behind the member gate', async () => {
    const { db, calls } = makeDb();
    const res = await createApi(db, botApi, CONFIG).request(`/api/g/${SLUG}/handoff`, {
      method: 'POST',
      headers: { Origin: WEB_APP_URL },
    });
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('keeps the mint behind the csrf origin check', async () => {
    const { db, calls } = makeDb();
    const res = await createApi(db, botApi, CONFIG).request(`/api/g/${SLUG}/handoff`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });
});
