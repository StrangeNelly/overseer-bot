# Prompt for Claude Design — pass 2 (copy-paste below the line)

---

This is a REFINEMENT pass on an existing, live design — not a rebrand. Read two things in this repo before designing: `docs/design-brief.md` — especially the final section, **"Design pass 2 addendum"**, which is the entire mandate for this pass (six directives plus a designer's license) — and the original handoff you (or a prior session) produced in `design/extracted/design_handoff_overseer_board/` (README.md + overseer-canvas.dc.html). The Degen Neon system from that handoff is implemented and live at https://groupie-production-3bbd.up.railway.app with a real trading group using it daily. Keep every token, type choice, and palette law exactly as shipped: green/red are P&L only, cyan is analysis, magenta is brand, no emojis, compact numbers.

The owner's pass-2 feedback in one breath: things should **pop more**, segments need **clear separation**, the **wordmark and group name are too small**, the layout feels **cramped**, and the desktop board's **center stage must read as the opportunity surface** — a returning member is looking for opportunities right now, not a chronology of what they missed. The addendum unpacks each of these; treat its owner-verbatim quotes as the acceptance test.

Deliver updated artboards for the six directives:

**1. Wayfinding.** View headlines for RANGING and SLEEPERS (desktop full-views especially — the "« board" breadcrumb is not enough), and whatever makes the desktop board's section identity readable from across the room. Space Grotesk display; family of the wordmark, not a new element.

**2. Segment separation.** Every section (Fresh, Runners, Retraced, Reviving, Died, tabs) must read as its own bounded zone before a single word is read. Choose the mechanism — spacing rhythm, boundary treatments, per-section accent logic, background shifts — and apply it consistently across desktop, mobile, and compact.

**3. Visualisation + pop.** Show the data, don't only list it. Candidates (compose the ones that earn their pixels, all within the noise budget and reduced-motion):
- Band bars wherever a range exists (Ranging rows, Sleepers rows — dark track, cyan held-range fill, glowing live tick)
- An mcap-position indicator on cards (where the coin sits inside its band / between call and peak)
- A day-outcome strip in or near Pulse (calls → runners/died/flat as a visual ratio)
- Bigger, richer call-story sparklines on the desktop spotlight cards (baseline, peak dot, drawdown shade at hero size)
- Anything else that turns a number the group reads into a shape they feel — propose freely within the palette laws

**4. Opportunity-first center stage (desktop).** Redesign the middle zone of the 1440 board as the at-a-glance opportunity read: what's moving now, what retraced with liquidity intact, what's reviving, what's on watch — ranked by "worth a look right now", not by recency. Neutral framing is law: the data that constitutes opportunity (multiple, retrace %, LP, volume, time-in-range), never advice labels. Fresh-call history stays reachable, just not as the hero.

**5. Hierarchy and air.** The overseer wordmark + group name become real anchors (they are currently timid). De-cramp the layout without giving up the 8-9-scannable-rows density target — crowded elements are the failure, dense rows are the point.

**6. Link affordance audit.** Every card variant offers the trade/research links: list rows have tap/hover pills (AXIOM / GMGN / DEXS / COPY CA / X — plus a WEBSITE pill now exists for coins that have one). Desktop spotlight/hero cards shipped with none — design where links live on spotlight cards, consistent and discoverable across all variants, without resurrecting the old 40px-per-card link row.

**Designer's license:** the owner explicitly invites anything else you believe serves the twin goals — tracking and finding good coins, and being alerted to opportunities on tracked coins — as extra artboards or annotations. Constraints: read-only board (the chat curates; Telegram commands mutate), no filter forests, neutral framing, one recognizable system across all three surfaces.

Artboards to produce: updated **desktop 1440** (opportunity-first center stage + wayfinding + separation + hierarchy fixes in place), updated **Ranging view** and **Sleepers view** (headlines + duration chips incl. 30m/1h short holds on small bands, and Sleepers' time-in-band durations 3h–1m + the $1M–$3M band at long durations), an updated **spotlight card anatomy** sheet (with links), an updated **compact Mini App** and **mobile 390** where these changes touch them, and any license artboards you propose. Annotate motion the way the original handoff did. Real data from the brief's cheat sheet.
