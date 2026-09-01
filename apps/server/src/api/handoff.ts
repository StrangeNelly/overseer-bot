import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { handoffTokens, type Db } from '@groupie/db';
import type { HandoffResponse } from '@groupie/shared';
import type { Config } from '../config.js';
import { setSessionCookie } from './auth.js';
import type { ApiEnv } from './membership.js';

/**
 * Seamless Mini App -> browser handoff (docs/decisions.md round 7).
 *
 * The Mini App is already authenticated (initData -> session cookie), but that
 * cookie lives in Telegram's webview and cannot be carried into the system
 * browser. So the webview asks for a one-time secret, Telegram opens it in the
 * browser, and the browser trades it for the ordinary session cookie.
 *
 * The secret is a bearer credential for 60 seconds, so:
 *   - it is 32 random bytes, never a guessable id;
 *   - only its sha256 is stored (a database leak cannot be replayed as a login);
 *   - redemption is a single conditional UPDATE, so it can only ever win once;
 *   - it is never logged, and never rendered by the SPA.
 */

/** Long enough to survive a slow browser cold start, short enough to be uninteresting. */
const HANDOFF_TTL_SECONDS = 60;
const HANDOFF_TOKEN_BYTES = 32;
/** Live (unused, unexpired) tokens one user may hold; the oldest are evicted. */
const MAX_LIVE_TOKENS_PER_USER = 10;
/** A raw token is 43 base64url chars; anything wildly longer is not ours. */
const MAX_TOKEN_INPUT_LENGTH = 256;

/**
 * TTL and housekeeping window run on the DATABASE clock: the redeem's claim has
 * to compare against the same clock the mint stamped, and app/DB skew must not
 * be able to lengthen a token's life.
 */
const EXPIRES_AT = sql`now() + ${sql.raw(String(HANDOFF_TTL_SECONDS))} * interval '1 second'`;
const STALE_BEFORE = sql`now() - interval '1 hour'`;
const NOW = sql`now()`;

/** The raw token (goes in the link) and the sha256 hex we store for it. */
export interface MintedToken {
  raw: string;
  hash: string;
}

export function hashHandoffToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function generateHandoffToken(): MintedToken {
  // base64url so the secret survives a URL untouched — no percent-encoding to
  // get mangled by a Telegram client, a browser, or a copy-paste.
  const raw = randomBytes(HANDOFF_TOKEN_BYTES).toString('base64url');
  return { raw, hash: hashHandoffToken(raw) };
}

/** `<webAppUrl>/auth/handoff?token=<raw>`, tolerant of a trailing slash in the base. */
export function handoffUrl(webAppUrl: string, raw: string): string {
  return `${webAppUrl.replace(/\/+$/, '')}/auth/handoff?token=${encodeURIComponent(raw)}`;
}

/** Where the browser lands once the cookie is set (or once we give up). */
function boardPath(slug: string, query = ''): string {
  return `/g/${encodeURIComponent(slug)}${query}`;
}

/**
 * Best-effort tidy-up on the mint path so no cron is needed: rows are useless
 * within 60s, and a mint is the only thing that creates them. Failure here must
 * never cost the user their handoff, so it is logged and swallowed.
 */
async function housekeep(db: Db, userId: number): Promise<void> {
  try {
    await db.delete(handoffTokens).where(lt(handoffTokens.createdAt, STALE_BEFORE));

    // Light rate limit: keep the newest MAX-1 live tokens so the one about to
    // be minted brings the user back to exactly the cap. Tapping the button
    // repeatedly then costs a constant number of rows, not an unbounded pile.
    const live = and(
      eq(handoffTokens.userId, userId),
      isNull(handoffTokens.usedAt),
      gt(handoffTokens.expiresAt, NOW),
    );
    const surplus = await db
      .select({ id: handoffTokens.id })
      .from(handoffTokens)
      .where(live)
      .orderBy(desc(handoffTokens.createdAt), desc(handoffTokens.id))
      .offset(MAX_LIVE_TOKENS_PER_USER - 1);
    if (surplus.length > 0) {
      await db.delete(handoffTokens).where(
        inArray(
          handoffTokens.id,
          surplus.map((row) => row.id),
        ),
      );
    }
  } catch (err) {
    console.warn('handoff housekeeping failed:', err);
  }
}

export function createHandoffRoutes(db: Db, config: Config): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  /**
   * Mint. Gated by requireMember (and the csrf Origin check) via app.ts's
   * /api/g/:slug/* middleware, so reaching this handler already proves the
   * caller is a Telegram member of this board.
   */
  app.post('/api/g/:slug/handoff', async (c) => {
    const group = c.get('group');
    const userId = c.get('userId');
    await housekeep(db, userId);

    const token = generateHandoffToken();
    await db.insert(handoffTokens).values({
      tokenHash: token.hash,
      userId,
      // The gated group's own slug, never the raw path param.
      slug: group.slug,
      expiresAt: EXPIRES_AT,
    });

    const body: HandoffResponse = { url: handoffUrl(config.webAppUrl, token.raw) };
    // The response body is a bearer credential: keep it out of every cache.
    c.header('Cache-Control', 'no-store');
    return c.json(body);
  });

  /**
   * Redeem. PUBLIC by necessity — the whole point is a browser with no session
   * yet. Registered outside /api and before the SPA fallback (see app.ts) so
   * the static handler never swallows it.
   *
   * Every failure redirects: an expired tap must land on the board's login wall
   * with an explanation, never on an error page dead-end.
   */
  app.get('/auth/handoff', async (c) => {
    c.header('Cache-Control', 'no-store');
    const raw = c.req.query('token');
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_TOKEN_INPUT_LENGTH) {
      return c.redirect('/', 302);
    }
    // Attacker-supplied input is hashed before it touches the database, so the
    // comparison is a lookup on a 256-bit digest, not a secret-dependent match.
    const hash = hashHandoffToken(raw);

    // The claim IS the check: one UPDATE flips usedAt only while the row is
    // unused and unexpired, so two browsers racing the same link produce
    // exactly one winner and the loser sees a plain expired link.
    const claimed = await db
      .update(handoffTokens)
      .set({ usedAt: NOW })
      .where(
        and(
          eq(handoffTokens.tokenHash, hash),
          isNull(handoffTokens.usedAt),
          gt(handoffTokens.expiresAt, NOW),
        ),
      )
      .returning({ userId: handoffTokens.userId, slug: handoffTokens.slug });

    const row = claimed[0];
    if (row) {
      setSessionCookie(c, row.userId, config);
      return c.redirect(boardPath(row.slug), 302);
    }

    // Known but unusable (expired, or already spent): we still know which board
    // they wanted, so send them to its login wall with the explanation.
    const known = (
      await db
        .select({ slug: handoffTokens.slug })
        .from(handoffTokens)
        .where(eq(handoffTokens.tokenHash, hash))
    )[0];
    return c.redirect(known ? boardPath(known.slug, '?handoff=expired') : '/', 302);
  });

  return app;
}
