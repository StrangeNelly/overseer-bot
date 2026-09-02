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
import { startAlertDelivery } from './bot/alertDelivery.js';
import { createBot } from './bot/bot.js';
import { chainRpcUrl, createChainClient } from './chain/client.js';
import { loadConfig } from './config.js';
import { startDiscovery } from './discovery/runner.js';
import { startPoller } from './poller/scheduler.js';
import { createTweetWatcher } from './xwatch/twitterapi.js';
import { startXWatch } from './xwatch/runner.js';

// Load the repo-root .env regardless of cwd; a missing file is a no-op
// (deployments inject env vars directly).
loadEnv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

const config = loadConfig();
const { db, client } = createDb(config.databaseUrl);

// The bot + poller run ONLY in production (or under an explicit RUN_BOT=1).
// A second bot instance anywhere 409-crash-fights the deployed one — a local
// `npm run dev` did exactly that to real users on 2026-09-02 — and a second
// poller double-writes snapshots. Local default is therefore web-only:
// API + SPA against the live DB, nothing that touches Telegram.
// (WEB_ONLY=1 still forces web-only anywhere, including production.)
const webOnly =
  process.env.WEB_ONLY === '1' ||
  (process.env.NODE_ENV !== 'production' && process.env.RUN_BOT !== '1');

// The chain listener writes shared rows and posts into the chat, so it obeys
// the same guardrail: exactly one instance, alongside the poller. Absent an
// Alchemy key it is dormant anyway (startDiscovery says so once and returns).
// Started BEFORE the API and the bot because both have to tell members the
// truth about it: the board's `enabled`, and `/overseer alerts`.
const chain = webOnly ? null : createChainClient(chainRpcUrl(config));
const discovery = startDiscovery(db, chain);

// The X launch monitor (docs/decisions.md round 23) obeys the same guardrail as
// the chain listener, for the same reason: it writes shared rows and posts into
// the chat, so exactly one instance runs it. Absent an X key it is dormant
// anyway (startXWatch says so once and returns). The watcher itself is created
// whether or not the runner starts, because `/overseer track` and the POST
// route resolve a handle through it — a WEB_ONLY box can still curate the list.
const tweetWatcher = createTweetWatcher(config);
const xwatchRunner = startXWatch(db, webOnly ? null : tweetWatcher, chain);
const xwatch = { enabled: xwatchRunner.running, watcher: tweetWatcher };

const bot = createBot(config, db, discovery.running, xwatch);
const api = createApi(db, bot.api, config, discovery, {
  running: xwatchRunner.running,
  watcher: tweetWatcher,
});

const server = serve({ fetch: api.fetch, port: config.port }, (info) => {
  console.log(`api listening on :${info.port}${webOnly ? ' (WEB_ONLY: no bot, no poller)' : ''}`);
});

const stopPoller = webOnly ? () => {} : startPoller(db);
// Watchlist alerts post into Telegram, so WEB_ONLY (no bot, no poller) has
// nothing to deliver and no bot to deliver with.
const stopAlertDelivery = webOnly ? () => {} : startAlertDelivery(db, bot.api);

function closeServer(): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// Long polling: only the update types we act on. A rejected start (401 bad
// token, 409 second instance) must kill the process, not leave a healthy-
// looking API with a dead bot.
if (!webOnly) {
  // Registers the command for Telegram's "/" autocomplete. Best-effort: a
  // failure here must not stop the bot (the command works regardless).
  bot.api
    .setMyCommands([
      {
        command: 'overseer',
        description:
          'board · watch <ca> · dead <coin> · undead <coin> · watchlist · ' +
          'track @handle · untrack · tracking · alerts · set',
      },
    ])
    .catch((err) => console.warn('setMyCommands failed:', err));
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
  stopAlertDelivery();
  discovery.stop();
  xwatchRunner.stop();
  if (!webOnly) await bot.stop();
  await closeServer();
  await client.end().catch(() => {});
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
