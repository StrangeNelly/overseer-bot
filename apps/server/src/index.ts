import { setDefaultResultOrder } from 'node:dns';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

// Some machines (incl. this dev box) advertise IPv6 without a working route;
// Telegram's AAAA record then blackholes Node's fetch. Prefer IPv4 — and
// disable fetch's happy-eyeballs family selection, which ignores the DNS
// result order and still attempts the dead IPv6 path.
setDefaultResultOrder('ipv4first');
net.setDefaultAutoSelectFamily(false);
import { serve } from '@hono/node-server';
import { createDb } from '@groupie/db';
import { createApi } from './api/app.js';
import { createBot } from './bot/bot.js';
import { loadConfig } from './config.js';
import { startPoller } from './poller/scheduler.js';

// Load the repo-root .env regardless of cwd; a missing file is a no-op
// (deployments inject env vars directly).
loadEnv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

const config = loadConfig();
const { db, client } = createDb(config.databaseUrl);
const bot = createBot(config, db);
const api = createApi(db, bot.api, config);

// WEB_ONLY=1: serve API + SPA against the live DB without starting the bot or
// the poller — for local dev while the deployed instance owns Telegram polling
// (two pollers 409-fight) and the snapshot writes.
const webOnly = process.env.WEB_ONLY === '1';

const server = serve({ fetch: api.fetch, port: config.port }, (info) => {
  console.log(`api listening on :${info.port}${webOnly ? ' (WEB_ONLY: no bot, no poller)' : ''}`);
});

const stopPoller = webOnly ? () => {} : startPoller(db);

function closeServer(): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// Long polling: only the update types we act on. A rejected start (401 bad
// token, 409 second instance) must kill the process, not leave a healthy-
// looking API with a dead bot.
if (!webOnly) {
  bot
    .start({
      allowed_updates: ['message', 'my_chat_member'],
      onStart: (me) => console.log(`bot @${me.username} polling`),
    })
    .catch(async (err) => {
      console.error('bot polling failed:', err);
      await closeServer();
      await client.end().catch(() => {});
      process.exit(1);
    });
}

async function shutdown() {
  console.log('shutting down...');
  stopPoller();
  if (!webOnly) await bot.stop();
  await closeServer();
  await client.end().catch(() => {});
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
