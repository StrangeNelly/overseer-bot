# Prompt for the Claude Design session (copy-paste below the line)

---

Read `docs/design-brief.md` in this repo first — it is the authoritative brief and this prompt defers to it. You are designing **Groupie**, a live crypto call-tracking board for private Telegram trading groups. The current app is running (unstyled structure) at https://groupie-production-3bbd.up.railway.app — the mechanics are real; your job is the face.

Build a design canvas in this order:

**Round 1 — three identity directions.** Three compact artboards (one hero board screen each, desktop or mini — your call on which sells a direction best): (1) Clean Terminal, (2) Degen Neon, (3) a hybrid with terminal bones and one expressive signature element. Same real data on all three (use the brief's cheat-sheet numbers — HDFI 2.4x is the hero runner). Label them clearly; I'll pick one on the canvas.

**Round 2 — full screen set in the chosen direction** (do all of these as separate artboards):
1. Compact Telegram Mini App: Pulse strip + fresh list, half-sheet (~390×560), with the "Full board ↗" bridge
2. Full board, desktop 1440 — dense multi-column terminal layout
3. Full board, mobile browser 390 — single column
4. Token card anatomy sheet — every state in the brief (fresh / runner / retraced / died+reason / REVIVING / watched / re-called ×N / unresolved), including the call-story sparkline spec (dotted mcap-at-call baseline, peak dot, drawdown shade)
5. Ranging tab with band + duration controls (fix the K-input footgun)
6. Wordmark, app icon, and a 640×360 cover image

Ground rules from the owner, non-negotiable: dark-first; visual and tactile — annotate intended motion (number ticks, direction flashes, state-change transitions, what gets ceremony) directly on the artboards since motion is part of the design, with a stated noise budget; the multiple-since-call is the hero number everywhere; green/red carry P&L meaning only; neutral data framing (never "buy" labels); no emojis in the UI; compact number formatting ($1.2M, 4.2x, 14h); design loading/empty/stale states, not just the happy path; 8-9 scannable rows per phone screen in list views.

Solve the brief's "known rough edges" list explicitly — density, badge collisions, the links row, null-state hero, sparkline anonymity — and show the solutions in the card anatomy sheet.
