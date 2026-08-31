# Groupie — project notes for Claude

## What this is

"Groupie" (working title) is a web dashboard companion for a private crypto-trading Telegram group. The group posts token contract addresses ("calls") and pre-launch X accounts all day; in-group bots (Rick, Phanes) already track call market caps and multiples inside Telegram. Groupie lives OUTSIDE Telegram: a board members check to catch up on what was called, what's pumping, what died, and what's about to launch.

## Product principles (from the owner)

- Simple. No heavy filtering UI — the group chat IS the filter/curation layer.
- Read-only dashboard; interaction happens via Telegram commands (e.g. `/groupie addlaunchmonitor @project51`).
- Time windows: 6/12/24 hours, 3 days, week, month.
- Each token card: main coin details + deep links to trading apps (Axiom and similar).
- "Died after call" section; group chooses to keep in memory or remove.
- "Retraced" board: coins that pumped hard after the call (banger, e.g. 3x+) and have pulled back well off their peak but are NOT dying (liquidity intact, volume flowing). Same machinery as died-detection, different thresholds. Present as neutral data (retrace %, LP, volume) — never "buy opportunity" labels.
- The bot stays near-silent in Telegram: no recurring digest/summary posts (Rick/Phanes already do summaries; the chat is noisy enough). At most: reply to /groupie with the board link + a pinned message. The app is the calm, visual surface; the chat is the input.
- Track peak-since-call ourselves by polling from the moment a CA is posted — call-relative data (call MC, ATH-since-call, retrace %) is Groupie's moat and avoids paying for historical OHLCV APIs.
- v1 targets Robinhood Chain (#HOOD, EVM addresses) only. Multi-chain later.
- Built for one group first; designed so any group can add it later (multi-group SaaS potential).
- Visual polish comes after structure ("Claude design will eventually need to have a look at it").

## Where things live

- `docs/` — research reports, decisions, and planning documents. Read these before making architecture choices; they are the project's memory.

## Status log

- 2026-09-01: Project started. API/architecture research workflow run; results to be saved under `docs/`. Stack not yet chosen — do not assume one until docs/decisions say so.
