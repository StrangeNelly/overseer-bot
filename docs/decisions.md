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

## 2026-09-02 — Design pass 2 implementation + watch everywhere (round 16)

- **Design pass 2 handoff accepted** (`design/extracted/pass2/design_handoff_overseer_board/`, Round 3 artboards 3A–3G): opportunity-first desktop with zone system (FRESH rail · IN PLAY column: RUNNERS → RETRACED → REVIVING → ON WATCH · right rail DIED → RANGING summary → SLEEPERS summary), day-outcome strip in Pulse, retraced gauge, hero sparklines, band bars on Ranging/Sleepers rows, view headlines for Ranging/Sleepers, mobile zone chips + tone bands, bigger wordmark/group name. **3G license (watch-move ceremony on the board + `your slots n / 3`) is IN** — it serves the alerting goal directly.
- **Owner rule: watch/unwatch on EVERY coin that shows up in the app**, and the watchlist is manageable both in the app and in Telegram. Overrides the handoff's "no WATCH on sleepers" note. Consequences:
  - Sleepers rows get the watch pill. A sleeper is not a group call, so the web gains **watch by address** (`POST /api/g/:slug/watch {address}`), the exact semantics of `/overseer watch <ca>` (upsert token, then add the watch under the caller's slot, same cap, same orphan-row guard). Card-id watch stays for board cards.
  - The board payload carries the group's **entire active watchlist** (`BoardResponse.watchlist`, including chat/Sleepers watches with no call), and ON WATCH renders from it — desktop zone AND a mobile tab — so every slot a member holds is visible and unwatchable from the app. This closes the round-15 review's "stranded slots" finding for good.
  - Died rows, Ranging cards, Sleepers rows, spotlight cards, list rows, half-sheet rows: all carry WATCH / WATCHING / WATCHING·YOU. Dead coins may be watched (alerts resume automatically on revival).
- Neutral-framing law unchanged: the board prints numbers ("NARCO +41% in 1h — on watch"), never "buy-opp"/"nuke" labels.

## 2026-09-03 — Resolution honesty + diet (round 17b)

- Live case: `0x020e…1ba3`, called 2026-09-01 17:21Z, sat in FRESH as "indexing…" for 7h+. It is a **Base** contract (DexScreener any-chain lookup: Uniswap v4 pair on Base; GT 404 and DS empty on Robinhood Chain). v1 is HOOD-only, so it could never resolve — and the never-graduated rule only kills it at 48h, while resolution retried every 45s the whole time (resolution is now the dominant GT burst: up to 2 calls per token, 6 per tick).
- **Wrong-chain detection:** when both Robinhood-Chain lookups miss, ask DexScreener's any-chain token endpoint once; pairs on another chain => the token dies immediately with `death_reason = 'wrong_chain:<chain>'` (the call goes to DIED as "WRONG CHAIN · BASE", no mcap line — nothing was ever measured). Never revival-polled; a repost stays dead. The bot stays silent — the board says it.
- **Unindexed back-off:** an address found on NO chain stays unresolved but leaves the 45s tier: 45s for its first 15 min (new PONS launches index within minutes), then every 5 min to 1h, then hourly until the existing 48h death (reason stays `never_graduated`). The UI says "not indexed yet · Nh" past the first hour instead of "indexing…".
- **Batched resolution:** unresolved tokens resolve through GT's `/tokens/multi` 30 per call (the endpoint is already wrapped), one call per tick instead of one per token.

## 2026-09-02 — Sleepers: stocks filter, short holds, higher bands (round 17)

- Diagnosis behind the ask: the latest scan held 12 coins with 24h+ in band, but 10 of them were Robinhood's **tokenized stocks/ETFs** (QQQ, TSM, PLTR, MRNA...) with no X account — the "X only" default was the only thing hiding them, and they will always dominate the long-hold bands because they are stocks. Residency itself reads GeckoTerminal candle history and reaches back before the bot existed (HOOD: 214h on day one).
- **Stocks filter (owner):** a toggle chip next to "X only" — `no stocks`, default ON — excluding tokenized equities. Detection is a rule, not a heuristic: token name ends with the issuer suffix `• Robinhood Token`, OR the name matches a leveraged-equity pattern (`<n>x Long|Short`), OR the address is on a tiny curated list (HOOD's own token, named just "HOOD"). Stocks are still scanned and stored (`is_stock`) so the toggle can show them; the per-band keep cut applies to stocks and non-stocks separately so stocks never crowd real coins out of a band.
- **Short holds (owner):** duration chips gain **30m** and **1h**. Hourly candles cannot see half an hour, so entries with under 3h of hourly residency get a 15-minute-candle read (≤3h back) — 30m = 2 consecutive in-band 15m closes ending at a candle ≤30 min old, 1h = 4. Bounded cost: only new/short entries fetch minute candles (incremental residency from round 16b covers the rest).
- **Higher bands (owner):** `$1M–$3M` becomes a regular band at every duration (supersedes round 14's 2w/1m gate), and **`$3M–$5M`** and **`$5M–$8M`** are added. Seven bands total; the 10-day pool-age ceiling for sub-2w views (round 9) is unchanged.
- Noted for later: the scan refreshes every 3h, so a "30m in band" reading can be up to 3h old when seen. If round 16b's budget savings hold, the next lever is an hourly scan.

## 2026-09-02 — GeckoTerminal budget diet (round 16b, ops)

- Observed live: GT 429s at every pacing we tried (25/min bursts, 20/min even, 8s gaps). Pattern = five calls succeed, the sixth fails, a cooldown buys a few more — a small token bucket per egress IP, shared with other Railway tenants. Shipped: an ADAPTIVE budgeter (429 doubles the inter-call gap to 15s max; 20 successes halve it back to 2s) + 5-min boot hold-off + 10-min scan retry. Scans now complete, slowly; alert-path polling of graduated coins is DexScreener and unaffected.
- Root demand: every curve-phase (PONS) token costs ONE GT call per 45s (`pollCurve` → `gt.getPool`), up to 40/min with the group's call volume. Graduated coins already batch 30/call via DexScreener.
- **Decided (next backend milestone, after round 16 lands):** (1) batch curve polls through GT's multi-pool endpoint (`/networks/robinhood/pools/multi/{a,b,...}`, ≤30 per call — probed live 2026-09-02) so ten curve coins cost one call; pollDead's curve path shares it. (2) Incremental sleeper residency: an address still in the same band as last scan extends `inBandHours` by the elapsed time instead of refetching candles — OHLCV only for new or band-changed entries. (3) Budgeter priority: poll traffic is granted before scan traffic when both wait. Expected effect: steady-state GT demand well under the observed bucket; the scan's 10 listing pages per 3h become the only burst.

## 2026-09-02 — Watch button, declined toggle, design pass 2 (round 15)

- **Watch button on the board (approved):** tap-to-watch on cards; watching = the existing Telegram alerts (nuke / buy-opp) for that coin. **Cap: each member may hold max 3 active watches per group** (enforced server-side by addedBy; friendly error when full; unwatching frees a slot). Bot commands stay as the power-user path and share the same cap.
- **$100-at-call toggle: DECLINED.** Owner: the app is collaborative, not competitive — revisit only if the product is ever monetized/sold.
- **API gaps batch (approved):** hidden-probation count in Died, true todayCallCount for Pulse, mcap-at-death stored, desktop Ranging summary data. PLUS (from the OMNI confusion): dead-token revival checks every 3h for the first 48h after death, then daily.
- **Functional link gaps ship as build work, not design:** the desktop spotlight/hero cards (Retraced, Reviving, Runners hero) must carry the same links row as list rows (AXIOM/GMGN/DEXS/COPY CA/X); and every coin with a stored website gets a website link app-wide (websiteUrlFrom already exists — surface it as a pill next to X).
- **Design pass 2 (owner will run Claude Design again):** gripes for the brief — (1) no wayfinding: the active view needs a clear headline ("RANGING", "SLEEPERS"...) especially on desktop; (2) "looks like a terminal, which is fine, but I want more visualisation" — push the data-graphics dimension (the board should show, not just list); (3) link affordances audit across every card variant. Brief to be updated before the owner's session.

## 2026-09-02 — Ranging short holds (round 14b)

- Owner: Ranging gains **30m** and **1h** durations, for the smaller bands only ("the first 3 default bands"). Implemented as a band-ceiling rule — durations under 3h require the band's hi <= $500K — so equivalent custom bands behave consistently; the 500K-1M preset (and anything larger) never offers them. Sub-hour values display as minutes. Bundled into the Sleepers v2 build (same files).

## 2026-09-02 — Sleepers v2: real time-in-band + LP-ratio floor (round 14)

- **Time-in-band (owner ask):** sleepers gain a duration dimension computed from GeckoTerminal's free hourly/daily OHLCV at scan time — continuous candle-close residency in the band, INCLUDING history from before we first saw the coin. Duration filter chips: 3h (default) / 6h / 24h / 3d / 7d / 2w / 1m. Selecting 2w or 1m unlocks a fifth band, $1M–$3M (owner: acceptable at those durations only). Store ~12 entries/band so duration filters have depth; serve 3 as today. Rows show "in band Xh/Xd".
- **LP-ratio floor (owner, FORESKIN case):** unlocked-LP coins rugged mid-cycle leave crumbs ($5.4K LP on $1.85M mcap = 0.29%). New scan filter: liquidity >= 2% of mcap (liqToMcapMinRatio: 0.02) alongside the absolute $10K. Also self-corrects mid-cycle pulls at the next scan.
- Accepted constraint: the stream refreshes every 3h; a pull inside the window can linger one cycle (the "refreshed Xm ago" line is the honesty marker).

## 2026-09-02 — Locked-LP reality: mcap-based revival (round 13)

- Owner insight: PONS fair launches lock LP permanently, so every graduated corpse keeps ~$5-6K residual liquidity forever (ETH-priced). Consequences accepted/fixed:
  - The $250 liquidity_floor only catches true LP pulls (unlocked pools) — fine, keep it for those; fair-launch rugs die via the mcap probation machinery (already true since rounds 6/10).
  - **BUG (latent, would fire on the next daily dead-poll): graduated-death revival used liquidity >= $1K, which residual locked LP always satisfies → dead fair-launch coins would zombie-flap (revive -> probation -> die -> revive, ~25h cycle). Fix: dead-token revival is mcap-based for EVERY death type — one bar, mcap >= $30K (probation's revival threshold; replaces both the $1K liquidity bar and the separate $16K curve bar). The pool.graduated===true curve-completion revival stays.**
  - Per-call 95% LP-collapse rule is blunted by locked LP (~85-90% max observable drop) — left as-is; mcap rules carry the weight.
- Builds bundled with round 11 (liquidity-death persistence) — same files.

## 2026-09-02 — Full Telegram browser login (round 12)

- Owner: members hitting the plain web URL (shared links, new devices) must be able to sign in — the telegram-only wall becomes a real login. Implement Telegram's 2026 OIDC flow (oauth.telegram.org, Authorization Code + PKCE, JWT id_token verified against Telegram's JWKS; Client ID/Secret + allowed URLs configured in BotFather's Login Widget section — see docs/research-auth-architecture.md).
- Feature is env-gated (TG_OAUTH_CLIENT_ID/SECRET): absent = the old wall text; present = the login button. The Mini App initData path and the handoff bridge are untouched — this is the third door, same session cookie, same getChatMember gate behind it.
- The `jose` library is sanctioned for the JWT verification (security-critical parsing is not a place for hand-rolling; strict alg allowlist, iss/aud/exp verified).

## 2026-09-02 — Liquidity deaths need persistence (round 11)

- Live case OMNI: pool 6 minutes old, called 19:02:11, declared dead (liquidity_floor) 19:02:14 off a single liquidity=$0 first reading while the chart traded happily to $132K — newborn-pool indexing lag, not a rug.
- Fix: liquidity-based deaths (token liquidity_floor AND per-call liquidity collapse) fire only when the condition holds across >= 10 minutes AND >= 3 readings — never one snapshot. Plus a 30-minute newborn grace (since token_created_at/first_seen) where liquidity deaths are off entirely. Real drains stay drained; confirmation is free.
- Also extend the DS suspicious-pair guard: a best-pair switch to a dust-liquidity pair while the cached liquidity was >= 10x healthier is distrusted (skip + log), not snapshotted.
- Healing: existing repost->revive machinery already resurrects false deaths (used for OMNI same day). Builds after round 10 lands (shared files).

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
