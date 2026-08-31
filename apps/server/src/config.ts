function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  }
  return value;
}

/** Empty/blank/garbage all mean "unset" — a half-set dev knob must not half-work. */
function optionalInt(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

export interface Config {
  botToken: string;
  databaseUrl: string;
  webAppUrl: string;
  port: number;
  /** HMAC key for session cookies. */
  sessionSecret: string;
  /**
   * Direct-link base of the registered Telegram Mini App, e.g.
   * https://t.me/overseergroupbot/board — when set, /groupie replies with
   * `<this>?startapp=<slug>` so the board opens INSIDE Telegram.
   */
  miniAppUrl: string | null;
  /**
   * DEV ONLY: browse the board as this Telegram user id without initData (no
   * Telegram webview, no membership check). Non-null ONLY when ENABLE_DEV_AUTH
   * is exactly 'true' and NODE_ENV is not 'production', so this one field is
   * the whole gate — every consumer just checks it for null.
   */
  devAuthUserId: number | null;
}

export function loadConfig(): Config {
  // Dev auth is an unauthenticated session minter + membership bypass, so it
  // demands an EXPLICIT opt-in and is force-disabled in production. Forgetting
  // NODE_ENV then fails closed (disabled), not open.
  const devAuthFlag = process.env.ENABLE_DEV_AUTH?.trim().toLowerCase() ?? '';
  const isProduction = process.env.NODE_ENV === 'production';
  const devAuthArmed = devAuthFlag === 'true' && !isProduction;
  // Any truthy-looking value on a production host is a deployment mistake worth
  // shouting about, even though it is already inert.
  if (isProduction && devAuthFlag !== '' && devAuthFlag !== 'false' && devAuthFlag !== '0') {
    console.warn(
      `ENABLE_DEV_AUTH=${process.env.ENABLE_DEV_AUTH} is IGNORED under NODE_ENV=production. Remove it from the production environment.`,
    );
  }
  return {
    botToken: required('BOT_TOKEN'),
    databaseUrl: required('DATABASE_URL'),
    webAppUrl: process.env.WEB_APP_URL ?? 'http://localhost:3000',
    port: Number(process.env.PORT ?? 3000),
    sessionSecret: required('SESSION_SECRET'),
    miniAppUrl: process.env.MINI_APP_URL?.trim() || null,
    devAuthUserId: devAuthArmed ? optionalInt('DEV_AUTH_USER_ID') : null,
  };
}
