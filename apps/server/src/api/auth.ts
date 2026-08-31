import { createHmac, timingSafeEqual } from 'node:crypto';
import { Hono, type Context, type Env } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { MeResponse } from '@groupie/shared';
import type { Config } from '../config.js';

const COOKIE_NAME = 'groupie_session';
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Telegram's own recommendation: treat initData older than this as replayed. */
const INIT_DATA_MAX_AGE_SECONDS = 24 * 60 * 60;

export interface InitData {
  userId: number;
  /** Unix seconds, as signed by Telegram. */
  authDate: number;
}

export interface Session {
  userId: number;
  /** Unix seconds. */
  expiresAt: number;
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/** Constant-time hex compare that tolerates (and rejects) length mismatches. */
function hexEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  // Buffer.from('zz', 'hex') silently truncates, so equal-length garbage can
  // still yield differently sized buffers.
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

/**
 * Official Telegram Mini App initData validation
 * (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app):
 * every field except `hash`, sorted by key and joined `key=value` with \n, is
 * HMAC'd with a secret that is itself HMAC_SHA256("WebAppData", botToken).
 * Values are the DECODED ones — URLSearchParams handles that.
 */
export function validateInitData(initData: string, botToken: string): InitData | null {
  if (typeof initData !== 'string' || initData.length === 0) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return null;

  const fields: [string, string][] = [];
  for (const [key, value] of params) {
    if (key !== 'hash') fields.push([key, value]);
  }
  if (fields.length === 0) return null;
  fields.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const dataCheckString = fields.map(([key, value]) => `${key}=${value}`).join('\n');

  const secretKey = hmac('WebAppData', botToken);
  const expected = hmac(secretKey, dataCheckString).toString('hex');
  if (!hexEquals(expected, hash.toLowerCase())) return null;

  const authDate = Number(params.get('auth_date'));
  if (!Number.isSafeInteger(authDate) || authDate <= 0) return null;
  // Only staleness is rejected: a slightly future auth_date is clock skew on a
  // payload Telegram already signed, not an attack we can do anything about.
  if (Date.now() / 1000 - authDate > INIT_DATA_MAX_AGE_SECONDS) return null;

  const userId = parseUserId(params.get('user'));
  if (userId === null) return null;

  return { userId, authDate };
}

function parseUserId(userJson: string | null): number | null {
  if (!userJson) return null;
  try {
    const parsed: unknown = JSON.parse(userJson);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const id = (parsed as { id?: unknown }).id;
    return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

/** Session token: `${userId}.${expiresAtSec}.${hexsig}` over `${userId}.${exp}`. */
export function signSession(userId: number, expiresAtSec: number, secret: string): string {
  const payload = `${userId}.${expiresAtSec}`;
  return `${payload}.${hmac(secret, payload).toString('hex')}`;
}

export function verifySession(token: string, secret: string): Session | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [rawUserId, rawExp, signature] = parts as [string, string, string];
  const userId = Number(rawUserId);
  const expiresAt = Number(rawExp);
  if (!Number.isSafeInteger(userId) || userId <= 0) return null;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) return null;

  const payload = `${rawUserId}.${rawExp}`;
  if (!hexEquals(hmac(secret, payload).toString('hex'), signature.toLowerCase())) return null;
  if (expiresAt <= Date.now() / 1000) return null;
  return { userId, expiresAt };
}

export function setSessionCookie(c: Context, userId: number, config: Config): void {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  // Telegram renders the Mini App in a cross-site webview, so the cookie only
  // rides along as SameSite=None — which browsers accept only with Secure.
  // Plain-http local dev can't set Secure, hence the Lax fallback.
  const https = config.webAppUrl.startsWith('https');
  setCookie(c, COOKIE_NAME, signSession(userId, expiresAt, config.sessionSecret), {
    httpOnly: true,
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
    secure: https,
    sameSite: https ? 'None' : 'Lax',
  });
}

/** The session user id, or null when the cookie is absent/forged/expired. */
export function readSession(c: Context, config: Config): number | null {
  const token = getCookie(c, COOKIE_NAME);
  if (!token) return null;
  return verifySession(token, config.sessionSecret)?.userId ?? null;
}

/**
 * Dev auth is a local-browser convenience; it must never arm in production.
 * loadConfig() is the single gate (ENABLE_DEV_AUTH=true AND not production), so
 * a non-null devAuthUserId already means "explicitly armed outside production".
 */
export function devAuthEnabled(config: Config): boolean {
  return config.devAuthUserId !== null;
}

export function createAuthRoutes<E extends Env>(config: Config): Hono<E> {
  const app = new Hono<E>();

  app.post('/api/auth/telegram', async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const initData = (body as { initData?: unknown } | null)?.initData;
    if (typeof initData !== 'string') return c.json({ error: 'initData required' }, 400);

    const validated = validateInitData(initData, config.botToken);
    if (!validated) return c.json({ error: 'invalid initData' }, 401);

    setSessionCookie(c, validated.userId, config);
    return c.body(null, 204);
  });

  app.get('/api/auth/dev', (c) => {
    const devUserId = config.devAuthUserId;
    if (devUserId === null || !devAuthEnabled(config)) return c.json({ error: 'not found' }, 404);
    setSessionCookie(c, devUserId, config);
    return c.body(null, 204);
  });

  app.get('/api/me', (c) => {
    const userId = readSession(c, config);
    if (userId === null) return c.json({ error: 'unauthorized' }, 401);
    const body: MeResponse = { userId };
    return c.json(body);
  });

  return app;
}
