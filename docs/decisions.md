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

## 2026-09-03 — Graduation alerts, filtered (round 20, owner)

- Owner, on the discovery list: graduation alerts are wanted, but the raw count may be too high — "strip it down to show only the ones with an X account and website", and "if we could somehow not show coins that have been heavily bundled, even better".
- **Stream:** PONS graduations from the on-chain event (PoolGraduated on the verified PONS v2 factory/hook — signature from the verified ABI), through the shared on-chain client (Alchemy). Enriched via DexScreener batch (socials, website, mcap, liquidity, LP lock) — DS is cheap; zero GeckoTerminal.
- **Filters (default ON, each a fact on the row):** (1) an X account AND a website present; (2) not heavily bundled — measured from the launch: the share of supply bought in the launch block (and the first few blocks) and how many wallets took it, read from the curve's Transfer logs; a graduation whose launch block absorbed ≥ the threshold (start 25% of supply) is hidden, and every visible row prints "launch block 12% · 9 wallets" so the number is never a hidden verdict; (3) not a tokenized stock. Thresholds live in constants, tunable later via `/overseer set`.
- **Surfaces:** a GRADUATED board zone/tab (last 24h, filtered; the rows carry mcap, LP + lock %, X/web pills, launch-block share, WATCH) — always on, silent. Chat: one terse alert per passing graduation — "$SYM graduated · $84K mcap · LP $22K (locked 100%) · launch block 12% / 9 wallets · X · web" — with a per-hour cap (start 3/h; the rest stay board-only) and `/overseer set grads off` as the mute. Neutral wording throughout.
- **Bundle:** with round 18 (Uniswap launches share the client, the enrichment and the same filters) into one "discovery" build after round 19 lands. Owner action required first: a free Alchemy account + app key for Robinhood Chain (Railway var), verified against the chain before build.

## 2026-09-03 — BUY OPP measures from the watch, not the peak (round 19, owner)

- Owner: the buy-opp alert was firing off the coin's high ("down from its all time high"); the 30% drawdown must be measured from **the market cap when the coin was added to the watchlist**. Rationale accepted: a retrace from a peak nobody was watching is trivia; a drawdown from the member's own entry point is the opportunity they asked to hear about.
- Rule: `watches.mcap_at_watch` is stamped when a watch is activated (from the token's cached mcap; if unknown then, filled from the first snapshot after `added_at` — the same honesty as mcap-at-call). BUY OPP fires when current mcap ≤ (1 − buyRetracePct%) × mcap_at_watch, on the CROSSING (previous reading above the line, this one at/below) with the existing per-(group, token, type) cooldown as the backstop, and re-arms only after the mcap recovers above the line. Re-activating a watch re-stamps the baseline. `buyPeakWindowHours` / `buyMinDeclineHours` retire from the buy-opp rule (kept as settings keys for `/overseer set` compatibility, ignored, and dropped from `alerts` help text). NUKE is unchanged (peak-relative over 15 min is its point).
- Message: "🟢 BUY OPP: $SYM −32% since watched ($120K → $82K) · LP $X" — numbers only. The bot's watch confirmation names the baseline ("Watching $SYM from $120K"), and ON WATCH rows show "watched at $120K · −32% since" (WatchlistEntry.mcapAtWatch).

## 2026-09-03 — Uniswap launch alerts (round 18, owner idea)

- Owner: the meta is PONS, but bigger teams launch straight onto Uniswap with real liquidity ("even a 5 ETH paired launch is something to look at"); alert on those, without catching ordinary liquidity adds to existing pools.
- Live sample (GeckoTerminal `/networks/robinhood/new_pools`, 2026-09-03): DEX ids `pons-v2` (curves, ~$4–6K reserves), `pons-v2-dex` (graduations), `uniswap-v2-robinhood`, `uniswap-v4-robinhood`. A direct v4 launch (MEMESTOCKS/WETH) opened with a $28K reserve; OUROBOROS had three v4 fee-tier pools — the false positive to exclude.
- **Signal = pool CREATION, never liquidity events**, so adds to existing pools cannot appear by construction. A "launch" is a new pool where: dex is a Uniswap id; quote token is WETH or USDG; the base token is NEW — this is its first pool anywhere (no older pool on GT, never seen in our tokens table, no PONS pool ⇒ not a graduation or migration, not a second fee tier); not a tokenized stock (isTokenizedStock); initial reserve ≥ the group's threshold, expressed in ETH ("5 ETH paired" ≈ $24K total reserve at today's price, converted from the pool's own WETH price); pool age ≤ 10 min at detection; deduped by pool address (persist seen pools).
- **Source — corrected by the research pass (docs/research-features-2.md §5):** GT `/new_pools` cannot be the feed. It returns 20 pools per page against ~20K PONS launches/day (797 in 50 minutes of blocks), so one page every few minutes samples only the newest ~90 seconds and enumerating an hour would cost ~5,700 GT calls/day. The feed is ON-CHAIN: subscribe to the Uniswap v2 factory `PairCreated` / v4 `PoolManager` `Initialize` events on Robinhood Chain through the shared Alchemy client the research pass verified (public RPC 429s; Alchemy free tier is the sanctioned path). PONS spam never enters that stream, the "first pool for this token" test is one `getLogs`/eth_call away, and initial reserves come from the pool's own Mint/ModifyLiquidity event — zero GeckoTerminal cost, seconds of latency. One shared on-chain client serves this, the creator dossier and the graduated strip.
- **Surfaces:** (1) a LAUNCHES board zone/tab, always on and silent: launches from the last 24h with initial liquidity in ETH, liquidity now, mcap, age, LP-lock % (GT reports `locked_liquidity_percentage` — Uniswap LP is unlocked unless the team locks it, so this is the honest risk fact), links, WATCH pill. (2) One terse chat alert per qualifying launch above the group threshold — a new, event-driven message class (a few a day at most), `/overseer set launch <eth>` to tune, 0 to mute. Neutral wording: "$SYM launched on Uniswap v4 · 5.8 ETH liquidity · LP locked 0% · $23K mcap · links". Nothing is auto-called: the chat stays the curation layer; members watch or call from the zone.
- Sequencing: after round 17 ships; bundle with round 17b (same scheduler/market files).

## 2026-09-03 — Resolution honesty + diet (round 17b)

- Live case: `0x020e…1ba3`, called 2026-09-01 17:21Z, sat in FRESH as "indexing…" for 7h+. It is a **Base** contract (DexScreener any-chain lookup: Uniswap v4 pair on Base; GT 404 and DS empty on Robinhood Chain). v1 is HOOD-only, so it could never resolve — and the never-graduated rule only kills it at 48h, while resolution retried every 45s the whole time (resolution is now the dominant GT burst: up to 2 calls per token, 6 per tick).
- **Wrong-chain detection:** when both Robinhood-Chain lookups miss, ask DexScreener's any-chain token endpoint; pairs on another chain => the token dies with `death_reason = 'wrong_chain:<chain>'` (the call goes to DIED as "WRONG CHAIN · BASE", no mcap line — nothing was ever measured). Never revival-polled and a repost stays dead, but the corpse keeps the daily dead cadence so calls made after the death still get swept onto it. The bot stays silent — the board says it.
  - **Review revision (timing):** the check runs on EVERY failed resolution attempt once the token is `wrongChainMinMinutes` (**60**) old — a permanent verdict waits longer than the 15-min fast tier, because a CA is often pasted before its Robinhood pool opens and a same-address multi-chain deploy (CREATE2 / omnichain) would otherwise be killed on the strength of an hour the pool had not had yet. A DexScreener blip therefore costs nothing (the next attempt asks again); the death UPDATE is guarded on `phase = 'unresolved'`, and a wrong-chain death releases its watch slots exactly as a permanent rug does.
- **Unindexed back-off:** an address found on NO chain stays unresolved but leaves the 45s tier: 45s for its first 15 min (new PONS launches index within minutes), then every 5 min to **6h** (review: a CA pasted before its pool opens must not wait an hour for the reading its mcap-at-call is measured from), then hourly until the existing 48h death (reason stays `never_graduated`). The UI says "not indexed yet · Nh" past the first hour instead of "indexing…", and a dead card never shows that wording at all.
- **Batched resolution:** unresolved tokens resolve through GT's `/tokens/multi` 30 per call (the endpoint is already wrapped), one call per tick instead of one per token. Review: failure is staged, not shared — a `/pools/multi` or DexScreener throw returns everything already answered and simply omits the addresses that were waiting on that stage; omitted addresses and whole-batch failures are both stamped, so nothing retries at tick rate through a 429 storm or a DexScreener outage — the tier interval is the retry.

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

## Round 21 — Member verdict + flatline deaths (2026-09-03)

- **Trigger:** $VLR — 0.4x, $106K → $46K on $19K LP, a dump the owner calls a definite rug, yet alive by every rule: the pool never drained, and residual holders too small to bother selling hold the mcap around $45K. The rules were written for coins whose LIQUIDITY collapses; a dumped coin with a retained mcap has a different signature — far below its peak with no trades. $DOSS (0.3x, $108K → $36K) has the same shape.
- **Member verdict (manual):** a MARK DEAD control on every LIVE call surface in the app (cards, desktop rows, ON WATCH rows) and `/overseer dead <symbol|CA>` in the bot. Any member, group-wide — the same standing as binning. Effect: the call dies with `death_reason = 'member'`, mcap-at-death stamped from the current reading, `death_marked_by` = the member's display name, watch slots released, the card moves to DIED reading "marked dead by @name". A member-marked death is **exempt from auto-revival** (the revival bar is "$30K mcap" and $VLR sits at $46K — it would be resurrected within three hours otherwise). Reversal is a member action only: RESTORE on the died card / `/overseer undead <symbol|CA>` puts the call back live (phase active, probation cleared, no re-alert). BIN works on it afterwards exactly as on any death. The bot stays silent (the board says it); reposts of a member-dead token are inert like any dead repost.
- **Flatline rule (automatic):** a live token dies with `death_reason = 'flatline'` when, continuously for `DEATH.flatlineHours` (6h): retrace from peak-since-call ≥ `DEATH.flatlineRetracePct` (85%) AND 24h volume < `DEATH.flatlineVolumeUsd` ($500) AND 24h trades ≤ `DEATH.flatlineTxns24` (5). Evidence is the poll's own DexScreener/GeckoTerminal reading (vol24, txns24); a null reading is NOT evidence and clears the clock. Stamped with mcap-at-death; card reads "flatlined · vol $120 / 24h · 3 trades". Same dead cadence as other deaths.
- **Revival for flatline deaths:** needs volume back, not only mcap — `revivalMcapUsd` ($30K) AND 24h volume ≥ `DEATH.flatlineRevivalVolumeUsd` ($2,000) for the usual 3h — otherwise a flatlined coin with a retained mcap would revive the moment it died.
- **Cards:** `deathMarkedBy` and `txns24` on BoardCard (contract). No emojis, neutral wording, numbers only.
- **Amendments (review, 2026-09-03):** (a) a flatline clock needs COVERAGE, not just elapsed time — `tokens.flat_readings` counts the polls that held the condition and `tokens.flat_last_at` dates the last one; the death fires only when elapsed >= 6h AND readings >= `DEATH.flatlineMinReadings` (6) AND the last holding reading is no older than `DEATH.flatlineMaxGapMinutes` (125). An outage is not six quiet hours. The numbers are sized to the SLOWEST live tier: an idle coin (called > 7 days ago) is polled hourly, so six hours is six readings and a gap ceiling under two polls would make flatline unreachable for exactly the old quiet coins it exists for. (b) The flatline revival gate (mcap AND volume) applies BEFORE the curve-graduation revival exception: a flatlined curve corpse whose launchpad flag flips to completed does not revive on the flag alone. (c) A flatline death of an ungraduated token is read on the curve source (GeckoTerminal), like the other curve deaths — DexScreener never indexes a curve token. (d) RESTORE refuses (409) when the token itself has since died of a rule: there is nothing live to restore the call to. (e) MARK DEAD is on the Telegram half-sheet and the Ranging cards too, and on live-but-unresolved calls (the Base-dud case) — liveness of the CALL is the only scope.

## Round 22 — Graduation floor (2026-09-03)

- **Owner:** "for pons graduations lets make sure they are removed from the list if they go back down below 15k."
- **Rule:** a graduation whose latest mcap reading is below `DISCOVERY.graduationMinMcapUsd` ($15,000) is not served in the GRADUATED zone (serve-time, so it reappears if it climbs back; unknown mcap is never hidden) and does not qualify for a chat alert. Launches are untouched. The zone footnote says so. Re-enrichment (every 10 min for rows under 24h) is what keeps the reading current.
- **Graduations are board-only by default (owner, same day):** `DISCOVERY_DEFAULTS.gradsOn` flips to `false`. The GRADUATED zone carries the whole stream and no group posts graduation messages into the chat unless it opts in with `/overseer set grads on` — the near-silent-bot rule reasserted over round 20's "wanted". The toggle itself is unchanged (`on|off`, per group); `/overseer alerts` reads "graduations board only" in the default state. Launch alerts are untouched.
- **Unreadable liquidity is not thin liquidity (Sleepers, 2026-09-03):** the 14:15Z scan dropped eight in-band coins worth $450K–$4.6M at the liquidity floor ($JOHNDOG $902K cap on $5.5M/24h, lp -68.8%; $DEBTCOIN -116%; $CACHE, $AU and five more) because GeckoTerminal reports a NEGATIVE `reserve_in_usd` for some Uniswap v4 pools on this chain. **Rule:** a reserve that is not a positive, finite number is UNKNOWN, never a measured shortfall. On the sleeper listing (`getTopPools`) any `reserve <= 0` becomes null; on the pool resource (`parsePoolResource`, which feeds the poller's curve/dead tiers) only NEGATIVES become null — a zero reserve there is a genuinely drained pool and is the `liquidity_floor` rule's own evidence (death.ts already treats null liquidity as unknown: it breaks the persistence run and is never death evidence, so the negative case can no longer kill a v4-pool coin). A candidate with unknown GT liquidity is no longer dropped at the floor: it is carried into the DexScreener enrichment the scan already runs (which now supplies `liquidity.usd` as well as the token name) and both liquidity floors are decided on that figure — which is also the figure persisted on the row. With no usable figure from either source the drop reason is `lp_unknown`, never `lp_floor`, and the per-coin telemetry line prints `lp unknown` rather than a negative percentage. Lookup scope: the enrichment batch now covers candidates sitting at `lp_unknown` **inside a band** as well as fully qualified ones.
- **Owner (same round):** "i don't want pons graduations to trigger an alert in the chat - let it only be something someone can browse in the webapp in discovery. so many coins graduate so itll just flood the feed." **Rule:** graduation chat alerts are OFF by default (`DISCOVERY_DEFAULTS.gradsOn = false`); the GRADUATED zone in DISCOVERY is the only surface. `/overseer set grads on` remains as an explicit opt-in for a group that wants them (multi-group future), `set grads off` the way back. Launch alerts (>= launchMinEth, X + web, not bundled) are unchanged.
- **Owner (2026-09-03, after the first drop report):** leave the quiet-hour residency gate as it is (a coin with no trades in the last hour stays out of every duration view) and leave the launch-block bundle checker as it is. The cluster-map ping is parked (docs/research-clusters.md). Next: the X launch monitor (round 23) — a member asked for "a section for non listed projects, and a tracker that sends a message if their accounts post a contract".

## Round 23 — X launch monitor: UPCOMING projects + launch ping (2026-09-03)

- **Ask (member via owner):** "a section for non listed projects, and a tracker that sends a message if their accounts post a contract." Research: docs/research-x-monitor.md (supersedes the provider section of docs/research-x-monitoring.md: a twitterapi.io rule holds ~12–14 handles, not ~100).
- **Trigger = the account's OWN post carrying an address that resolves on Robinhood Chain.** Never "a token cites the handle" (measured: ~22 PONS launches/min, 101 of 166 X-linked launches in one window pointed at someone else's tweet; @legsdotfun already has a $31K impostor). Tier A (pings): authored post (no RT/QT/other-author reply) + EVM address in text or in a launchpad/chart URL + confirms on chain in one batched RPC (code present, symbol/decimals answer, not a known quote/router/factory) + first pool < 24h old. Resolution failure ⇒ board row only, no message. Tier B (board only, never chat): a new PONS launch whose on-chain `socials()` names a tracked handle — "claims @handle · not posted by the account"; escalates to Tier A if the account posts it. Never ping on a bare tweet, bio/pin changes, CA-in-image (blind spot, stated), or a token citing the handle. Hijack case: when the token predates the post by > 10 min the ping is held board-only; the ping prints token age and launch-block bundle share.
- **Provider:** twitterapi.io filter rules in POLL mode behind a `TweetWatcher` seam (fallback SocialData search monitor; escape hatch official X recent search, same adapter shape). `X_API_KEY` absent ⇒ the feature is DORMANT (the discovery precedent). Default poll 60 s (≈ $11/mo for 20 handles; 120 s ≈ $6/mo) — `XWATCH.pollSeconds`, owner-tunable. Expected post→ping 60–150 s p50; the board copy says we are the CONFIRMED CA, not the first.
- **Product:** `/overseer track @handle [note]`, `untrack @handle`, `tracking`; web parity (POST/DELETE /api/g/:slug/upcoming). Caps 12 per group, 3 per member (advisory lock), auto-expire after 60 days without a post. UPCOMING zone: mobile tab + desktop rail card, polled 120 s: handle/name/avatar, followers with delta since added, bio, account age, who added and when, last post age, status chip (active/launched/expired/renamed/suspended — x_user_id stored at add time so a rename never repoints a monitor), Tier-B candidates nested. Dormant line without a key; lastCheckAt + stall line.
- **On fire:** one plain-text reply to the message that added the monitor ("@legsdotfun posted a contract address." / "LEGS · 0xb279…60cc" / "mcap $31K · LP $31K · launched 4m ago · PONS · launch block 18% · 2 wallets" / permalink / links row), the monitor flips to `launched`, the token is AUTO-WATCHED under the adder's slot (slots full ⇒ ping anyway). **No synthetic call** (calls.message_id is NOT NULL, caller credit is a social record, a hijack would become a permanent call). A human pasting the CA converts it to a real call with nothing lost. Dedupe on (handle, address); one message per monitor, ever. `/overseer set launchping on|off` mutes the ping (board stays); ships with launchping ON.
- **Owner actions:** twitterapi.io account + `X_API_KEY` on Railway; optional $1 pilot on one chatty handle to confirm reply delivery. Build proceeds against mocks and stays dormant until the key exists.
- **Amendments (build review, 2026-09-03).** (a) **A failed confirmation is a QUEUE, never silence.** A Tier-A post whose address does not confirm (unresolved, unreadable, a thrown read) becomes a `launch_candidates` row of kind `posted`, re-confirmed on the round-17b ladder (45s/15m -> 5min/6h -> hourly) until it confirms and takes the normal fire path, or until the post passes `launchMaxPoolAgeHours` ('aged_out'). Only TWO rejections skip the queue: a known quote/router/factory/burn address and evidence older than 24h. The board shows a pending row with the post, its time and the last reason. (b) **The cursor is the runner's.** A page is processed OLDEST-first, each post in its own try/catch; the cursor moves past a post only once it was processed, a throw stops the page (the rest is re-read next poll), a TRUNCATED page (`maxPagesPerPoll` 10) does not move the cursor at all — the adapter serves newest-first, so the unread stretch is the older one and the whole window is re-read next poll (the seen set absorbs the duplicates) — and an empty poll never rewinds. (c) **Cadence** is `XWATCH.pollSeconds` alone (60s, about $5.20/mo — one `advanced_search` shard of ~25 handles per poll, sized by `searchQueryMaxChars` 480; `ruleValueMaxChars` 255 is kept for a future webhook/rule adapter). (d) **Status honesty:** a handle that stops resolving is 'renamed' (the @ no longer answers for the account you added), never 'suspended' — that word needs the provider to say it, asked of the stored `x_user_id`; the two 404s say different sentences. (e) **Launch clock = earliest evidence** (our discovery row, else the PONS launch block, else the pool), persisted as `launched_token_created_at`; the hijack hold, the 24h ceiling and "launched Nm ago" all read it, and `launched_hold_reason` records why a launch stayed board-only. (f) The auto-watch belongs to the PING: a held or muted launch takes no slot. (g) The alert row is written FIRST and `launch_pinged` is set from whether it was actually inserted. (h) `expires_at` is the single expiry source, pushed forward by every post, and the sweep also collects 'renamed'/'suspended' so a broken monitor frees its slot. (i) A post older than max(added_at, now - `lookbackMinutes`) is ignored: a newly tracked handle can never replay yesterday. (j) `RT @x:` text is a retweet whatever the provider flags, and a reply with no parent id is `reply_unattributable` (silence). (k) Tier B is ON: `socials()` returns five ABI strings, index 0 is the X URL, and a revert means "not a PONS v2 token" (verified on chain, docs/research-x-monitor.md section 2). (l) Slots are counted on the occupying statuses everywhere (route, bot header, caps), and an expired monitor can be untracked.
- **Amendments (final review, 2026-09-03).** (m) **No launch post is silenced by a transient failure.** Every pending row's whole body (monitor read, group read, confirm, fire, delete) is isolated: a throw anywhere settles that row onto the next ladder rung as `error:<name>` and the pass carries on with the next row. `no_code` is no longer a definitive rejection — a launch announced before its deploy lands, and a node one block behind, read identically — so only the 24h age-out and the two definitive rejections in (a) end a queued address. (n) **The housekeeping tick does not honour the X back-off.** `pausedUntilMs` is a back-off against the PROVIDER: the pending queue, the expiry sweep and the Tier-B scan read our own tables and the chain and run regardless; only the profile rotation (the one provider caller in that loop) skips a paused pass. (o) **The window floor follows the cursor.** A poll's floor is max(added_at, min(previous cursor, now - `lookbackMinutes`)), so an outage's backlog is processed instead of being clipped to the last ten minutes, and discarded posts are logged once per poll with a count. (p) **A contradiction is not evidence:** when the handle lookup says "gone" and the stored id answers under THAT SAME handle, nothing is written and the next rotation asks again; 'renamed' needs the id under a different handle (or no id opinion at all), and a 200 body carrying `status: 'error'` is only not_found when its message says the user is missing. (q) Bounds: `maxAddressesPerPost` 3 queued per post, `candidatesPerMonitor` 10 served per monitor (a correlated count, so one hunted handle cannot crowd the board), and Tier B retires an address only after `tierBNullReadsToRetire` 3 null `socials()` answers — a null is a revert OR a failed read. (r) `profile_refreshed_at` is stamped at TRACK time (the resolve that added the handle was a refresh), so a fresh handle does not jump the oldest-first rotation.

## Round 25 — X monitor visibility: the search index is not the account (2026-09-04)

- **Measured, with the production provider key.** The group tracked `@legsdotfun` (monitor added
  2026-09-02 23:21Z). On 2026-09-03 21:05:19Z the account posted, as a TOP-LEVEL post,
  "$LEGS is now live on Robinhood Chain. CA: 0x8fcf98e1348d3ddee46cdd15a5c7d9a8d423077d …"
  (post 2095619171002593725, author id 2094468493223620608), and posted the CA three more times
  after that. The watcher was healthy and polling every 60 s throughout. It never saw a single one:
  `launch_monitors.last_post_at` stayed null for two days.
- **Root cause 1 — X hides some accounts from the Latest index.** `GET /twitter/tweet/advanced_search`
  with `queryType=Latest` returns ZERO posts for `from:legsdotfun` — for every window we asked, and
  for all time. `queryType=Top` returns the same account's posts, launch post included.
  `GET /twitter/user/last_tweets` returns an empty list for it. Other accounts
  (`gaiadotfinance`, `RobinhoodCrypto`) answer normally in Latest, so this is per-account, not an
  outage and not our query. Round 23 polled Latest and only Latest, so a hidden account is a monitor
  that can never fire — the exact failure the feature exists to prevent.
- **Decision — recover the posts from the replies, and sweep Top.** `to:<handle>` in Latest returns
  every reply to the account within seconds (measured: first reply +130 s on the launch post, +24 s
  on the next), and a reply carries `inReplyToId` (the parent post) and `inReplyToUserId` (the parent
  author). So each poll also searches replies TO the tracked accounts, collects the unseen parent
  ids whose author is the tracked account, and fetches them with
  `GET /twitter/tweets?tweet_ids=a,b,c` — which returns the parent posts with `author.id`, `text`,
  `createdAt` and `entities.urls`. Recovered parents go through the SAME detector as a directly
  observed post, and are judged against their own floor (never before the monitor was added, never
  older than `XWATCH.parentLookbackMinutes` = 60). The account's OWN posts on that page are
  judged where they are found rather than thrown away as pointers: a `to:` shard returns the
  tracked account's self-replies too, and a CA dropped under the announcement is the pattern the
  detector was written for — it is already in hand, so it costs no call. The reply cursor,
  unlike round 23(b)'s from: cursor, ALWAYS ADVANCES: a truncated page does not hold it and a
  failed parent fetch does not either, because a stranger's reply is a redundant pointer (every
  reply to a post names the same parent) and holding the window would let one viral thread pin it
  open and be re-read every poll. The outstanding work is carried by the pending parent-id queue,
  not by the window; what is accepted in exchange is that a truncated reply window's older
  replies are not re-read, with the continuing stream of new replies and the Top sweep as the
  backstops — and, unlike the from: poll, a truncated reply page is currently silent. A combined
  `(from:a OR to:a OR from:b OR to:b) since_time:N` query is accepted by the provider and is the
  obvious way to halve this later; what SHIPPED is a second, independent `to:` shard set with its
  own search per poll (see Cost). Belt to those braces: every
  `XWATCH.topSweepEveryPolls` (5) polls the `from:` shard is also asked with `queryType=Top` over
  the last `XWATCH.topLookbackMinutes` (15) — Top is engagement-ranked and DID carry the hidden
  account's launch post, so a post nobody replied to but somebody liked is still found. The Top
  sweep never moves the cursor, and it is INDEPENDENT of reply recovery: its cadence is counted on
  polls the `from:` read answered, and a pausing refusal from the reply read is held until the
  sweep has run (then rethrown into the back-off). Otherwise the read most likely to draw a 429 —
  the `to:` read pages hardest — would silently disable the only remaining road to a hidden
  account nobody replies to.
- **The source is recorded and the board says it.** `launch_monitors.last_post_via`
  ('search' | 'replies' | 'top', migration 0016) records how the newest post we hold actually
  reached us, and it is served on `ProjectEntry.lastPostVia`. A row whose value is not 'search'
  prints a dim sub-text line — "newest post reached us through a reply, not through X search" (or
  "through the Top sweep") — because a reader cannot otherwise tell a normally-indexed account
  from one whose primary channel is blind. No colour of its own, no warning voice, nothing said
  about the account. It reports the ROAD, not a verdict on X's index: the three reads use
  different windows (10 / 60 / 15 minutes) over in-process state a restart empties, so a visible
  account whose post falls in the gap can be recovered by a reply, and only the operator log makes
  the stronger claim ("may be hiding this account"). It is past tense because only 'active'
  monitors are polled and a recovered launch ends as 'launched' — "watching replies" would be a
  claim about a stopped poller on the very row this path exists to produce. The stamp keeps the
  road that got there FIRST: it moves only for a strictly newer post, or a different post id
  inside the same second, so re-reading a recorded post by a slower road cannot restamp it; and a
  re-track clears the column with the rest of the post history.
- **Root cause 2 — Tier B was scanning the wrong rows, and had never written one.**
  `xwatch/tierB.ts` scanned `discovery_events` rows with `kind='launch'` only, and those rows are
  exclusively first Uniswap v2/v4 pools. A PONS token — the only kind whose `socials()` Tier B can
  decode — never produces a 'launch' row; it appears as a 'graduation'. So in production Tier B had
  never read a single PONS `socials()` and had never written a candidate. The LEGS graduation row
  (id 1462, 2026-09-03 21:03:56Z) even carried `twitter_url = https://x.com/legsdotfun` from
  enrichment by 21:06Z, unused.
- **Decision — Tier B scans three sources, cheapest first, still board-only.** (1) ENRICHMENT: a
  discovery row of EITHER kind whose stored `twitter_url` names a tracked handle claims with no
  chain call at all; **no URL is not an answer** — enrichment lands minutes after the row (LEGS:
  row 21:03:56Z, enriched 21:06:17Z), so an unenriched row falls through instead of being retired
  — and **nor is a URL naming a stranger**: the two free passes are re-derived from bounded
  SELECTs every scan, the tracked set changes between scans, and "I saw a coin claiming @foo, so I
  tracked @foo" is the flow this tier serves, so only a URL that answered for a monitor on this
  board retires the address. (2) CHAIN: `socials()` for what enrichment could not answer, still
  bounded at 20 reads per pass with the three-null retirement rule, retiring on **its own key**
  ("no socials() to read" is not "we know who this coin names", and a DexScreener URL landing
  hours later is free to read). (3) CALLS: a token the group ITSELF called inside the window whose
  `tokens.socials` name a handle that **same group** tracks, read with the shared
  `twitterUrlFrom` (round 9's defensive reader — that jsonb is written verbatim from DexScreener's
  own `type` strings, so `->>'twitter'` would miss an `x`-keyed row on the one pass that is the
  whole of Tier B without a chain client). Group-scoped, because a call is a fact about one
  group's chat. THE CANDIDATE POOL IS ONE QUERY PER KIND, each limited to the newest
  `SCAN_CANDIDATES` (500) rows: the effective look-back is min(24h, that many rows per kind), and
  a shared cap let a busy launch hour crowd every graduation out of the pool — the same pathology
  `api/discovery.ts` already fixed in production, on the rows round 25 widened the scan to read.
  Cadence is unchanged (the runner's 30-minute slow pass); a dedicated `tierBMinutes` knob is left
  open.
- **Cost — TWO terms, and the second one is now the driver.** twitterapi.io bills $0.00012 per
  CALL *and* $0.00015 per POST RETURNED. Round 23 could ignore the second term because a `from:`
  shard returns a handful of the account's own posts a day; a `to:` shard returns every reply to
  those accounts, paged in full (`maxPagesPerPoll` 10, ~20 posts a page).
  *Calls:* at one shard and `pollSeconds` 60 — from: 43.2K + to: 43.2K + up to 43.2K parent
  fetches + 8.6K Top sweeps ≈ 95–138K calls/month = **$11–17**.
  *Posts:* twelve pre-launch hype accounts at a few hundred replies a day each is 2.4–6K
  replies/day = 72–180K posts/month = **$11–27**, and a sustained busy minute that saturates the
  page bound is 200 posts a poll (~$0.03/poll). So the honest figure at the 12-handle cap is
  **$20–45/month, not "well under $20"** — and it scales with how popular the tracked accounts
  are rather than with our cadence: halving `pollSeconds` halves the calls and leaves the post term
  almost unchanged, because each poll's window simply doubles.
  *The levers that actually cap the post term:* `maxPagesPerPoll` (10) bounds the replies one poll
  can pull per shard — a reply-specific, lower bound is the obvious next knob, since the reply
  cursor always advances and unread replies are redundant pointers rather than lost posts — and
  `last_post_via` now records which accounts the `from:` road is serving, so a future round can
  skip the `to:` shard for handles whose posts arrive as 'search'. Secondary knobs: `pollSeconds`
  (60), `parentLookbackMinutes` (60), `parentsPerPoll` (20), `topSweepEveryPolls` (5),
  `topLookbackMinutes` (15). NOTE: `XRequestMeter` counts REQUESTS only, so the hourly meter line
  cannot see the term that now dominates.
- **Unchanged.** Tier A — the account's own post carrying an address that confirms on chain — is
  still the ONLY thing that pings, and a recovered post is a Tier-A post like any other, judged by
  the same detector, the same confirmation and the same one-message-per-monitor rule. The hijack
  hold (`XWATCH.hijackHoldMinutes` = 10) still holds a ping board-only when the token predates the
  post. Tier B is still board-only and can never produce a chat message, from any of its three
  passes.
