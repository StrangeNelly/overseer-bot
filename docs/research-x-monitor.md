# X launch monitor — research memo (2026-09-03, round 23)

Ask (a member, relayed by the owner): "a section for non listed projects, and a tracker that sends
a message if their accounts post a contract." Three Opus researchers (providers, detection, repo)
plus a synthesis; every claim below is cited in the workflow transcript and was verified against a
live response or a vendor document on 2026-09-02/03 unless marked UNVERIFIED.

## 1. Verdict

Build it, board-first, ping second. The chain measurement changes the design: the trigger is the
tracked account's OWN post carrying an address that resolves on Robinhood Chain — never the chain's
guess about which token belongs to which account.

## 2. What the chain actually does (measured)

- In one 8m34s window (blocks 52886091–52891061) the PONS v2 factory emitted **189 TokenLaunched
  events (~22/min)**. 166 declared an X link on-chain; **101 of those point at someone else's
  tweet** — snipers launching coins off a tweet a median **19 s** after it posted (p25 5 s, p75
  63 s). Zero of the 99 measurable source tweets contained a contract address. One @RobinhoodApp
  tweet spawned 14 tokens in 13 s.
- "A token cites @handle" is worthless as a trigger: six handles had 2–3 different tokens claiming
  them in 8.5 minutes, and the owner's own example already has a **$31K impostor LEGS token**
  on-chain carrying legs.fun + @legsdotfun as its socials while the real account has posted no CA.
- Free, definitive primitive: PONS v2 tokens carry creator-declared socials IMMUTABLY on-chain
  (`socials()` selector 0x53cd512a; `getTokenInfo()`), and `PonsV2LaunchFactory.getLaunchedToken
  (address)` (0x3cf28b5a) returns deployer + exists. overseer already sees every launch seconds
  after it happens (the discovery listener).
- Hijack case, stated not judged: the @vladtenev takeover (2026-07-23, ~650 ETH) — the token was
  created 46 min BEFORE the post; every "own post + resolves" rule would ping. Mitigation: print
  token age and launch-block bundle share; hold the ping to board-only when the token predates the
  post by more than 10 min.

## 3. Providers

Correction to docs/research-x-monitoring.md: a twitterapi.io filter rule's `value` is capped at
**255 characters** (API reference), i.e. ~12–14 `from:` handles per rule, not ~100. Cost steps
with rule count. Empty checks ARE billed ($0.00012/call; $0.00015 per tweet returned).

| Accounts | Rules | twitterapi.io @60s | @120s | SocialData search @60s | X recent-search @60s |
|---|---|---|---|---|---|
| 20 | 2 | $11/mo | $6/mo | $10/mo | $9–30/mo (per post returned) |
| 50 | 4–5 | $23–28/mo | $15/mo | $12–21/mo | $22–75/mo |

- Primary: **twitterapi.io filter rules in POLL mode** (their webhook echoes our API key to the
  configured URL, adds unauthenticated ingress, documents no retry). Self-polling their
  advanced_search (512-char query ≈ 25 handles in one call) is cheaper still ($6.5/mo at 60s) but
  the docs page 404'd — UNVERIFIED query-length cap.
- Fallback: **SocialData search monitor** — the only vendor that explicitly documents replies and
  quotes ("typically within 30 seconds", each tweet delivered once, no backfill).
- Escape hatch: **official X API recent search on pay-per-use** ($0.005 per post returned, 450
  req/15 min app-only, 512-char query ≈ 25 handles). ToS-compliant, survives a scraper shutdown
  (X killed Nitter Aug 2026; xcancel 2026-08-24). Filtered stream access on pay-per-use is
  DISPUTED (docs say yes, several 2026 write-ups say Pro/Enterprise only) — do not plan on it.
- Disqualified: Apify (50-tweet minimum per run ≈ $864/mo at 60s), Sorsa (quota plans, no push),
  crypto-native tiers (TweetStream $199/mo, 1322 $250/mo) unless the group wants image OCR and
  pinned-tweet events — the only ones that ship them.
- Latency post → ping: rule interval (mean 30 s at 60 s) + our 30 s result poll + one batched RPC
  confirm (5–15 s) + send ≈ **60–150 s p50, ~3 min p90**. Snipers act in 19 s; we are the
  CONFIRMED CA with a links row, and the copy must say so.
- UNVERIFIED, load-bearing: whether twitterapi.io `from:` rules deliver REPLIES (a CA dropped as a
  self-reply is the common pattern). A $1 pilot on one chatty handle settles it.

## 4. Detection rules

**Tier A — the only thing that pings.** All of: (1) the tracked account AUTHORED the post (no
RT, no QT of someone else, no other author's reply); (2) an address appears in its own text or in
a URL it carries (strip `ethereum:` / `base:` / `eip155:` prefixes; launchpad/chart URL patterns:
ponsfamily.com/launchpad/0x…, app.long.xyz/tokens/0x…, launch.o1.exchange/token/0x…?chain=4663,
dexscreener.com/robinhood/0x…); (3) passes the EVM address check (EIP-55 on mixed case, the
shared extractor); (4) CONFIRMS on Robinhood Chain in one batched RPC — `eth_getCode` non-empty,
`symbol()`/`decimals()` answer, not a known quote/router/factory (chain/addresses.ts); (5) the
token's first pool is under 24 h old. Resolution failure ⇒ no message, board row only.

**Tier B — board only, never chat.** A new PONS launch whose on-chain `socials()` twitter field
cites a tracked handle: "claims @handle · not posted by the account". Escalates to Tier A if the
account later posts the address.

**Never ping on:** the account merely tweeting, bio/pin/name changes, CA in an image (blind
spot — say so), a token citing the handle.

**Dedupe:** (handle, address) partial unique index on `alerts`; provider redelivery by
`last_tweet_id`; a member pasting the same CA first wins (calls unique per group+token). The
monitor flips to `launched` and leaves the rule on fire — one message per monitor, ever.

## 5. Product shape

- Commands: `/overseer track @handle [note]`, `untrack @handle`, `tracking`. Caps 12 per group
  (one rule) and 3 per member at launch (advisory lock as in watchlist.ts); auto-expire at 60 days
  without a post.
- UPCOMING zone: own mobile tab, desktop right-rail summary card, polled 120 s, no SSE (the
  discovery precedent). Row: handle + display name, avatar, followers WITH delta since added
  (@legsdotfun moved 1,882 → 1,890 in 8 min — the curve is the number), bio verbatim, account
  age, adder + added_at, "quiet 14h", status chip, Tier-B candidates nested beneath. Dormant line
  without a key; `lastCheckAt` + stall threshold; store `x_user_id` at add time and show
  `renamed` / `suspended` explicitly (a silently broken monitor is worse than none).
- Ping (plain text, reply to the message that added the monitor, unknown clauses dropped):
  `@legsdotfun posted a contract address.` / `LEGS · 0xb279…60cc` / `mcap $31K · LP $31K ·
  launched 4m ago · PONS · launch block 18% · 2 wallets` / tweet permalink / axiom · gmgn ·
  dexscreener.
- **Auto-ingest as a call: no.** Ping + AUTO-WATCH the token (existing addWatch, adder as
  added_by; slots full ⇒ ping anyway). A synthetic call needs a schema change (calls.message_id
  NOT NULL), fabricates caller credit, and would make a hijack ping a permanent call row. The
  token row exists from the ping, so peak tracking starts immediately; a human pasting the CA
  converts it to a real call with nothing lost.

## 6. Build map

- Migration 0015: extend `launch_monitors` (x_user_id, display_name, avatar_url, bio, followers,
  followers_at_add, account_created_at, note, added_message_id, last_checked_at, last_post_at,
  last_tweet_id, provider_rule_id, launched_address/launched_at/launch_tweet_id, status +=
  suspended/renamed); new `launch_candidates` (Tier B); partial unique index on `alerts` for
  `x_launch`.
- `apps/server/src/xwatch/`: client.ts (TweetWatcher: syncRules / poll / resolveHandle; null
  adapter = dormant), twitterapi.ts, rules.ts (255-char sharding), runner.ts, detect.ts,
  confirm.ts, alerts.ts, message.ts, settings.ts. config: `X_API_KEY` absence = feature flag,
  started beside startDiscovery under the web-only guard. bot: three subcommands, setMyCommands,
  alertsSummary. api: `GET /api/g/:slug/upcoming` (+ web parity POST/DELETE).
- Contract: ProjectEntry, ProjectsResponse, XWatchSettings. Web: Upcoming view + rail card +
  mobile chip, api.ts.
- Opus estimate: backend ~350K, web ~200K, adversarial pass ~700K, fixes ~250K ⇒ ~1.5M.

## 7. Owner questions

1. twitterapi.io account + `X_API_KEY` (Railway variable), and a $1 pilot on one chatty handle to
   settle reply delivery.
2. Budget: $6/mo at 120 s or $11/mo at 60 s for 12–20 handles.
3. Confirm ping + auto-watch, no synthetic call.
4. Caps: 12 handles per group, 3 per member, 60-day expiry.
5. Run Tier A silent (board only) for a week before enabling the chat ping?
