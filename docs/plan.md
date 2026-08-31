# Groupie v1 — Build plan

*Written 2026-09-01. Assumes all decisions in `decisions.md`; architecture rationale in `research-summary.md`.*

## Shape

One npm-workspaces monorepo (Node 24 is on the dev machine; no extra tooling), TypeScript throughout:

```
groupie/
  packages/
    shared/     — types, CA extraction, constants, link builders
    db/         — Drizzle schema + client (Supabase Postgres)
  apps/
    server/     — grammY bot (long polling) + pollers + Hono API + SSE + serves web build
    web/        — Vite + React Telegram Mini App
```

One deployable Node process (Railway, ~$5/mo). Database on the owner's existing Supabase.

## Core data model

- **groups** — `chat_id` BIGINT PK (negative for supergroups), title, slug, settings JSONB (death thresholds, link prefs), status, added_at. Registered automatically via `my_chat_member`.
- **tokens** — id, chain_id, address (unique per chain), symbol, name, image, socials, phase (`curve` | `graduated` | `dead`), pool address, launchpad, created_at, graduated_at, died_at, death_reason. Polled once per unique token regardless of group count.
- **calls** — unique (group_id, token_id): caller_user_id + name, called_at, message_id, mcap_at_call, liquidity_at_call, peak_mcap_since_call + peak_at, mentions_count, last_mention_at, status (`active` | `died` | `binned`), binned_by/at.
- **mentions** — call_id, user_id, user_name, message_id, at. Every repost. Activity time = max(called_at, last_mention_at).
- **snapshots** — token_id, at, price, fdv/mcap, liquidity, vol24, txns. Time series for sparklines + retrace math; pruned by age tiers.
- **group_members** — cache of getChatMember results (group_id, user_id, status, checked_at, ~10 min TTL).
- **launch_monitors** — (v1.5) group_id, x_handle, added_by, status.

## Board semantics (derived, not stored)

- **Fresh** — activity time within selected window (6/12/24h/3d/w/m).
- **Runners** — active + current mcap ≥ ~3× mcap_at_call.
- **Retraced** — was a runner (peak ≥ 3× call) + now ≥ 40% below peak + NOT dead (healthy liquidity/volume). Neutral data framing — retrace %, LP, volume — never "buy" labels.
- **Died** — curve token back at ≤ ~$8k mcap; graduated token with best-pair liquidity < $250 or >95% drop from call-time; never-graduated after 48h. Own section; any member can bin (group-wide); repost revives.

## Milestones

### M0 — Scaffold (small)
npm workspace, TS config, Drizzle connected to Supabase, `.env.example` (bot token, Supabase URL, Alchemy key), typecheck/lint scripts, first migration.

### M1 — Bot ingest (the spine)
grammY long-polling bot; `my_chat_member` auto-registration; message pipeline: extract CAs (regex + entities + known URL patterns from Axiom/GMGN/DexScreener links) → create call or record mention; `/groupie` command replies once with the board link. Manual test in a scratch group.

### M2 — Market data engine (the hard part)
- GeckoTerminal client with a 30 req/min budgeter; DexScreener client (30-address batches, best-pair selection **always** liquidity-filtered).
- New-call resolution: GT `tokens/multi` first (use `fdv_usd`), DexScreener dust-guarded fallback; store mcap_at_call immediately; backfill exact call-time value from GT minute-OHLCV when processing lags. (hood.fun adapter deferred — that launchpad has been dormant since early Aug; the resolution chain accepts new sources when the meta rotates.)
- Snapshot poller with frequency tiers: < 24h-old or re-mentioned tokens every ~45s; active older tokens every 5 min; dead tokens daily (revival check).
- Peak-since-call tracking, death detection per decided thresholds, retrace computation.
- (Stretch, can slip to v1.1) Alchemy WS `logs` subscription on launchpad factories for instant launch/graduation detection — contract addresses + topic0s are in `research-followup-3.md`. Never `newHeads` (100ms blocks would blow the free CU cap).

### M3 — API + Mini App board
- Auth: validate `initData` server-side → session cookie; gate `/g/:slug` routes via cached getChatMember (creator/admin/member/restricted pass).
- REST endpoints + one multiplexed SSE stream (`price_update`, `new_call`, `re_call`, `token_died`) with ~25s heartbeat.
- UI: four board sections, time-window switcher, token cards (symbol, mcap now, **x since call**, first caller, re-called ×N badge, age, sparkline, links: Axiom `axiom.trade/t/{ca}?chain=robinhood`, GMGN `gmgn.ai/robinhood/token/{ca}`, DexScreener `dexscreener.com/robinhood/{ca}`), bin/keep on died cards. Structure first; design polish is a later dedicated pass.

### M4 — Deploy + real-group beta
Railway service from GitHub; BotFather checklist (privacy OFF **before** adding, Mini App registered, menu button, bot added as rights-less admin); pinned board link in the owner's group; a week of live-fire with the actual chat; tune thresholds from real calls.

### M5 — v1.5 (after the board sticks)
X launch monitor (twitterapi.io rule behind `TweetWatcher` interface, SocialData fallback); browser OIDC login; design pass; then multi-chain groundwork (Solana) and per-group settings UI.

## Known risks / watch items

- **Launchpad meta rotation** — if the group's calls move to a launchpad GeckoTerminal doesn't index, we add a per-launchpad adapter (Mobula almanac has recipes) or fall back to Bitquery (~$49/mo). The adapter interface exists from M2.
- **GT 30 req/min ceiling** — fine for one group; multi-group SaaS needs a paid CoinGecko key or Codex. Budgeter isolates this.
- **DexScreener dust pools** — guarded by liquidity-filtered best-pair selection everywhere; never trust `pairs[0]`.
- **Ingester downtime > 24h loses messages** (Telegram queue limit) — Railway restarts cover normal deploys; long outages accepted for v1.
