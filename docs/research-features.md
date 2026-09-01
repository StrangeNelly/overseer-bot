# Groupie feature research (2026-09-02)

*Four-agent research pass: alert-bot landscape, tactile dashboard UX, moat-grounded features, synthesized recommendations. Live-web verified.*

# PART 1 — Prioritized recommendations (synthesis)

## Top 10

1. **Instant-open package (cached board paint + one-round-trip session + webview one-liners)** (medium, generic) — The board appears the instant it's opened — cached last board painted at first frame, auth and data in one POST, no white flash, no half-sheet, no swipe-to-close fight — because a tactile product that makes you wait isn't tactile.
2. **Call-story sparkline (call baseline, peak dot, drawdown shade, ranging band)** (medium, MOAT) — A dotted line at mcap-at-call turns every sparkline into the called-peaked-now story no generic screener can draw — the moat rendered literally, and it fixes three flagged rough edges at once.
3. **Anti-fatigue alert engine (closed buckets, compound nuke + LP-drain tier, budget, presets)** (medium, MOAT) — Alerts are the one exception to the near-silent bot, and the exception survives only if it never cries wolf — closed 5-min buckets, liquidity-scaled compound conditions, an hourly budget whose overflow spills onto the board instead of the chat.
4. **Alert message craft (reply-thread to the call, severity in one message, mute)** (small, MOAT) — Post each alert as a Telegram reply to the original call message — context travels, the chat stays scannable, and nobody else in the market does it despite it being nearly free.
5. **Tight card density variant (64-72px rows, status edge, tap-to-expand links)** (medium, generic) — From 2.5 cards a screen to 8-9 scannable rows — state told by a 3px colored edge, rarely-tapped link buttons folded into tap-to-expand — glanceability through disclosure, not filters.
6. **Yesterday recap strip (in-app only)** (small, MOAT) — The morning story card — N calls, best, worst, died, ranging — rewards the twice-a-day check-in in the first second, built from data already stored, and never pollutes the chat Rick and Phanes already fill.
7. **$100-at-call what-if toggle** (small, MOAT) — '$100 at call → $2,340 at peak → $890 now' makes the multiple visceral with zero user input — competitors need wallets or manual entry, Groupie just re-labels the number it already owns.
8. **Watchlist presence layer (added-by, watch-count, on-card watch toggle)** (small, MOAT) — Make the group's attention visible on the board — who's watching what, right on the card — presence not opinion, riding the alerts schema already in build.
9. **Liveness motion system (NumberFlow ticks, flash convention, event pulse, haptic garnish)** (medium, generic) — One disciplined motion grammar — rolling digits, throttled direction-tinted flashes, ceremony reserved for section moves and deaths, haptics only under your thumb — the feeling-the-market layer with a noise budget.
10. **Caller cards (died-inclusive record, no ladder)** (medium, MOAT) — Tap a caller's name and see their real record including the deaths — the unfakeable, verify-don't-trust track record no incumbent shows, without the shame ladder that would kill call volume in a small group.

# Groupie — prioritized feature/UX recommendations (synthesis, 2 Sep 2026)

Synthesized from three research reports (alert-bot landscape, tactile-dashboard UX, moat features) against the owner's philosophy — simple, visual, tactile, group-curated, neutral framing — and the live roadmap: **watchlist alerts in build now → design pass next → X launch monitor → browser login → multi-group SaaS**.

## Positioning preamble (read first)

The "empty lane" verdict from 1 Sep is stale. **Rick Hub** (per-user cross-group feed, hit-rate comparisons) and **Phanes DApp** (per-group dashboard: heatmaps, PNL cards, member rankings, in-chat 2x/5x/10x multiplier alerts) both shipped in 2026 — and both bots already sit in the owner's target group. Groupie's defensible position is exactly what those two are not: a **calm, glanceable lifecycle board** (fresh → runner → retraced → died/ranging) built on **call-relative data from its own polling** (mcap-at-call, peak-since-call, retrace-from-peak, time-in-range), with a **death-inclusive, bot-recorded, unfakeable group record**. The market narrative that traders don't trust claimed win rates ("audit past calls, verify them") is the SaaS positioning sentence. Do not race Rick/Phanes on charts, filters, or chat noise — out-story them in one visual second.

Every recommendation below was screened against three filters: (1) does it violate a principle (advice framing, filter forest, chat noise)? (2) does the chat-adjacent version collide with Rick/Phanes, who already own in-chat summaries and multiplier callouts? (3) does it use data only Groupie has?

---

## The top 10, ranked

### 1. Instant-open package: cached board paint + one-round-trip session (Medium, not moat)
The owner said it plainly: the Mini App loads too slowly, the webapp is first-class, and "performance IS design." Nothing else on this list matters if the board takes seconds to appear — the product's whole promise is the twice-a-day check-in rewarded in the first second. Concrete bundle, all verified implementable on the current stack:
- Persist the last board JSON per group+window in `localStorage`; paint it synchronously at first frame (`initData` is available before auth completes), show "updated Xm ago", revalidate behind it. Skeletons (layout-accurate, no spinners) only on true first run.
- Collapse the auth→board chain: one `POST /session` that validates initData AND returns the first board payload in the same response. Persist the cookie so repeat opens skip initData entirely.
- The four webview one-liners: `ready()` at skeleton-paint time, dark `setBackgroundColor`/`headerColor` immediately (kills the white flash), `expand()` (no half-sheet open), `disableVerticalSwipes()` (kills the swipe-to-close scroll fight).
- Hygiene: immutable hashed-asset HTTP caching (works on iOS where service workers do not), initial JS ~150–250KB gz, system fonts or a digits-subset woff2, pause SSE on `deactivated` / instant revalidate on `activated`.

This is the foundation of "tactile": tactile things respond instantly. It also directly serves the browser-login roadmap item — the same caching and session work carries the desktop surface.

### 2. Call-story sparkline: baseline, peak dot, drawdown shade (Medium, MOAT)
Draw the moat literally. A dotted horizontal **baseline at mcap-at-call** turns every sparkline into the called → peaked → now story: above the line = up from call, below = underwater. Add a **peak dot** at ATH-since-call (the engine already tracks it), a state-colored **end dot** on "now", area fill from line to the call baseline (not to zero), and on Retraced cards a faint red **drawdown shade** between peak and current — the retrace % made visible, still pure neutral data. Ranging cards get their own grammar: the **band drawn as a channel** with price wiggling inside and time-in-range as the hero — solving the brief's "Ranging needs its own identity" flag. Optional small tick marks at 2x/5x/10x levels make milestones visible **on the board** (see "what NOT to build" for why milestones should live here and not in chat). No generic screener can draw any of this because none of them has the call anchor. This is the single highest-leverage item in the design pass.

### 3. Anti-fatigue alert engine (Medium, MOAT)
Alerts are in build **now**, and they are a deliberate exception to the near-silent-bot rule — the exception survives only if the group never regrets granting it. Every mature tool surveyed converges on the same lessons; adopt them before first fire, not after the first false alarm:
- **Evaluate triggers on closed 5-minute buckets** (the ranging-board machinery already exists), never raw polls — TradingView's once-per-bar-close pattern; consistent with "wicks don't reset the clock."
- **Compound the nuke**: drop % AND a minimum sell-volume/liquidity condition, with thresholds scaled to pool liquidity (Nansen's explicit guidance) so thin-pool wicks never fire. Fold in the **LP-drain condition as the severity tier above nuke** — best-pair liquidity collapsing within minutes is the rug-in-progress signal, it reuses the existing death machinery, and Birdeye (the only comparable) cannot post into Telegram groups.
- **Per-token+type cooldown** (already planned) made owner-settable with clamps (5 min floor / 24h ceiling).
- **Group hourly alert budget** (default ~6/hr); overflow suppressed silently and surfaced **on the board** instead — the board as pressure-relief valve is a mechanism no competitor has, because no competitor has a board.
- **Preset severity tiers** — `sensitive / normal / chill` moving all thresholds together, with `/groupie set nuke|buyopp` as the escape hatch. Adjustable without a filter forest.

### 4. Alert message craft: thread to the call, severity in one message (Small, MOAT)
When an alert does fire, post it as a **Telegram reply to the original call message** — `message_id` is already in the calls/mentions tables, context travels with the alert, and the chat stays scannable. Nobody in the surveyed market does this; it is nearly free. Encode severity **inside the single message** (the drop %, magnitude glyphs per the buy-bot pattern — plain bold numbers preferred over emoji rows, in keeping with the neutral voice), never via additional messages. Add `/groupie mute <ca>` and `/groupie mute all <duration>` as the quiet-hours valve. Neutral framing throughout: "-47% in 12m, LP $8.2k" — data, never "get out" or "buy the dip."

### 5. Tight card density variant + status edge + tap-to-expand links (Medium, not moat)
The brief flags 2.5 cards per phone screen; research converges on **64–72px rows for Runners/Died** (8–9 visible rows on a 390px viewport), keeping Fresh/Retraced at a taller ~96–110px reading card. Mechanism: a **3px color-coded left edge** carries section/state (freeing the badge row for the one exceptional thing — REVIVED, died reason), max 3–4 data points at rest (multiple as hero → symbol → one contextual stat → sparkline), and the 40px always-visible trading-links row moves into **tap-to-expand** (rarely-tapped actions must not tax every card). The watched-coin affordance is a small filled edge/corner marker, not another badge. This is progressive disclosure doing the work filters would otherwise do — exactly "the chat is the curation."

### 6. "Yesterday" recap strip, in-app only (Small, MOAT)
A glanceable morning story card at the top of the board: N calls, best call (peak x + caller), worst, died count, ranging count, one visceral aggregate. **Never posted to chat** — Rick/Phanes own chat summaries and the near-silent bot rule stands. Pure re-derivation of stored snapshots and calls (days of work), and it is the retention surface for the member who didn't trade yesterday — the design brief's "reward the twice-a-day check-in" made literal. The precedent products are all feed/chart shaped; the glanceable recap strip is unoccupied ground.

### 7. "$100 at call" what-if toggle (Small, MOAT)
Per-card toggle re-labeling the existing multiple into dollars: "$100 at call → $X at peak → $Y now," plus the group aggregate as the recap's visceral number ("$100 on each of yesterday's 12 calls: peak $2,340, now $890"). Demand is proven (paperhands.gg, PulsePaper, DryFlip) and every competitor needs wallet connections or manual input — Groupie needs **zero user input** because it owns every call anchor. Guardrails keep it neutral: multiple stays the hero, dollars are a toggle, labeled "at call mcap; ignores fees/slippage/fillability." Illustrative data, not a performance claim.

### 8. Watchlist presence layer (Small, MOAT)
Ride the alerts feature shipping now: **"added by X" attribution** on watchlist entries, a **watch-count badge** on board cards, and the **watch toggle on the token card itself** (DexScreener's bell-on-the-token-page pattern — config lives where the data lives, backed by inline-keyboard confirmation in TG). Neutral wording — "watched," never "hot" — presence, not opinion, so the group's attention becomes visible without manufacturing herding. The design brief already asks for watched coins to look "followed"; this is the cheap social layer that fits the philosophy, built from group-curated data nobody outside the group can see.

### 9. Liveness motion system (Medium, not moat)
The "feeling the market" layer, as one disciplined system rather than scattered effects:
- **NumberFlow** (`@number-flow/react`) for the hero multiple — compact notation matches `$1.2M` formatting, trend follows delta sign, respects `prefers-reduced-motion` out of the box; `tabular-nums` globally so columns never shimmy.
- **ag-Grid flash convention** for live ticks: 500ms low-alpha direction-tinted background + 1000ms fade, throttled to ≤1–2 flashes/card/sec, and only when the *compact-formatted* value actually changed (no fireworks for $4.21M→$4.22M).
- A stronger **one-shot pulse reserved for discrete events** — section move, new peak-since-call, death, revival. Drama for ceremony, subtlety for ambience; nothing loops except the SSE live-dot.
- **Haptics as garnish, user-action-only**: `selectionChanged()` on window/section switches, light impact on card taps, success notification on watch-add — gated on `isVersionAtLeast('6.1')`, with the known Android weak-haptics caveat meaning nothing may depend on being felt. A board that buzzes on price ticks would burn trust; a board that clicks under your thumb builds it.

### 10. Caller cards — the record, not the ladder (Medium, MOAT)
Per-member profile reached by tapping "called by X" on a card: calls timeline, outcome distribution, 2x/5x hit rates, median peak multiple, **died %**, median time-to-peak. The died-inclusive honesty is the differentiator — no incumbent shows a caller's failures, and it operationalizes the "verify, don't trust claimed win rates" narrative. Everything computes from existing tables. Deliberately **not** a ranked board-level ladder: Rick anonymizes Telegram leaderboards by default for a reason, and in a small friend group a shame ladder suppresses call volume — which kills the chat-as-curation flywheel that feeds the whole product. If the group wants competition later, an opt-in, week-scoped, resetting ladder with group consent. Sequence this a few weeks after real-group launch — it needs call volume to be meaningful anyway.

---

## What NOT to build, and why

1. **Milestone multiplier chat alerts (2x/5x/10x posts into the group).** The alert-landscape report ranked these #1, but the moat report shows **Phanes already fires 2x/5x/10x…10,000x multiplier alerts in-chat** — and Phanes runs in this very group. Groupie posting them would duplicate existing noise and violate the near-silent-bot spirit for zero differentiation. Resolution: milestones live **on the board** (sparkline tick marks, a quiet "5x" moment on the card, the recap strip) where Groupie's rendering is unmatched — not in the chat where Phanes owns the megaphone.
2. **A named, ranked leaderboard by default.** The biggest incumbent (Rick) made named rankings opt-in; hit-rate farming, bag-shilling, and the chilling effect on call volume are documented failure modes. Caller cards (#10) capture the value without the ladder.
3. **Chat digests or recap posts.** Owner rule, and Rick/Phanes own chat summaries. The recap is in-app only, always.
4. **Wallet/whale tracking or holdings import.** Cielo and GMGN own it with heavy infrastructure; wallet surveillance in a private friend group is a privacy chill that damages the trust the product runs on. The v2 private in/out annotation taps capture most of the value with none of the chill.
5. **Technical-indicator alerts, screener filters, heatmap suites.** Phanes DApp's filter-and-heatmap forest is the anti-pattern made flesh. The chat is the filter. Compound conditions in the alert engine (#3) deliver the false-positive-killing benefit without exposing a config surface.
6. **USD price-target alerts.** Unreadable for memecoins with absurd supplies. When level-cross alerts eventually come (deferred — see below), phrase them in **mcap, never token price**, matching the board's language.
7. **Trading execution / copy-trade.** Custody and regulatory surface; philosophy says link out (the Axiom/GMGN/DexScreener row does this job).
8. **AI call scoring, rug predictions, or any "buy opportunity" labels.** Advice framing violates the neutral principle. The buy-opp *alert* is acceptable only because a member explicitly opted the coin in; the *label* never appears on the board — raw retrace %, LP, volume, time-in-range only.
9. **Token-gated or rate-limit-tiered pricing tricks at this stage.** DEXTools is the cautionary tale (token-gated tiers, stale triggers, weakest product surveyed). Note the SaaS-phase lever for later: the whole market monetizes watchlist size + alert budgets + white-label bot identity (Cielo) — clean levers that don't degrade the free product.
10. **Public KOL/channel tracking.** SpyDefi/CallAnalyser own it; it is not the private-group lane.
11. **Digest emails / multi-channel delivery sprawl.** Two surfaces: the chat (input + opted-in alerts) and the board (output). Adding channels multiplies noise, not value.

## Near-misses (good ideas, deliberately not top-10)

- **Mcap-level cross alerts** (`/groupie alert <ca> above|below <mcap>`): the baseline everyone offers, cheap, and the hysteresis re-arm design (re-arm only after ~10% move off the level) is right — but it's table stakes, not moat, and each new alert type taxes the config surface. Ship after nuke/buy-opp/LP-drain prove the alert channel's signal-to-noise.
- **Generalized trailing-retrace alerts** (per-token retrace %): genuinely rare in the market and native to Groupie's peak tracking — but it's a v-next generalization of buy-opp, not a launch feature.
- **Volume-spike triggers**: only ever compounded with a price move (wash-trade noise otherwise); optional and late.
- **Group pattern cards** ("median runner peaks 84 min after call", time-to-peak/retrace-depth distributions): the honest, neutral version of "you sell too early" — Groupie has no exit data, so the advice version is both unknowable and off-philosophy. Needs months of snapshots; verify now that snapshot pruning tiers preserve what the math needs (peak_at survives pruning, which is most of it), design later.
- **Entry/exit annotations** (private in/out taps): v2, after the watchlist proves tap-engagement; aggregates-only publicly.

## Roadmap fit and sequencing

- **Now, inside the alerts build:** #3 (anti-fatigue engine) and #4 (message craft) — these are cheapest before first fire and decide whether the group tolerates the silent-bot exception. #8 (presence layer) rides the same schema work.
- **Design pass (next):** #1 (instant-open) as the opening move, then #2 (call-story sparkline), #5 (density), #9 (motion system) as the core visual work; #6 (recap) and #7 (what-if) slot in as content features of the same pass — both are days-scale re-derivations of stored data with maximum visceral payoff.
- **Post-launch, as real-group data accumulates:** #10 (caller cards).
- **v1.5 X launch monitor:** two tie-ins from the research to keep in scope — **auto-linking** (a watched X account tweets a CA, or the token appears via the launchpad-factory WS → the pre-launch card *becomes* the live call card with provenance and mcap-from-birth; pre-launch → called → peaked → died on one board is a lifecycle nobody renders), and SocialData **bio/name-change events** (pre-launch accounts drop CAs in bios).
- **Browser login:** #1's session/caching work is shared plumbing; design the logged-out browser state during the design pass as the brief already requires.
- **SaaS phase:** the **cross-group convergence badge** ("called in 3 groups within an hour" — groups anonymized, per-group opt-out) is the hook no single-group tool can copy; Xanguard sells convergence detection at $100/mo and the tokens-polled-once schema already supports it — just keep the query path clean now. Pricing levers: watchlist size, alert budget, custom presets, white-label bot identity.

## The one-sentence version

Ship alerts that never cry wolf and thread back to the call that spawned them; make the board open instantly and draw the call-relative story no one else can draw; add the recap, the $100 frame, and the presence layer to make the group's own curation visible; keep every word neutral and every summary out of the chat — and let Rick and Phanes keep the noise while Groupie keeps the record.

---

# PART 2 — Alert-bot landscape

# Crypto price-alert & watchlist tooling survey (Sept 2026) — what to steal for Groupie

## 1. Dedicated Telegram alert bots

### Drops Bot (dropstab) — richest config model surveyed
- **Triggers:** price % change (e.g. "+5%"), price level ("above $50K"), DEX swap volume thresholds (">$1,000"), token unlock/vesting schedules, wallet activity (transfers/swaps/mints, size-filtered), NFT floor, ETH gas, funding rates, exchange flows. 22+ chains, CA auto-detects network.
- **Config UX:** dual-mode — inline tap menus ("Tracking → Add → Coin/Wallet") for casuals AND command shortcuts (`/add 0xABC… MyWhale`) for power users; bulk import via text file; per-item filter settings; user-customizable alert message format (choose which fields appear: address, price, chart, quick-action buttons).
- **Group support:** add as admin to groups/channels; **different alert profiles per group**; "Caller Mode" (referral-link signal sharing, revenue share).
- **Anti-fatigue:** free tier hard caps (20 coins, 20 wallets, **100 alerts/hour**; paid up to 2,000); **compound conditions** ("price up 3% AND volume >$500K in 5 min"); min-size wallet filters; category toggles for quiet hours; docs explicitly advise "set useful thresholds and skip tiny 0.1% price moves". No built-in DND.
- **Pricing:** free tier as above; paid raises caps; payable via Telegram Stars.

### Cielo Finance — the group-chat-native reference
- Wallet-transaction alerts across 30+ chains, delivered into any Telegram **group, channel, or forum topic** (`/menu → Group Alerts → Add to group`, `/setup_bot` per topic).
- **Per-group config: tx type, chain, minimum USD value** — min-USD is their main noise valve.
- Pro/Whale tiers can run a **private clone bot** (own bot identity in the group) — white-labeling as a paid feature.
- Clean message format: token, amount, price, tx links. Free tier exists.

### Cryptocurrency Alerting (cryptocurrencyalerting.com) — best-in-class anti-fatigue controls
- Triggers: price target above/below, % change (volatility windows), periodic price updates, volume threshold, exchange listing, wallet tx, whale tx (beta), gas/mempool.
- **User-settable cooldown per alert: 5 minutes to 7 days**; explicit **one-time (auto-disable after firing) vs continuous** toggle per alert. This is the cleanest articulation of re-fire semantics in the space.
- 9 delivery channels (SMS, call, email, TG, Discord, Slack, webhook, push, browser). Pricing: free hobby tier (few alert slots), Trader $3.99/mo, Pro $19.99/mo, Business $49/mo (removes rate-limiting — note: rate limits themselves are a monetized tier).

### Others
- **Maestro:** wallet monitoring, whale notifications, price alerts + target levels, multi-chain; alerting bundled into a trading bot.
- **Whale Alert / cryptowhalebot:** large-transfer feeds; severity communicated by transaction size, channel-style (no per-user config).
- **XHuntr:** 13 social signal types (CA posted by account, renames, pinned-tweet changes, account convergence) via `/add @username`; ~1–2 SOL/mo. (Relevant to Groupie's v1.5 X monitor, not alerts.)
- **Rick / Phanes:** call tracking + ATH leaderboards + ROI ranking in-group (free, read-only). Neither is an alert engine — they answer commands and post summaries. **Groupie's watchlist alerts do not collide with them.**

## 2. DexScreener alerts
- Per-pair "Set Price Alerts": target price above/below, **percentage change**, and **% move within a time window**. Managed in an Alerts tab with disable/delete.
- Delivery: browser notification + email (no Telegram delivery — a real gap Groupie doesn't share).
- One-shot semantics; alert **slots are tier-limited on free accounts**, more slots on the paid tier. Otherwise product is free.
- UX note: alert entry point is the bell icon *on the token page itself* — config lives where the data lives, not in a settings tree.

## 3. Birdeye / GMGN / Axiom

### Birdeye
- Alert types: price thresholds, **volume spikes, large-trade detection (whale buy/sell over $X), liquidity drains**, smart-wallet activity, technical indicators.
- Distinctive **watchlist-combo model**: (a) watchlist + technical indicator, (b) watchlist + token-stats performance (price %, volume change), (c) watchlist + trading events (a tracked wallet trades any watchlisted token). The watchlist is the *scope*, the condition is applied across it — one rule covers the whole list.
- Delivery: Telegram bot, Discord webhook, email, in-app push. **Private-chat only for the TG price bot — group alerts not supported in TG** (gap Groupie fills).
- Pricing: free tier (limited watchlists); Pro ≈ $45/mo (up to 100 watchlists, expanded alerts).

### GMGN
- Watchlist = starred tokens with custom grouping + notes/renames; Monitor Square shows followed-wallet inflows over 1m/5m/1h/6h/24h windows; noise control = "hide tokens you're not interested in".
- Delivery via official TG signal bots per chain; two invitable group bots: @GMGNAI_bot (CA query/analysis on demand) and @Alert_GMGNBOT (smart-money wallet alerts into groups). Ten themed signal channels. Free; thresholds barely configurable — GMGN's answer to fatigue is *curated channels*, not user knobs.

### Axiom
- Watchlists + alerts on "significant moves": **% change within a timeframe, volume-surge events**; wallet-tracking watchlists. Delivery: mobile push, email, desktop. Alerting is a terminal side-feature, not deeply configurable.

### Nansen (adjacent but instructive)
- Wallet/token/protocol alerts with USD thresholds; docs explicitly warn: low thresholds on broad cohorts = noise, very high = too late — **start with one token, one cohort, a value range fitted to the token's liquidity** (i.e. thresholds should scale with liquidity — directly applicable to Groupie's nuke false positives on thin pools).
- **AI builds an alert from a plain-language request** — the frontier config UX in 2026.

### DEXTools
- Price-level alerts only (favorites → Pair Explorer → enter price); email/SMS/in-app; gated behind DEXT-token-holding Standard/Premium plans. Weakest offering surveyed — token-gated pricing adds friction and the trigger set is stale.

## 4. Group-chat-native patterns (buy bots: Safeguard, MajorBots, Defined, NomVe)
The most battle-tested anti-spam engineering for *posting into a group* lives in buy bots:
- **Min Buy USD** — the universal noise valve; nothing below the floor posts.
- **Emoji step**: magnitude encoded as repeated emoji ($ amount per emoji, configurable) — severity is *inside one message*, never extra messages.
- **Whale highlight** (wallet >$35k holdings flagged), **MEV-bot filtering** (drop non-human activity), custom layouts, up to 3 deep-link buttons per message, `/settings` inline panel in-group, `/reset` to defaults.

## 5. Anti-fatigue mechanics inventory (across all tools)
| Mechanic | Seen at | Notes |
|---|---|---|
| Per-alert cooldown (user-set 5m–7d) | Cryptocurrency Alerting; Kraken (fixed 5-min) | Groupie already plans per-token+type cooldown |
| One-shot vs repeating toggle | Cryptocurrency Alerting, DexScreener | explicit re-fire semantics per alert |
| Once-per-bar-close / confirmation | TradingView | fire on closed 5-min bucket, not wick — kills chop spam |
| Compound conditions (price AND volume) | Drops, TradingView | best false-positive killer |
| Min-USD floors | Cielo, all buy bots, Nansen | threshold scaled to liquidity (Nansen guidance) |
| Hourly alert budget | Drops (100/hr free) | cap + overflow suppression |
| Category/token mute, quiet hours | Drops | manual toggles |
| Severity-in-message (emoji scaling) | buy bots | one message, magnitude visible |
| Digest email tier | generic guides | nobody in the DEX space does digests well; owner rule says no digests anyway |
| Curated channels instead of knobs | GMGN | editorial, not configurable |

Trailing-stop-style alerts are essentially **absent** from mainstream tools (TradingView requires custom Pine Script). Groupie's peak-since-call machinery makes "retrace X% from tracked peak" native — buy-opp *is* a trailing alert, and generalizing it is a genuine differentiator.

## 6. Recommendations for Groupie (beyond nuke/buy-opp)

**Adopt — trigger types (in priority order):**
1. **Call-multiple milestones** (2x/5x/10x from mcap-at-call, each fires once ever, monotonic): pure moat — call-relative, no competitor has the call anchor. Neutral framing ("hit 5x since call"), zero config needed.
2. **LP-drain critical alert** (best-pair liquidity −X% within minutes, or below death floor while token still watched): reuses existing death machinery as an *early warning*; Birdeye's "liquidity drains" is the only comparable, and it can't post into TG groups. This is the tier ABOVE nuke.
3. **Mcap-level cross** (`/groupie alert <ca> above|below <mcap>`): the baseline everyone offers; phrase it in **mcap, never token price** (group thinks in mcap; matches board language). One-shot with hysteresis re-arm (re-arms only after price moves ~10% back off the level — avoids DexScreener's flapping problem).
4. **Volume-spike vs trailing baseline** (e.g. 15-min volume > N× trailing 6h average) as an optional "something's happening" trigger — but ship it *compounded* with a price move to avoid wash-trade noise.
5. **Generalized trailing retrace** later: let buy-opp's retrace % be set per-token, making it a de facto trailing-stop alert — rare in the market, native to Groupie's data.

**Skip:** wallet/whale tracking (Cielo/GMGN own it, heavy infra), technical-indicator alerts (filter forest, violates philosophy), USD price targets (unreadable for memecoins), digest posts (owner rule; Rick/Phanes own summaries), token-gated pricing (DEXTools cautionary tale).

**Adopt — anti-fatigue mechanics:**
1. Evaluate triggers on **closed 5-min buckets** (the ranging-board machinery), not raw polls — TradingView's once-per-bar-close, already consistent with "wicks don't reset the clock".
2. **Compound the nuke**: drop % AND minimum sell-volume/liquidity floor so thin-pool wicks don't fire; scale thresholds to liquidity per Nansen's guidance.
3. Keep planned per-token+type cooldown but make it **owner-settable with clamps** (5 min floor / 24h ceiling — Cryptocurrency Alerting's 5m–7d model).
4. **Group-level alert budget**: max N alert posts/hour (default low, e.g. 6); overflow suppressed silently, visible on the board instead — the board is the pressure-relief valve no competitor has.
5. **One thread per token**: post alerts as Telegram *replies to the original call message* — context travels with the alert and the chat stays scannable. Nobody does this; it's cheap (message_id is already in the mentions table).
6. **Severity inside one message** (buy-bot emoji-step pattern): nuke magnitude shown by repeated 🔻 or the drop %, never by additional messages. Milestone alerts likewise (2x…10x escalating glyphs).
7. `/groupie mute <ca>` / `/groupie mute all <duration>` — per-token and blanket quiet hours (Drops pattern).
8. **Preset severity tiers instead of parameter soup**: `sensitive / normal / chill` presets that move all thresholds together, with `/groupie set nuke|buyopp` as the escape hatch — honors "no filter forests" while still adjustable.
9. Config surface: keep bot commands, but add an **alerts panel in the Mini App** (inline-keyboard confirmations in TG, full editing in the app). DexScreener's per-token bell icon → put the watch/alert toggle on the token card itself.

**Pricing signal for the SaaS phase:** the whole market monetizes via alert-slot and rate caps (Drops 20/20/100-per-hr free; DexScreener paid slots; Birdeye Pro $45/mo; Cryptocurrency Alerting sells the removal of rate limits; Cielo sells private clone bots). For multi-group SaaS: free = small watchlist + default alert budget; paid = bigger watchlist, higher budget, custom presets, maybe a white-label bot identity (Cielo's Pro trick).

## Sources
- https://xhuntr.com/blog/best-crypto-alert-telegram-bots-2026
- https://news.dropstab.com/research/drops-bot-the-crypto-price-alerts-bot-for-telegram
- https://docs.cielo.finance/discord-+-telegram-bots/telegram-groups-+-channels
- https://cryptocurrencyalerting.com/coin/DEX
- https://www.webopedia.com/crypto/learn/dex-screener-user-guide-2024/
- https://www.altrady.com/blog/crypto-trading-tools/dexscreener-guide
- https://cryptoadventure.com/birdeye-review-2026-solana-token-analytics-wallet-tracking-and-trade-signals/
- https://blog.pumpparade.com/reviews/birdeye-review-2026-fees-features-verdict/
- https://docs.birdeye.so/docs/alert-notification-settings
- https://docs.gmgn.ai/index/follow-monitor-square-follow-watchlist
- https://docs.gmgn.ai/index/gmgn-tg-alert-channel-bot
- https://coinbureau.com/review/axiom-trade-review
- https://www.communitycoachingcenter.org/get-custom-alerts-based-on-price-movements-with-axiom-trade/
- https://cryptoadventure.com/nansen-review-2026-smart-money-onchain-analytics-alerts-and-pricing/
- https://info.dextools.io/faq/can-i-get-price-notifications/
- https://docs.safeguard.run/buy-bot/settings
- https://docs.majorbots.io/docs/majorbuybot
- https://www.tradingview.com/script/TkbChZ6S-Bitcoin-All-Time-High-ATH-Alert-with-Cooldown/
- https://www.bitget.com/academy/bitcoin-price-alerts
- https://toptelegrambots.com/best-crypto-telegram-bots
- https://coinspot.io/en/analysis/crypto-bots-tg-top-5-telegram-tools-for-monitoring-the-crypto-market-in-2026/
- https://phanes.bot/
- https://www.codex.io/case-studies/rickbot

---

# PART 3 — Tactile dashboard UX

# UX patterns for a fast, tactile, glanceable board (Telegram Mini App + mobile webview)

Researched 2026-09-02 for the Groupie design pass. Everything below is implementable with the current stack (Vite/React SPA + Hono on Railway, session cookie auth, SSE).

## 1. Liveness: number ticks and price flashes

### Number-tick animation
- **NumberFlow** (`@number-flow/react`, MIT, dependency-free, also Vue/Svelte/vanilla) is the current standard for odometer-style digit rolls. Transitions fire automatically when `value` changes; `format` takes `Intl.NumberFormatOptions` — `{ notation: 'compact' }` matches Groupie's `$1.2M` formatting out of the box. `trend` prop controls roll direction (`+1` ascend, `-1` descend, `0` per-digit) — set trend from the sign of the delta so a rising multiple visibly rolls *up*. `spinTiming` customizes easing; `continuous` plugin makes big jumps pass through intermediate values (good for the hero multiple). Respects `prefers-reduced-motion` by default (`respectMotionPreference`), which satisfies the design brief's requirement for free. Wrap multiple counters in `<NumberFlowGroup>` so simultaneous changes stay in sync. Uses CSS `mask-image`; fine in modern Telegram webviews (Chromium on Android/desktop, WebKit on iOS).
- **Requirement**: `font-variant-numeric: tabular-nums` on every live number (and honestly on all numbers on the board) so digits don't shift width mid-roll and columns stay scannable. This is a one-line CSS win to apply globally now.
- Alternative if a dependency is unwanted: Motion's `AnimateNumber`, or plain CSS `@property` counter transitions — but NumberFlow's reduced-motion + tabular handling makes it the pragmatic pick.

### Price-flash convention (the industry default, verified against ag-Grid)
- The de facto grid convention (ag-Grid "flashing cells"): on value change apply a **background highlight for 500ms, then fade it out over 1000ms**. Flash the *background* of the cell/stat, not the text color; tint direction-coded (green-tinted bg for up, red for down) at low alpha (~10-18% in dark mode) so it reads as a pulse, not a traffic light.
- Implementation: set `data-direction="up|down"` and restart a CSS animation (`animation: flash-up 1.5s ease-out`) by toggling a key/class. Keep text color stable; only the pulse carries direction. This avoids the "Christmas tree" effect when many cards update.
- **Throttle/batch**: coalesce updates so any one card flashes at most ~1-2x per second, and only when the *displayed* (compact-formatted) value actually changed — a $4.21M -> $4.22M tick that still renders "$4.2M" should not flash. With SSE pushing updates, batch a whole board frame per event rather than per-field renders.
- **Threshold-cross pulse** (brief owner ask: "a pulse when something crosses a threshold"): reserve a stronger, one-shot animation (scale 1.0->1.02->1.0 + brighter ring) for discrete events only — section change (fresh->runner), new peak-since-call, death, revival. Discrete events deserve drama; ambient ticks don't.
- **Live indicator**: a small pulsing dot ("live" connection state, driven by SSE open/closed) tells users data is flowing even when nothing changes — trading-app research calls this out as the core micro-animation that communicates system state. When SSE drops, the dot goes static/amber and the board shows "updated Xs ago" instead — neutral, not alarming.
- Accessibility: red/green alone excludes ~8% of male users — Groupie's signed numbers (+/-, x-multiples, retrace %) already carry the direction in text; keep that, and keep 4.5:1 contrast on all data text (WCAG 2.1 AA). Gate all flash/pulse animations behind `@media (prefers-reduced-motion: no-preference)`.

## 2. Haptics: Telegram WebApp HapticFeedback (verified current)

- Available since **Bot API 6.1** on `Telegram.WebApp.HapticFeedback`; still current per docs (updated Dec 2025):
  - `impactOccurred(style)` — styles `light | medium | heavy | rigid | soft`
  - `notificationOccurred(type)` — types `error | success | warning`
  - `selectionChanged()` — for changing (not confirming) a selection
  - All chainable. Gate with `Telegram.WebApp.isVersionAtLeast('6.1')` and wrap in try/catch.
- **Platform caveat (verified)**: a long-standing issue reports `impactOccurred` and `selectionChanged` doing nothing / being extremely weak on Telegram **Android**, while `notificationOccurred` works ([issue #28](https://github.com/Telegram-Mini-Apps/issues/issues/28)); iOS is the gold standard. Also, in-app vibration can be disabled by the user in Telegram settings. Design haptics as **pure garnish**: nothing may depend on them being felt.
- Concrete mapping for Groupie (haptics only for *user-initiated* actions, never for passive data updates — a board that buzzes on price ticks would be obnoxious and drain trust):
  - `selectionChanged()` — sliding across the time-window segmented control (6h/12h/24h/3d/w/m) and switching board sections.
  - `impactOccurred('light')` — card tap/expand, watch-toggle tap.
  - `impactOccurred('medium')` — pull-to-refresh crossing the commit threshold.
  - `notificationOccurred('success')` — watchlist add confirmed; `('warning')` — bin/remove confirmation step.
  - Optional single tasteful exception: `impactOccurred('rigid')` when a card the user is *watching* crosses a threshold **while the app is open and the event is on-screen** — at most once per coin per session.

## 3. Loading: skeleton + stale-while-revalidate (the perceived-speed core)

- **Pattern**: render the last-known board instantly from a local cache, revalidate behind it. This is exactly SWR ("stale-while-revalidate"): serve cached content immediately, fetch fresh in background, reconcile. Research consistently shows skeleton/cached-first paints are *perceived* faster than spinner waits even at identical real latency.
- Concrete for Groupie:
  1. Persist the last board JSON per group + window in `localStorage` (works in iOS/Android Telegram webviews; iOS quota ~5MB is plenty for JSON) with a timestamp.
  2. On boot: paint cached board synchronously (before auth completes — `Telegram.WebApp.initData` is available synchronously in the webview, so group identity is known at first frame), show a subtle "updated 2m ago" stamp, kick off auth+fetch, then reconcile.
  3. Reconcile without jank: keep card identity stable (key by call id), animate section moves (FLIP / `view-transition`), and *do not* flash cells on the reconcile diff — flashes are for live ticks only, otherwise every open is a firework show.
  4. Skeleton screens only on true first run (no cache): skeleton must mirror the exact card layout (shape-accurate placeholders, shimmer optional) so there's no layout shift when data lands. Never spinners for the board.
  5. Null states: real words ("No calls yet in this window"), never the hero-sized em-dash (flagged in the brief).
- **`ready()` timing**: call `Telegram.WebApp.ready()` as soon as the shell/skeleton is painted — it hides Telegram's loading placeholder. Calling it late is a major source of "Mini App feels slow"; calling before first meaningful paint causes a white flash. Right moment: first React commit of the cached-board/skeleton shell.
- Also set `Telegram.WebApp.setBackgroundColor` / `headerColor` (or themeParams-matched CSS) to the board's dark background immediately so the pre-paint frame is dark, not white — the white-flash-into-dark-app is the single most cited "feels broken" moment in Mini App UX writing.

## 4. Mini App performance: why they open slow, proven fixes

Causes, roughly in Groupie-relevant order: server round-trip distance (already being fixed via region move), sequential request chains (auth -> board), oversized JS, uncached assets, webfonts, and late `ready()`.

- **Collapse the auth/board chain (biggest app-level win)**: the standard Mini App auth pattern is validate `initData` HMAC-SHA256 once server-side (check `auth_date` freshness; common windows are 5 min strict to 24h default in libraries), then issue your own session (JWT or cookie — Groupie already has the cookie). Extend it: one `POST /session` that takes initData and returns *both* the session cookie *and* the first board payload in the same response — one round trip from cold open to data. Subsequent opens skip initData entirely while the cookie lives (persist it; don't re-auth every open).
- **Budgets** (community norms for Mini Apps): initial JS < ~1MB uncompressed (aim far lower — a board SPA should land ~150-250KB gz), TTFP < 800ms on fast 3G, LCP <= 2.5s, INP <= 200ms. Code-split anything not needed for first board paint (detail views, settings, watchlist management).
- **Static assets**: hashed filenames + `Cache-Control: public, max-age=31536000, immutable` (Vite does the hashing already); short/no-cache on `index.html`; brotli. Plain HTTP caching works in *all* Telegram webviews including iOS — this, not service workers, is the reliable repeat-open accelerator.
- **Service workers (verified)**: registered fine on **Android** (Chromium-based WebView) and Telegram Desktop/macOS, but **do NOT work on iOS** — WKWebView only allows SW with the browser entitlement / app-bound domains, which Telegram doesn't provide ([issue #27](https://github.com/Telegram-Mini-Apps/issues/issues/27), [Apple forums](https://developer.apple.com/forums/thread/722160)). Treat SW app-shell caching as a progressive enhancement for Android/desktop; the localStorage board cache + HTTP caching carry iOS. (Telegram has experimented with offline asset bundles in betas; nothing shipped to rely on.)
- **Fonts**: system font stack, or one preloaded `woff2` with `font-display: swap` — a render-blocking webfont is a classic Mini App cold-open killer. If a display font matters for the hero multiple, subset it to digits + a few glyphs.
- **Preconnect**: `<link rel="preconnect">` to any second origin (fonts CDN, image host). Groupie serves SPA + API same-origin — keep it that way; it's the fastest architecture (no extra TLS handshake, cookie just works).
- **Lifecycle**: use `activated`/`deactivated` events (Bot API 8.0) — on `deactivated` pause SSE/polling; on `activated` immediately revalidate and reconnect. Users minimize the Mini App and come back; instant-fresh on return is a perceived-speed multiplier and saves battery/server.

## 5. Webview mechanics that make it feel native (tactile prerequisites)

- **Kill the swipe-to-close fight**: call `Telegram.WebApp.disableVerticalSwipes()` (Bot API 7.7+) — without it, any downward swipe on an unscrolled board can minimize the app, which destroys the "tactile board" feel. Users can still close via the header. Fallback for older clients: make the document scrollable (`height: calc(100vh + 1px)`) and pin `scrollY` to 1 on touchstart.
- `Telegram.WebApp.expand()` on load so the board opens full-height, not half-sheet. Fullscreen mode (`requestFullscreen`, Bot API 8.0) exists but is overkill for a board; ignore for now.
- Sync `themeParams` (Telegram theme colors -> CSS variables) so the app never looks like a foreign white iframe inside dark Telegram; the board is dark-first anyway, but header/background colors should be set explicitly via the API.
- Use Telegram's native `BackButton` for detail views instead of an in-app back arrow; it reads as native and saves header space.
- Overscroll: `overscroll-behavior: none` on the scroll container to stop rubber-band chaining into the webview.

## 6. Card density and glanceability

- Trading-dashboard guidance converges on **max 3-4 data points per card at rest**, one hero metric in large high-contrast type, secondary metrics smaller and muted. For Groupie: multiple (hero) -> symbol -> one contextual stat (now-mcap or retrace %) + sparkline. Everything else is tap-to-expand.
- Density targets for the tight variant (Runners/Died, flagged in the brief at 2.5 cards/screen today): rows of **~64-72px** yield 8-9 visible rows on a 390x844 viewport — the scan-list sweet spot while keeping the whole row a comfortable >=44px touch target. Fresh/Retraced can keep a taller ~96-110px card (4-5 visible) since those reward reading.
- **Trading-links row**: kill the always-visible 40px 3-button row. Standard patterns: (a) tap card -> expanded state with links, or (b) long-press / swipe-left action row. Rarely-tapped actions must not tax every card's height by 40px x N.
- **Badge row fix**: one status *edge* (3px left border color-coded by state: fresh/runner/retraced/died/ranging/revived) + at most one text badge inline after the symbol. Status color on the edge frees the badge slot for the exceptional thing only (REVIVED, died reason on died board).
- Progressive disclosure over filters — aligns exactly with "the chat is the curation": section tabs + time-window control and nothing else. Persistent bottom nav in-app only if watchlist becomes a real second surface.
- Watched-coin affordance: a small filled marker on the card edge/corner (not another badge) + optionally sort-pinning within section.

## 7. Sparkline enrichments (make it tell the call-relative story)

Tufte's rules ("data-intense, design-simple, word-sized") plus dashboard practice:
- **Baseline = mcap at call.** A dotted horizontal reference line at the call level turns every sparkline into the called -> peaked -> now story at a glance: line above baseline = still up from call, below = underwater. This is Groupie's moat drawn literally, and no generic screener has it.
- **Peak marker**: a single dot at max-since-call (the ATH-since-call the engine already tracks). On Retraced cards, additionally shade the drawdown zone (area between peak level and current) faintly red-tinted — the retrace % made visible, still neutral data.
- **End dot** on the current value (slightly larger, state-colored) so the eye lands on "now". Min markers only where meaningful (died board).
- **Area fill** below the line to the call-baseline (not to zero, not to the chart floor) at low alpha — filled area is what makes tiny charts readable; centering a flat anonymous line (current bug) reads as noise.
- Size: ~16-20px tall inline in tight rows; ~32-40px on full cards. Per-card independent y-scale is correct here (each coin's own story), but always anchored by the call baseline so scale ambiguity doesn't mislead — this addresses the classic scaling pitfall of comparing sparklines across rows.
- **Ranging cards**: different sparkline grammar — draw the *band* (two horizontal lines or a shaded channel) with the price wiggling inside, plus time-in-range as the hero number. The channel-with-line-inside is instantly distinguishable from the peak-story sparkline, giving Ranging its own identity (brief requirement).
- Color by section state, not by last tick: runner = accent/green line, retraced = neutral line + red drawdown shading, died = muted gray, ranging = neutral in band. Last-tick coloring of sparklines is noise at this size.

## 8. Reduced motion + noise budget (the restraint half of "alive")

- One motion system: ambient (number rolls, live dot) always-on but subtle; reactive (flash 500ms/fade 1000ms) on data ticks, throttled; ceremonial (section-move slide, threshold pulse, death fade) for discrete events only. Nothing loops except the live dot.
- `prefers-reduced-motion`: NumberFlow handles itself; wrap all CSS flash/pulse/slide in the media query; replace section-move animation with instant reorder + a brief highlight.
- Every animated element must also be readable static (screenshot test) — motion is annotation, never the data itself.

## Sources
- https://core.telegram.org/bots/webapps
- https://docs.telegram-mini-apps.com/platform/haptic-feedback
- https://github.com/Telegram-Mini-Apps/issues/issues/28
- https://github.com/Telegram-Mini-Apps/issues/issues/27
- https://developer.apple.com/forums/thread/722160
- https://docs.telegram-mini-apps.com/platform/swipe-behavior
- https://dev.to/nimaxin/how-to-fix-the-telegram-mini-app-scrolling-collapse-issue-a-handy-trick-1abe
- https://number-flow.barvian.me/
- https://github.com/barvian/number-flow
- https://motion.dev/docs/react-animate-number
- https://www.ag-grid.com/react-data-grid/flashing-cells/
- https://lollypop.design/blog/2026/june/trading-app-design/
- https://turumburum.com/blog/telegram-mini-app-beyond-the-standard-ui-designing-a-truly-native-experience
- https://blog.logrocket.com/ux-design/skeleton-loading-screen-design/
- https://www.infoq.com/news/2020/11/ux-stale-while-revalidate/
- https://www.edwardtufte.com/notebook/sparkline-theory-and-practice-edward-tufte/
- https://www.perceptualedge.com/articles/visual_business_intelligence/best_practices_for_scaling_sparklines.pdf
- https://docs.telegram-mini-apps.com/platform/init-data
- https://medium.com/@miralex13/seamless-authentication-in-telegram-mini-apps-building-a-secure-and-frictionless-user-experience-6249599e2693
- https://www.findmini.app/read/common-telegram-mini-app-development-challenges-solutions/

---

# PART 4 — Moat-grounded features

# Groupie moat-feature research & brainstorm (2 Sep 2026)

Grounded in C:\Projects\crypto-app\CLAUDE.md, docs\decisions.md, docs\plan.md, docs\design-brief.md, docs\research-summary.md, docs\research-trading-links-competitors.md, plus live web research.

## 0. Competitive reality check — the lane is NO longer empty (update to docs/research-summary.md)

The 1 Sep 2026 research verdict ("no product gives a private group a web board of its own calls") is now stale in two places:

- **Rick Hub** (app.rick.bot, beta; also a Telegram Mini App): a **per-user** aggregated feed of scans across all your Telegram/Discord groups — historical search, real-time leaderboards, push notifications, and group comparison over 1h/4h/12h/24h/3d/7d/31d windows on "median gain, current performance, first-scan FDV, 2x/5x hit rates." Access is per-user (Telegram/Discord link) and expires 24h after you leave a group. Source: talk.markets/t/rick-hub-your-feed-your-edge/8255.
- **Phanes DApp** (dapp.phanes.bot, reached via `/dapp` in the group): a **per-group** web dashboard — "heatmaps, performance trends, success rates, chain comparisons, return distributions," Group PNL Cards, real-time sparklines/mcap updates, plus in-chat multiplier alerts (2x/5x/10x… up to 10,000x for boosted groups). Phanes also ranks members "by real call ROI and win rate" via a point system that "penalizes poor calls and pump chasing." Sources: phanes.bot, docs.phanes.bot (via search snippets; direct fetch 403s), x.com/phanesbot/status/1936219044107239508.

**What neither has** (Groupie's actual moat, sharpened): lifecycle board sections (fresh/runners/retraced/died/ranging), call-relative retrace and time-in-range math from own polling, died-after-call as a first-class honest record, group memory (bin/keep, revival), watchlist alerts with nuke/buy-opp semantics posting into the chat, Robinhood-Chain-first coverage, and — crucially — the *calm glanceable board* philosophy. Rick Hub and Phanes DApp are both analytics forests (filters, chart suites, heatmaps) — exactly what the owner's principles reject. Groupie should not race their chart suites; it should out-story them: called → peaked → retraced → died/ranging in one visual second.

A resonant market narrative found in discourse: traders are leaving alpha groups for wallet trackers because **claimed win rates aren't trusted — "audit past calls… don't trust claimed win rates, verify them."** Groupie's bot-recorded, at-call-time, death-inclusive record is an *unfakeable* group track record. That's the positioning sentence for the SaaS phase.

## 1. Caller stats / leaderboards — build "caller cards," not a ladder

**Precedent:** Rick `/ga` ATH leaderboards + BurpBoard (winner-biased, ATH-multiple based; min FDV 25K to count); Phanes point-scored member rankings (explicit "pump chasing" penalty); public-KOL rank sites (Kolscan, KOL Explorer, pump.fun callouts leaderboard ranked by "hit rate, multipliers, total return"; DexCheck KOL Performance Index).

**Toxicity evidence the owner should weigh:** Rick makes Telegram leaderboards **anonymous by default** (admins must run `anon off`; clantags exist as a middle ground) — the biggest incumbent decided named rankings are risky enough to opt-in. Known failure modes: (a) hit-rate farming — spamming safe/late calls to pad stats (Groupie's first-caller-only credit + reposts-never-create-calls already blunts this); (b) shill-your-own-bag — leaderboard status rewards calling coins you're already holding (the entire Kolscan wallet-vs-words genre exists because of this); (c) chilling effect — in a small private friend group, a public shame ladder suppresses call volume, and the chat-as-curation flywheel dies with it; (d) ATH-only stats are survivorship-biased, which clashes with Groupie's neutral-data principle.

**Opinionated build:** per-member **caller card** (profile view reached by tapping "called by X" on a token card — no global ranked list on the board): calls timeline, outcome distribution as a small multiple-histogram, 2x/5x hit rates, median peak multiple, died %, median time-to-peak. Died-inclusive honesty is the differentiator — no incumbent shows a caller's failures. If the group wants competition later, make it an **opt-in, week-scoped ladder that resets** (no permanent hierarchy), named only with group consent — mirroring Rick's anonymity default. All of this computes from existing tables (calls.peak_mcap_since_call, peak_at, died_at, mentions).

## 2. Group daily recap — highest philosophy-fit, build early

An **in-app** "Yesterday" strip (never posted to chat — preserves the near-silent bot; Rick/Phanes own chat summaries): N calls, best call (peak x + who), worst, died count, ranging count, and one visceral aggregate number (see §3). This is the design brief's "reward the twice-a-day check-in in the first second" made literal, and it's the retention surface for members who didn't trade that day. Pure derivation of stored snapshots/calls — cheap. Precedent (BurpBoard hourly/weekly channel posts, Phanes trend charts) is feed/chart shaped; a glanceable morning story card is unoccupied.

## 3. PnL-if-you-held / "what-if" views — strong fit, proven demand, near-zero cost

Demand is proven by wallet/manual tools: paperhands.gg (NFT regret calculator), PulsePaper and DryFlip (memecoin paper-trading sims whose pitch is literally "see where you exited too early"), generic what-if calculators. **Groupie can do this with zero user input** because it owns every call + full call-relative history: per-card toggle "$100 at call → $X at peak → $Y now," and the group aggregate for the recap ("$100 on each of yesterday's 12 calls: peak $2,340, now $890"). It's a re-labeling of the multiple — the existing hero number — into a visceral, tactile frame. Guardrails: label "at call mcap, ignores fees/slippage/fillability" (curve tokens at $5k mcap are not fillable at size); keep the multiple as hero and dollars as a toggle; this is illustrative data, not performance claims.

## 4. "Your group sells too early" analytics — the honest version is *group patterns*, not sell advice

Hard constraint: **Groupie has no exit data** — no wallet tracking, no sells. "You sell too early" is both unknowable and advice-framed (violates the neutral principle). The honest, buildable version from snapshots alone: **group pattern cards** — "median runner peaks 84 min after call," time-to-peak distribution, retrace-depth distribution, call-quality by hour/day heatmap, "calls made while another call is pumping die N% more often." Neutral, verifiable, and impossible for generic tools (they lack call timestamps). Needs weeks–months of accumulated data; design after soft launch has volume. Check that snapshot pruning tiers (plan.md) retain enough resolution for time-to-peak math — peak_at on calls survives pruning, distributions need only that.

## 5. Entry/exit annotations — v2, private-by-default

Tap "in" on a card (records timestamp + current mcap), later "out." Unlocks true per-member "you exited at 2.1x, peak was 7x" — privately. Risks: manual = decays; public positions in a friend group are socially sensitive. Ship after the watchlist proves tap-engagement; display only aggregates publicly ("3 in"). No wallet connection, ever — it breaks the zero-friction property and chills a private group.

## 6. Who's-watching-what — ride the watchlist shipping now

Design brief already asks for watched coins to look "followed." Cheap extensions: "added by X" attribution on watchlist entries, a watch-count badge on board cards, and possibly ambient "5 members opened this card today." Neutral wording ("watched," never "hot") to avoid manufactured herding. This is the social layer that fits — presence, not opinion.

## 7. Cross-group convergence signal — the SaaS-phase moat; design the data now, ship later

Precedent proves value: CallAnalyser's core product is "how many KOLs called this CA"; GMGN surfaces KOL call/holder counts; **Xanguard sells a "Convergence Tracker" add-on for $100/mo** (detects multiple accounts clustering on the same pre-launch community). Groupie's version at multi-group scale: "called in 3 groups within the last hour" badge — schema already supports it (tokens polled once across groups; calls are per group_id). Non-negotiable: **anonymize which groups** — private-group trust is the foundation; add a per-group opt-out of contributing to the aggregate. This becomes the SaaS hook no single-group tool can copy.

## 8. Launch-monitor tie-ins (v1.5) — proceed, and close the lifecycle loop

The crypto-X-monitoring category is alive and paid in 2026 (Xanguard; TwitGram free X→Telegram CA streams for pump.fun/four.meme etc.; Tweet Catcher-style bots), validating twitterapi.io/SocialData plans in docs/research-x-monitoring.md. Two additions: (a) keep SocialData's **bio/name/profile-change events** in scope — pre-launch accounts drop CAs in bios; (b) the unique tie-in is **auto-linking**: watched X account tweets a CA (or its token appears on a watched launchpad factory via the Alchemy WS) → the pre-launch card *becomes* the live call card with the X account as provenance and mcap-from-birth. Pre-launch → called → peaked → died on one board is a lifecycle nobody (Rick, Phanes, screeners) renders.

## 9. Explicitly do NOT build

1. **A named, ranked leaderboard ladder by default** — Rick anonymizes by default for a reason; caller cards + opt-in weekly ladder instead.
2. **Trading execution / copy-trade** — custody + regulatory surface; philosophy says link out (Axiom/GMGN row).
3. **Filter forests / screener-style UI** — Phanes DApp's heatmap-and-filter suite is the anti-pattern; the chat is the filter.
4. **Wallet tracking / holdings import** — privacy chill in a private group; annotations (§5) capture 80% of the value.
5. **In-chat digests or recap posts** — Rick/Phanes own chat noise; recap lives in the app only.
6. **AI call scoring / rug predictions / "buy-opp" *labels*** — advice framing; keep raw neutral signals (LP, volume, retrace %, time-in-range). The watchlist buy-opp *alert* is fine because a member explicitly opted the coin in.
7. **Public KOL/channel tracking** — SpyDefi/CallAnalyser own it; not the private-group lane.

## 10. Suggested sequencing (soft-launch flesh-out)

1. Recap strip + $100-what-if framing (§2, §3) — days of work, pure re-derivation, maximum visceral payoff.
2. Watchlist social affordances (§6) — rides the alerts feature already in build.
3. Caller cards (§1) — needs a few weeks of real-group call volume anyway.
4. Group patterns (§4) — needs months of snapshots; design later.
5. Launch-monitor auto-link (§8) — v1.5 as planned.
6. Cross-group badge (§7) — SaaS phase; just keep the query path clean now.

## Sources
- https://talk.markets/t/rick-hub-your-feed-your-edge/8255
- https://talk.markets/t/global-burpboard/1466
- https://talk.markets/t/commands-on-telegram/1465
- https://phanes.bot/
- https://docs.phanes.bot/phanes/leaderboard
- https://docs.phanes.bot/phanes/dapp
- https://x.com/phanesbot/status/1936219044107239508
- https://www.codex.io/case-studies/rickbot
- https://www.solanatracker.io/leaderboard/kolscan
- https://kolexplorer.com/
- https://pump.fun/callouts/leaderboard
- https://dexcheck.ai/app/kol-performance
- https://kalkinemedia.com/education/guides/kolscan-how-solanas-smart-money-gets-ranked
- https://nftnow.com/news/nft-trading-calculator-paper-hands/
- https://pulsepaper.xyz/
- https://dryflip.com/
- https://xanguard.tech/blog/best-twitter-monitoring-tools-crypto/
- https://twitgram.xyz/
- https://www.mexc.com/news/74318
- https://coinbrain.com/blog/top-crypto-signal-groups