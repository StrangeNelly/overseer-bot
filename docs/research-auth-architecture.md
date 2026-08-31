# Groupie Architecture Research (verified 1 Sep 2026)

## 1. Mini App vs external web app — the auth landscape changed in 2026

**Big finding: the classic Telegram Login Widget hash flow is now legacy.** The official "Log In With Telegram" page (core.telegram.org/bots/telegram-login, fetched 1 Sep 2026) now documents an **OpenID Connect flow**: authorization-code + PKCE against `https://oauth.telegram.org`, discovery at `https://oauth.telegram.org/.well-known/openid-configuration`, user data delivered inside a signed JWT `id_token` (RS256 by default; ES256/EdDSA/ES256K configurable), verified against Telegram's public JWKS — no bot token involved. You validate `iss == https://oauth.telegram.org`, `aud == your bot ID`, and `exp`. The old iframe widget with the `hash` = HMAC-SHA256(data-check-string, SHA256(bot_token)) scheme is explicitly labeled "archived/legacy" on that page. (Sources: core.telegram.org/bots/telegram-login; kulikovd.medium.com "How to Add Telegram Login to the Website with new OIDC Flow".)

**Mini App (Telegram WebApp) validation is unchanged** (core.telegram.org/bots/webapps, fetched 1 Sep 2026):
- Server receives `Telegram.WebApp.initData` (a querystring). Remove `hash`, sort remaining `key=value` pairs alphabetically, join with `\n` → data-check-string.
- `secret_key = HMAC-SHA256(bot_token, key="WebAppData")`; valid iff `hash == hex(HMAC-SHA256(data_check_string, secret_key))`.
- Check `auth_date` freshness (common guidance: reject if older than ~5 minutes at first login; you then issue your own session cookie/JWT).
- Newer **`signature` field**: base64url **Ed25519** signature over `<bot_id>:WebAppData\n<sorted pairs>` verifiable with Telegram's published public key — lets a backend that doesn't hold the bot token validate. Not needed for Groupie (you hold the token) but good to know.
- Launch surfaces: BotFather menu button, keyboard/inline `web_app` buttons, and **direct links `https://t.me/<bot>/<app>?startapp=<param>`** — a pinned message in the group with that link is a zero-friction entry point.

**Gating to "members of group X" — `getChatMember`** (core.telegram.org/bots/api, fetched 1 Sep 2026):
- `getChatMember(chat_id, user_id)` returns a ChatMember with status `creator | administrator | member | restricted | left | kicked`. Treat `creator/administrator/member` (and arguably `restricted`) as allowed. The bot must be in the chat (it already is, for ingestion). Works identically whether identity came from Mini App initData or OIDC login — both give you a verified Telegram `user_id`.
- Cache results (e.g. 5–15 min per (chat_id,user_id)) — don't call it on every request; Bot API global limits are on the order of ~30 requests/sec and hammering it on page loads is wasteful.

**Ingestion constraint that shapes everything (privacy mode)** (core.telegram.org/bots/features#privacy-mode, fetched 1 Sep 2026): by default a bot in a group only sees commands/replies directed at it. To read *all* messages (Rick/Phanes posts, raw CA pastes) either **disable privacy mode via BotFather `/setprivacy`** (then re-add the bot to the group — the setting only applies after re-adding) **or make the bot a group admin** (admin bots always receive all messages). Also: the Bot API has **no access to message history before the bot joined** — Groupie's board starts populating the day the bot is added. (Backfilling history would require an MTProto user-session library like GramJS/Telethon under a member's account — possible but a ToS gray area; keep out of v1.)

## 2. Stack: Node/TypeScript, grammY, one process

- **grammY** is alive and current: v1.45.1 on npm, published ~a month before 1 Sep 2026 (npmjs.com/package/grammy; grammy.dev). Ecosystem covers long polling, webhooks, sessions, rate-limit handling. The Bot API itself is in the 10.x era in 2026. TypeScript across bot + API + frontend means one language, shared types for `Call`, `Token`, `Group`, and shared regex/parsing code between the bot and any backfill scripts. Python (aiogram) is fine for the bot but you'd still write the dashboard in JS — two languages for a solo hobby project is pure overhead. **Verdict: Node/TS.**
- **Framework shape**: for a private, auth-gated dashboard you don't need SSR or SEO — skip Next.js. Recommended: **one Node process** containing (a) grammY bot on **long polling** (no public webhook URL/TLS needed; works identically on the Windows dev machine and in prod), (b) schedulers (node-cron or plain setInterval) for the market-data poller and X-launch poller, (c) **Hono or Fastify** HTTP server providing `/api/*`, the SSE endpoint, and serving the **Vite + React** static build. One deployable container, one log stream, in-memory pub/sub between poller and SSE. Next.js on Railway (as a node server, not Vercel serverless) is an acceptable alternative if you prefer it — but never Vercel/serverless for this: the bot and pollers are long-running processes.

## 3. Database

- **Supabase free** (verified via multiple 2026 pricing writeups: uibakery.io/blog/supabase-pricing, makerkit.dev/blog/saas/supabase-pricing): $0, 500 MB DB, 2 projects, **auto-pauses after 7 days of no API activity** (Groupie's constant poller would likely keep it alive, but it's a footgun); Pro $25/mo. You don't need Supabase auth/storage/edge functions — Telegram is your auth.
- **Turso** (turso.tech/pricing via 2026 reviews): free tier 5 GB / 500M row reads / 10M row writes; Developer ~$4.99/mo. Nice, but an edge-replication abstraction Groupie doesn't need.
- **Railway Postgres**: runs as a service inside the same Railway project; cost is just its RAM/CPU usage (typically ~$2–5/mo for a small instance), one click, private networking to the app.
- **Verdict: Postgres from day one, hosted as a Railway service next to the app**, accessed via **Drizzle ORM** (schema in TS, migrations, works with Postgres and SQLite alike). Rationale: the poller writes continuously, the multi-group future wants `group_id`-scoped relational queries and composite unique indexes, and starting on Postgres kills the future SQLite→Postgres migration. Plain SQLite on a Railway volume is the runner-up (cheapest, zero network hops) but couples data to one container and complicates the later multi-worker split.

## 4. Hosting (prices verified Sept 2026)

- **Railway** (docs.railway.com/pricing/plans, fetched 1 Sep 2026): Free plan $0 with **$1/mo credit (doesn't roll over — not enough for an always-on bot)**; **Hobby $5/mo including $5 usage credit**; usage: **$10/GB-RAM-month, $20/vCPU-month**; Pro $20/mo. Trial: one-time $5 grant. Realistic Groupie bill: app container (~512MB) + Postgres ≈ **$5–12/mo total**. No sleep for paid services; supports long-running processes, background workers in the same project, volumes (5 GB on Hobby), cron. Deploys straight from GitHub with no local Docker needed (relevant on Windows).
- **Fly.io** (2026 pricing roundups: costbench.com, saaspricepulse.com/tools/flyio): pure pay-as-you-go since Oct 2024, no free tier; shared-cpu-1x 256MB ≈ **$1.94/mo**, realistic 1CPU/1GB + volume + dedicated IPv4 ≈ **$10–20/mo**; IPv4 $2/mo. Cheapest floor, but flyctl/fly.toml ops and occasional machine migrations = more fiddling.
- **Render** (saaspricepulse.com/tools/render, livemy.app/blog/render-pricing, 2026): free web services **spin down after inactivity** (kills a bot/poller); paid: Starter **$7/mo per service** (512MB/0.5CPU) — a web service + a background worker = $14/mo. Workspace Hobby $0, Pro $25/mo flat (per-seat fees removed Apr 2026). Per-service pricing punishes Groupie's multi-process future.
- **Hetzner Cloud**: **raised prices 15 June 2026** (northflank.com/blog/hetzner-cloud-server-price-increases, fetched 1 Sep 2026): CPX line up ~2.4–2.75x (CPX22 €7.99→€19.49/mo), Arm CAX11 €4.49→**€5.99/mo** (2 vCPU/4GB); entry CX/CAX rose ~1.3–1.4x. Exact current CX22 price: UNCERTAIN (Hetzner's pricing page is JS-rendered; third parties quote ~$4.59–6/mo). Still the best raw hardware per euro, but you own OS patching, Docker, TLS, backups, monitoring — wrong trade for a solo hobby dev's first deploy.
- **Verdict: Railway Hobby ($5/mo + small usage)** — one project holding `app` (bot+poller+web) and `postgres`, push-to-deploy from GitHub, private networking, upgrade path to splitting services later without changing host.

## 5. Live updates: SSE

- **SSE over WebSockets** for v1: the dashboard is one-directional (server → browser), `EventSource` gives auto-reconnect + `Last-Event-ID` replay for free, it's plain HTTP (no upgrade handshake to babysit), and it degrades gracefully. Railway's own guide recommends SSE for exactly this (live dashboards) (docs.railway.com/guides/sse-vs-websockets). WebSockets also work through Railway's proxy (docs.railway.com/guides/socketio) — you'd only need them if the dashboard ever sends high-frequency client→server traffic, which a read-only board never does.
- **Caveat verified**: Railway's edge proxy has historically lacked HTTP/2 (open feedback thread: station.railway.com/feedback/http-2-support-on-edge-proxy-50adedfe; whether resolved by Sept 2026 is UNCERTAIN). On HTTP/1.1 browsers cap ~6 concurrent connections per origin — irrelevant for one SSE stream per dashboard tab, but multiplex all board updates over a **single** SSE stream with typed events (`price_update`, `new_call`, `token_died`, `launch_detected`) rather than one stream per token.
- Pattern: poller writes to Postgres → publishes to an in-process EventEmitter → SSE handler fans out to connected clients scoped by `group_id`. Send a heartbeat comment every ~25s so proxies don't idle-kill the stream. When you later split poller and web into separate services, swap the EventEmitter for Postgres LISTEN/NOTIFY or Redis pub/sub — hide it behind a tiny `publish(groupId, event)` interface now.

## 6. Contract-address extraction

- **EVM (Robinhood Chain is EVM — verified)**: Robinhood Chain launched public mainnet **1 July 2026**, Arbitrum Orbit stack, **chain ID 4663**, gas in ETH, RPC `https://rpc.mainnet.chain.robinhood.com`, explorer robinhoodchain.blockscout.com; DexScreener lists it under chain slug `robinhood` (robinhood.com newsroom Feb 10 2026 testnet PR; forum.arbitrum.foundation Robinhood Chain mainnet factsheet; trustswap.com/robinhood/network-details; dexscreener.com/robinhood/…). Regex: `/(?<![a-fA-F0-9])0x[a-fA-F0-9]{40}(?![a-fA-F0-9])/g` — the lookarounds stop it matching the first 40 hex chars of a 64-hex tx hash. Normalize to lowercase for dedupe/keys; if the raw text was mixed-case, verify EIP-55 checksum and drop failures (catches truncated/corrupted pastes); all-lowercase addresses carry no checksum, accept them.
- **Solana (for multi-chain later)**: `/[1-9A-HJ-NP-Za-km-z]{32,44}/g` is only a candidate filter — confirm by base58-decoding to exactly 32 bytes, and even then you can't distinguish a token mint from a wallet or program id by syntax. Only promote to a "call" after a market-data lookup (e.g. DexScreener token endpoint) returns a real pair. (Pump.fun mints conventionally end in `pump` — a useful positive signal, not a requirement.)
- **Use Telegram entities and bot messages, not just raw text**: addresses in these groups usually arrive inside `code`/`pre` entities, in `text_link` URLs, or in Rick/Phanes reply text and inline-keyboard button URLs (`reply_markup` is on the Message object your bot receives once privacy mode is off). Parse URLs for known patterns — `dexscreener.com/<chain>/<addr|pair>`, `axiom.trade/t/<addr>`, gmgn/photon/birdeye equivalents — they're higher-precision than regex over prose. Treat a Rick/Phanes reply as *confirmation* of the CA in the message it replies to (`message.reply_to_message` links them) and harvest the at-call market cap Rick prints.
- **$TICKER pitfalls**: tickers are non-unique (dozens of tokens per popular symbol per chain), squatters launch fake tickers around hyped names, and case/`$` usage is inconsistent. Never create a call from a bare `$TICKER`. Instead: (1) maintain a per-group rolling map ticker→address built from CAs already seen in that group; (2) if unseen, wait for the in-thread Rick/Phanes reply which contains the CA; (3) at most, offer a low-confidence DexScreener search match (filtered to chain 4663 + highest liquidity + recent creation) flagged "unconfirmed" in the UI.
- **Dedupe rule**: unique on `(group_id, chain_id, address)`; first sighting is the official "call" (store `called_at`, `caller_user_id`, `mcap_at_call` when Rick provides it); later mentions increment a counter, never reset the clock.

## 7. Design-for-SaaS-later (cheap now, priceless later)

1. **`group_id` (Telegram chat_id, signed 64-bit — store as BIGINT, they're negative for supergroups) on every row** from day one: calls, token snapshots, launch monitors, member cache. All queries and all SSE channels scoped by it. Composite indexes `(group_id, called_at)`, unique `(group_id, chain_id, address)`.
2. **A `groups` table now, even with one row**: chat_id, title, slug, settings JSONB (default chain, min-liquidity filter, "died" threshold), status. Handle **`my_chat_member`** updates so being added to a new group auto-registers it and being removed deactivates it — that's the entire SaaS onboarding flow ("add @GroupieBot to your group") already built.
3. **One bot token serves unlimited groups** — that's native to the Bot API. Disable privacy mode once at BotFather *before* adding the bot anywhere (toggling later means re-adding to every group). Never hardcode the group chat_id in env; resolve it from the message's `chat.id`.
4. **Auth stays group-scoped**: dashboard routes are `/g/<slug>`; on access, verify session's Telegram user via `getChatMember(that group's chat_id, user_id)` with a cached membership table (`group_members(group_id, user_id, status, checked_at)`). One user can belong to many groups; the Mini App direct-link `startapp` param carries the group slug.
5. **Rate-limit awareness**: Bot API ~30 req/s global; membership caching and batched poller writes keep you far under it. Market-data API keys/limits are per-app not per-group, so per-group polling must share one scheduler that polls each unique `(chain, address)` once regardless of how many groups called it — key token snapshots by token, join to groups through calls.
6. **Keep module boundaries** (ingest / enrich / serve) as folders in the monorepo now, so poller and web can become separate Railway services later without a rewrite; the `publish()` pub/sub seam (point 5 above) is the other future split line.

## Bottom-line recommendation

Build Groupie as a Telegram Mini App first, delivered as a normal SPA that also works in an external browser later. Concretely: one TypeScript monorepo, one long-running Node process on Railway (Hobby, $5/mo + ~$3–7 usage) containing a grammY bot on long polling (privacy mode disabled so it sees all group messages), node-cron pollers, and a Hono/Fastify server that serves a Vite+React build, a JSON API, and a single multiplexed SSE stream per dashboard tab; Postgres as a second Railway service accessed via Drizzle ORM. Auth v1: launch via pinned t.me/GroupieBot/board link, validate initData server-side (HMAC-SHA256 with secret = HMAC-SHA256(bot_token, "WebAppData"), check auth_date, then issue your own session cookie), gate every group route with a cached getChatMember check allowing creator/administrator/member. Add browser login later via Telegram's new OIDC flow (the legacy login-widget hash scheme is now archived — don't build on it). Skip Next.js (no SSR need), skip Supabase/Turso (plain Postgres + Drizzle), skip Render (per-service pricing) and Hetzner (June 2026 price hikes + ops burden) for v1. Detect calls primarily from Telegram entities, known trading-app/DexScreener URLs, and Rick/Phanes reply text and buttons (harvest at-call mcap from Rick), with the 0x-40-hex regex (hex lookarounds, EIP-55 check on mixed case) as the base layer; never auto-resolve bare $TICKERs. Put group_id on every table, a groups table with my_chat_member auto-registration, and unique (group_id, chain_id, address) from day one — that is 90% of the future multi-group SaaS for near-zero extra cost.

## Open questions for the owner

- Is the ~$10-15/mo all-in Railway budget acceptable, or must v1 run closer to $5 (which would push toward SQLite-on-volume or Fly.io's ~$2 minimum machine)?
- Roughly how many members will open the dashboard, and does anyone need access from desktop browser on day one (forces the OIDC login path into v1 instead of later)?
- Do you need any history from before the bot joins the group (only possible via an MTProto user-session like GramJS under a member account — a Telegram ToS gray area), or is 'board starts when bot is added' acceptable?
- Is the group a supergroup and can you get the bot added with privacy mode already disabled (or as admin)? Toggling privacy later requires re-adding the bot.
- Are you (not just group admins) the BotFather owner of the bot, or does the bot identity belong to someone else in the group — this affects who holds the token and can configure the Mini App?
- For the future SaaS: free for other groups or paid? A paid plan needs a billing story (Stripe) and per-group plan flags in the groups table now would be cheap to add.
- Confirm which trading apps to deep-link besides Axiom (gmgn, Photon, Padre?) so URL parsing and link-out formats can be pinned down.

## Sources consulted

- https://core.telegram.org/bots/telegram-login
- https://core.telegram.org/bots/webapps
- https://core.telegram.org/bots/api#getchatmember
- https://core.telegram.org/bots/features#privacy-mode
- https://kulikovd.medium.com/how-to-add-telegram-login-to-the-website-with-new-oidc-flow-4a1bb8ad03c4
- https://oauth.telegram.org/.well-known/openid-configuration
- https://docs.telegram-mini-apps.com/platform/init-data
- https://docs.railway.com/pricing/plans
- https://docs.railway.com/pricing/free-trial
- https://docs.railway.com/guides/sse-vs-websockets
- https://docs.railway.com/guides/socketio
- https://station.railway.com/feedback/http-2-support-on-edge-proxy-50adedfe
- https://www.saaspricepulse.com/tools/flyio
- https://costbench.com/software/cloud-infrastructure/fly-io/
- https://www.saaspricepulse.com/tools/render
- https://livemy.app/blog/render-pricing
- https://northflank.com/blog/hetzner-cloud-server-price-increases
- https://www.hetzner.com/cloud/regular-performance/
- https://uibakery.io/blog/supabase-pricing
- https://makerkit.dev/blog/saas/supabase-pricing
- https://turso.tech/pricing
- https://www.npmjs.com/package/grammy
- https://grammy.dev/
- https://robinhood.com/us/en/newsroom/robinhood-chain-launches-public-testnet
- https://forum.arbitrum.foundation/t/arbitrumdao-factsheet-robinhood-chain-mainnet-launch/31041
- https://trustswap.com/robinhood/network-details
- https://robinhoodchain.blockscout.com/
- https://dexscreener.com/robinhood/0xa427ad72db4227910805162ffae9d9b0c87bd1b5
