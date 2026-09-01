# Groupie design brief (for the design pass)

*Owner's direction, 2026-09-02. This brief is the input for the dedicated design pass ("Claude design"). Read decisions.md and try the live app before designing.*

## The feel

- **Visual and tactile.** This is a way of *feeling* the market at a glance, not reading a spreadsheet. The board should reward the twice-a-day check-in in the first second: what ran, what died, what's coiling.
- **Motion is welcome when it serves use.** Animations, pops, moving parts — number ticks on live price updates, cards sliding when sections change, a pulse when something crosses a threshold. Restraint where motion would slow comprehension; drama where it aids it. Respect `prefers-reduced-motion`.
- **The multiple is the hero.** Everything else supports the x-since-call number and the story around it (called → peaked → now).

## Both surfaces, equally

- **Telegram Mini App** (phone-first, ~390px, inside the webview) AND **browser webapp** (desktop tab next to Axiom). Same app, both must feel native to their context. Browser login (Telegram OIDC) is on the roadmap — design the logged-out browser state assuming it exists.

## Performance IS design

The Mini App currently loads too slowly. Perceived speed is in scope:
- Instant skeleton/last-known-board paint (cache last board response locally, revalidate behind it).
- Collapse sequential auth/board round-trips where possible.
- (Infra, done separately: server region moved close to the user/DB.)

## Known rough edges to fix (from build/review flags)

- Card density: ~2.5 cards per phone screen is too few for scanning; Runners/Died want a tighter variant.
- Null-state headline: the em-dash at hero size reads like a glitch; needs a real "no data yet" treatment.
- Sparkline doesn't tell the retrace story (no baseline/peak marker; flat lines centered but anonymous).
- Badge row (×N, REVIVED, DIED reason) competes with the symbol and wraps.
- Trading-links row eats 40px per card for three rarely-tapped buttons.
- Custom range inputs (in K) are a footgun — typing 150000 means $150M.
- Ranging cards need their own identity (band + time-in-range are the hero there, not the multiple).
- Alert/watchlist affordances (once alerts ship): watched coins should be visibly "followed" on the board.

## Non-negotiables (product principles)

- Simple. The chat curates; the board displays. No filter forests.
- Neutral data framing — never "buy this" labels (retrace/range data yes, advice no).
- No emojis in the web UI. Dark-first. Numbers formatted compact ($1.2M, 4.2x, 14h).
