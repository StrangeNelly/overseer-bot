# Handoff: Overseer board UI (Degen Neon)

## Overview
Visual redesign of Overseer (formerly Groupie) — the live crypto call-tracking board for a private Telegram trading group. Three surfaces, one system: Telegram Mini App half-sheet, mobile browser board, desktop 1440 terminal board. The mechanics already exist and run in production; this handoff restyles the existing React app in `apps/web/`, it does not add features (except the interaction changes listed under "Behavior changes").

## About the Design Files
`overseer-canvas.dc.html` is a **design reference built in HTML** — a canvas of annotated artboards, not production code. Recreate the designs inside the existing codebase (React + Vite, `apps/web/src/`), reusing its component structure. Round 2 artboards (ids 2a–2g) are the chosen direction ("Degen Neon", picked from Round 1 option 1B). Ignore Round 1 except as context.

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
- `overseer-profile-512.png` — Telegram profile photo (512×512 square)
- `overseer-cover-640x360.png` — BotFather /newapp cover
- Fonts via Google Fonts: Space Grotesk 500–700, JetBrains Mono 400–700, IBM Plex Sans 400–600

## Files
- `overseer-canvas.dc.html` — the full annotated design canvas (open in a browser; Round 2 = final)
