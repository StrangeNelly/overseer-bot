import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { csrf } from 'hono/csrf';
import type { Api } from 'grammy';
import type { Db } from '@groupie/db';
import type { Config } from '../config.js';
import { createAuthRoutes, devAuthEnabled } from './auth.js';
import { createBoardRoutes } from './board.js';
import { createDiscoveryRoutes } from './discovery.js';
import { createHandoffRoutes } from './handoff.js';
import { requireMember, type ApiEnv } from './membership.js';
import { createOauthRoutes } from './oauth.js';
import { createRangeRoutes } from './range.js';
import { createSleeperRoutes } from './sleepers.js';
import { createSseRoutes } from './sse.js';

/** serveStatic resolves `root` against the CWD, which is apps/server. */
const WEB_DIST_ROOT = '../web/dist';
const INDEX_HTML_PATH = fileURLToPath(new URL('../../../web/dist/index.html', import.meta.url));
const NOT_BUILT_MESSAGE = 'Groupie web app not built. Run: npm run build -w @groupie/web';

let cachedIndexHtml: string | null = null;

/**
 * Read the SPA shell once. A miss is NOT cached: the web build often lands
 * after the server is already running in dev.
 */
async function loadIndexHtml(): Promise<string | null> {
  if (cachedIndexHtml !== null) return cachedIndexHtml;
  cachedIndexHtml = await readFile(INDEX_HTML_PATH, 'utf8').catch(() => null);
  return cachedIndexHtml;
}

function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

/** Vite's dev server proxies /api and forwards its own Origin header. */
const VITE_DEV_ORIGIN = 'http://localhost:5173';

/**
 * Origins allowed to send mutating requests to the group API. The Mini App is
 * served from the API origin itself, so its same-origin fetches carry exactly
 * that Origin — nothing else legitimately writes here. A WEB_APP_URL we cannot
 * parse allows nothing (writes fail closed) rather than everything.
 */
function allowedOrigins(config: Config): ReadonlySet<string> {
  const origins = new Set<string>();
  try {
    origins.add(new URL(config.webAppUrl).origin);
  } catch {
    console.warn(`WEB_APP_URL is not a valid URL (${config.webAppUrl}); CSRF allows no origin.`);
  }
  if (devAuthEnabled(config)) origins.add(VITE_DEV_ORIGIN);
  return origins;
}

/**
 * Whether the on-chain listener is LIVE IN THIS PROCESS. index.ts passes the
 * handle startDiscovery returned; the default is the honest answer for anything
 * that builds an API without one (tests, and any future embedding).
 *
 * Deliberately not `chainRpcUrl(config) !== null`: a WEB_ONLY box has the key
 * and runs no listener, and telling its board the feed is on would make a
 * stream nobody is reading look like a quiet chain.
 */
export function createApi(
  db: Db,
  botApi: Api,
  config: Config,
  discovery: { running: boolean } = { running: false },
): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  app.get('/health', (c) => c.json({ ok: true }));
  app.route('/', createAuthRoutes<ApiEnv>(config));

  // The session cookie is SameSite=None (Telegram's webview is cross-site), so
  // SameSite can't defend the mutating routes — validate Origin instead. csrf()
  // only inspects unsafe methods, so the GET board/SSE routes are untouched; a
  // forged POST arrives with a foreign Origin (or none at all) and gets a 403.
  const csrfOrigins = allowedOrigins(config);
  app.use('/api/g/:slug/*', csrf({ origin: (origin) => csrfOrigins.has(origin) }));
  // Everything group-scoped is gated; registered before the routes so it runs
  // first in the composed chain.
  app.use('/api/g/:slug/*', requireMember(db, botApi, config));
  app.route('/', createBoardRoutes(db));
  app.route('/', createRangeRoutes(db));
  app.route('/', createSleeperRoutes(db));
  // The discovery zones answer `enabled:false` — not an empty stream — wherever
  // no listener is running here (docs/decisions.md rounds 18 and 20).
  app.route('/', createDiscoveryRoutes(db, discovery));
  app.route('/', createSseRoutes(db));
  // Mini App -> browser handoff. The mint sits under /api/g/:slug/* so it picks
  // up the csrf + requireMember middleware above; the redeem is a PUBLIC GET on
  // /auth/handoff — outside /api (so the 404 branch below can't claim it) and
  // registered here, ahead of the static/SPA handlers, so it is matched first.
  app.route('/', createHandoffRoutes(db, config));
  // Browser "Log in with Telegram" (OIDC, docs/decisions.md round 12). Both
  // redirect legs are PUBLIC GETs on /auth/telegram/* — outside /api and, like
  // the handoff redeem, registered here so the SPA fallback cannot claim them.
  app.route('/', createOauthRoutes<ApiEnv>(config));

  // Built SPA. /api/* must never fall through to a static file or the shell —
  // an unmatched API path is a 404, not an HTML page.
  const staticFiles = serveStatic<ApiEnv>({ root: WEB_DIST_ROOT });
  app.use('*', async (c, next) => {
    if (isApiPath(c.req.path)) return next();
    return staticFiles(c, next);
  });
  app.get('*', async (c) => {
    if (isApiPath(c.req.path)) return c.json({ error: 'not found' }, 404);
    const html = await loadIndexHtml();
    if (html === null) return c.text(NOT_BUILT_MESSAGE, 200);
    return c.html(html);
  });

  return app;
}
