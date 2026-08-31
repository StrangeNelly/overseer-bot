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
