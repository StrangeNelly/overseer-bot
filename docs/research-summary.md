# Groupie — Research synthesis & proposed architecture

*Compiled 2026-09-01 from a 10-agent research pass. Detailed reports with sources: `research-*.md` in this folder. Facts below were live-verified against official docs and production APIs on 31 Aug–1 Sep 2026.*

## Verdict: green light, the lane is empty

No existing product connects to a **private** Telegram group and gives its members a web board of the group's own calls. Rick and Phanes live entirely inside the chat; CallAnalyser/SpyDefi track **public** KOL channels; Robinhood Chain screeners (Nock Terminal etc.) are chain-wide, not group-scoped. Groupie's combination — group-scoped board + time filters + died-after-call + pre-launch X monitoring — has no incumbent.

Estimated v1 running cost: **~$5–15/mo** (hosting) + **$0** market data + **~$6–10/mo** X monitoring (when added). Telegram APIs are free.

## The three hard constraints (design around these)

### 1. A Telegram bot can never see other bots' messages
Verified against official docs: even as group admin, a Bot API bot receives all **human** messages but **never other bots'** messages. So Groupie cannot read Rick/Phanes call cards or harvest Rick's at-call market cap. It must extract contract addresses from members' own messages and compute call-time mcap from its own market-data feed. Also: no access to history before the bot joins (one-time backfill possible via Telegram Desktop JSON export), and updates are only queued 24h if the ingester is down. Privacy mode must be off (or bot made admin) **before** adding to the group — toggling later means re-adding.

### 2. DexScreener alone can't price fresh launchpad calls
Robinhood Chain (mainnet 1 Jul 2026, Arbitrum-stack L2, chain ID 4663, ETH gas, EVM 0x addresses, ~100ms blocks) has a launchpad meta: most fresh calls are bonding-curve tokens, currently dominated by **PONS V2**. Live probes showed:
- **DexScreener** (free, 300 req/min, 30-address batches): only sees Uniswap-style pools → blind to PONS curves pre-graduation, and returns **parasitic dust pools with absurd FDVs** (observed "$6.8B FDV" on $0.02 liquidity) for tokens it can't see properly. Always filter by `liquidity.usd` and pick highest-liquidity pair.
- **GeckoTerminal** (free, 30 req/min): **indexes PONS bonding pools within ~40s–3min** of creation, exposes `launchpad_details` (graduation %), serves free minute-OHLCV even during bonding → mcap-at-call can be backfilled from the call timestamp. Use `fdv_usd` (mcap is null pre-graduation; supply is 1B so FDV≈mcap).
- **Chain events are the free real-time layer**: all major launchpad contracts + event topic0 hashes are mapped (see `research-followup-3.md`) — hood.fun launchpad `0x8c529f0a...`, NOXA factory `0xD9eC2db5...`, Pons V1/V2 factories, Uniswap v4 PoolManager `0x8366a39c...`. One Alchemy free-tier WebSocket (`robinhood-mainnet`, 30M CU/mo free) with filtered `logs` subscriptions detects every launch/graduation in ~1 block using <1% of free quota. Never subscribe to `newHeads` on a 100ms chain (blows the free 300 CU/s cap).

**Data plan: GeckoTerminal primary, DexScreener secondary refresher for graduated tokens, Alchemy WS chain-events for launch detection, hood.fun's free JSON API as a legacy adapter.** Paid escape hatches if the meta rotates or SaaS scales: Bitquery (~$49/mo, dedicated Robinhood launchpad streams) or Codex ($350/mo, websockets + 200-token batch — what Rick uses).

### 3. X monitoring: official API is dead for hobbyists; scrapers are cheap but ToS-grey
X moved to pay-per-use in Feb 2026 ($0.005/post read, free tier gone). Timeline polling at our cadence would cost **thousands/mo**. Nitter received a cease-and-desist Aug 2026 and is dead. The pragmatic option: **twitterapi.io** webhook filter rule (`from:acct1 OR from:acct2 ...`, ~100 handles per rule, 60s interval) ≈ **$6–8/mo** for the whole watchlist at 1–2 min latency. Fallback: socialdata.tools search monitors (~$9–35/mo) — also the only product pushing **bio/name/profile-change** events (≤30s), which matter because pre-launch accounts often announce via bio changes. Wrap the provider behind a thin `TweetWatcher` interface; any unofficial provider can vanish with days of notice.

## Death detection (verified empirically on real rugs)

- **`liquidity.usd` is the one reliable signal.** Rugged pools: $0–2. Merely-quiet pools: liquidity intact, volume ~0. Proposed: died = best-pair liquidity < ~$250 OR >95% drop from call-time liquidity; quiet = healthy liquidity + no txns.
- `priceUsd` becomes garbage after rugs (observed $171 trillion from dust-reserve math); `priceChange` decays to an empty object; `fdv`/`marketCap` keys can vanish. Parse defensively; compare against **our stored call-time baseline**, never the API's change fields.
- **Empty `[]` from DexScreener means "not indexed", NOT dead** — actively-trading PONS curve tokens return `[]` there. Route through GeckoTerminal (404 = never existed; nulls + empty top_pools = dead).
- Dead pairs stay queryable forever (verified 5 years back on BSC) → retention is purely our product choice; decay polling of confirmed-dead tokens to ~daily.

## Trading link row (all verified working on Robinhood Chain)

| Venue | Format | Referral |
|---|---|---|
| Axiom | `axiom.trade/t/{ca}/@HANDLE?chain=robinhood` | in-link, 30% commission |
| GMGN | `gmgn.ai/robinhood/token/CODE_{ca}` | in-path, tiered |
| Maestro | `t.me/maestropro?start=r-CODE` (quick-buy format: generate in-bot to confirm) | 25% lifetime |
| Banana Gun | `t.me/BananaGunSniper_bot?start=snp_{refID}_{ca}` | 10% |
| Bloom | supported on HOOD; token deep-link format: verify in-bot | 25% of 1% fee |
| OKX | `web3.okx.com/token/robinhood-chain/{ca}` | none |
| DexScreener | `dexscreener.com/robinhood/{ca}` | none (chart link) |

**Do not link BullX** (trading suspended Jun 2026, considered dead). Photon/Trojan have no Robinhood support — defer to the Solana phase.

## Proposed stack (opinionated)

- **One TypeScript monorepo, one long-running Node process** on Railway (Hobby $5/mo + ~$3–7 usage): grammY bot on long polling (no webhook/TLS needed; works identically on the Windows dev box), node-cron pollers, Hono/Fastify serving a Vite+React SPA, JSON API, and one multiplexed SSE stream. Skip Next.js (no SSR need), skip serverless (long-running processes).
- **Postgres on Railway + Drizzle ORM** from day one (kills the future SQLite→Postgres migration).
- **Auth:** ship as a **Telegram Mini App** first (pinned `t.me/GroupieBot/board` link in the group; validate `initData` server-side), gate every route with cached `getChatMember` (creator/admin/member pass). Browser login later via Telegram's new OIDC flow (the legacy login-widget hash scheme is now archived — don't build on it).
- **Multi-group SaaS baked in cheaply:** `group_id` (BIGINT, negative for supergroups) on every row; a `groups` table; handle `my_chat_member` so being added to a group auto-registers it; poll each unique token once regardless of how many groups called it.
- **CA extraction:** regex `0x`+40-hex with lookarounds (rejects tx-hash prefixes), EIP-55 checksum validation on mixed case, plus parsing known URLs (dexscreener/axiom/gmgn links) from message entities. **Never auto-create a call from a bare $TICKER** (non-unique, squatted) — resolve via the group's own rolling ticker→CA map or flag "unconfirmed".
- **Framework health check:** grammY current (tracks Bot API 10.x within days); Telegraf stagnant since Feb 2024 — avoid.

## Costs at a glance

| Item | v1 | Later/optional |
|---|---|---|
| Telegram (bot, auth, getChatMember) | $0 | $0 |
| Market data (GeckoTerminal + DexScreener + hood.fun API) | $0 | Bitquery $49/mo or Codex $350/mo |
| Chain events (Alchemy free WS; VC/dRPC/QuickNode as failover keys) | $0 | Blockscout Pro free tier for explorer data |
| Hosting (Railway app + Postgres) | ~$5–12/mo | split services, same host |
| X launch monitor (twitterapi.io) | — (v1.5) | ~$6–10/mo; SocialData fallback ~$9–35/mo |

## Open decisions (owner input needed)

See the questions posed in chat on 2026-09-01; decisions will be recorded in `decisions.md`.
