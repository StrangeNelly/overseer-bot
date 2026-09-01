# Groupie design brief v2 (for the Claude Design pass)

*Owner direction, 2026-09-02 (supersedes v1). Companion prompt: `docs/design-prompt.md`. The product is LIVE with the owner's real trading group on it — this pass designs what real users see tomorrow.*

## What Groupie is (one paragraph)

A private crypto Telegram group posts token contract addresses ("calls") all day. Groupie's bot silently ingests them, tracks every called coin's market data continuously, and gives the group a board: what was called, what's running, what retraced, what's quietly ranging, what died, what's coming back from the dead. Its numbers are call-relative (multiple since call, peak since call, time-in-range) — data no generic screener has. Live at `https://groupie-production-3bbd.up.railway.app` (current UI is deliberately unstyled structure).

## Two surfaces, one app (owner decision)

**Same product, two presentations — never a feature fork.**

### 1. Telegram Mini App — compact "pulse" mode
- Opens by default in Telegram's **small half-sheet window** (~390px wide, roughly 500-600px visible). We will STOP auto-expanding; the design owns the compact state.
- **Leads with the Pulse**: a dense story strip — today's call count, best runner (e.g. "HDFI 2.4x"), died count, anything Reviving — followed by a tight fresh-calls list. A member should absorb the day in two seconds without scrolling.
- Everything else (tabs, ranging controls, watchlist) still reachable — compact-first, not cut-down.
- A prominent **"Full board ↗"** affordance opens the browser version *already signed in* (one-time handoff link; backend being built now). This is the bridge to the big-screen experience — make it feel like a natural graduation, not an exit.
- If the user drags the sheet to full height (Telegram native gesture), the layout may relax toward the mobile-browser presentation.

### 2. Full web app — the real deal
- **Desktop (~1440px): dense multi-column trading-terminal energy.** Sections side by side (e.g. Fresh feed | Runners+Retraced | Reviving+Died rail), more data per screen, built to live in a tab next to Axiom. This is the "web component really good" mandate.
- **Mobile browser (390px): single column**, richer than the compact pulse (full cards, all tabs).

## Identity: EXPLORE 2-3 DIRECTIONS (owner decision)

Present side-by-side on the canvas, then build out the full screen set in whichever reads strongest (owner picks on the canvas):
1. **Clean terminal** — restrained pro-tool dark: near-black, one disciplined accent, green/red reserved strictly for P&L meaning, personality carried by motion and typography.
2. **Degen neon** — crypto-native: neon accents, glow, louder energy. Risk: fatigue; keep data legible.
3. **A hybrid** — terminal bones, one expressive signature element (e.g. the Pulse strip or the multiple as glowing hero).

Also wanted: a **"Groupie" wordmark**, an app icon, and a 640×360 BotFather cover image in the chosen direction.

## The feel (owner's philosophy, verbatim intent)

- **Visual and tactile — a way of *feeling* the market, not reading a spreadsheet.** Animations, pops, and moving parts are GOOD where they serve human use: rolling number ticks on live updates, direction-tinted flashes (throttled), cards that physically move when their state changes, ceremony reserved for real events (a death, a revival, a runner crossing 10x). Haptics in Telegram where it makes sense (thumb actions).
- A **noise budget**: motion earns its place; the board must stay calm enough to read. Respect `prefers-reduced-motion`.
- **The multiple since call is the hero number** everywhere. Its story: called → peaked → now.

## Performance IS design

The board must *appear* instantly: skeleton/cached-last-board first paint, revalidate behind it. Design the loading, empty, and stale states explicitly (a "data as of Xm ago" treatment exists in the contract — `dataAsOf`).

## Screens to design (the canvas deliverable list)

1. **Compact Mini App** — Pulse + fresh list (half-sheet)
2. **Full board, desktop 1440** — dense multi-column
3. **Full board, mobile browser 390** — single column
4. **Token card anatomy** — every state: fresh, runner (≥3x), retraced (−40% from peak), died (with reason), REVIVING spotlight, watched (on alert watchlist), re-called ×N, revived, no-data/unresolved. Include the **call-story sparkline**: dotted baseline at mcap-at-call, peak dot, drawdown shading — the called→peaked→now story drawn, not implied.
5. **Ranging tab** — band presets + custom lo/hi (K-inputs today are a flagged footgun), duration chips, time-in-range as that tab's hero.
6. **Reviving treatment** — the comeback spotlight (section sits right after Fresh).
7. **Wordmark / icon / BotFather 640×360.**

## Data cheat sheet (design with REAL numbers)

Sections: Fresh (all active, newest activity first) · Runners (≥3x multiple) · Retraced (peaked ≥3x, now ≥40% below peak — neutral data, never "buy" labels) · Ranging (held a mcap band N hours) · Died (with reason: liquidity_floor, rug_floor, never_graduated) · Reviving (survived rug probation: back over $30K for 3h+).
Real examples from production to use in mockups: HDFI called $256K → $609K (2.4x, ~1h, LP ~$80K); WATCH called $134K → $88K (0.66x); pokepad called $60K → $5.6K (0.09x, hidden by rug probation); MICA died liquidity_floor at $52K; a Reviving example: "$41K, revived 3h ago, +38% since". Callers: @denzelbeckons, @pwnzssg. Numbers compact ($1.2M, 4.2x, 14h). **No emojis in the UI.**

## Known rough edges the design must solve

- Density: ~2.5 cards/screen today → target 8-9 scannable rows (status via colored edge, links behind tap-to-expand).
- Null-state hero number reads like a glitch at 26px.
- Badge row (×N, REVIVED, DIED reason, watched) fights the symbol and wraps.
- Links row (AXIOM/GMGN/DEXS) costs 40px per card for rare taps.
- Ranging custom inputs: typing 150000 means $150M (K-suffix is the only guard).
- Sparkline is anonymous: no baseline/peak, flat lines read as dead.

## Non-negotiables

Simple — the chat curates, the board displays; no filter forests. Neutral framing — retrace/range data yes, advice never. Dark-first. One system: compact, mobile, desktop must be recognizably the same product.

---

# Design pass 2 addendum (2026-09-02, owner feedback from live use)

The Degen Neon system is live and working. This pass refines, it does not rebrand. Owner verbatim: *"i want things to pop a bit more, and for different segments to be clearly separated … even the title at the top (overseer) and our group name i feel is a bit small. i like some of it, but it feels like things are a little cramped too."* Six directives:

1. **Wayfinding.** The app never says where you are. The active view needs a clear headline — RANGING, SLEEPERS, the board sections on desktop — visible at a glance, in the existing type system (Space Grotesk display). The "« board" breadcrumb is not enough. Mobile tabs partially cover this; desktop full-views (ranging/sleepers) and any pushed view need explicit titles.
2. **Segment separation.** Distinct from wayfinding: even with headlines, the sections currently run together. Each segment (Fresh, Runners, Retraced, Reviving, Died, and the tabs) should read as its own clearly bounded zone — a member's eye should land in the right region before reading a single word. Whatever mechanism earns it (spacing rhythm, boundary treatments, per-section accent logic, background shifts), the seams between segments must be unmistakable at a glance.
3. **More visualisation, more pop.** Owner (pass 1): "looks like a terminal now, which is fine, but I want more visualisation." Owner (pass 2): "i want things to pop a bit more." The data should be SHOWN, not only listed — band bars everywhere ranges appear, mcap-position dots, section-level micro-charts (the day's call outcomes as a strip), bigger sparklines on spotlight cards, a visual died/alive ratio in Pulse. Pop means stronger hierarchy and visual energy where the data deserves it — NOT more noise everywhere; the noise budget and reduced-motion laws still hold. Stay inside the palette laws (green/red = P&L only; cyan = analysis; magenta = brand).
4. **The center stage is the opportunity surface.** The middle zone of the desktop board is what a returning member checks first, and the owner is explicit about the mental model: *"they are mainly looking for opportunities, not knowing what they've missed."* Design the center column as an at-a-glance opportunity read — what is moving NOW, what retraced with liquidity intact, what is reviving, what's on watch — rather than a chronological catch-up feed. The neutral-framing law is untouched: surface the data that constitutes opportunity (multiple, retrace %, LP, volume, time-in-range), never advice labels like "buy". Fresh-call history stays reachable; it just isn't the hero.
5. **Hierarchy and air.** The overseer wordmark and the group name are too small — they should anchor the page with real presence. And the layout is cramped: give the board breathing room without sacrificing the 8-9-rows density target. Density and cramped are different failures — dense rows are wanted; elements crowding each other is not.
6. **Link affordance audit.** Every card variant must offer the trade/research links — list rows have tap/hover pills, but desktop spotlight/hero cards (Retraced, Reviving, top Runner) shipped with none. (The functional fix ships in code before this pass; the design pass owns making the affordance consistent and discoverable everywhere, including the new website link.)

**Designer's license.** Beyond the directives, the owner invites proposals: anything the design believes serves the product's twin goals — *tracking and finding good coins, and being alerted to opportunities on coins we're tracking* — may be proposed as additional artboards or annotations. Constraints stand: read-only board (the chat curates, Telegram commands mutate), no filter forests, neutral framing, one recognizable system across compact/mobile/desktop.
