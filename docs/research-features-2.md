# overseer feature research 2 (2026-09-02)

*Synthesis of four angles — own-data, external-free, tool-patterns (Axiom / GMGN / DexScreener / Phanes / Rick), empirical (the group's own 9h of history) — plus a completeness critic and a cost audit. 40 raw ideas, ~25 distinct after de-duplication. Scored value ÷ cost, free-data-first, screened against every hard constraint (near-silent bot, neutral framing, no filter forests, HOOD-only, GT budget that already 429s, owner's declined list).*

---

## 1. Verdict: where the cheapest value is now

The cheapest value is not in a new data source. It is in three places we already pay for and throw away: **(a) fields that arrive in every poll response and are dropped by the parsers** — h1/m5 volume, buys/sells, unique buyers/sellers, m5–h24 price change, `launchpad_details.graduation_percentage`; **(b) columns we already store and never render** — `peak_at`, `liquidity_at_call`, `mentions.user_id`, `alerts.mcap_usd`, `rug_hidden_at`, per-call `died_at/death_reason/mcap_at_death`; and **(c) the loop we never closed** — an alert is the one licensed chat message and it currently opens nothing, anchors to nothing, and is never followed up on the board. Twelve of the distinct ideas cost zero API calls and together they are one migration (0009), one parser pass, and a handful of card lines. The empirical pass on the group's first day makes the case bluntly: 10 of 16 tracked tokens printed nuke-shaped drops and **zero** nuke alerts fired, because nobody was watching during the first two hours; three buy-opp alerts fired and the app has no record of them. The alerting goal is under-served not by missing data but by missing plumbing.

Two prerequisites gate everything external. **Round 17b batched resolution is decided but not implemented** — resolution is still up to 2 single-token GT calls per unresolved token per tick, which is today's dominant GT burst; ship it and re-measure 429s before approving *any* new GeckoTerminal traffic (trending pill, holder `/info`, trade tape). And **`dexscreener.ts` has no pacer or 429 handling** — a non-OK response throws and stamps the whole batch — so the first DexScreener-adding idea pays ~2h for a shared DS pacer with per-route constants (300/min token routes, 60/min orders/profiles). The external ideas that survive scrutiny are DexScreener-only (paid-signal pills, multi-pool liquidity, sleeper live-drift) and on-chain via a single shared Alchemy client (creator dossier, graduated stream, curve reads); the ones that add GT calls do not survive it. The one architectural question nobody on the panel answered — whether curve-phase mcap/liquidity/graduation can be read from chain via multicall and GT dropped for the curve tier entirely — would change the cost line of half this list and is worth a half-day spike before the next GT-dependent decision.

**Build order is not rank order.** The foundation migration (#2) should land first because #1, #3, #4, #5 and #7 all write to or read from it, and because it fixes a correctness gap in the moat itself (mcap-at-call is the *first snapshot*, taken 45s-to-minutes after the paste; every multiple, peak, milestone and trough compounds that lag).

---

## 2. Top 10

| # | Name | What the member sees | Goal | Data source | Cost | Why it ranks here |
|---|------|----------------------|------|-------------|------|-------------------|
| 1 | **Close the alert loop** (deep link + watched-at baseline + outcome trail) | The NUKE/BUY-OPP reply carries a link that opens *that* card; ON WATCH rows read "watched at $57K · now 1.8x" with a watched-at baseline on the sparkline; every card/row that fired an alert shows "NUKE 14:02 at $460K → now $635K (+38%)". Died rail shows the last alert before death. | alerting | `alerts` (fired_at, mcap_usd, details), `watches.added_at` + nearest snapshot (LATERAL), `start_param` in the Mini App, `?focus=` on the web | 0 API · ~10–12h (three surfaces) · no migration | Highest value per hour on the list. Three angles proposed the outcome trail independently; the critic found the deep link and the watch baseline missing entirely. Turns the only chat message we send into a door, and gives the group the neutral evidence base for alert tuning without a settings UI. |
| 2 | **Migration 0009: materialise what we already pay for** | Nothing directly — the enabler for #3/#4/#5/#7. Plus one honesty line: "call price as of +2m" when the first snapshot lagged the paste by >60s. | tracking | DS `volume.{m5,h1,h6}`, `txns.h1.{buys,sells}`, `priceChange.*`; GT `volume_usd.h1`, `transactions.h1.{buys,sells,buyers,sellers}`, `price_change_percentage.*`, `launchpad_details.graduation_percentage` — all already in the responses `toPair`/`parsePoolResource` drop. New: `snapshots.{vol1h_usd,buys1h,sells1h,buyers1h,sellers1h,graduation_pct}`, `tokens` latest-cache of the same + `chg_m5/h1/h6/h24`, `calls.{trough_mcap_since_call,trough_at,milestones jsonb,first_snapshot_lag_s}`, `tokens.graduation_pct` | 0 extra API · ~8h backend · +~2–3 MB/day snapshot growth | Five ideas each proposed "their own migration 0009". One migration, one writer (`applySnapshot`/`applyCurvePool`), materialise-on-write so nothing scans raw snapshot rows per request — which also makes a retention/prune tier safe (none exists today; only serve-time downsampling). Fixes the mcap-at-call lag before anything multiplies off it. |
| 3 | **Curve progress bar + graduation timing** | FRESH cards on PONS curves: thin monochrome bar "curve 64% · +2.1%/h"; ≥80% prints FINAL STRETCH (text, not colour); stalled 3h prints "stalled 3h". On graduation: "graduated +22m after call" (or "called 5m after graduation"), sparkline tick, day strip "N graduated today". | tracking | `GtPoolInfo.graduationPct` (parsed since M2, never stored) via #2; `tokens.graduated_at`, `calls.called_at` | 0 extra API (rides on the existing `/pools/multi` curve poll) · ~6h incl. UI | Three angles converged on it; PONS is the dominant launchpad and graduation is *the* lifecycle event, currently visible only as a phase flip. Members open PONS to see the curve fill. Call-to-graduation timing is data no terminal can show. The proposed "graduated" *chat* alert is dropped — Phanes already posts migration alerts (see §5). |
| 4 | **Flow strip + LP-vs-call** | Under every sparkline: a thin two-tone bar "1h · 46 buys / 62 sells" ("buyers/sellers" where GT supplies uniques), a "1h vol = 6× its 24h pace" chip when h1×24/h24 ≥ 3, m5/h1/h6/h24 % on expand; "LP 0.6× of call" chip (suppressed in curve phase); a thinner liquidity trace under the mcap sparkline on Retraced and ON WATCH. Died rail: last known flow before death. | tracking / finding | #2's flow columns; `calls.liquidity_at_call`, `snapshots.liquidity_usd` (same `loadSparklines` CTE, second series) | 0 API · ~10h (one FlowBar + second sparkline series × three surfaces) | The single most-used glance in every terminal ("is anyone still buying?") and the one number the board cannot answer: a coin bleeding on 30 sells / 1 buy looks identical to one consolidating. Also the free proxy for "one wallet or many" that makes the holder/whale ideas unnecessary for now. Ratio bar + raw counts, never a score; omit under 10 txns. |
| 5 | **The lows** (trough since call · first-hour ribbon · off-the-low on Retraced · dip count) | Every card: "low −38% · t+12m" next to peak, trough marked on the sparkline. FRESH: "+15m −23% · +1h +40%" ribbon. RETRACED: "low $41K · 3h ago · now +38% off low · vol 1.6×" (secondary sort by % off low). Retraced/Runners: "dips ≥40%: 2 · new high after: 1". | tracking / alerting | `calls.trough_*` (#2), post-peak min over `snapshots` where `at >= calls.peak_at` for retraced ids only, dip walk done incrementally in the poller (never per request) | 0 API · ~10h | Empirical backbone: 10 of 15 calls were *below* call mcap 15 min after the call; all 4 runners drew down ≥40% then bounced 1.7–5.0×, 3 of 4 printed a new high after, 2 of 4 still finished −96%. The board tracks peaks and not troughs, so it cannot show the pattern the group actually lives through. Retraced today says how far a coin fell and nothing about what it has done since. Wording: "off the low", never "bounce"/"recovery"; dip counter frozen once rug-hidden; nothing in the chat message. |
| 6 | **Alert enrichment + LP-DRAIN tier** | Same single reply, one more line of evidence: "NUKE HDFI −47% in 12m · $872K → $460K · LP $18K (−81% since call) · 30m: 28 buys / 134 sells". New tier LP DRAIN (best-pair liquidity −60%+ within 15 min on an unlocked pool) fires ahead of nuke, once, suppresses nuke for the same token/window. Watched coins only. | alerting | `loadLiquidityReadings` series already loaded per tick, `calls.liquidity_at_call`, #2 flow cache, `alertLogic.evaluateAlerts`, `alerts.type` (text column) | 0 API · ~6h (pure functions + template + settings clamp) | Severity *inside* one message is how every mature alert tool avoids sending more messages; our alert's credibility is the product's credibility. LP drain is the rug-in-progress signal the death machinery already measures. Works without #4 (shorter line). On locked PONS pools the LP clause is omitted rather than printing a misleading observable-max −85%. |
| 7 | **Pulse timing** (time-to-peak · since-you-last-looked · patterns · yesterday) | Card subline "peak 3.4× at +84m · now 1.9× at +6h". Pulse line "since 08:10: 6 calls · 2 died · 1 reviving · NARCO (watched) −38%" from a per-device `lastOpenedAt`. PATTERNS line (only when N ≥ 10, 7 local days): "median runner peaked 71m after call · 40% peaked inside 1h · 22% died". Tap → YESTERDAY sheet (calls, best peak + symbol, died by reason, reviving). | tracking | `calls.called_at/peak_at/peak_mcap_since_call/mcap_at_call/status/died_at/death_reason`, `tokens.reviving_at`, existing `?tz=` day bounds; `localStorage` for the since-marker (private to the viewer) | 0 API · ~9h | `peak_at` has been stored since M2 and never shown. Delivers the shortlisted yesterday recap as a derivation, plus the highest-frequency workflow moment (morning open) that no idea attached to. One group-wide median is neutral; per-caller medians are not (caller cards, deferred). "peaked at +0m" renders "never above call". |
| 8 | **Honesty batch** (re-mention semantics · probation disclosure + death timeline · polling-health line · unresolved card links) | "re-called ×N" counts only mentions by a *different* member than the caller. DIED rail's "N hidden on probation" expands to "pokepad · hidden 40m ago · $6.2K · revives at $30K". Died rows: "called $41K → peak $410K at +1h20 → died +4h12 (rug_floor) at $7.8K". Reviving: "hidden 6h, revived after 3h hold". Pulse: "curve coins last polled 4m ago (throttled)" / "SSE reconnecting". Unresolved FRESH cards render caller + AXIOM/GMGN/DEXS links immediately. | tracking | `mentions.user_id` vs `calls.caller_user_id`; `tokens.rug_hidden_at/reviving_at/revived_at`, per-call death columns, `THRESHOLDS.revivalMcapUsd/rugProbationHours`; budgeter state + `tokens.last_snapshot_at`; `tradingLinks(address)` works off the bare address already | 0 API · ~9h | Empirical: all 3 re-mentions in the group's history were the original caller reposting, so the badge currently reads as consensus for one person posting twice — fix it while it is 1.5h. Round 6's "nothing should be missable" is only half-honoured by a count. For a product whose alert promise is "we are watching", an unwatched minute must be visible. The unresolved-card check is <1h and covers the 45-second moment after a paste. |
| 9 | **Sleepers freshness** (live drift via DexScreener + scan deltas) | Each Sleepers row: "listed $541K → now $188K", rows that left their band dimmed; a change column (h6/h24 %) and a marker vs the previous scan: NEW / "from $100–250K band" / "rank 7 → 2" / dropped (kept one scan, muted). Refresh line gains "calls from this list: N (7d)". | finding | DS `/tokens/v1/robinhood/{≤30 addrs}` every 10 min over current `sleeper_entries` (≤~170 rows → ~860 DS/day, <1% of allowance, 0 GT); `price_change_percentage.*` already in the `getTopPools` pages; keep 2 scans instead of 1; `sleeper_seen` × `calls` | DS cheap · 0 GT · ~9h incl. DS pacer | The scan is 3-hourly; PRESS was listed at $541K and was $188K fifty minutes later while the tab still showed the listing figure, and 7 of 41 entries had ≤30 min in band. The stream's value rests on its figures being current. The crossover join is 3h of work and is the only feedback loop on whether Sleepers finds anything (so far: 0 sleepers called after listing; the group was *ahead* of the scan both times). Requires the shared DS pacer — this item pays for it. |
| 10 | **Ranging exits + coil width** | Each ranging card: "range 18% · last 1h 6%" with a "tightening" mark when the 1h width is under half the streak width. An EXITS strip at the top of Ranging: "NARCO left 100K–250K ↑ +34% · held 14h", gone after 6h. | finding | `range.ts loadBuckets` (5-min buckets, 49h) + a second `computeInRange` walk ending at the last in-band bucket; `RangeInfo.observedLow/High`; `tokens.mcap_usd` | 0 API · ~12h | The one moment the Ranging thesis resolves is the moment the view goes silent. Empirical: the only band hold followed by a ≥2.5× breakout (LIGMA, 0.9h in $1–3M → 2.8× the band top) and the ones that collapsed (HDFI 1.8h → rug, PRESS 0.8h → −72%) are exactly the exits in both directions. Require the newest 3 buckets outside the band so a wick does not read as an exit; judged against the 4 presets only; "left band ↑", never "breakout". Ranks last because few calls have qualified yet — it grows with uptime. |

**Eleventh, just outside:** DEX PAID / CTO / BOOST fact pills + multi-pool liquidity map (both DexScreener-only, ~10h together, 0 GT). They become cheap the moment #9's DS pacer exists — see §4.

---

## 3. Top-3 specs

### 3.1 Close the alert loop

**Data.**
- `alerts` rows already hold `group_id, token_id, type ('nuke'|'buy_opp'), fired_at, mcap_usd, details{dropPct, peakMcapUsd}`; `alerts_cooldown_idx` covers the per-token lookup.
- `watches.added_at, added_by, token_id`; nearest snapshot at/after `added_at` via `LATERAL (select mcap_usd from snapshots where token_id = w.token_id and at >= w.added_at order by at limit 1)` → `mcapAtWatch`. Snapshots older than 48h are serve-time-downsampled only, so this is exact for every live watch.
- Outcome fields per alert: `mcapNow` from `tokens.mcap_usd`; if the call has `died_at > fired_at`, outcome = "died +Nh (reason)" from the per-call death columns, never a blank.

**Contract (packages/shared/src/api.ts).**
- `WatchlistEntry` gains `mcapAtWatch: number | null`, `watchedAt: string`, `multipleSinceWatch: number | null`.
- `BoardCard` and `WatchlistEntry` gain `lastAlert: { type, firedAt, mcapAtFire, mcapNow, changePct, outcome: 'live' | 'died' } | null` — most recent alert per type, at most one line per type on the card.
- `alertMessage()` (apps/server/src/poller/alertLogic.ts) appends one line: `t.me/overseergroupbot/board?startapp=<slug>_<callId>` (start_param charset `[A-Za-z0-9_-]`, so `_` is the separator; `MINI_APP_URL` must be set — until then fall back to `WEB_APP_URL/g/<slug>?focus=<callId>`). The `/overseer watch` confirmation carries the same link.
- Mini App `telegram.ts` parses `start_param` as `slug[_callId]` (today it is the slug only); web honours `?focus=<callId>`: scroll the card into view, open its half-sheet/expanded state, one pulse of the existing motion system. If the card is on probation (hidden), land on the DIED rail's probation disclosure (#8) or, until that ships, the Died rail with a toast "hidden on probation".

**Rules with numbers.**
- `changePct = (mcapNow / mcapAtFire − 1) × 100`, rounded to whole percent; print both mcaps and the delta, nothing else.
- Watch baseline drawn as a second dotted line on the ON WATCH sparkline only when `watchedAt` falls inside the sparkline's 24h window; otherwise the row prints "watched 3d ago at $57K".
- No aggregate. No "median +4% at 1h", no "55% higher at 6h". Per-alert outcomes only. (The owner declined hit-rates for people; a hit-rate for the BUY OPP rule printed next to the label is a performance claim on advice-adjacent text.) If the owner later wants an aggregate, it hides under N ≥ 20 and never uses "wins".

**Surface.**
- Chat: one extra line on existing alert replies — no new message class, no change to cadence or cooldowns.
- Board: trail line on the card (desktop hero/list, mobile row, half-sheet row) and on every ON WATCH row; watched-at baseline on ON WATCH sparklines; died rail shows the last alert before death.

**Neutral-framing check.** Labels stay the existing type names; the trail is two numbers and a delta. "+38% since the nuke" must never be accompanied by "missed", "recovered", "should have". The watch baseline is a line, not a P&L.

**Failure modes.**
- A token with no snapshot after `added_at` (watched seconds ago) → `mcapAtWatch = null`, row prints the bare mcap as today.
- Deep link into a group the member is not in → existing `getChatMember` gate; `focus` ignored.
- Alert fired for a chat/Sleepers watch with no call (`callId` null) → link carries `_t<tokenId>` and the web focuses the ON WATCH row instead of a card.
- The per-type "most recent" rule hides an older nuke behind a newer one on the same coin — acceptable; the full history is `GET /api/g/:slug/alerts` if the owner ever wants the panel (§4).

### 3.2 Migration 0009: materialise what we already pay for

**Data captured (all already in the responses we fetch).**
- DexScreener pair (`dexscreener.ts toPair`): `volume.{m5,h1,h6}`, `txns.h1.{buys,sells}`, `priceChange.{m5,h1,h6,h24}`, `boosts.active`.
- GeckoTerminal pool (`geckoterminal.ts parsePoolResource`): `volume_usd.h1`, `transactions.h1.{buys,sells,buyers,sellers}`, `price_change_percentage.{m5,h1,h6,h24}`, `launchpad_details.{graduation_percentage, completed}`. GT curve pools sometimes omit the `transactions` block → null, never 0.

**Schema (one migration).**
- `snapshots` +`vol1h_usd double`, `buys1h int`, `sells1h int`, `buyers1h int`, `sellers1h int`, `graduation_pct double` — all nullable.
- `tokens` +latest cache of the six above, +`chg_m5/chg_h1/chg_h6/chg_h24 double`, +`boosts_active int`.
- `calls` +`trough_mcap_since_call double`, `trough_at timestamptz`, `milestones jsonb` (`{"2": iso, "3": iso, "5": iso, "10": iso}`), `first_snapshot_lag_s int`.
- `MarketSnapshot` type gains the flow fields; `applySnapshot` writes them in the same statement that updates the peak: `trough = least(trough, mcap)`, milestones set when `mcap >= k × mcap_at_call` for the first time, per k in {2,3,5,10}. `applyCurvePool` writes `graduation_pct`. One-off backfill of trough/milestones from existing snapshots (±15 min past the 48h thinning — label as such).

**Rules with numbers.**
- `first_snapshot_lag_s = first_snapshot.at − calls.called_at`. Board prints "call price as of +2m" when lag > 60s. Consider (not in this build) the existing late-call OHLCV backfill path in `scheduler.ts` for a minute-candle anchor when lag > 120s on a curve coin.
- Trough and milestone updates stop while `tokens.rug_hidden_at` is set (a collapse is not a dip; a probation revival is not a milestone).
- Retention decision to record with this migration: snapshots older than 48h thinned to 15-min rows on write (currently only downsampled at serve time — no prune exists; round 5 flagged storage at peak volume). Every derived fact the board needs past 48h now lives in `calls`/`alerts` columns, so the prune is safe. The ~77K rows/day estimate assumes 40 tokens at 45s forever; activity tiering drops most to 5 min within hours, so real growth is ~⅓ of that.

**Surface.** None on its own beyond the lag line. #3, #4, #5, #7 read from it.

**Neutral-framing check.** Nothing is rendered here; the rule for consumers is written once: flow is a pair of counts, milestones are timestamps, the trough is a number.

**Failure modes.**
- DS and GT disagree on shape (DS has no unique buyers) → `buyers1h/sellers1h` null on graduated coins; the card says "buys/sells" unless it has buyers. Never mix the two vocabularies on one row.
- Wash trades on sub-$20K coins inflate counts → raw counts + ratio bar, omit under 10 txns/h.
- A token that only ever fell has `peak_at == called_at` (coalesced) — consumers render "never above call", not "peaked at +0m".
- Backfilled milestones on calls older than 48h are ±15 min; flag `milestones._backfilled: true`.

### 3.3 Curve progress bar + graduation timing

**Data.** `tokens.graduation_pct` and the last 1h of `snapshots.graduation_pct` (from #2); `tokens.phase`, `tokens.graduated_at` (stamped on phase flip in `applyCurvePool`; it is "when we noticed", coalesced to now()), `tokens.token_created_at`, `calls.called_at`. Optional exact read for *watched* curve coins only: `readyToGraduate()`, `graduationThreshold()` and `eth_getBalance(curve)` via the shared Alchemy client (verified by eth_call: 2.61 ETH raised of 4.2 ≈ the 74% GT showed) — not in this build; gated on the Alchemy client existing.

**Contract.** `BoardCard` gains `graduationPct: number | null`, `graduationRatePerHour: number | null`, `graduatedAt: string | null`, `graduatedAfterCallMin: number | null` (negative = called after graduation). `BoardResponse.day` gains `graduatedToday`.

**Rules with numbers.**
- Bar shown only when `phase === 'curve'` and `graduationPct !== null`. Null = "unknown", never 0%. A non-PONS launchpad with no percentage hides the bar rather than lying.
- `graduationRatePerHour` = slope over the last 1h of `snapshots.graduation_pct` (min 3 readings). Print "+2.1%/h"; if the bar has not moved 5 points in 3h, print "stalled 3h".
- FINAL STRETCH at ≥ 80%: plain text, same colour as the bar, no animation beyond the existing number tick. The bar is monochrome; a bar near 100% already reads as a nudge, so no colour, no "about to migrate".
- On graduation: badge "graduated by 14:02 · +22m after call" for 24h (the "by" wording because `graduated_at` is when the poller noticed, up to one poll cycle plus budgeter back-off late); sparkline tick at `graduated_at`; if `graduated_at < called_at` print "called 5m after graduation". Day strip counts graduations across the group's calls.
- Pulse PATTERNS (#7) gains "median call-to-graduation 41m" under the same N ≥ 10 gate.

**Surface.** FRESH rail cards (desktop rail, mobile row, half-sheet row). The graduated badge shows wherever the card lands next. No chat message: the proposed "graduated" alert collides with Phanes' migration alert and is dropped.

**Neutral-framing check.** "curve 64%" is a fact PONS shows itself; FINAL STRETCH is Axiom's word for a stage, not a recommendation, and stays text-only. Nothing implies "buy before it graduates".

**Failure modes.**
- GT's percentage lags chain by up to one 45s cycle and by budgeter back-off (15s gaps, 30s cooldowns under 429) — the "by HH:MM" wording and the existing `dataAsOf` cover it.
- `graduation_percentage` semantics are undocumented for non-PONS launchpads on GT's dex list (bankr, clanker, virtuals, hoodit) — treat as null unless the pool's dex is `pons-v2`.
- Graduation on PONS v2 lands in a Uniswap v4 hook pool (hook `0xE5e7…e044`); the migrated-pool revival path already handles `migrated_destination_pool_address`, but confirm DexScreener's best-pair pick includes v4 (labels `['v4']`) before trusting the post-graduation LP number.

---

## 4. Worth it later — and what makes it worth it

| Idea | Cost line when triggered | Trigger |
|------|--------------------------|---------|
| **DEX PAID / CTO / BOOST fact pills** ("DEX PAID · 40m after call", "CTO", "BOOSTED ×3"; boosts are free in the pair object; paid/CTO via DS `/orders/v1/robinhood/{addr}`, ~210–960 DS/day on the 60/min route) | ~5h, 0 GT | The DS pacer exists (ships with #9). Board-only forever — Phanes already announces dex-paid in chat; our value is the call-relative timestamp. Cancelled/refunded orders show nothing. |
| **Multi-pool liquidity map** (DS `/token-pairs/v1/robinhood/{addr}`, ~960 DS/day hourly; ARROW has 12 pools incl. five v4) | ~5h, 0 GT | Same trigger. Display the sum, keep death rules on the best pool until reviewed; v4 hook pools report null liquidity — unknown, not zero. It also explains the round-11 "best pair switched to dust" guard. |
| **Curve-phase chain reads replacing GT** (multicall over PONS curve contracts via Alchemy: raised ETH, threshold, readyToGraduate; price from curve state) | Half-day spike, then ~2 days if viable | Run the spike after 17b batching is measured. If it works, the entire GT bucket is freed for scans and the holder/trending ideas stop being rationed; if not, record the finding. This is the single decision that changes the cost of half the list. |
| **Shared Alchemy client** (one key — owner action — one viem client with reconnect/backfill, one CU meter) | ~6–8h infra, counted once | Any of the three on-chain ideas below is approved. Free tier 30M CU/month; per-feature CU is tiny except delivered-log volume on hot pools. |
| **Creator dossier** ("creator 0x3c2a…7166 · 14 PONS launches / 7d · creator tax 0%"; PONS v2 factory `0x7eD5…EC7e`, `TokenLaunched` with deployer indexed as topics[3] — 1–2 filtered `getLogs` per new call, ~11K CU/day; Blockscout keyed API for non-PONS creators) | ~2 days | Alchemy client exists. Keep it a count — never coloured, never "serial rugger". Factory address is config; a PONS v3 silently drops coverage until updated. Absence of history is not safety. |
| **"Just graduated" chain-wide strip** (WS `eth_subscribe` on the PONS factory/hook for `PoolGraduated` — signature must be taken from the verified ABI, the panel's keccak guesses did not match; DS batch enrichment <100/day) | ~14–18h | Alchemy client exists AND Sleepers has proven itself (a sleeper gets called). Same rules as Sleepers: own tab, never mixed with calls, ≤5 rows, empty is a valid state. This replaces the GT-based "Launched strip" (below), whose cost model was wrong. |
| **Holder count + top-10 %** (Blockscout keyed `/tokens/{addr}/counters`, ~1,000 calls/day of 5,000 free; GT `/tokens/{addr}/info` once at graduation only) | ~10–12h | Two blockers: the panel disagrees on whether Blockscout is reachable (keyed `api.blockscout.com/4663` returned 200; public `robinhoodchain.blockscout.com` is Cloudflare-403'd) — verify from Railway's Singapore egress first; and the free key is an owner action. Drop the daily GT refresh entirely (each `/info` call is a single-token GT grant). Subtract pool/curve/locker/burn contracts or the count is wrong; a wrong number is worse than none. Until then #4's unique buyers/sellers is the free proxy. |
| **Trade tape on watched coins** (GT `/pools/{pool}/trades?trade_volume_in_usd_greater_than=500`, on card-open only, 5-min cache, scan priority) | ~6h | 17b measured and GT 429 count acceptable. Never the background poll (960 GT/day ≈ 30% of demand). WS route only with a hard cap on watched pools — a hot pool at 100 swaps/min is ~86M CU/month, not free. Size, side, wallet, time — no "whale", no "smart money". Any chat alert type needs the owner's anti-fatigue decision first. |
| **GT trending cross-reference pill** ("GT trending · 1h #3", 96 GT/day at 15 min, scan priority) | ~3h | 17b measured AND the curve chain-read spike frees GT. It is the closest thing on this list to the declined "hot" badge — label it as GT's fact, never ours. Modest value: outside GT's top 20 it shows nothing. |
| **Self-watch on own calls** (opt-in `/overseer autowatch on`, own calls occupy a slot for 2h, nuke-only) | ~5h, 0 API | Owner decision on chat volume. Empirical case is strong (0 nuke alerts fired while 10 of 16 tokens printed nuke-shaped drops; the danger window is the first 2h and nobody watches then), but at ~10 calls/day from one member this can post up to ~10 nuke replies/day — a recurring-post pattern the owner declined. Viable only as opt-in, own calls, nuke-only, 3-slot cap unchanged, plus a per-member daily cap the owner sets. |
| **Short-hold Ranging chips for every band** (drop the round-14b `hi ≤ $500K` gate) | ~1h | Owner reverses round 14b. The data disagrees with the decision on a sample of one (LIGMA's 0.9h in $1–3M before 2.8×) — present as evidence, the owner's call. |
| **Mention ticks on the sparkline** ("re-called at $410K (peak) · $120K · $95K", last 8) | ~7h, 0 API | After #8 fixes re-mention semantics and the group has produced a second-member re-mention (there have been none). No names on ticks. |
| **Convergence chip** ("3 members · 14m") | ~6h, 0 API | Same trigger; the data says it has never fired once. Semantics first, chip later. Count only, never names. |
| **Sleepers-to-call crossover chip on cards** | ~3h | Folded into #9's "calls from this list" line; the per-card chip waits for a first crossover. `sleeper_seen` is pruned at 14d — keep rows whose address has a `calls` row. |
| **YOURS filter** (own calls, own slots, alerts on own watches; session userId only) | ~3h, 0 API | Owner confirms it does not cross the "ranks people" line. It shows one member their own numbers and nobody else's — the non-ranking cousin of caller cards. |
| **Full ALERTS panel** (`GET /api/g/:slug/alerts`, last 20 with +15m/+1h/+6h outcomes) | ~4h | #1's per-card trail proves insufficient. Same rules: per-alert outcomes, no aggregate under N < 20, never titled "accuracy". |
| **X launch monitor** | paid twitterapi.io ~$6–10/mo | Owner-gated, unchanged from the shortlist. |
| **Multi-chain** | — | Round 17b's wrong-chain detection already tells the group when a call is on Base; the trigger is the group calling non-HOOD coins often enough that "WRONG CHAIN" rows become a pattern. |

---

## 5. Deliberately not

- **"Launched" strip from GT `/new_pools`.** The cost model was wrong, not just the number: 20 pools/page against ~20K launches/day means one page every 10 min samples the newest ~90 seconds — it cannot enumerate "pools born in the last hour", and covering an hour would be ~5,700 GT/day. Reshaped into the on-chain "just graduated" strip (§4), which is also a naturally curated event stream (tens/hour, not thousands).
- **"Graduated" chat alert.** Phanes already posts migration alerts in this group; a copy breaks the near-silent rule for zero differentiation. Board-only (#3).
- **Aggregate alert hit-rate** ("55% higher at 6h"). A performance claim on advice-adjacent text; the owner declined hit-rates for people and the same logic applies to the rule. Per-alert outcomes only (#1).
- **Dip count in the BUY OPP chat message.** Survivorship framing attached to a buy label in the one place the neutral law is most exposed. Board-only (#5); the chat message stays numbers about the current move.
- **Background GT polling of watched pools for trades** (960 GT/day) and **holder `/info` on a daily refresh**. Both add single-token GT grants to a bucket that already 429s; each grant costs the fresh tier a 2–15s gap.
- **Multiplier / migration / drawdown / dex-paid alerts in chat.** Phanes and Rick already post them here. Milestones (2×/3×/5×/10× as sparkline ticks and "hit 5× 41m after call") live on the board via #2's `milestones` column; the chat stays nuke / buy-opp / LP-drain for watched coins. Owner should know Phanes has a drawdown alert — if the group enables it, our nuke and theirs can land on the same thread; a per-group "nuke off" via the existing `/overseer set` path is the escape hatch.
- **Rug-probability scores, AI verdicts, "safety" badges.** A score is advice with the reasoning hidden; on a locked-LP fair-launch chain the usual inputs (LP burn, renounce) are constants. We show the facts a score would be built from — LP/mcap, flow, graduation, dex-paid, holder proxies — and the chat judges.
- **Filter forests and analytics suites** (Axiom's 14 filters, Phanes DApp heatmaps/PNL cards, DexScreener screener). The chat is the filter; Phanes DApp already offers the filterable version of this group's calls. Every idea above adds a fixed rule or a pill, never a knob. Sleepers' two toggles are the ceiling; if the Sleepers deltas or Ranging exits ever want a third chip, stop.
- **Wallet tracking, smart-money labels, top-trader PnL, copy-trade.** No free labelled-wallet source on HOOD; wallet surveillance inside a private friend group is the privacy chill that damages the trust the product runs on; execution adds custody surface the owner already rejected in favour of the link row. The narrow acceptable slice is a trade's size and side (§4 trade tape), never who.
- **Member leaderboards, points, pay-to-rank feeds.** Declined by the owner (ranks people; the app is collaborative). Rick anonymises its own ladders for the same reason. Boosts appear only as a fact pill with a count, never as an ordering input. The day strip's "best today: HDFI 5×" names a coin, not a caller — keep it that way.
- **$100-at-call, daily digest, caller leaderboards, alert thresholds as UI, "hot" badges.** Previously declined; nothing above re-litigates them. Caller cards (shortlisted, deferred) stay deferred; the YOURS filter (§4) is the self-only cousin that does not rank.

---

## 6. Appendix — what the group's own first day says (empirical pass)

Sample: ~9 hours of production history, 17–18 calls, 16 tracked tokens, 4,782 snapshot rows across 18 tokens at ~60s cadence, 21 mentions, 3 watches, 3 alerts. Small enough that every percentage below will regress; large enough to show which plumbing is missing.

**The dip comes first.**
- 10 of 15 calls with data were *below* call mcap 15 minutes after the call (67%).
- 2 of the 4 runners dipped hard in the first 15 minutes before running: VOXEL −23% → 5.4×, LIGMA −44% → 3.1×.
- 12 of 17 calls halved from call mcap at some point; median call→half = 37 min, 6 of the 12 within 21 min.
- Caveat: may be this group's launch-sniping style rather than the chain. → #5 (trough, first-hour ribbon).

**Runners draw down, then some print new highs, then some still die.**
- All 4 runners (≥2×) drew down ≥40% from their running peak at least once, then bounced off the dip: HDFI 2.70×, PIRANHA 1.68×, VOXEL 3.57×, LIGMA 5.00×.
- 3 of 4 printed a NEW high after that first dip: HDFI 1.39× prior peak, VOXEL 1.97×, LIGMA 2.99×.
- 2 of those 4 finished −96% to −98% (HDFI, PIRANHA). → #5 (dip count, board-only).

**Peaks collapse fast and nobody is watching.**
- Peak → −50% took 4–72 min (median ~16 min); peak → below call mcap took 4–26 min for 4 of 5 runners. The danger window is the first two hours.
- 10 of 16 tracked tokens printed at least one nuke-shaped reading (≥40% drop within 15 min): PIRANHA 69 readings, DUCS 54, HDFI 41, pokepad 38, VOXEL 31, LIGMA 27, LLMMART/PRESS/DOSS 15, Stake 14.
- Nuke alerts fired: **0**. The first watch in the group was added at 23:09Z, 8h after the first call (15:05Z); only 3 watches were ever added across 17 calls, 2 already inactive. → #1, #6; self-watch decision (§4).

**Alerts fire into a void.**
- 3 alerts fired, all buy-opp, 0 nuke; the app keeps no visible record.
- VOXEL buy-opp at $57K → +27% at 15m, +21% at 1h, +118% max within 4h. VOXEL buy-opp at $73K → +40% at 15m, +51% at 1h. LIGMA buy-opp at $4.47M → −7% at 15m, −21% min in the window.
- Two of three were followed by a +20% hour; members only ever saw the chat line. → #1 (outcome trail, per-alert, no aggregate).

**Ranging has barely had time to qualify.**
- No call reached the 6h default minimum; 2 holds reached 3h (WATCH 4.5h in $50–100K, no breakout; SCHIFFY 3.5h in $500K–1M, still in band).
- The only band hold followed by a ≥2.5× breakout: LIGMA 0.9h in $1–3M → $8.3M (2.8× the band top) — a band and duration the round-14b gate cannot display. Other sub-3h holds in big bands went the other way: HDFI 1.8h in $500K–1M → collapse, PRESS 0.8h → −72%. → #10 (exits in both directions); round-14b reversal is the owner's call (§4).

**Sleepers is honest about cadence and stale in figures.**
- PRESS listed at $541K in the $500K–1M band at 23:29Z; $188K fifty minutes later (−65%) while the tab showed the listing figure.
- 7 of 41 entries in the latest scan had 0.0–0.5h in band (MANY, BIAO, RADIO, FORESKIN, CASHBIRD, RIPE, AIAIAI) — the most fragile listings.
- The group was AHEAD of the scan both times a called coin qualified (PIRANHA called 1.0h before listing, PRESS 0.6h before); 0 sleepers were called after listing across 6 scans / 48 addresses. → #9 (live drift, crossover line).

**"Re-called ×N" has never meant a second person.**
- 21 mentions over 18 calls = 3 re-mentions, all by the original caller: SYNDROMICS +1 min, VOXEL +43 min (revival repost), PIRANHA +1 min (posting the chart).
- 0 of 17 calls were mentioned by a second member; members-within-2h = 1 for every call. → #8 (semantics fix now, cheap); convergence chip waits (§4).

**Verified external facts the panel established (for the record).**
- GeckoTerminal free `/tokens/{addr}/info` returns `holders.count` and top-10/11–30/31–50 distribution (ARROW 7,293 holders / 73.2% top-10; CHUMP 4,339 / 13.7%), null on-curve. Single-token endpoint — every call is a GT grant.
- Blockscout keyed base `api.blockscout.com/4663/api/v2` works (free key at dev.blockscout.com, 100K credits/day, ~20/call); the public `robinhoodchain.blockscout.com` instance is Cloudflare-gated (403 with a curl UA, 200 with a browser UA — do not spoof in prod). One panel member only saw the 403; verify the keyed host from Railway before costing anything.
- PONS v2 factory `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`, `TokenLaunched(token, curve, deployer, pairToken, launchConfigId, graduationThreshold)`, topic0 `0x8d4aad49…a89607`, deployer indexed; 797 launches in ~50 min of blocks. v1 factories dead (0 launches in 11h). Curve view fns verified via eth_call. Public RPC 429s after a handful of calls and times out on long `getLogs`; Alchemy free tier is the sanctioned path.
- DexScreener: `/orders/v1/robinhood/{addr}` (profile / CTO orders with status + paymentTimestamp), `/token-pairs/v1/robinhood/{addr}` (all pools with dex labels v2/v3/v4), `/token-profiles/latest/v1`, `/token-boosts/*`, `/ads/latest/v1` — HOOD is roughly half of the latest global profiles/ads. 300/min token routes, 60/min profile/orders routes. `dexscreener.ts` has no pacer.
- GT `/trending_pools?duration=…` (20/page, CHUMP #1 on 1h) and `/new_pools` (a 30s-old pool already listed; ~20K launches/day of noise) both verified; both cost GT grants.
- GT effective throughput is not 20/min: ~5 grants then a 30s cooldown per egress IP (round 16b), so "cheap" for GT means ≤~100 calls/day at scan priority — and the budgeter's back-off makes every extra call cost the fresh tier 2–15s of latency.
