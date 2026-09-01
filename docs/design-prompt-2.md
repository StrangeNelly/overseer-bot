# Prompt for Claude Design — pass 2 (copy-paste below the line)

---

This is a REFINEMENT pass on an existing, live design — not a rebrand. Read two things in this repo before designing: `docs/design-brief.md` — especially the final section, **"Design pass 2 addendum"**, which is the entire mandate for this pass — and the original handoff you (or a prior session) produced in `design/extracted/design_handoff_overseer_board/` (README.md + overseer-canvas.dc.html). The Degen Neon system from that handoff is implemented and live at https://groupie-production-3bbd.up.railway.app with a real trading group using it daily. Keep every token, type choice, and palette law exactly as shipped: green/red are P&L only, cyan is analysis, magenta is brand, no emojis, compact numbers.

Deliver updated artboards for exactly these three problems:

**1. Wayfinding.** The app never announces where you are. Design the "you are here" system: view headlines for RANGING and SLEEPERS (desktop full-views especially — the "« board" breadcrumb is not enough), and whatever treatment makes the desktop multi-column board's section identity readable at a glance from across the room. Space Grotesk display type; it should feel like the wordmark's family, not a new element.

**2. More visualisation.** Owner verbatim: "looks like a terminal now, which is fine, but I want more visualisation." Show the data, don't only list it. Candidates to design (choose and compose the ones that earn their pixels — every one must respect the noise budget and reduced-motion):
- Band bars wherever a range exists (Ranging rows have one; Sleepers rows and any band context should too — dark track, cyan held-range fill, glowing live tick)
- An mcap-position indicator on cards (where is this coin inside its band / between call and peak)
- A day-outcome strip in or near Pulse (calls → runners/died/flat as a visual ratio, not just numbers)
- Bigger, richer call-story sparklines on the desktop spotlight cards (baseline, peak dot, drawdown shade at hero size)
- Anything else that turns a number the group reads into a shape they feel — propose freely within the palette laws

**3. Link affordance audit.** Every card variant must offer the trade/research links: list rows have tap/hover pills (AXIOM / GMGN / DEXS / COPY CA / X — plus a WEBSITE pill now exists for coins that have one). The desktop spotlight/hero cards (Retraced, Reviving, top Runner) shipped with none — design where links live on spotlight cards, and make the affordance consistent and discoverable across all variants without resurrecting the old 40px-per-card link row.

Artboards to produce: updated **desktop 1440** (with wayfinding + spotlight links + any visualization upgrades in place), updated **Ranging view** and **Sleepers view** (with headlines + duration chips incl. the new 30m/1h short holds on small bands, and Sleepers' new time-in-band durations 3h–1m + the $1M–$3M band at long durations), an updated **spotlight card anatomy** sheet, and an updated **mobile 390** only where these changes touch it. Annotate motion the way the original handoff did. Real data from the brief's cheat sheet.
