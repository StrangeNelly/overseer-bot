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

## Where things live

- `docs/` — research reports, decisions, and planning documents. Read these before making architecture choices; they are the project's memory.

## Status log

- 2026-09-01: Project started. API/architecture research workflow completed; findings in `docs/research-*.md`, synthesis in `docs/research-summary.md`.
- 2026-09-01: v1 decisions locked in `docs/decisions.md` — TS monorepo, grammY bot (long polling), Hono + Vite/React Mini App, Supabase Postgres + Drizzle, Node process on Railway, GeckoTerminal-primary market data, clean (non-referral) trading links, X monitor deferred to v1.5, owner-supplied death thresholds. Next: `docs/plan.md` build plan, then scaffold.
- 2026-09-01: Round-2 decisions (Mini App confirmed; links = Axiom/GMGN/DexScreener only; any member can bin; repost semantics defined) and `docs/plan.md` written (M0 scaffold → M1 bot ingest → M2 data engine → M3 Mini App board → M4 deploy/beta → M5 v1.5). Ready to scaffold on owner go-ahead.
- 2026-09-01: M0+M1 built (npm-workspaces monorepo: packages/shared, packages/db, apps/server) and hardened via 19-agent adversarial review (13 confirmed findings fixed — see commit 1f645a2).
- 2026-09-01: M1 verified LIVE. Bot = @overseergroupbot (owner-created; privacy disabled, admin in test group). Supabase project npyjgnuskcexskxydehr (ap-northeast-2, fresh project, migration 0000 applied; MCP server configured in .mcp.json). Call + repost + /groupie all proven against the real group: caller credit preserved, mentions_count bumps, clock never resets. Dev-box gotcha: unroutable IPv6 blackholes Node fetch — index.ts forces ipv4first + disables autoSelectFamily; keep that in mind for deploys. NEXT: M2 market-data engine (GeckoTerminal primary, DexScreener refresher, mcap-at-call, peak tracking, death/retrace rules per decisions.md).
