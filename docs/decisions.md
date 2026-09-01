# Decisions log

Running record of decisions made with the owner. Newest at the bottom.

## 2026-09-01 — v1 decisions (owner Q&A round 1)

1. **Call detection:** calls usually arrive as a pasted contract address in a human member's message. Primary extraction = CA regex (0x + 40 hex, lookarounds, EIP-55 check on mixed case) + parsing known trading-app/DexScreener URLs from message entities. Bare `$TICKER` never auto-creates a call.
2. **Bot setup:** owner creates the bot in BotFather and adds it to the group as a rights-less admin. Privacy mode disabled before first add (toggling later requires re-adding).
3. **History:** the board starts the day the bot joins. No backfill.
4. **App surface:** Telegram Mini App first (pinned `t.me/<bot>/board` link; initData validation; zero per-member friction — board opens inside Telegram with identity automatic). Browser version (one-time "Log in with Telegram" OIDC per device) is the first fast-follow; pull into v1 if the group turns out desktop-tab-heavy. *Owner reviewing this trade-off; Mini-App-first is the working plan.*
5. **X launch monitor:** deferred to v1.5 (after the call board proves itself). Provider plan per research: twitterapi.io webhook rule, SocialData fallback, behind a `TweetWatcher` interface.
6. **Trading links:** clean deep links, NO referral codes (owner preference — links are purely "open this coin in your terminal"; referrals only attribute at signup anyway). v1 link row: Axiom, GMGN, Maestro, Banana Gun, Bloom, OKX, DexScreener. Never BullX (dead). Photon/Trojan deferred to a Solana phase.
7. **Death rules** (owner's curve knowledge + research):
   - Curve-phase (PONS-style) tokens: launch ≈ $5k mcap; **retrace to ≤ ~$8k mcap = dead** (back at curve floor; liquidity ~$10k there is virtual/curve liquidity, so mcap is the signal, not liquidity).
   - Graduated (Uniswap pool) tokens: best-pair `liquidity.usd` < $250 OR >95% liquidity drop from call-time = dead. Quiet-but-alive (healthy liquidity, no volume) is NOT dead.
   - Never-graduated launchpad tokens auto-die after 48h.
   - Died tokens get their own board section. Bin/keep is a **group-wide** action. OPEN: can any member bin, or admin-only? (Current assumption: any member.)
8. **Hosting/stack:** TypeScript confirmed. Database = owner's **existing Supabase** Postgres (already paid) via Drizzle. One always-on Node process (grammY bot long-polling + pollers + Hono API + Vite/React SPA + SSE) on **Railway Hobby ~$5/mo**. Vercel not used for v1 (serverless can't run the bot/pollers; SPA is served by the Node process).

- COV link label in Phanes: unidentified; dropped as non-blocking.

## 2026-09-02 — Watchlist alerts, webapp priority, design philosophy (round 4)

- **Watchlist alerts (owner spec):** a per-group watchlist of coins the bot actively follows; alerts post INTO the Telegram group chat. This is a deliberate, opt-in exception to the near-silent-bot rule — alerts fire only for explicitly watched coins.
  - **Nuke alert:** drop > 40% within 15 minutes (defaults).
  - **Buy-opp alert:** retraced >= 30% from its recent peak over a longer period (peak within the last 24h, and the decline took >= 1h — slow bleed, not a nuke).
  - Parameters easily adjustable per group via bot commands; sane clamps; per-token+type cooldown so alerts can't spam.
  - Commands: `/groupie watch <ca>`, `/groupie unwatch <ca>`, `/groupie watchlist`, `/groupie alerts` (show config), `/groupie set nuke <pct> <minutes>`, `/groupie set buyopp <pct> <maxHours>`. Watching a CA that was never called still tracks it (token created, polled like a call).
- **Webapp is very important:** the browser experience is first-class, not an afterthought — browser login (Telegram OIDC) moves up the roadmap. The Telegram Mini App currently loads too slowly; performance (first paint, fewer sequential round-trips, cached last board, and server region near the user/DB) is part of the design-pass scope.
- **Design pass covers BOTH surfaces** (Mini App + browser). Owner's philosophy for the design brief: visual and tactile; animations, pops, and moving parts are GOOD when they serve human use; this is a way of *feeling* the market, not a spreadsheet. Brief lives in docs/design-brief.md.
- Railway: owner will upgrade to Hobby when the trial runs down.

## 2026-09-01 — Ranging board (owner idea, round 3)

- New board section "Ranging": tokens whose mcap has sat inside a user-chosen band (presets 50K–100K, 100K–250K, 250K–500K, 500K–1M, plus custom lo/hi) without nuking — the accumulation phase before 10-20x moves. Owner picks the band and a minimum duration (6/12/24/48h).
- Semantics: continuous time-in-range walking back from now over 5-minute average buckets (single-poll wicks must not reset the clock); the latest bucket must be in-band; a token only qualifies when its data span covers the requested duration (no claiming 6h in-range from 2h of history). Cards show time-in-range, observed band (min–max while ranging), current mcap/LP/volume; sorted longest-in-range first. Active calls only (died/binned excluded).
- Ships in the soft-launch flesh-out phase, before the X monitor.

## 2026-09-01 — rollout decision

- **Soft launch only:** Groupie stays in the owner's private test group ("overseer test group", just owner + bot) until the product is fully fleshed out AND the design pass is done. The real trading group gets the pinned link only after that. Deploy to Railway + BotFather registration proceed now so the Mini App is usable on the owner's phone.

## 2026-09-01 — round 2 (owner confirmations + repost design)

1. **App surface confirmed:** Mini App first. Browser OIDC login is a later fast-follow.
2. **Link row trimmed to three:** Axiom, GMGN, DexScreener. (Maestro/Banana Gun/Bloom/OKX dropped from v1 — can return as per-group settings later.)
3. **Binning:** any member can bin; the action is group-wide.
4. **Repost handling:** every mention of an already-called CA is recorded (`mentions` table: who/when/message). A token's board *activity time* = latest mention, so reposts resurface it in the short time-window views with a "re-called ×N" badge; the card shows multiple-since-first-call. First caller and call clock never change. Repost of a binned token un-bins it; repost of a died token triggers an immediate re-poll and, if alive, revives it flagged "revived". The bot never replies in chat to reposts (Rick/Phanes own that).
