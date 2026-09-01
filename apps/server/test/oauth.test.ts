import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTVerifyGetKey,
} from 'jose';
import { createApi } from '../src/api/app.js';
import { verifySession } from '../src/api/auth.js';
import {
  ID_TOKEN_ALGORITHMS,
  OAUTH_SCOPE,
  TELEGRAM_AUTHORIZATION_ENDPOINT,
  TELEGRAM_ISSUER,
  TELEGRAM_TOKEN_ENDPOINT,
  callbackUrl,
  challengeFor,
  createOauthRoutes,
  generateState,
  generateVerifier,
  oauthEnabled,
  signOauthState,
  verifyOauthState,
} from '../src/api/oauth.js';
import type { Config } from '../src/config.js';

/**
 * Everything here is hermetic: the token endpoint is a fake fetch and the
 * id_token is signed by a key pair generated in-process and served through a
 * LOCAL JWKS. No test may reach oauth.telegram.org — a network call would make
 * the suite depend on Telegram being up and on a real bot's credentials.
 */

const CLIENT_ID = '7654321';
const CLIENT_SECRET = 'botfather-login-widget-secret';
const SESSION_SECRET = 'test-session-secret';
const WEB_APP_URL = 'https://groupie.example';
const SLUG = 'hammertime';
const USER_ID = 4242;
const CALLBACK_URL = `${WEB_APP_URL}/auth/telegram/callback`;
const STATE_COOKIE = 'groupie_tg_oauth';

const BASE_CONFIG: Config = {
  botToken: '7654321:AA-not-a-real-bot-token',
  databaseUrl: 'postgres://unused',
  webAppUrl: WEB_APP_URL,
  port: 3000,
  sessionSecret: SESSION_SECRET,
  miniAppUrl: null,
  tgOauthClientId: CLIENT_ID,
  tgOauthClientSecret: CLIENT_SECRET,
  devAuthUserId: null,
};

/** Same deployment with the feature un-configured. */
const OFF_CONFIG: Config = { ...BASE_CONFIG, tgOauthClientId: null, tgOauthClientSecret: null };

// ---------------------------------------------------------------- key material

/** Taken from jose so the test does not depend on a global CryptoKey type. */
type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;
type Key = KeyPair['privateKey'];

/** The "Telegram" signing key, and a second one that must never be trusted. */
const telegramKeys = await generateKeyPair('RS256', { extractable: true });
const impostorKeys = await generateKeyPair('RS256', { extractable: true });

async function publicJwk(key: Key, kid: string): Promise<JWK> {
  return { ...(await exportJWK(key)), kid, alg: 'RS256', use: 'sig' };
}

const LOCAL_JWKS: JWTVerifyGetKey = createLocalJWKSet({
  keys: [await publicJwk(telegramKeys.publicKey, 'test-oidc-1')],
});

interface TokenOptions {
  sub?: string;
  audience?: string;
  issuer?: string;
  /** Seconds from now; negative for an already-expired token. */
  expiresInSeconds?: number;
  issuedAtOffsetSeconds?: number;
  signWith?: Key;
  omitExp?: boolean;
}

async function makeIdToken(options: TokenOptions = {}): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  let jwt = new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: 'test-oidc-1' })
    .setIssuer(options.issuer ?? TELEGRAM_ISSUER)
    .setAudience(options.audience ?? CLIENT_ID)
    .setSubject(options.sub ?? String(USER_ID))
    .setIssuedAt(nowSec + (options.issuedAtOffsetSeconds ?? 0));
  if (!options.omitExp) jwt = jwt.setExpirationTime(nowSec + (options.expiresInSeconds ?? 300));
  return jwt.sign(options.signWith ?? telegramKeys.privateKey);
}

// -------------------------------------------------------------------- fake net

interface TokenCall {
  url: string;
  method: string;
  authorization: string | null;
  contentType: string | null;
  body: URLSearchParams;
}

interface FakeNet {
  fetch: typeof globalThis.fetch;
  calls: TokenCall[];
}

/** A token endpoint that records what it was asked and answers a script. */
function fakeTokenEndpoint(
  respond: (call: TokenCall) => Promise<Response> | Response = () =>
    new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
): FakeNet {
  const calls: TokenCall[] = [];
  type FetchArgs = Parameters<typeof globalThis.fetch>;
  const fetchImpl = async (input: FetchArgs[0], init?: FetchArgs[1]): Promise<Response> => {
    const call: TokenCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      authorization: new Headers(init?.headers).get('Authorization'),
      contentType: new Headers(init?.headers).get('Content-Type'),
      body: new URLSearchParams(typeof init?.body === 'string' ? init.body : ''),
    };
    calls.push(call);
    return respond(call);
  };
  return { fetch: fetchImpl as unknown as typeof globalThis.fetch, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ---------------------------------------------------------------- app + cookies

function testApp(config: Config = BASE_CONFIG, net?: FakeNet): Hono {
  const app = new Hono();
  app.route(
    '/',
    createOauthRoutes(config, { fetch: net?.fetch, jwks: LOCAL_JWKS }),
  );
  return app;
}

function cookieValue(res: Response, name: string): string | null {
  // Hono sets one cookie per response here, so a plain header read is enough.
  const header = res.headers.get('set-cookie');
  if (!header) return null;
  const match = new RegExp(`${name}=([^;]*)`).exec(header);
  const raw = match?.[1];
  if (raw === undefined || raw === '') return null;
  return decodeURIComponent(raw);
}

function sessionUserId(res: Response): number | null {
  const cookie = cookieValue(res, 'groupie_session');
  return cookie ? (verifySession(cookie, SESSION_SECRET)?.userId ?? null) : null;
}

function locationOf(res: Response): string {
  return res.headers.get('location') ?? '';
}

/** Drive the real start leg, then hand its cookie back like a browser would. */
async function startFlow(app: Hono, slug = SLUG) {
  const res = await app.request(`/auth/telegram/start?slug=${slug}`);
  const cookie = cookieValue(res, STATE_COOKIE);
  const location = new URL(locationOf(res));
  return {
    res,
    cookie,
    state: location.searchParams.get('state') ?? '',
    challenge: location.searchParams.get('code_challenge') ?? '',
    header: { Cookie: `${STATE_COOKIE}=${encodeURIComponent(cookie ?? '')}` },
  };
}

// ============================================================== state cookie

describe('oauth state cookie', () => {
  const future = Math.floor(Date.now() / 1000) + 600;
  const state = { state: generateState(), verifier: generateVerifier(), slug: SLUG, expiresAt: future };

  it('round-trips state, verifier, slug and expiry', () => {
    const token = signOauthState(state, SESSION_SECRET);
    expect(verifyOauthState(token, SESSION_SECRET)).toEqual(state);
  });

  it('carries the verifier but never the challenge', () => {
    const token = signOauthState(state, SESSION_SECRET);
    expect(token).toContain(state.verifier);
    expect(token).not.toContain(challengeFor(state.verifier));
  });

  it('rejects a tampered state, verifier, slug or expiry', () => {
    const signature = signOauthState(state, SESSION_SECRET).split('.')[4]!;
    const forge = (parts: string[]) => `${parts.join('.')}.${signature}`;
    expect(
      verifyOauthState(forge([generateState(), state.verifier, SLUG, String(future)]), SESSION_SECRET),
    ).toBeNull();
    expect(
      verifyOauthState(forge([state.state, generateVerifier(), SLUG, String(future)]), SESSION_SECRET),
    ).toBeNull();
    expect(
      verifyOauthState(forge([state.state, state.verifier, 'other-board', String(future)]), SESSION_SECRET),
    ).toBeNull();
    expect(
      verifyOauthState(forge([state.state, state.verifier, SLUG, String(future + 600)]), SESSION_SECRET),
    ).toBeNull();
  });

  it('rejects a cookie signed with another secret', () => {
    expect(verifyOauthState(signOauthState(state, 'other-secret'), SESSION_SECRET)).toBeNull();
  });

  it('rejects an expired cookie even though its signature is valid', () => {
    const past = { ...state, expiresAt: Math.floor(Date.now() / 1000) - 1 };
    const token = signOauthState(past, SESSION_SECRET);
    // The signature itself is genuine; only the clock rejects it.
    expect(token.split('.')).toHaveLength(5);
    expect(verifyOauthState(token, SESSION_SECRET)).toBeNull();
  });

  it('rejects malformed cookies', () => {
    expect(verifyOauthState('', SESSION_SECRET)).toBeNull();
    expect(verifyOauthState('a.b.c', SESSION_SECRET)).toBeNull();
    expect(verifyOauthState(`${state.state}.${state.verifier}.${SLUG}.${future}`, SESSION_SECRET)).toBeNull();
  });
});

// ==================================================================== PKCE

describe('PKCE', () => {
  it('generates a verifier inside RFC 7636 length and alphabet', () => {
    const verifier = generateVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
  });

  it('never repeats a verifier or a state', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(generateVerifier()).add(generateState());
    expect(seen.size).toBe(400);
  });

  it('challenge is base64url(sha256(verifier)) — independently computed', () => {
    const verifier = generateVerifier();
    expect(challengeFor(verifier)).toBe(
      createHash('sha256').update(verifier, 'ascii').digest('base64url'),
    );
    // Known RFC 7636 appendix B vector.
    expect(challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });
});

// ============================================================== feature flag

describe('GET /api/auth/telegram/available', () => {
  it('is true only when both client id and secret are set', async () => {
    const on = await testApp().request('/api/auth/telegram/available');
    expect(await on.json()).toEqual({ available: true });

    const off = await testApp(OFF_CONFIG).request('/api/auth/telegram/available');
    expect(await off.json()).toEqual({ available: false });
  });

  it('treats a half-configured client as off', async () => {
    for (const half of [
      { ...BASE_CONFIG, tgOauthClientSecret: null },
      { ...BASE_CONFIG, tgOauthClientId: null },
    ]) {
      expect(oauthEnabled(half)).toBe(false);
      const res = await testApp(half).request('/api/auth/telegram/available');
      expect(await res.json()).toEqual({ available: false });
    }
  });
});

// ================================================================ start leg

describe('GET /auth/telegram/start', () => {
  it('redirects to Telegram with every required authorization parameter', async () => {
    const { res, cookie } = await startFlow(testApp());
    expect(res.status).toBe(302);
    expect(res.headers.get('cache-control')).toBe('no-store');

    const url = new URL(locationOf(res));
    expect(`${url.origin}${url.pathname}`).toBe(TELEGRAM_AUTHORIZATION_ENDPOINT);
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(CALLBACK_URL);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe(OAUTH_SCOPE);
    expect(url.searchParams.get('scope')).toContain('openid');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(cookie).not.toBeNull();
  });

  it('binds the redirect to the cookie: same state, challenge of the stored verifier', async () => {
    const { cookie, state, challenge } = await startFlow(testApp());
    const stored = verifyOauthState(cookie ?? '', SESSION_SECRET);
    expect(stored?.state).toBe(state);
    expect(stored?.slug).toBe(SLUG);
    expect(challengeFor(stored?.verifier ?? '')).toBe(challenge);
  });

  it('never puts the verifier or the client secret in the redirect', async () => {
    const { res, cookie } = await startFlow(testApp());
    const verifier = verifyOauthState(cookie ?? '', SESSION_SECRET)?.verifier ?? '';
    expect(locationOf(res)).not.toContain(verifier);
    expect(locationOf(res)).not.toContain(CLIENT_SECRET);
  });

  it('sets the state cookie httpOnly, Lax and short-lived', async () => {
    const res = await testApp().request(`/auth/telegram/start?slug=${SLUG}`);
    const header = res.headers.get('set-cookie') ?? '';
    expect(header).toContain('HttpOnly');
    // Lax is required, not incidental: Telegram returns via a top-level GET.
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Secure');
    expect(header).toContain('Max-Age=600');
  });

  it('goes straight to the board when the feature is off, minting no cookie', async () => {
    const res = await testApp(OFF_CONFIG).request(`/auth/telegram/start?slug=${SLUG}`);
    expect(res.status).toBe(302);
    expect(locationOf(res)).toBe(`/g/${SLUG}`);
    expect(cookieValue(res, STATE_COOKIE)).toBeNull();
  });

  it('rejects a slug that is not slug-shaped', async () => {
    const app = testApp();
    for (const slug of ['', 'has%20space', 'a'.repeat(65), '../etc', 'a/b']) {
      const res = await app.request(`/auth/telegram/start?slug=${encodeURIComponent(slug)}`);
      expect(res.status).toBe(302);
      expect(locationOf(res)).toBe('/');
      expect(cookieValue(res, STATE_COOKIE)).toBeNull();
    }
    const missing = await app.request('/auth/telegram/start');
    expect(locationOf(missing)).toBe('/');
  });
});

// ============================================================= callback leg

describe('GET /auth/telegram/callback', () => {
  it('signs the browser in and lands it on the board', async () => {
    const net = fakeTokenEndpoint(async () =>
      jsonResponse({ id_token: await makeIdToken(), token_type: 'Bearer', expires_in: 3600 }),
    );
    const app = testApp(BASE_CONFIG, net);
    const { state, header } = await startFlow(app);

    const res = await app.request(`/auth/telegram/callback?code=auth-code&state=${state}`, {
      headers: header,
    });

    expect(res.status).toBe(302);
    expect(locationOf(res)).toBe(`/g/${SLUG}`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    // Exactly the cookie auth.ts mints for the Mini App and the handoff.
    expect(sessionUserId(res)).toBe(USER_ID);
    expect(res.headers.get('set-cookie')).toContain('HttpOnly');
  });

  it('exchanges the code the way the live docs specify', async () => {
    const net = fakeTokenEndpoint(async () => jsonResponse({ id_token: await makeIdToken() }));
    const app = testApp(BASE_CONFIG, net);
    const { state, header, cookie } = await startFlow(app);
    await app.request(`/auth/telegram/callback?code=auth-code&state=${state}`, { headers: header });

    expect(net.calls).toHaveLength(1);
    const call = net.calls[0]!;
    expect(call.url).toBe(TELEGRAM_TOKEN_ENDPOINT);
    expect(call.method).toBe('POST');
    expect(call.contentType).toBe('application/x-www-form-urlencoded');
    // client_secret_basic, the first method the discovery document lists.
    expect(call.authorization).toBe(
      `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
    );
    expect(call.body.get('grant_type')).toBe('authorization_code');
    expect(call.body.get('code')).toBe('auth-code');
    expect(call.body.get('redirect_uri')).toBe(CALLBACK_URL);
    expect(call.body.get('client_id')).toBe(CLIENT_ID);
    // The PKCE proof is the verifier from OUR cookie, never anything the caller sent.
    expect(call.body.get('code_verifier')).toBe(verifyOauthState(cookie ?? '', SESSION_SECRET)?.verifier);
    // The secret travels in the Authorization header only.
    expect(call.body.get('client_secret')).toBeNull();
  });

  it('clears the state cookie so a code cannot be replayed', async () => {
    const net = fakeTokenEndpoint(async () => jsonResponse({ id_token: await makeIdToken() }));
    const app = testApp(BASE_CONFIG, net);
    const { state, header } = await startFlow(app);
    const res = await app.request(`/auth/telegram/callback?code=auth-code&state=${state}`, {
      headers: header,
    });
    // Hono's deleteCookie writes an immediate expiry.
    expect(res.headers.get('set-cookie')).toContain(`${STATE_COOKIE}=;`);

    // Replaying the same code with no cookie has nothing to check against.
    const replay = await app.request(`/auth/telegram/callback?code=auth-code&state=${state}`);
    expect(locationOf(replay)).toBe('/');
    expect(sessionUserId(replay)).toBeNull();
    expect(net.calls).toHaveLength(1);
  });

  it('rejects a mismatched state WITHOUT spending the code', async () => {
    const net = fakeTokenEndpoint();
    const app = testApp(BASE_CONFIG, net);
    const { header } = await startFlow(app);

    const res = await app.request(
      `/auth/telegram/callback?code=auth-code&state=${generateState()}`,
      { headers: header },
    );

    expect(res.status).toBe(302);
    expect(locationOf(res)).toBe(`/g/${SLUG}?login=failed`);
    // The whole point of checking state first: no token-endpoint call happened.
    expect(net.calls).toHaveLength(0);
    expect(sessionUserId(res)).toBeNull();
  });

  it('rejects a missing state, and a state that is a prefix of the real one', async () => {
    const net = fakeTokenEndpoint();
    const app = testApp(BASE_CONFIG, net);
    const { state, header } = await startFlow(app);

    for (const query of ['code=auth-code', `code=auth-code&state=${state.slice(0, -1)}`]) {
      const res = await app.request(`/auth/telegram/callback?${query}`, { headers: header });
      expect(locationOf(res)).toBe(`/g/${SLUG}?login=failed`);
    }
    expect(net.calls).toHaveLength(0);
  });

  it('fails on a missing, empty or absurd code without spending one', async () => {
    const net = fakeTokenEndpoint();
    const app = testApp(BASE_CONFIG, net);
    const { state, header } = await startFlow(app);

    for (const query of [
      `state=${state}`,
      `code=&state=${state}`,
      `code=${'x'.repeat(3000)}&state=${state}`,
      // Telegram's decline path: an error instead of a code.
      `error=access_denied&state=${state}`,
    ]) {
      const res = await app.request(`/auth/telegram/callback?${query}`, { headers: header });
      expect(locationOf(res)).toBe(`/g/${SLUG}?login=failed`);
      expect(sessionUserId(res)).toBeNull();
    }
    expect(net.calls).toHaveLength(0);
  });

  it('sends a request with no usable cookie to the root, not to a dead end', async () => {
    const net = fakeTokenEndpoint();
    const app = testApp(BASE_CONFIG, net);

    const bare = await app.request('/auth/telegram/callback?code=c&state=s');
    expect(bare.status).toBe(302);
    expect(locationOf(bare)).toBe('/');

    const forged = await app.request('/auth/telegram/callback?code=c&state=s', {
      headers: { Cookie: `${STATE_COOKIE}=not.a.valid.cookie.value` },
    });
    expect(locationOf(forged)).toBe('/');
    expect(net.calls).toHaveLength(0);
  });

  it('never leaks a reason beyond the flag', async () => {
    const net = fakeTokenEndpoint(() => jsonResponse({ error: 'invalid_grant' }, 400));
    const app = testApp(BASE_CONFIG, net);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { state, header } = await startFlow(app);
      const res = await app.request(`/auth/telegram/callback?code=auth-code&state=${state}`, {
        headers: header,
      });
      const location = locationOf(res);
      expect(location).toBe(`/g/${SLUG}?login=failed`);
      expect(location).not.toContain('invalid_grant');
      expect(location).not.toContain('auth-code');
      // Nothing secret reached the log either.
      const logged = warn.mock.calls.flat().map(String).join(' ');
      expect(logged).not.toContain('auth-code');
      expect(logged).not.toContain(CLIENT_SECRET);
    } finally {
      warn.mockRestore();
    }
  });
});

// ================================================== id_token verification

describe('id_token verification', () => {
  async function attempt(token: string | null | undefined): Promise<Response> {
    const net = fakeTokenEndpoint(() => jsonResponse(token === undefined ? {} : { id_token: token }));
    const app = testApp(BASE_CONFIG, net);
    const { state, header } = await startFlow(app);
    return app.request(`/auth/telegram/callback?code=auth-code&state=${state}`, { headers: header });
  }

  async function expectRejected(token: string | null | undefined): Promise<void> {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const res = await attempt(token);
      expect(locationOf(res)).toBe(`/g/${SLUG}?login=failed`);
      expect(sessionUserId(res)).toBeNull();
    } finally {
      warn.mockRestore();
    }
  }

  it('rejects an expired id_token', async () => {
    await expectRejected(await makeIdToken({ expiresInSeconds: -3600 }));
  });

  it('rejects an id_token signed by a key that is not in the JWKS', async () => {
    await expectRejected(await makeIdToken({ signWith: impostorKeys.privateKey }));
  });

  it('rejects a token issued to another audience', async () => {
    await expectRejected(await makeIdToken({ audience: '999999' }));
  });

  it('rejects a token from another issuer', async () => {
    await expectRejected(await makeIdToken({ issuer: 'https://evil.example' }));
  });

  it('rejects an everlasting token with no exp', async () => {
    await expectRejected(await makeIdToken({ omitExp: true }));
  });

  it('rejects a non-numeric or non-positive subject', async () => {
    for (const sub of ['not-a-number', '0', '-5', '', '12.5', '9'.repeat(20)]) {
      await expectRejected(await makeIdToken({ sub }));
    }
  });

  it('rejects an unsigned (alg: none) token', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const claims = {
      iss: TELEGRAM_ISSUER,
      aud: CLIENT_ID,
      sub: String(USER_ID),
      iat: nowSec,
      exp: nowSec + 300,
    };
    const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    await expectRejected(`${b64({ alg: 'none' })}.${b64(claims)}.`);
    expect(ID_TOKEN_ALGORITHMS as readonly string[]).not.toContain('none');
  });

  it('rejects a token response with no id_token at all', async () => {
    await expectRejected(undefined);
    await expectRejected(null);
  });

  it('accepts the algorithms the discovery document advertises', () => {
    expect([...ID_TOKEN_ALGORITHMS]).toEqual(['RS256', 'ES256', 'EdDSA', 'ES256K']);
  });

  it('takes the user id from sub', async () => {
    const net = fakeTokenEndpoint(async () =>
      jsonResponse({ id_token: await makeIdToken({ sub: '123456789' }) }),
    );
    const app = testApp(BASE_CONFIG, net);
    const { state, header } = await startFlow(app);
    const res = await app.request(`/auth/telegram/callback?code=auth-code&state=${state}`, {
      headers: header,
    });
    expect(sessionUserId(res)).toBe(123456789);
  });
});

// ======================================================== token endpoint faults

describe('token endpoint faults', () => {
  async function expectFailedLogin(net: FakeNet): Promise<void> {
    const app = testApp(BASE_CONFIG, net);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { state, header } = await startFlow(app);
      const res = await app.request(`/auth/telegram/callback?code=auth-code&state=${state}`, {
        headers: header,
      });
      expect(locationOf(res)).toBe(`/g/${SLUG}?login=failed`);
      expect(sessionUserId(res)).toBeNull();
    } finally {
      warn.mockRestore();
    }
  }

  it('fails the login on a non-2xx token response', async () => {
    await expectFailedLogin(fakeTokenEndpoint(() => jsonResponse({ error: 'invalid_grant' }, 400)));
  });

  it('fails the login on a non-JSON token response', async () => {
    await expectFailedLogin(fakeTokenEndpoint(() => new Response('<html>nope</html>', { status: 200 })));
  });

  it('fails the login when the token endpoint is unreachable', async () => {
    await expectFailedLogin(
      fakeTokenEndpoint(() => {
        throw new Error('ECONNREFUSED');
      }),
    );
  });
});

// ================================================================== helpers

describe('callbackUrl', () => {
  it('is <webAppUrl>/auth/telegram/callback, trailing slash or not', () => {
    expect(callbackUrl(WEB_APP_URL)).toBe(CALLBACK_URL);
    expect(callbackUrl(`${WEB_APP_URL}/`)).toBe(CALLBACK_URL);
  });
});

/**
 * Both legs live outside /api, so the only thing between them and the SPA
 * catch-all is registration order in app.ts. These run against the REAL
 * createApi so a reorder there fails here. None of them touch the network: the
 * start leg never does, and a callback with no cookie stops before the exchange.
 */
describe('wiring in createApi', () => {
  const db = {} as unknown as Parameters<typeof createApi>[0];
  const botApi = {} as unknown as Parameters<typeof createApi>[1];

  it('answers /auth/telegram/start itself instead of serving the SPA shell', async () => {
    const res = await createApi(db, botApi, BASE_CONFIG).request(`/auth/telegram/start?slug=${SLUG}`);
    // The SPA fallback would be a 200 (index.html or the not-built notice).
    expect(res.status).toBe(302);
    expect(new URL(locationOf(res)).origin).toBe(TELEGRAM_ISSUER);
  });

  it('answers /auth/telegram/callback itself', async () => {
    const res = await createApi(db, botApi, BASE_CONFIG).request('/auth/telegram/callback?code=c&state=s');
    expect(res.status).toBe(302);
    expect(locationOf(res)).toBe('/');
  });

  it('serves the availability flag as public JSON', async () => {
    const res = await createApi(db, botApi, BASE_CONFIG).request('/api/auth/telegram/available');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: true });
  });

  it('leaves the Mini App login route alone', async () => {
    const res = await createApi(db, botApi, OFF_CONFIG).request('/api/auth/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: 'nonsense' }),
    });
    // Still initData validation, not the OIDC flag.
    expect(res.status).toBe(401);
  });
});
