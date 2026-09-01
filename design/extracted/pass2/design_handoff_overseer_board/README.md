# Handoff: Overseer board UI (Degen Neon)

## Overview
Visual redesign of Overseer (formerly Groupie) — the live crypto call-tracking board for a private Telegram trading group. Three surfaces, one system: Telegram Mini App half-sheet, mobile browser board, desktop 1440 terminal board. The mechanics already exist and run in production; this handoff restyles the existing React app in `apps/web/`, it does not add features (except the interaction changes listed under "Behavior changes").

## About the Design Files
`overseer-canvas.dc.html` is a **design reference built in HTML** — a canvas of annotated artboards, not production code. Recreate the designs inside the existing codebase (React + Vite, `apps/web/src/`), reusing its component structure. Round 2 artboards (ids 2a–2g) are the shipped Degen Neon system. **Round 3 (ids 3a–3g, top of the canvas) is Pass 2 — the refinement to implement now**; where a Round 3 artboard covers a screen, it supersedes the Round 2 one (3A→2B, 3E→2A, 3F→2C/2G, 3B→2E desktop, 3D extends 2D). Ignore Round 1 except as context. See "Pass 2" at the bottom of this file.

## Fidelity
**High-fidelity.** Colors, type, spacing, and row anatomy are final; match them exactly. Motion is specified as annotations (see Motion) — implement to spec, not to taste.

## Map to existing code
| Design artboard | Implement in |
|---|---|
| 2a Mini App half-sheet | `App.tsx` (Telegram mode; stop auto-expanding), new Pulse component |
| 2b Desktop 1440 multi-column | `App.tsx`/`Board.tsx` — new desktop layout, sections side by side, no tabs |
| 2c Mobile 390 + 2g tab states | `Board.tsx`, `SectionTabs.tsx`, `TokenCard.tsx` |
| 2d Card anatomy (all states) | `TokenCard.tsx`, `Sparkline.tsx` |
| 2e Ranging | `Ranging.tsx` |
| 2f Brand | wordmark/icon in header; PNGs included for BotFather/profile |

## Design tokens
Backgrounds: page gradient `#0C0616 → #080310`; panel border `#2A1640`; hairline row border `#170B26`; section border `#221238`; input/skeleton fills `#150C26` / `#1A0F2E`.
Text: primary `#F2EAFB`; secondary `#C9B8E0`; dim `#8E7BA8`; dimmer `#6E5C8C`; faint `#4A2E66`.
Accents: magenta `#FF3DBE` (brand, active tab, Pulse); cyan `#23D9FF` (LIVE dot, Reviving state, watchlist dot, ranging hero); badge border `#33204D`; cyan badge border `#1B4A5C`.
P&L ONLY: up `#00FF9C`, down `#FF4D6D`. Never used for anything but the multiple/sparkline/edge direction. Stale amber: `#FFB84D`.
Glows: text-shadow `0 0 10–16px rgba(accent,.5–.7)`; static everywhere except top runner (see Motion).
Type: Space Grotesk (wordmark, hero multiples, section headers), JetBrains Mono (all data), IBM Plex Sans (small secondary labels). Google Fonts.
Numbers: compact always — `$1.2M`, `4.2x`, `14h` (formatters already exist in `apps/web/src/format.ts` — keep them).

## Row anatomy (the density fix: 8–9 rows per phone screen)
52px rows (44px in the half-sheet): left 2px status edge → 20–22px avatar disc (hsl by symbol hash, existing `avatarHue`) → symbol + ONE badge max + caller/status subline → 44×18 sparkline → right-aligned multiple (700, 14–15px, P&L color) over `$now ← $atCall` → age.
- Status edge: green/red = live P&L direction; cyan = reviving; `#33204D` solid = died; dashed = unresolved.
- Badge priority (show only the highest): DIED·reason > REVIVING > REVIVED > ×N. Watched = 5px cyan dot after symbol, never a badge.
- Links (AXIOM/GMGN/DEXS/COPY CA): never rendered by default. Mobile: tap row expands a 34px pill row (one open at a time). Desktop: hover swaps the sparkline for the pills. Removes the old 40px per-card links row.
- Null state: multiple renders as small dim `—` + "indexing…" subline — never a 26px hero.
- Died rows: whole row at ~0.55 opacity, gray badge with reason (`LIQ FLOOR`, `RUG FLOOR`, `NEVER GRADUATED`), "$52K at death" in place of mcap pair, `bin` button (confirm dialog, purges group-wide — existing behavior).
- Stale (>5m, existing `STALE_AFTER_MS`): multiple dims to ~0.6–0.7 opacity, amber "as of 7m ago" in the subline; board-level "data as of Xs ago" chip in the header.

## Call-story sparkline (replaces the anonymous polyline in Sparkline.tsx)
Dotted horizontal baseline at mcap-at-call (the 1x line), the trace relative to it, a dot at the peak (magenta in hero cards, trace-colored in rows), an end dot at now, and drawdown shading (translucent red) between peak and now on retraced cards. Flat ON the baseline = "unchanged"; dead = dimmed line that just ends.

## Screens
### 2a — Telegram Mini App (390×560 half-sheet)
Grabber bar, wordmark + LIVE + close. Pulse hero block (magenta-tinted band): "PULSE · TODAY" + "as of Xs ago"; big row `18 calls` and `HDFI 2.4x best` (green, glowing); subline `3 died · 1 reviving — SABLE +38%` (cyan). "FRESH · 12" label + 6× 44px rows. Bottom bridge: full-width magenta button "Full board ↗" + "opens in your browser · already signed in" (uses the existing handoff endpoint). Dragging the sheet to full height relaxes to the 2c layout.

### 2b — Desktop 1440
Header (wordmark, group title, LIVE, "data as of", window chips 6h–30d, active chip cyan). Full-width Pulse strip. Three columns: Fresh feed (48px rows) | Runners (hero card: big spark with baseline/peak/fill, 26px multiple; secondary runner row) + Retraced (card with drawdown-shaded spark, "−62% from peak $780K") | Reviving spotlight (cyan-bordered card) + Died rail (40px dim rows + probation footnote) + Ranging summary card.

### 2c/2g — Mobile 390
Header + Pulse strip + tab row (FRESH 12 / REVIVING / RUNNERS / RETR / DIED / RNG, active = 2px magenta underline; Reviving's underline and count are cyan). Tab bodies per 2g: Runners sorted by multiple desc, top runner gets a 56px row + glow; Reviving = spotlight cards (badge + "+38% since revival", honest red multiple-from-call, expiry note); Died = dim rows with reasons + bin + "+1 hidden by rug probation" footnote.

### 2e — Ranging
Band preset chips (existing `RANGE_PRESETS`) + CUSTOM (active = filled magenta). Custom inputs: LOW/HIGH fields accept K/M suffixes and plain numbers; a cyan dollar echo (`= $50,000`) sits under each field; invalid band (low ≥ high) turns the echo red. Duration chips `3h 6h 12h 24h 48h` (active = filled cyan). Cards: symbol + caller + `$now`, hero = `14h in band` (cyan, Space Grotesk 18px), band bar = dark track (queried band) + translucent cyan fill (observed held range) + glowing cyan tick (live mcap), endpoint labels `$50K`/`$150K` + `held $77K–$126K`. No live refetch on this tab (existing behavior: control change + focus only).

## Motion (implement exactly; ceremony is rationed)
- Number ticks: digits roll vertically like an odometer, ~120ms/digit, on live updates.
- Row update flash: background tints toward P&L color ~6%, 400ms fade, throttled 1/row/10s.
- New call: row drops in with a magenta glow bloom, 500ms decay.
- Top runner ONLY: glow "breathes" on a 4s cycle while its multiple climbs. All other glows are static.
- Ceremony (only these): death = row desaturates 600ms + badge stamps in; revival = cyan bloom + Pulse strip prints "SABLE is back"; 10x cross = one shimmer sweep + Pulse entry.
- State change on desktop: card lifts, dims, flies to its new section (450ms arc); on mobile just count ticks.
- Mini app: haptic tick on bridge tap (Telegram WebApp API); Pulse counts roll; list rows never animate in the half-sheet.
- Noise budget: ≤3 concurrent animations (1 breathing card + ≤2 transits); queue overflow. `prefers-reduced-motion`: no flashes/blooms/rolls — direction arrows instead, glows frozen.

## Performance / loading
Cached last board paints instantly (localStorage), revalidate behind it; only Pulse numbers shimmer while revalidating. Skeleton = ghost rows (fills `#1A0F2E`/`#150C26`), shimmer once. Keep existing empty-state copy from `Board.tsx` verbatim.

## Behavior changes vs current code
1. Stop auto-expanding the Mini App; own the half-sheet (2a).
2. Desktop ≥~1100px: multi-column layout, no tabs.
3. Links row removed from default card; tap/hover reveal.
4. Ranging: add 3h duration option; custom inputs move from bare-K semantics to suffix parsing + dollar echo (`Ranging.tsx` `parseK`).
5. Badge collapse to one + watchlist dot (`TokenCard.tsx` head-line).
6. Sparkline gains baseline/peak/now/drawdown (`Sparkline.tsx`).

## Brand
Wordmark: lowercase `overseer` in Space Grotesk 700 magenta with glow + cyan period ("the peak dot"). App icon / Telegram profile: magenta ring ("o") on near-black radial, cyan dot riding the lower-right rim — see PNGs. No emojis anywhere in the UI. Neutral framing: never "buy"/advice labels.

## Assets
- `screenshots/3a…3g-*.png` — 2× renders of each Round 3 artboard (reference only; the canvas is the source of truth)
- `overseer-profile-512.png` — Telegram profile photo (512×512 square)
- `overseer-cover-640x360.png` — BotFather /newapp cover
- Fonts via Google Fonts: Space Grotesk 500–700, JetBrains Mono 400–700, IBM Plex Sans 400–600

## Files
- `overseer-canvas.dc.html` — the full annotated design canvas (open in a browser; Round 3 = Pass 2, Round 2 = shipped base)

---

# Pass 2 (Round 3, 2026-09-02) — refinement of the live system

Mandate: `docs/design-brief.md` → "Design pass 2 addendum". Not a rebrand: every token, type family and palette law above stays. Six directives + one license proposal.

## Map to code
| Artboard | Implement in |
|---|---|
| 3A Desktop 1440, opportunity-first | `DesktopBoard.tsx` (new column composition + IN PLAY zones), `Spotlight.tsx` (hero/retraced/reviving), `Pulse.tsx` (outcome strip), `App.tsx` header, `styles.css` |
| 3B Ranging desktop view | `Ranging.tsx` + `App.tsx` (`desk-ranging` gets a view header), `styles.css` |
| 3C Sleepers desktop view | `Sleepers.tsx` (band bar per row, zone headers), `App.tsx` view header |
| 3D Spotlight anatomy + links strip | `Spotlight.tsx`, `LinkPills.tsx` (`.card-links` sizing), `Sparkline.tsx` (hero size, revival marker), new `Gauge` (call→now→peak) |
| 3E Mini App | `MiniBoard.tsx`, `Pulse.tsx` hero variant, `App.tsx` `head-mini` |
| 3F Mobile 390 | `Board.tsx`, `SectionTabs.tsx` (zone chips), new view-headline band per tab |
| 3G License: watch alerts on the board | `motion.ts` (`useBoardChange` announcement), `Pulse.tsx`, ON WATCH zone in `DesktopBoard.tsx` |

## Screens (Pass 2)
### 3A — Desktop 1440 (replaces 2B)
- **Header** (~76px, padding 18px 28px, bottom rule `#221238`): `overseer.` 28px + 1×24px divider `#2A1640` + group name 24px + LIVE chip (10px mono, 7px glowing dot) · right: "data as of Xs ago" 10px + window chips.
- **Pulse strip** (padding 13px 28px, magenta 6% band): PULSE tag · items 13px `#C9B8E0` separated by `#4A2E66` dots · right-aligned day-outcome block: `TODAY'S 18` label 9px + 200×6px segmented bar + legend.
- **Body** (`display:flex; gap:24px; padding:26px 28px 32px; align-items:flex-start`): left column `flex:0 0 350px`, center `flex:1; min-width:0`, right `flex:0 0 330px`; 20px vertical gap between zones in a column.
- **Left — FRESH zone**: header band (neutral) + 48px rows exactly as Round 2 (edge, disc, symbol/subline, 44×16 spark, multiple over `$now ← $call`, age). Hover reveal unchanged (+WEBSITE pill).
- **Center — IN PLAY**: column headline row (22px magenta "IN PLAY" + 10px note "ranked by the data, not by when it was called"; right note "multiple · 1h move · LP · retrace — never advice"), then four zones:
  - RUNNERS (green tone; panel border `rgba(0,255,156,.22)`; body `inset 0 0 60px rgba(0,255,156,.035)`): hero card padding 16px 18px 12px — top row (28px disc, 16px symbol, 10px meta "@caller · age · LP", 1h chip, 34px multiple right) · 72px sparkline · label row (`┈ called $250K (1x line)` · `● peak $1.3M · 5.2x` · `$1.2M now` right) · links strip. Further runners: 48px rows attached below with the 1h chip before the spark.
  - RETRACED (lavender tone): card padding 14px 18px 12px — top row (24px disc, 14px symbol, meta, `−62% from peak` red chip, `LP $140K · 47% of mcap` lavender chip, 24px multiple right) · 56px drawdown sparkline · 6px gauge · label row (`called $153K` · `now $296K · 1.9x` · `● peak $780K · 5.1x`) · links strip (WATCH off).
  - REVIVING (cyan tone + glow; panel border `rgba(35,217,255,.3)`, `0 0 28px rgba(35,217,255,.06)`): top row (disc, symbol, REVIVING badge, meta, right `+38%` 24px cyan + "since revival") · 44px cyan sparkline with hollow revival dot · foot (`$41K now` · `○ revived 3h ago at $30K` · `0.31x from call` red · `spotlight ends in 21h` right) · links strip.
  - ON WATCH (cyan, 7px watch dot before the headline; note "alerts on in the chat · biggest 1h move first"): 48px rows with subline `your slot / @member's slot · LP` and a 1h chip in front of the spark.
- **Right rail**: DIED zone (dim; rows 40px at .7 opacity; footer line "bin purges for the whole group · died rows dim, never red") · RANGING zone (header note = `open view ▸` cyan link; summary line + 36px mini rows: symbol 52px · 6px band bar · hours 12px Space Grotesk cyan; endpoint labels under) · SLEEPERS zone (`open view ▸`; count line; 8px five-segment bar with per-band counts; "refreshed · X only · in band ≥" footnote).

### 3B — Ranging, desktop view
View header (padding 22px 28px 0): `◂ board` 10px cyan → `RANGING` 30px + subline "group calls holding a market-cap band · time in band is the hero" · right: "analytical — refreshes on control change and focus". Controls panel (margin 18px 28px 0; padding 14px 18px; zone panel style): BAND row (84px label + chips + CUSTOM; note about custom inputs = 2E) and HELD FOR ≥ row (30m 1h 3h 6h 12h 24h 48h). Results: 2-column grid (`gap:20px; padding:22px 28px 30px`) of range cards — top row (22px disc, 14px symbol, watch dot / ×N badge, meta "@caller · $now · LP", right hero `14h` 28px Space Grotesk cyan + "in band") · 10px band bar · endpoint/held labels · "in band since … · N five-minute buckets" 9px. Hover/tap: pills replace the meta line.

### 3C — Sleepers, desktop view
View header: `SLEEPERS` 30px + "chain-wide scan · **not group calls** · refreshed 40m ago" · right: "coins with an X account only" + `X only` filled cyan chip. Controls panel: IN BAND ≥ 3h 6h 24h 3d 7d 2w 1m. Bands: 2-column grid of zones (40px header band: `$50K–$100K` 15px cyan + count + note "ranked by turnover…"), 48px rows: 20px disc · symbol + X pill + `in band 16d` (cyan) + `on list 9h` (dim) badges, subline `$mcap · vol $` · 72×6px band bar (tick only) · turnover 14px cyan + `LP $` · pool age. `$1M–$3M` zone only at 2w/1m, header note "long holds only · unlocked at 2w+". Empty band keeps its zone with the existing empty line. Footnote (existing copy) under the grid.

### 3D — Spotlight anatomy: see the artboard; dimensions are in the tokens below. Mobile spotlight = 362px card, 30px multiple, 48px spark, 44px link band.

### 3E — Mini App (replaces 2A)
Header row: wordmark 20px + group name 13px `#C9B8E0` · LIVE · ×. Pulse hero: tag row · 26px numbers row · 6px outcome strip · legend line (`2 runners · 12 active · SABLE reviving +38% · 3 died`). FRESH zone header 36px (`FRESH 12` 14px + `all tabs ▾` cyan). 6×44px rows. Bridge unchanged (36px button).

### 3F — Mobile 390 (replaces 2C/2G)
Header: wordmark 22px · divider · group 16px (ellipsis) · LIVE; second line "data as of" + window chips. Pulse: text line + strip line (5px bar + counts). Tabs: zone chips strip (padding 12px 14px 0, gap 6px, horizontal scroll with right fade). Tab body: 46px tone band (20px headline + count + note, radius 12px 12px 0 0, margin 14px 14px 0) over a bordered panel; spotlight card (as 3D mobile) then 52px rows. Other tabs follow the same band in their tone; RNG/SLPRS put their chips under the band, wrapping to two rows.

## Derived data (no API changes)
- **1h move**: from `card.sparkline` — nearest point ≥ 60 min before the last point vs the last point; `null` (no chip) when the trace doesn't reach back an hour. Formatter: signed integer % (`fmtSignedPct`).
- **LP ÷ mcap**: `liquidityUsd / mcapUsd` as a whole %; chip text `LP $140K · 47% of mcap`; hidden when LP is null.
- **Outcome strip counts** (from `derivePulse` inputs): runners = alive cards with multiple ≥ 3; reviving = `sections.reviving` (24h window); died = `sections.died`; active = today's calls − (runners + reviving + died), floored at 0. Widths ∝ counts; a zero segment is omitted (no 0-width sliver).
- **Gauge position**: `(mcapUsd − mcapAtCall) / (peakMcapSinceCall − mcapAtCall)` clamped 0–1; peak dot at 100%, call ring at 0%.
- **Sleepers band tick**: `(mcapUsd − loUsd) / (hiUsd − loUsd)` clamped.
- **Ranging held fill / tick**: unchanged (`observedLowUsd/HighUsd`, `mcapUsd`) — just drawn at the new sizes.
- **Watch slots**: `your slots n / 3` = count of `watchedByMe` on the board (cap constant already on the server).

## Suggested implementation order
1. Header + zone system + Pulse outcome strip (3A shell) · 2. IN PLAY zones, rank rules, gauge, hero sparks · 3. Links strip restyle on spotlight cards; range/sleeper reveal · 4. Ranging/Sleepers view headers + chips + band bars (3B/3C) · 5. Mobile tabs → zone chips + tone band, half-sheet (3E/3F) · 6. Motion additions · 7. (optional) 3G watch ceremony.

## New tokens / sizes (additions only)
- Zone panel: bg `#0F0819`, border `#221238` (or the tone at 22–30% alpha), radius 12px, gap between zones 20px (desktop), 24px between columns, board padding 26px 28px 32px.
- Zone header band: 44px (40px inside Sleepers bands, 36px in the half-sheet, 46px on mobile tab bodies); bg = tone at 3–5% alpha; bottom rule = tone at 25–30% alpha (`#2A1640` for neutral tones).
- Zone headline: Space Grotesk 700 17px, letter-spacing 1px, tone colour; count JetBrains Mono 600 12px `#8E7BA8`; note 9.5px `#6E5C8C` right-aligned.
- Zone tones: FRESH `#F2EAFB` · RUNNERS `#00FF9C` (+glow 10px/.35) · RETRACED `#C9B8E0` · REVIVING `#23D9FF` (+glow) · ON WATCH `#23D9FF` + 7px watch dot · DIED `#8E7BA8` · RANGING / SLEEPERS `#23D9FF` (no glow).
- Column headline (desktop IN PLAY): Space Grotesk 700 22px magenta with glow. View headline (Ranging/Sleepers full views, desktop): Space Grotesk 700 30px `#F2EAFB`; mobile 20–22px inside the tone band.
- Header: wordmark 28px (desktop) / 22px (mobile) / 20px (half-sheet); group name Space Grotesk 600 24px / 16px / 13px; 1px `#2A1640` divider between them; desktop header padding 18px 28px (~76px tall); window chips 11px, padding 6px 10px.
- Pulse strip (desktop): 13px, padding 13px 28px; PULSE tag Space Grotesk 700 12px, letter-spacing 3px.
- Day-outcome strip: 6px tall (5px mobile), 2px gaps, segments in order runners `#00FF9C` (glow) · active `#6E5C8C` · reviving `#23D9FF` · died `#33204D`; widths proportional to counts; legend 9px.
- Hero multiple 34px Space Grotesk (runner hero), 24px (retraced / reviving delta), 30px mobile spotlight. Hero sparkline 72px (runner), 56px (retraced), 44px (reviving), 48px mobile; stroke 2–2.2; fill 8%.
- 1h-move chip: JetBrains Mono 600 9–9.5px, P&L colour, 1px border in the same colour at 30–35% alpha, radius 3px, padding 2px 5–6px.
- Gauge (retraced): 6px track `#150C26` / border `#221238`; green `rgba(0,255,156,.35)` from call to now; red `rgba(255,77,109,.18)` from now to peak; now-tick 2×12px `#F2EAFB` with glow; peak dot 6px magenta; call ring 6px `#8E7BA8`. Linear dollar scale call→peak.
- Band bars: hero 10px track (Ranging cards), 6px (summary rows, Sleepers rows, 72px wide in the row's spark slot); held fill `rgba(35,217,255,.28)`; live tick 2px cyan with 8–10px glow. Sleepers: tick only.
- Links strip on spotlight cards: pills JetBrains Mono 600 8.5px, padding 3px 7px, radius 4px, border `#1B4A5C`, resting opacity .8; strip = 10px top padding + 1px `#1A0F2E` rule (≈20px cost). Mobile spotlight: 44px band, pills 9.5px padding 7px 9px, horizontal scroll past 6 pills. WATCH pill pinned right: off `#8E7BA8`/`#33204D`; on = cyan text, cyan border, bg `rgba(35,217,255,.12)`, glow.
- Chips (Ranging/Sleepers desktop): 11px, padding 6px 12px, radius 5px; band active = filled magenta, duration active = filled cyan; disabled 30m/1h = `#4A2E66` text, dashed `#33204D` border, tooltip "Only for bands up to $500K".
- Mobile tabs → zone chips: bordered boxes (`#221238`, bg `#0F0819`) with label 9.5px + count; active = tone border at 45% + tone bg at 8% + 12px glow; strip scrolls horizontally.

## Behaviour changes (Pass 2)
1. **Desktop composition** (3A): left FRESH rail (350px, 48px rows) · center IN PLAY column (fluid) with zones RUNNERS → RETRACED → REVIVING → ON WATCH · right rail (330px) DIED → RANGING summary → SLEEPERS summary. Tabs stay off on desktop.
2. **IN PLAY rank rules** (client-side, from the payload): RUNNERS sorted by 1h move desc (Δ over the last hour read off `card.sparkline`); RETRACED by LP ÷ mcap desc; REVIVING by % since revival desc (`revivalDelta`); ON WATCH = every `card.watched`, by |1h move| desc. A coin appears in one zone only: REVIVING > RUNNERS > RETRACED > ON WATCH; the watch dot still marks it wherever it sits. Empty zones collapse to header band + existing empty line — never removed.
3. **Wayfinding**: Ranging and Sleepers desktop views get a 30px headline + subline row above their controls (breadcrumb kept); board window chips go inert at .35 there (existing `wins-inert`). Mobile tab bodies get a 46px tone band with a 20px headline.
4. **Links everywhere**: spotlight cards render `LinkPills` in a persistent strip (already wired in round 15 — restyle to the 20px spec); range cards and sleeper rows reveal pills on hover/tap in place of the meta line; WEBSITE where present; no WATCH on sleepers.
5. **Visualisation**: day-outcome strip in Pulse (hero + strip variants) from `derivePulse` counts (runners = multiple ≥3 alive, reviving, died, active = rest); gauge on retraced cards; hero-size sparklines with baseline label row; band bars on the RANGING summary rows and every Sleepers row (tick = mcap position in band); Sleepers summary shows a per-band count strip.
6. **Ranging chips**: 30m / 1h shown always, disabled when band high > $500K (existing `rangeHoursAllowed`); fallback to 3h unchanged.
7. **License (3G, optional)**: watch-move ceremony — when a watched coin's 1h move crosses the bot's alert threshold (same event the chat gets), Pulse prints `SYMBOL ±NN% in 1h — on watch` in cyan for 6s via the existing announcement slot; its row blooms cyan once and FLIPs to rank 1 in ON WATCH. ON WATCH header shows `your slots n / 3`. Wording law: number + window + "on watch"; never "buy-opp"/"nuke".

## Motion additions (all inside the Round 2 noise budget)
- Rank change inside a zone: FLIP slide 300ms, ≤1 reorder per zone per 10s; reduced-motion instant.
- Outcome strip: segment widths ease 400ms; the segment that grew flashes once at 6% of its own colour.
- Band ticks and the gauge now-tick glide 300ms; never jump. Held fill only widens.
- Links strip: opacity .8 → 1 on card hover (150ms); WATCH toggle 150ms scale-pop; COPIED ✓ 1.4s (existing).
- Mobile tab switch: band tint cross-fade 200ms + 12px content slide; reduced-motion cut.
- Sleepers: no motion at all beyond a 200ms cross-fade on chip change.
- Unchanged: odometer rolls, throttled row flash, new-call bloom, breathing top runner only, 450ms transits, ≤3 concurrent, all ceremonies.
