import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Hono, type Context, type Env } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { TelegramLoginAvailability } from '@groupie/shared';
import type { Config } from '../config.js';
import { hexEquals, hmacHex, setSessionCookie } from './auth.js';

/**
 * Browser "Log in with Telegram" (docs/decisions.md round 12) — the third door
 * into the same session cookie, beside Mini App initData and the handoff link.
 *
 * Telegram's 2026 login is OpenID Connect, not the archived hash widget:
 * Authorization Code + PKCE against oauth.telegram.org, identity delivered as a
 * signed JWT id_token verified against Telegram's JWKS. The bot token is not
 * involved. Endpoints below are copied from the live discovery document
 * (https://oauth.telegram.org/.well-known/openid-configuration, re-verified
 * 2026-09-02) and are hard-coded rather than discovered at boot: a login must
 * not depend on a second network round-trip, and a swapped discovery response
 * must not be able to move where we send an authorization code.
 *
 * Security posture:
 *   - the PKCE verifier + state live ONLY in a signed, httpOnly, 10-minute
 *     cookie — no server-side session store, nothing to sweep;
 *   - the state cookie is SameSite=Lax on purpose: the leg that must carry it
 *     is Telegram's top-level GET navigation back to our origin, which Lax
 *     allows. (SameSite=Strict would drop it and break every login.)
 *   - codes, tokens, verifiers and secrets are never logged and never appear in
 *     a redirect URL;
 *   - every failure lands on the board's login wall with `?login=failed` —
 *     never an error page, never a reason the user could not act on anyway.
 */

/** Live discovery document, https://oauth.telegram.org/.well-known/openid-configuration */
export const TELEGRAM_ISSUER = 'https://oauth.telegram.org';
export const TELEGRAM_AUTHORIZATION_ENDPOINT = 'https://oauth.telegram.org/auth';
export const TELEGRAM_TOKEN_ENDPOINT = 'https://oauth.telegram.org/token';
export const TELEGRAM_JWKS_URL = 'https://oauth.telegram.org/.well-known/jwks.json';

/**
 * `id_token_signing_alg_values_supported` verbatim. RS256 is Telegram's default;
 * the other three are opt-in under BotFather -> Login Widget -> Advanced. An
 * explicit allowlist is the point: it is what stops an attacker downgrading a
 * token to `none` or to an HMAC alg keyed on something we published.
 */
export const ID_TOKEN_ALGORITHMS = ['RS256', 'ES256', 'EdDSA', 'ES256K'] as const;

/**
 * `openid` alone yields sub/iss/iat/exp — and `sub` is the Telegram user id,
 * which is the entire identity we need. `profile`/`phone`/`telegram:bot_access`
 * are deliberately not requested: we already have names from the group.
 */
export const OAUTH_SCOPE = 'openid';

const STATE_COOKIE_NAME = 'groupie_tg_oauth';
/** Long enough to read Telegram's consent screen, short enough to be uninteresting. */
const STATE_TTL_SECONDS = 10 * 60;
/** 32 bytes -> 43 base64url chars, comfortably inside PKCE's 43..128. */
const STATE_BYTES = 32;
/** 64 bytes -> 86 base64url chars: a legal PKCE verifier with room to spare. */
const VERIFIER_BYTES = 64;
/** Telegram's own codes are far shorter; anything past this is not a code. */
const MAX_CODE_LENGTH = 2048;
/** A hung token endpoint must fail the login, not hold a request open forever. */
const TOKEN_REQUEST_TIMEOUT_MS = 10_000;
/** Signed-JWT clock skew we tolerate on iat/exp. */
const CLOCK_TOLERANCE_SECONDS = 30;

/** Same alphabet the SPA accepts for `/g/<slug>` and Telegram start params. */
const SLUG_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Our own state/verifier are base64url, so the cookie parts never contain a dot. */
const BASE64URL_RE = /^[A-Za-z0-9_-]{16,256}$/;

export function oauthEnabled(config: Config): boolean {
  return config.tgOauthClientId !== null && config.tgOauthClientSecret !== null;
}

/** Where the browser lands — the board, or its login wall with a flag. */
function boardPath(slug: string, query = ''): string {
  return `/g/${encodeURIComponent(slug)}${query}`;
}

/** Must match the URL registered in BotFather's Login Widget section exactly. */
export function callbackUrl(webAppUrl: string): string {
  return `${webAppUrl.replace(/\/+$/, '')}/auth/telegram/callback`;
}

export function generateVerifier(): string {
  return randomBytes(VERIFIER_BYTES).toString('base64url');
}

export function generateState(): string {
  return randomBytes(STATE_BYTES).toString('base64url');
}

/** PKCE S256: BASE64URL(SHA256(ASCII(verifier))) — RFC 7636 §4.2. */
export function challengeFor(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** Constant-time compare of two opaque ASCII strings. */
function secretEquals(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || a.length === 0) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** What the start leg has to hand the callback leg, carried by the browser. */
export interface OauthState {
  state: string;
  verifier: string;
  slug: string;
  /** Unix seconds. */
  expiresAt: number;
}

/**
 * `${state}.${verifier}.${slug}.${exp}.${hexsig}` — same shape and same HMAC as
 * auth.ts's session token. Every part is base64url or a slug, so none of them
 * can contain the separator.
 */
export function signOauthState(state: OauthState, secret: string): string {
  const payload = `${state.state}.${state.verifier}.${state.slug}.${state.expiresAt}`;
  return `${payload}.${hmacHex(secret, payload)}`;
}

export function verifyOauthState(token: string, secret: string): OauthState | null {
  const parts = token.split('.');
  if (parts.length !== 5) return null;
  const [state, verifier, slug, rawExp, signature] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];

  // Signature first: nothing below this line trusts an unauthenticated string.
  const payload = `${state}.${verifier}.${slug}.${rawExp}`;
  if (!hexEquals(hmacHex(secret, payload), signature.toLowerCase())) return null;

  const expiresAt = Number(rawExp);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) return null;
  if (expiresAt <= Date.now() / 1000) return null;
  // Belt and braces: a secret rotation could in principle validate a payload
  // shape we never mint, and `slug` goes into a redirect.
  if (!BASE64URL_RE.test(state) || !BASE64URL_RE.test(verifier)) return null;
  if (!SLUG_RE.test(slug)) return null;

  return { state, verifier, slug, expiresAt };
}

/**
 * SameSite=Lax is required, not merely acceptable: Telegram sends the browser
 * back with a top-level GET, which Lax cookies ride along with. Secure tracks
 * the deployment scheme so plain-http local dev still works.
 */
function setStateCookie(c: Context, state: OauthState, config: Config): void {
  setCookie(c, STATE_COOKIE_NAME, signOauthState(state, config.sessionSecret), {
    httpOnly: true,
    path: '/',
    maxAge: STATE_TTL_SECONDS,
    secure: config.webAppUrl.startsWith('https'),
    sameSite: 'Lax',
  });
}

function clearStateCookie(c: Context, config: Config): void {
  deleteCookie(c, STATE_COOKIE_NAME, {
    path: '/',
    secure: config.webAppUrl.startsWith('https'),
    sameSite: 'Lax',
  });
}

/**
 * The Telegram user id, from the `sub` claim (live docs: "The `sub` claim
 * contains the unique identifier"). It arrives as a decimal string; the numeric
 * `id` claim only exists with the `profile` scope, which we do not request.
 */
export function telegramUserId(payload: JWTPayload): number | null {
  const sub = payload.sub;
  if (typeof sub !== 'string' || !/^[0-9]{1,19}$/.test(sub)) return null;
  const userId = Number(sub);
  return Number.isSafeInteger(userId) && userId > 0 ? userId : null;
}

/**
 * Module-level so the key set is fetched once per process and refreshed by jose
 * on an unknown `kid`. Created lazily: importing this module must not open a
 * socket, and a deployment with the feature off must never touch Telegram.
 */
let remoteJwks: JWTVerifyGetKey | null = null;
function telegramJwks(): JWTVerifyGetKey {
  remoteJwks ??= createRemoteJWKSet(new URL(TELEGRAM_JWKS_URL));
  return remoteJwks;
}

/**
 * Full JWT verification: signature against Telegram's JWKS, plus issuer,
 * audience, expiry and the claims we refuse to do without. Returns the user id,
 * or null for ANY failure — the caller has exactly one thing to do about it.
 */
export async function verifyIdToken(
  idToken: string,
  clientId: string,
  keys: JWTVerifyGetKey,
): Promise<number | null> {
  try {
    const { payload } = await jwtVerify(idToken, keys, {
      issuer: TELEGRAM_ISSUER,
      audience: clientId,
      algorithms: [...ID_TOKEN_ALGORITHMS],
      // jose enforces exp when present; requiring it stops an everlasting token.
      requiredClaims: ['sub', 'exp', 'iat'],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    });
    return telegramUserId(payload);
  } catch {
    // Deliberately silent about the reason: it would only ever be logged next
    // to material we have promised not to log.
    return null;
  }
}

/** Injection seam for tests — production wires the real fetch and the real JWKS. */
export interface OauthDeps {
  fetch?: typeof globalThis.fetch;
  jwks?: JWTVerifyGetKey;
}

/**
 * Trade the authorization code for an id_token. Client authentication is HTTP
 * Basic (`client_secret_basic`, the first method the discovery document lists
 * and the one the docs page shows), with client_id repeated in the body as the
 * docs' parameter table requires.
 */
async function exchangeCode(
  code: string,
  verifier: string,
  config: Config,
  doFetch: typeof globalThis.fetch,
): Promise<string | null> {
  const clientId = config.tgOauthClientId;
  const clientSecret = config.tgOauthClientSecret;
  if (clientId === null || clientSecret === null) return null;

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: callbackUrl(config.webAppUrl),
    client_id: clientId,
    code_verifier: verifier,
  });
  // RFC 6749 §2.3.1: both halves are form-urlencoded before base64. A BotFather
  // client id/secret has nothing to escape, so this is only correctness.
  const basic = Buffer.from(
    `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`,
  ).toString('base64');

  let res: Response;
  try {
    res = await doFetch(TELEGRAM_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        Authorization: `Basic ${basic}`,
      },
      body: body.toString(),
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
  } catch {
    console.warn('telegram oauth: token endpoint unreachable');
    return null;
  }

  if (!res.ok) {
    // The status is safe to log; the body can quote the code back at us.
    console.warn(`telegram oauth: token endpoint returned ${res.status}`);
    return null;
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    console.warn('telegram oauth: token endpoint returned a non-JSON body');
    return null;
  }

  const idToken = (json as { id_token?: unknown } | null)?.id_token;
  return typeof idToken === 'string' && idToken.length > 0 ? idToken : null;
}

export function createOauthRoutes<E extends Env>(config: Config, deps: OauthDeps = {}): Hono<E> {
  const app = new Hono<E>();
  const doFetch = deps.fetch ?? globalThis.fetch;

  /** The SPA's feature flag: does this deployment have a browser login at all? */
  app.get('/api/auth/telegram/available', (c) => {
    const body: TelegramLoginAvailability = { available: oauthEnabled(config) };
    return c.json(body);
  });

  /**
   * Leg 1. PUBLIC — a browser with no session is the whole point. Registered
   * outside /api and ahead of the SPA fallback (see app.ts), like /auth/handoff.
   */
  app.get('/auth/telegram/start', (c) => {
    c.header('Cache-Control', 'no-store');
    const raw = c.req.query('slug');
    const slug = typeof raw === 'string' && SLUG_RE.test(raw) ? raw : null;

    // Feature off: the SPA should never have offered the button, but a stale tab
    // or a hand-typed URL must still land somewhere sane.
    if (!oauthEnabled(config)) return c.redirect(slug ? boardPath(slug) : '/', 302);
    if (slug === null) return c.redirect('/', 302);

    const verifier = generateVerifier();
    const state = generateState();
    setStateCookie(
      c,
      { state, verifier, slug, expiresAt: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS },
      config,
    );

    const url = new URL(TELEGRAM_AUTHORIZATION_ENDPOINT);
    url.searchParams.set('client_id', config.tgOauthClientId ?? '');
    url.searchParams.set('redirect_uri', callbackUrl(config.webAppUrl));
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', OAUTH_SCOPE);
    url.searchParams.set('state', state);
    // Only the challenge crosses the network; the verifier stays in our cookie,
    // which is what binds this authorization code to this browser.
    url.searchParams.set('code_challenge', challengeFor(verifier));
    url.searchParams.set('code_challenge_method', 'S256');
    return c.redirect(url.toString(), 302);
  });

  /**
   * Leg 2. PUBLIC, and the only place a session is minted from OIDC. Every exit
   * is a redirect: to the board on success, to `?login=failed` otherwise.
   */
  app.get('/auth/telegram/callback', async (c) => {
    c.header('Cache-Control', 'no-store');

    const cookie = getCookie(c, STATE_COOKIE_NAME);
    const stored = cookie ? verifyOauthState(cookie, config.sessionSecret) : null;
    // Single-use whatever happens next: a replayed code must not find a verifier.
    clearStateCookie(c, config);

    // Nothing to go back to — an expired, forged or absent cookie means we do
    // not even know which board was wanted.
    if (stored === null) return c.redirect('/', 302);
    const failed = boardPath(stored.slug, '?login=failed');
    if (!oauthEnabled(config)) return c.redirect(boardPath(stored.slug), 302);

    const state = c.req.query('state');
    const code = c.req.query('code');
    // State before anything expensive: a mismatch is CSRF (or a stale tab) and
    // must not spend an authorization code.
    if (typeof state !== 'string' || !secretEquals(state, stored.state)) {
      return c.redirect(failed, 302);
    }
    // Telegram sends `error=access_denied` instead of a code when the user
    // declines; both land here as "no usable code".
    if (typeof code !== 'string' || code.length === 0 || code.length > MAX_CODE_LENGTH) {
      return c.redirect(failed, 302);
    }

    const idToken = await exchangeCode(code, stored.verifier, config, doFetch);
    if (idToken === null) return c.redirect(failed, 302);

    const userId = await verifyIdToken(
      idToken,
      // Non-null: oauthEnabled() was checked above.
      config.tgOauthClientId ?? '',
      deps.jwks ?? telegramJwks(),
    );
    if (userId === null) {
      console.warn('telegram oauth: id_token rejected');
      return c.redirect(failed, 302);
    }

    // Identical to every other door: the same signed session cookie, and the
    // getChatMember gate still stands between it and any board data.
    setSessionCookie(c, userId, config);
    return c.redirect(boardPath(stored.slug), 302);
  });

  return app;
}
