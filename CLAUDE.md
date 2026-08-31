# Groupie — project notes for Claude

## What this is

"Groupie" (working title) is a web dashboard companion for a private crypto-trading Telegram group. The group posts token contract addresses ("calls") and pre-launch X accounts all day; in-group bots (Rick, Phanes) already track call market caps and multiples inside Telegram. Groupie lives OUTSIDE Telegram: a board members check to catch up on what was called, what's pumping, what died, and what's about to launch.

## Product principles (from the owner)

- Simple. No heavy filtering UI — the group chat IS the filter/curation layer.
- Read-only dashboard; interaction happens via Telegram commands (e.g. `/groupie addlaunchmonitor @project51`).
- Time windows: 6/12/24 hours, 3 days, week, month.
- Each token card: main coin details + deep links to trading apps (Axiom and similar).
- "Died after call" section; group chooses to keep in memory or remove.
- "Retraced" board: coins that pumped hard after the call (banger, e.g. 3x+) and have pulled back well off their peak but are NOT dying (liquidity intact, volume flowing). Same machinery as died-detection, different thresholds. Present as neutral data (retrace %, LP, volume) — never "buy opportunity" labels.
- The bot stays near-silent in Telegram: no recurring digest/summary posts (Rick/Phanes already do summaries; the chat is noisy enough). At most: reply to /groupie with the board link + a pinned message. The app is the calm, visual surface; the chat is the input.
- Track peak-since-call ourselves by polling from the moment a CA is posted — call-relative data (call MC, ATH-since-call, retrace %) is Groupie's moat and avoids paying for historical OHLCV APIs.
- v1 targets Robinhood Chain (#HOOD, EVM addresses) only. Multi-chain later.
- Built for one group first; designed so any group can add it later (multi-group SaaS potential).
- Visual polish comes after structure ("Claude design will eventually need to have a look at it").

## Working style (owner preference, 2026-09-01)

- Implementation is done by **Opus 5 subagents** (Workflow/Agent with `model: 'opus'`), driven by precise specs (file paths, interfaces, product rules from these docs). The main session designs, integrates, and adversarially reviews. Small glue edits/fixes stay inline.

## Where things live

- `docs/` — research reports, decisions, and planning documents. Read these before making architecture choices; they are the project's memory.

## Status log

- 2026-09-01: Project started. API/architecture research workflow completed; findings in `docs/research-*.md`, synthesis in `docs/research-summary.md`.
- 2026-09-01: v1 decisions locked in `docs/decisions.md` — TS monorepo, grammY bot (long polling), Hono + Vite/React Mini App, Supabase Postgres + Drizzle, Node process on Railway, GeckoTerminal-primary market data, clean (non-referral) trading links, X monitor deferred to v1.5, owner-supplied death thresholds. Next: `docs/plan.md` build plan, then scaffold.
- 2026-09-01: Round-2 decisions (Mini App confirmed; links = Axiom/GMGN/DexScreener only; any member can bin; repost semantics defined) and `docs/plan.md` written (M0 scaffold → M1 bot ingest → M2 data engine → M3 Mini App board → M4 deploy/beta → M5 v1.5). Ready to scaffold on owner go-ahead.
- 2026-09-01: M0+M1 built (npm-workspaces monorepo: packages/shared, packages/db, apps/server) and hardened via 19-agent adversarial review (13 confirmed findings fixed — see commit 1f645a2).
- 2026-09-01: M1 verified LIVE. Bot = @overseergroupbot (owner-created; privacy disabled, admin in test group). Supabase project npyjgnuskcexskxydehr (ap-northeast-2, fresh project, migration 0000 applied; MCP server configured in .mcp.json). Call + repost + /groupie all proven against the real group: caller credit preserved, mentions_count bumps, clock never resets. Dev-box gotcha: unroutable IPv6 blackholes Node fetch — index.ts forces ipv4first + disables autoSelectFamily; keep that in mind for deploys. NEXT: M2 market-data engine (GeckoTerminal primary, DexScreener refresher, mcap-at-call, peak tracking, death/retrace rules per decisions.md).
- 2026-09-01: M2 complete (commit 3de0349): market-data engine live-verified. Opus agent applied 18 review findings; Fable review added the revival migrated-pool fix. Migration 0001 applied. NEXT: M3 Mini App board (auth, board API, SSE, React UI) — spec for Opus agents.
- 2026-09-01: M3 complete (commit c897f23): Mini App board live in browser with real data. Two parallel Opus agents (backend + frontend) against packages/shared/src/api.ts contract; 9 review findings fixed incl. CSRF (hono/csrf Origin allowlist on mutating routes — cookie is SameSite=None for the TG webview), fail-closed dev-auth (ENABLE_DEV_AUTH opt-in), per-call died_at/death_reason (migration 0002 applied). Board sections: fresh/runners/retraced/died. Dev browsing: ENABLE_DEV_AUTH=true + DEV_AUTH_USER_ID in .env, open /g/<slug>. NEXT: M4 — register Mini App in BotFather, deploy to Railway, pin board link in the real group. Design pass (M5) flagged items noted in agent reports.
- 2026-09-01 (end of session): M4 IN PROGRESS — deploy not yet live. State:
  - GitHub: https://github.com/StrangeNelly/overseer-bot (all commits pushed).
  - Railway: project "rare-compassion" (4798a5cf-04ed-4668-b4b3-218b80268911), env production (a7f359ce-8b61-49a1-87a7-f1f494f7ef46), single service "@groupie/server" (05768bd8-8af7-4241-ae0f-0fcc6fa194f6), domain groupieserver-production.up.railway.app. CLI installed + authed; repo linked. Railway MCP + plugin installed (MCP OAuth still pending in interactive /mcp; Supabase MCP same).
  - Variables set (via CLI): BOT_TOKEN, DATABASE_URL, SESSION_SECRET, NODE_ENV=production, PORT=3000, WEB_APP_URL=https://groupieserver-production.up.railway.app, NPM_CONFIG_PRODUCTION=false.
  - Fixed: original build failure (NODE_ENV=production stripped dev deps at install; second `npm ci` in buildCommand hit EBUSY on Railway's node_modules/.cache mount). railway.json now: buildCommand "npm run build", watchPatterns ["**"], Node pinned 22 (.node-version).
  - BLOCKER: every deployment reports SKIPPED — GitHub pushes ("No changes to watched files", stale apps/server watch paths from the original monorepo split) AND, unexplained, a CLI `railway up` deployment (a373f446-3fae-4d94-adcd-14420b6e01ba) also polled SKIPPED 6+ min. Next debug steps: dashboard → service Settings → check watch paths / root directory ("/") / any "Wait for CI"-style gate; or auth the Railway MCP and inspect; nuclear option that likely just works: delete the service, re-add from GitHub repo with root "/" (railway.json is now correct so a fresh service should build green), then re-add the 7 variables (values in local .env; NPM_CONFIG_PRODUCTION=false; regenerate domain and update WEB_APP_URL to match).
  - After deploy is green: BotFather /newapp (title Groupie, short name "board", 640x360 placeholder image already sent to owner, Web App URL = the Railway domain), then Railway var MINI_APP_URL=https://t.me/overseergroupbot/board, then pin /groupie reply in the TEST group only (soft-launch decision in docs/decisions.md).
  - Local bot/dev server STOPPED (Railway will be the only poller; Telegram drops queued updates >24h old).
  - Then: design pass + flesh-out before real-group launch (M5 flagged items in status above; agent design notes in M3 reports).
