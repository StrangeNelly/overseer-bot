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

## 2026-09-02 — Collapse rugs + Retraced honesty (round 10)

- Live case HDFI: sell-off rug to $8,249 ($249 above the $8K hide floor), LP down to 18.8% of call-time (above the 5% collapse line — LP survived because supply was dumped, not pulled), -99% from an $872K peak → showed as "Retraced 0.03x". Every rule individually correct; composition wrong for the dump-rug pattern.
- **New probation trigger (collapse rule):** sustained 1h (same bucket-maxima/coverage/freshness discipline) at mcap <= 10% of peak-since-call AND mcap < $30K absolute → rug-hidden into the existing probation (30-min polls, $30K/3h revival, 24h expiry). The $30K ceiling keeps big bleeders (e.g. LIGMA $996K at 0.37x) visible — a loss is not a rug. The $8K absolute trigger stays.
- **Retraced liveness clause** (restores round 1's "NOT dying" intent): retraced = peak >= 3x AND 40–85% off peak AND liquidity >= $1K dust. Beyond 85% off peak is collapse territory — probation's job, never a "dip". Volume is NOT a liveness signal (rug-day churn: HDFI printed $1.4M volume while dying).

## 2026-09-02 — "Sleepers" chain-wide discovery stream (round 9)

- Owner idea: automate the DexScreener filter-browse loop. Every **3h**, scan ALL of Robinhood Chain (GeckoTerminal pools by 24h volume, ~200 deep) and surface the top **3** coins per band (same four bands as Ranging) that are sitting at a mcap without being rugs. **This is the first uncurated surface** — its own tab, clearly framed as chain-wide research leads, never mixed with the group's calls.
- Ranked by **turnover** (vol/mcap). Floors: liquidity >= $10K; pair age **1h–10d**; txns/24h >= **20**; and a **tapering volume requirement**: requiredVol = 170 * mcap^0.4114 (anchored: $10K vol at $20K mcap ~ 50%, $50K vol at $1M ~ 5% — owner's spec verbatim).
- Excludes anything the group has already called (per group). **Twitter-required by default** with a "show all" toggle; persistence marker ("on the list 9h") instead of forced rotation — still qualifying = still interesting.
- No tracking/polling of sleepers (snapshot stream only; a coin becomes tracked the moment someone posts it in chat). No alerts, no chat messages.
- **App-wide addition (owner):** every coin card gets a small link to its X account where known (design pass didn't cover it) — an X pill in the card link row, sourced from stored socials.

## 2026-09-02 — Design chosen (round 8)

- Owner ran the Claude Design pass and picked **Degen Neon** (Round 1 option 1B). Handoff lives in `design/extracted/design_handoff_overseer_board/` — README.md is the implementation SPEC (high fidelity: match tokens/anatomy exactly; motion implemented to spec, not taste), overseer-canvas.dc.html is the visual reference, PNGs are the Telegram brand assets.
- **Product renamed: Groupie -> "overseer"** (display name/wordmark; repo/infra names unchanged). Matches the bot @overseergroupbot.
- Accepted behavior changes from the handoff: no Mini App auto-expand (own the half-sheet + Pulse); desktop >=~1100px multi-column no-tabs; links row behind tap/hover reveal (+ COPY CA); badge collapse to one + cyan watched dot; call-story sparkline; Ranging gains a **3h** duration option and suffix-parsing custom inputs with dollar echo; cached-board instant paint.
- Implementation = next build milestone (single coherent restyle of apps/web + tiny shared-constant change).

## 2026-09-02 — Design pass shape (round 7)

- Owner runs the pass with Claude Design on Fable 5; inputs are docs/design-brief.md (v2) + docs/design-prompt.md.
- Two surfaces, one app: Telegram Mini App = compact "pulse" mode in the default half-sheet (Pulse strip + fresh list, everything reachable, no more auto-expand) with a prominent "Full board" bridge; full web = the flagship (desktop 1440 dense multi-column terminal; mobile browser single column).
- The bridge is a **seamless handoff link**: the authenticated Mini App mints a one-time short-TTL link that opens the browser already signed in (backend built this phase). Browser OIDC login page for direct visitors remains a later milestone.
- Identity: canvas explores 3 directions (clean terminal / degen neon / hybrid); owner picks on the canvas; wordmark + icon + BotFather cover included.
- Design output = mockups; implementing the chosen design is the following build milestone.

## 2026-09-02 — Rug probation v2: hide fast, monitor quietly, revive visibly (round 6, supersedes round 5's 6h rule)

- Owner: 6h was too slow to clean the feed, but nothing should be missable. New lifecycle:
  1. **Hide** after just **1h** continuously under $8K (bucket maxima, coverage rules): call disappears from ALL board sections. Not dead, not binned — probation (tokens.rug_hidden_at).
  2. **Probation**: polled every **30 min** for **24h**.
  3. **Revival**: reaches **>= $30K and holds for 3h** (every reading at/above; a dip breaks the hold) → back into view under a new **"Reviving"** section, badge for 24h (tokens.reviving_at), then classifies normally. Un-hides and resumes activity-based polling.
  4. **Expiry**: 24h of probation without revival → the permanent rug: markTokenDead('rug_floor') + system-bin (round 5's mechanics).
  5. **Repost during probation cancels it** (renewed-attention rule): straight back into view; tanks again → new 1h clock.
  5a. **Amendment (owner): re-mentions of a token currently under $9K mcap are INERT.** People re-post rugged CAs to show the chart / point at the corpse — that is not renewed attention. The mention is still recorded (history + count), but it does NOT bump activity/resurface the card, un-bin, cancel probation, or request revival. Cached mcap null (unresolved token) = normal repost behavior. First calls are unaffected. Threshold $9K sits deliberately above the $8K floor (hysteresis).
- The instant armed-curve-floor death is RETIRED (the hide covers retrace-to-floor with a comeback path). liquidity_floor stays immediate (a drained pool cannot revive on mcap). never_graduated 48h stays.
- Thresholds as constants for now: hide $8K/1h, probation 30min/24h, revival $30K/3h.

## 2026-09-02 — Rug auto-removal + peak-volume capacity (round 5)

- **Rug rule (owner):** a token whose mcap sits below $8K continuously for 6+ hours is a rug — automatically removed from the board. Implemented as system auto-bin (binnedBy null = auto), with the token marked dead (reason `rug_floor`) if not already: repost still un-bins and re-evaluates (renewed-attention rule keeps working), and a later storage purge job can hard-delete long-binned tokens. Continuity judged like Ranging: max mcap over the 6h window under the floor, with data-span + coverage requirements so a token we barely watched can't be auto-condemned.
- **Peak volume (owner):** 50-100 CAs/day at peak. Budgets hold (DS trivial; GT degrades curve polling toward ~90s under heavy simultaneous curve load — acceptable). SSE-driven board refetch debounce raised (2s → 6s) to keep client/DB load sane at that card count. Watch item: Supabase free-tier storage at sustained peak — rug auto-removal is the main relief valve.

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
