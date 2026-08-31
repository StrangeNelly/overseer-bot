# Market-Data API research for Groupie (verified 1 Sept 2026)

## Context fact verified first
Robinhood Chain mainnet went live 1 July 2026 (Arbitrum-stack Ethereum L2, EVM 0x addresses, **chain ID 4663**, Uniswap deployed day one, USDG/WETH as quote assets, a pump-style launchpad exists — GeckoTerminal token data even returns `launchpad_details` with graduation status). Source: Robinhood newsroom + live API responses below. The meme tokens the group calls (e.g. "4663", "HOOD" memes) are visibly indexed today.

---

## 1. DexScreener API — VERIFIED LIVE, supports Robinhood Chain

- **Pricing:** Free, no API key. Docs/T&C mention paid enterprise tiers exist at "checkout", but all endpoints Groupie needs are on the free tier.
- **Rate limits (from official docs page, scraped 1 Sept 2026):** `/latest/dex/*`, `/tokens/v1/*`, `/token-pairs/v1/*` = **300 req/min**; profile/boost/meta endpoints = 60 req/min. Observed `Cache-Control: public, max-age=30` on responses, so data is effectively ~30s fresh.
- **Chains:** Robinhood Chain **confirmed live** — I called `GET https://api.dexscreener.com/tokens/v1/robinhood/0x45C8...0962,0x5fc5...d168` and got full data back (chainId `"robinhood"`). Solana supported. Broad multichain.
- **Data returned (verified in live response):** priceUsd/priceNative, **marketCap AND fdv**, liquidity (usd/base/quote), volume (m5/h1/h6/h24), buys/sells txn counts, priceChange (m5/h1/h6/h24), **pairCreatedAt**, dexId, labels (v4), **websites + socials (twitter)**, image/banner. **No holder count.**
- **Batch:** yes — `/tokens/v1/{chainId}/{addresses}` "up to 30 addresses" (docs, and verified multi-address call works). 200 tokens = 7 requests.
- **Historical OHLCV:** **none** in the public API. This is the one real gap — you cannot backfill ATH-since-call from DexScreener.
- **Websocket:** none officially documented; the site's internal WS is not a public/ToS-sanctioned API (third-party blogs claiming "free websocket" — UNCERTAIN/unsupported, don't build on it).

## 2. GeckoTerminal public API — VERIFIED LIVE, supports Robinhood Chain, free OHLCV

- **Pricing:** free, keyless, attribution required. **Rate limit 30 calls/min** (CoinGecko support article; I hit a 429 quickly in testing, consistent).
- **Chains:** `robinhood` network confirmed live (`/api/v2/networks/robinhood/pools` works). Solana supported.
- **Data (verified):** pool endpoints return price, **fdv_usd, market_cap_usd, pool_created_at**, buys/sells/buyers/sellers, volume, price change (m5→h24), reserve_in_usd. Token multi endpoint returns price, fdv, total_supply, volume, top pools, plus `launchpad_details`. `/tokens/{addr}/info` has socials/metadata. **No holder count on free tier.**
- **Batch:** `/networks/{network}/tokens/multi/{addresses}` — comma-separated (up to 30 per CoinGecko docs conventions).
- **OHLCV: yes, free** — verified live: `/networks/robinhood/pools/{pool}/ohlcv/minute?aggregate=5` returned candles for the HOOD meme pool. Day/hour/minute timeframes on public tier.
- **Websocket:** none.

## 3. CoinGecko API (onchain/DEX = GeckoTerminal data, keyed) — paid upgrade path

Pricing page (verified): **Demo free** (10k credits/mo, 100/min, includes onchain endpoints at 60s freshness), **Basic $35/mo** (100k credits, 300/min), **Analyst $129/mo** (500k credits, 500/min, 10s freshness), Lite $499/mo (2M). 
- Onchain endpoints: multi-token lookup all paid plans (up to 50 addresses on **Analyst+**; 30 otherwise), Token Info (socials) all paid plans.
- **Analyst+ only:** Top Holders, **Holders Chart**, Megafilter, token-level OHLCV, trades, top traders. Pool OHLCV from Basic; historical depth: Basic = past 6 months, Analyst+ = since Sept 2021/pool creation; **second-level candles** exist on paid.
- Robinhood chain supported (same `robinhood` network as GT; coingecko.com/en/chains/robinhood exists).

## 4. Birdeye Data Services — NO Robinhood Chain (disqualifying for v1)

- **Supported networks (official docs page):** solana, ethereum, arbitrum, avalanche, bsc, optimism, polygon, base, zksync, sui, monad, megaeth, fogo, aptos. **No Robinhood Chain.** Solana is its strength.
- Pricing (official docs): free "Standard" 30k CU/mo @ 1 rps (very small); Lite $39/mo 1.5M CU 15 rps; Starter $99 5M; Premium $199 15M 50 rps (+500 WS connections); Business $499 60M 100 rps. Overages ~$4.50–6.90/M CU on autoscale.
- Rich data (OHLCV, holders, wallet PnL, websockets) — but only relevant when/if Groupie adds Solana.

## 5. Moralis — NO Robinhood Chain (disqualifying for v1), pricing restructured upward

- Data API supported chains (official docs): Ethereum, Polygon, BSC, Arbitrum, Base, Optimism, Linea, Avalanche, Cronos, Gnosis, Chiliz, Flow, Ronin, Pulsechain, Sei, Monad, Bitcoin (+ Solana via its Solana API product line — pump.fun OHLCV etc.). **No Robinhood Chain.**
- Pricing (docs page, Sept 2026): Starter **$149/mo** 2M CU, Pro $249 100M, Business $749 500M. Free tier: docs pricing page no longer shows one; Moralis FAQ still mentions 40k CU/day free — **UNCERTAIN** whether a usable free tier remains. Either way: expensive relative to alternatives and misses the target chain.

## 6. Codex.io (formerly Defined.fi) — supports Robinhood + Solana, best "pro" option, real websockets

- **Chains (official networks page):** 90+ networks including **"Robinhood | 4663"** and **"Solana | 1399811149"** — both explicitly listed.
- **Pricing (official):** "Almost Free" **$0 after a one-time $1 verification: 10,000 requests/mo, 5 rps, no websockets** (enough for dev, not for production polling). **Growth $350/mo**: 1M–10M requests, 300 rps, **300 websocket connections**, webhooks, live token events. Enterprise custom.
- **Data (GraphQL, verified from docs):** `filterTokens` — **up to 200 tokens per request** with 100+ fields/filters: marketCap (FDV-style) + circulatingMarketCap, liquidity, volume, **holders**, top10HoldersPercent, insider/bundler/sniper held %, socials, createdAt, launchpad lifecycle. `getTokenPrices` — batched, supports **historical timestamp per input** (i.e. "price at call time" in one call); batch max not stated on page (~25 per older docs — UNCERTAIN exact). `getBars` — OHLCV, max 1500 datapoints/request, sub-minute resolutions (1S–30S) kept 24h only, 1m+ full history. `holders`, `top10HoldersPercent` queries. **Subscriptions over wss://graph.codex.io/graphql:** onBarsUpdated, onEventsCreated, onHoldersUpdated, **onFilterTokensUpdated** (live-updating board!), onLaunchpadTokenEvent.

## 7. Other contender: Mobula

- docs.mobula.io has a dedicated **Robinhood Chain page**: real-time prices, trades, **holders**, OHLCV, metadata, wallet data. Free tier "several thousand requests/day" (third-party description — exact numbers UNCERTAIN). Worth a look as a budget holder-count/OHLCV supplement, but less battle-tested than the above; verify limits on mobula.io before depending on it.

---

## Fit analysis for polling 50–200 tokens

| Need | DexScreener (free) | GT/CoinGecko | Codex $350 | Birdeye | Moralis |
|---|---|---|---|---|---|
| Robinhood Chain | YES (verified) | YES (verified) | YES | NO | NO |
| Solana (later) | YES | YES | YES | YES | YES |
| Batch by CA | 30/call @300 rpm | 30/call @30 rpm free | 200/call | n/a | n/a |
| Mcap+FDV+liq+vol | YES | YES | YES | — | — |
| Socials | YES | paid/info endpoint | YES | — | — |
| Pair created time | YES | YES | YES | — | — |
| Holder count | NO | Analyst $129+ | YES | — | — |
| OHLCV | NO | YES (free) | YES | — | — |
| Websocket | NO | NO | YES | — | — |

Poll math: 200 tokens ÷ 30-address batches = 7 DexScreener calls per refresh vs a 300/min cap → a full-board refresh every 30s uses ~5% of the free rate limit.

## Bottom-line recommendation

Build v1 on DexScreener's free API as the primary poller, with GeckoTerminal's free API as the OHLCV/backfill sidecar — total cost $0. DexScreener is verified to cover Robinhood Chain today (chainId "robinhood") and one batched endpoint (/tokens/v1/robinhood/{up to 30 CAs}, 300 req/min) returns everything the board needs per token: priceUsd, marketCap, FDV, liquidity, volume, buy/sell counts, price-change windows, pairCreatedAt, website and X links. Poll every 30-60s (responses are CDN-cached ~30s anyway), store each snapshot, and compute "multiple since call" and running ATH-since-call in your own DB — that sidesteps DexScreener's one gap (no OHLCV). Use GeckoTerminal's free OHLCV endpoint (verified working on Robinhood pools, minute/hour/day candles, 30 calls/min keyless) to backfill ATH for calls that predate ingestion or cover downtime, and to render charts. Neither free API gives holder counts; either drop that column in v1 or pull it cheaply from Mobula/CoinGecko Analyst later. First paid upgrade if you outgrow free limits or want holders + deep history: CoinGecko Basic $35/Analyst $129 per month (same GeckoTerminal data, keyed, 300-500 calls/min, holders + megafilter on Analyst). When Groupie becomes multi-group SaaS with live-updating boards, migrate the data layer to Codex.io Growth ($350/mo): it explicitly supports Robinhood (networkId 4663) and Solana, fetches 200 tokens in one filterTokens call including holder counts and top-10-holder %, does historical price-at-timestamp lookups (perfect for "price at call time"), and has real websockets (onFilterTokensUpdated) — its $0/10k-requests tier is fine for prototyping that migration now. Avoid Birdeye and Moralis for v1: neither supports Robinhood Chain as of Sept 2026 (Birdeye becomes relevant only for a Solana expansion).

## Open questions for the owner

- Is $0/month a hard constraint, or is up to ~$35-129/mo (CoinGecko Basic/Analyst) acceptable once the group relies on the dashboard daily?
- Is a holder-count column a must-have for v1? It is the one field the free DexScreener+GeckoTerminal stack cannot provide on Robinhood Chain.
- Is running-max ATH computed from 30-60s polling accurate enough for the 'x since call' bragging numbers, or do you need candle-exact intraminute ATH (which pushes toward GeckoTerminal OHLCV backfill on every call, or Codex getBars)?
- How soon is multi-group SaaS realistically planned? If under ~6 months, it may be worth building the data-access layer against Codex's GraphQL schema from day one (free 10k-req tier for dev) to avoid a rewrite.
- How many calls per day does the group actually produce (affects whether the 'died after call' section should keep polling dead tokens at full frequency or decay to hourly checks)?
- Do you need Solana in v1 at all, or strictly Robinhood Chain first?

## Sources consulted

- https://docs.dexscreener.com/api/reference
- https://docs.dexscreener.com/api/api-terms-and-conditions
- https://api.dexscreener.com/tokens/v1/robinhood/... (live API calls, 1 Sept 2026)
- https://api.geckoterminal.com/api/v2/networks/robinhood/pools and .../ohlcv/minute (live API calls, 1 Sept 2026)
- https://support.coingecko.com/hc/en-us/articles/23407777579801-The-rate-limit-for-the-public-GeckoTerminal-API-is-too-low-Can-I-request-a-higher-rate-limit
- https://www.coingecko.com/en/api/pricing
- https://docs.coingecko.com/reference/endpoint-overview
- https://docs.coingecko.com/reference/pool-ohlcv-contract-address
- https://docs.coingecko.com/reference/tokens-data-contract-addresses
- https://docs.birdeye.so/docs/pricing
- https://docs.birdeye.so/docs/supported-networks
- https://docs.moralis.com/get-started/pricing
- https://docs.moralis.com/data-api/supported-chains
- https://www.codex.io/pricing
- https://docs.codex.io/networks
- https://docs.codex.io/llms.txt
- https://docs.codex.io/api-reference/queries/filtertokens.md
- https://docs.codex.io/api-reference/queries/gettokenprices.md
- https://docs.codex.io/api-reference/queries/getbars.md
- https://docs.mobula.io/blockchains/robinhood
- https://robinhood.com/us/en/newsroom/robinhood-accelerates-global-expansion-robinhood-chain-mainnet-stock-tokens-agentic-trading/
- https://dexscreener.com/robinhood
