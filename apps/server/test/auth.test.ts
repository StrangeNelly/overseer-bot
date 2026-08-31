import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signSession, validateInitData, verifySession } from '../src/api/auth.js';

const BOT_TOKEN = '7654321:AA-not-a-real-bot-token-abcdefghijklmno';
const SECRET = 'test-session-secret';
const USER = { id: 4242, first_name: 'Vera', username: 'vera' };

/**
 * Independent implementation of Telegram's signing scheme (deliberately NOT
 * reusing anything from the module under test) so the test proves interop, not
 * self-consistency.
 */
function buildInitData(fields: Record<string, string>, botToken = BOT_TOKEN): string {
  const dataCheckString = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  const params = new URLSearchParams(fields);
  params.set('hash', hash);
  return params.toString();
}

function freshFields(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    query_id: 'AAHdF6IQAAAAAN0XohDhrOrc',
    user: JSON.stringify(USER),
    auth_date: String(Math.floor(Date.now() / 1000) - 30),
    signature: 'stub',
    ...overrides,
  };
}

describe('validateInitData', () => {
  it('accepts initData signed with the bot token', () => {
    expect(validateInitData(buildInitData(freshFields()), BOT_TOKEN)).toEqual({
      userId: USER.id,
      authDate: expect.any(Number),
    });
  });

  it('rejects a tampered hash', () => {
    const initData = buildInitData(freshFields());
    const params = new URLSearchParams(initData);
    const hash = params.get('hash')!;
    // Flip one hex digit: same length, still hex, wrong signature.
    params.set('hash', (hash[0] === 'a' ? 'b' : 'a') + hash.slice(1));
    expect(validateInitData(params.toString(), BOT_TOKEN)).toBeNull();
  });

  it('rejects a tampered payload under a valid-looking hash', () => {
    const params = new URLSearchParams(buildInitData(freshFields()));
    params.set('user', JSON.stringify({ ...USER, id: 9999 }));
    expect(validateInitData(params.toString(), BOT_TOKEN)).toBeNull();
  });

  it('rejects data signed with a different bot token', () => {
    const initData = buildInitData(freshFields(), '111:other-token');
    expect(validateInitData(initData, BOT_TOKEN)).toBeNull();
  });

  it('rejects auth_date older than 24h', () => {
    const stale = String(Math.floor(Date.now() / 1000) - 25 * 3600);
    expect(validateInitData(buildInitData(freshFields({ auth_date: stale })), BOT_TOKEN)).toBeNull();
  });

  it('accepts auth_date just inside the 24h window', () => {
    const edge = String(Math.floor(Date.now() / 1000) - 23 * 3600);
    expect(validateInitData(buildInitData(freshFields({ auth_date: edge })), BOT_TOKEN)).toEqual({
      userId: USER.id,
      authDate: Number(edge),
    });
  });

  it('rejects unparseable shapes', () => {
    expect(validateInitData('', BOT_TOKEN)).toBeNull();
    expect(validateInitData('user=%7B%7D&auth_date=1', BOT_TOKEN)).toBeNull(); // no hash
    expect(validateInitData('hash=notlongenough', BOT_TOKEN)).toBeNull();
    expect(validateInitData(buildInitData(freshFields({ auth_date: 'soon' })), BOT_TOKEN)).toBeNull();
    expect(
      validateInitData(buildInitData(freshFields({ user: 'not json' })), BOT_TOKEN),
    ).toBeNull();
    expect(
      validateInitData(buildInitData(freshFields({ user: JSON.stringify({ nope: 1 }) })), BOT_TOKEN),
    ).toBeNull();
  });
});

describe('session tokens', () => {
  const future = Math.floor(Date.now() / 1000) + 3600;

  it('round-trips a signed session', () => {
    const token = signSession(77, future, SECRET);
    expect(token.startsWith(`77.${future}.`)).toBe(true);
    expect(verifySession(token, SECRET)).toEqual({ userId: 77, expiresAt: future });
  });

  it('rejects a tampered user id, expiry, or signature', () => {
    const token = signSession(77, future, SECRET);
    const sig = token.split('.')[2]!;
    expect(verifySession(`78.${future}.${sig}`, SECRET)).toBeNull();
    expect(verifySession(`77.${future + 60}.${sig}`, SECRET)).toBeNull();
    expect(verifySession(`77.${future}.${'0'.repeat(sig.length)}`, SECRET)).toBeNull();
  });

  it('rejects a session signed with another secret', () => {
    expect(verifySession(signSession(77, future, 'other-secret'), SECRET)).toBeNull();
  });

  it('rejects an expired session', () => {
    const past = Math.floor(Date.now() / 1000) - 1;
    expect(verifySession(signSession(77, past, SECRET), SECRET)).toBeNull();
  });

  it('rejects malformed tokens', () => {
    expect(verifySession('', SECRET)).toBeNull();
    expect(verifySession('77', SECRET)).toBeNull();
    expect(verifySession(`77.${future}`, SECRET)).toBeNull();
    expect(verifySession(`abc.${future}.deadbeef`, SECRET)).toBeNull();
  });
});
