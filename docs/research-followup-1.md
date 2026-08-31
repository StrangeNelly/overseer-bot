# Do DexScreener / GeckoTerminal cover pre-graduation launchpad tokens on Robinhood Chain?

All findings below were verified with live API calls on 31 Aug / 1 Sep 2026 unless noted. Robinhood Chain context confirmed: Arbitrum-stack L2, chain ID 4663, mainnet live 1 July 2026 (robinhood.com support article, docs.robinhood.com/chain).

## Headline answer

**GeckoTerminal: YES for the launchpad that currently dominates the chain (PONS), with sub-3-minute latency and a free `launchpad_details` graduation field. NO for hood.fun's bonding phase. DexScreener: NO for any custom bonding curve on this chain — it only sees Uniswap-style pools, i.e. post-graduation (plus Noxa and pools.trade, whose "curves" are real Uniswap pools).** Groupie's core number ("mcap at call time") IS capturable for free, but not via the DexScreener-only plan — GeckoTerminal must be the primary source, with a small per-launchpad fallback adapter.

## GeckoTerminal free API (api.geckoterminal.com/api/v2) — tested live

- Network id `robinhood` is live with **35 indexed DEXes** (`GET /networks/robinhood/dexes`), including launchpad-related ones: `pons-v2` (PONS bonding curves), `pons-v2-dex` (graduated PONS pools, Uniswap-v4-hook based), `pons-dot-family` (Pons V1), `uniswap-pools-trade` (Uniswap's own pools.trade launchpad, live since 5 Aug 2026, no bonding phase), `hoodit`, `bankr-robinhood`, `virtuals-robinhood`, `clanker-robinhood`, `mint-club-robinhood`, `easya-kickstart-robinhood`, plus Uniswap v2/v3/v4, Pancake, Sushi, Curve, etc. **No `hood-fun` and no `noxa` dex ids.**
- **Bonding-curve pools ARE indexed for PONS, near-instantly.** `GET /networks/robinhood/new_pools` twice (minutes apart) showed the newest 20 pools 100% `pons-v2`; youngest pools were **41 seconds** and **2m43s** old at fetch time, already with price, FDV (~$3.2k–7.5k, i.e. fresh curve values), reserve and txn data. Observed PONS launch rate: roughly 5–10 tokens/minute (the chain's current meme meta).
- **`launchpad_details` is on the FREE endpoint.** `GET /networks/robinhood/pools/{poolAddress}` for a 3-minute-old PONS pool returned `"launchpad_details": {"graduation_percentage": 0.35, "completed": false, "completed_at": null, "migrated_destination_pool_address": null}`. CoinGecko markets this launchpad dataset (coingecko.com/en/api/launchpads) but it demonstrably works on the free GeckoTerminal v2 API for this chain.
- **Minute OHLCV works on bonding pools** (`/pools/{addr}/ohlcv/minute` returned valid candles for a still-bonding PONS pool) → Groupie can retro-fetch "price at call timestamp" even if it processes the Telegram message a few minutes late.
- **Token-address batch lookup works for bonding tokens**: `GET /networks/robinhood/tokens/multi/{addr1,addr2}?include=top_pools` returned `price_usd`, `fdv_usd`, `total_supply` and the bonding pool for a pre-graduation PONS token. Caveat: **`market_cap_usd` is usually `null` for these tokens — use `fdv_usd`** (fixed 1B supply on these launchpads, so FDV ≈ mcap).
- Rate limit: **30 calls/min free** (apiguide.geckoterminal.com/faq). Fine for one group (poll `new_pools` + targeted lookups); tight for future multi-group SaaS. UNCERTAIN: exact attribution requirements of the free tier — check GT's API guide terms.
- **hood.fun bonding tokens are NOT in GeckoTerminal**: token lookup for a bonding-phase hood.fun token returned 404, and the batch endpoint silently omitted it.

## DexScreener free API — tested live

- ChainId `robinhood` works; graduated tokens are covered correctly (tested graduated PONS tokens HOME/KISS: `dexId: "uniswap"` label `v4`, accurate mcap $270k/$51k, liquidity $48k/$21k). Pair-address lookup (`/latest/dex/pairs/robinhood/{pairId}`) also works.
- **Custom bonding curves are NOT indexed.** For brand-new (2–10 min) PONS tokens, `GET /tokens/v1/robinhood/{addresses}` returned `[]` and `/latest/dex/search` found nothing. hood.fun bonding tokens: also `[]`.
- **Correctness landmine:** for 5–23-hour-old, still-bonding PONS tokens with $150k–$317k real curve volume, DexScreener returned only **parasitic dust Uniswap v4 pools** someone else created: e.g. ALPE at "priceUsd $6.78, fdv $6,786,473,774" on **$0.02 liquidity**, while the real curve price was $0.0000041 (FDV ~$4.2k). If Groupie blindly takes `pairs[0]` from the planned `tokens/v1/robinhood/{addresses}` endpoint it will show billion-dollar mcaps for $4k tokens. Any DexScreener usage must filter by `liquidity.usd` (e.g. >$1k) and pick the highest-liquidity pair.
- Rate limits (docs.dexscreener.com/api/reference; uwuu.ai summary): pair/token-pair endpoints **300 req/min**, profile-type endpoints 60 req/min, free, no API key. Indexing of new Uniswap pools is automatic (dust pools created the same day were already present); precise pool-indexing latency in minutes: UNCERTAIN.

## Launchpad-by-launchpad reality (matters more than the API question)

The chain's launchpad meta rotates fast; where calls come from determines coverage:

- **PONS (pons.family / Pons V2)** — currently dominant (~all new pools). Custom bonding curve; graduates into Uniswap v4 pools. **Covered pre-graduation by GeckoTerminal** (with `launchpad_details`), post-graduation by both GT and DexScreener. Also covered by Bitquery's dedicated Pons API docs.
- **hood.fun** — the July flagship ("pump.fun of #HOOD", launched 9 July 2026 per press release). Custom curve contract, NOT a Uniswap pool (Mobula almanac: use `currentPrice(token)` view or virtual-reserve invariant; launchpad contract `0x6a63d96ef77ae569fcb85934cf1bd1ec7fe9b33d` seen in live data). **Invisible to both GT and DexScreener pre-graduation.** BUT it has a free public JSON API, verified live: `GET https://hood.fun/api/board` returns all 10,629 tokens with full curve state (`virtualEth`, `virtualTokens`, `realEth`, `realTokens`, `graduated`, `migrated`, `tradeFeeBps`, `timestamp`); `GET https://hood.fun/api/ethprice` gives ETH/USD. Price = virtualEth/virtualTokens; mcap = price × 1B. Note: hood.fun is effectively dead — newest token is ~31 days old; 10,561 of 10,581 timestamped tokens never graduated.
- **Noxa (fun.noxa.fi)** — bonding phase is a **real Uniswap v3-style pool** (Mobula almanac: launch factory `0xd9ec2db5f3d1b236843925949fe5bd8a3836fccb`, standard `sqrtPriceX96` pricing, graduation at 4.2 quote ETH). So Noxa tokens ARE automatically visible in GT/DexScreener as Uniswap pairs even while "bonding" (no graduation-progress field, though; compute progress = quoteReserve/4.2 ETH). Activity currently low (newest visible launch ~6 days old). No public Noxa REST API found (site is server-rendered): UNCERTAIN.
- **pools.trade (Uniswap's launchpad, public since 5 Aug 2026)** — Uniswap v4 pools from inception, no bonding phase → both APIs cover it from launch (GT dex `uniswap-pools-trade`).
- Others with Mobula integration guides existing: ApeStore, Bottom.fun, Bow.fun, DYOR.fun, Klik, LaunchProof, Long.xyz, RobinFun, Printr, RealFun, Flap.sh, Bags.fm (Bitquery). Several use Uniswap v3/v4 pools as their curve (auto-indexed); ones with custom curves need per-launchpad adapters.

## Alternatives evaluated for pre-graduation data

- **Launchpads' own APIs** — hood.fun verified free and complete (above). PONS-native API: not verified (a Medium guide exists but returned 403); unnecessary since GT covers it. **Cost: $0.**
- **Direct RPC + Mobula "almanac" guides (docs.mobula.io/almanac/robinhood-launchpads/…)** — free step-by-step integration docs for 13+ Robinhood launchpads with contract addresses, event signatures and exact pricing formulas. These are DIY guides (read the chain yourself via RPC), not a hosted Mobula feed. Excellent engineering reference for building fallback adapters. Robinhood Chain public RPC exists (docs.robinhood.com/chain; chainlist entries). **Cost: $0 + your own indexer.**
- **Codex.io** — has exactly the right product (launchpad lifecycle: `filterTokens` New/Completing/Completed views, `onLaunchpadTokenEventBatch` websocket with `graduationPercent`, `marketCap`, `priceUSD`, events through the curve + 6h post-migration; powers defined.fi). BUT (codex.io/pricing, fetched live): free tier = 10k req/mo, 5 rps, **no websockets and no launchpad data**; launchpad events require **Growth at $350/mo**. Robinhood Chain support in their launchpad list: UNCERTAIN (supported-launchpads page 404'd for me). **Not viable for a hobby budget.**
- **Bitquery** — dedicated Robinhood Chain docs section (docs.bitquery.io/docs/blockchain/robinhood/) covering Pons (real bonding curves, graduates to Uniswap v4 — matches my observations), Pools.trade, Flap.sh, Bags.fm, plus a cross-launchpad "every new token on the network" feed; GraphQL + websocket streams; realtime/archive/combined datasets. Pricing "from $49/mo"; free developer tier limits: UNCERTAIN. **Best paid safety net if the meta rotates to a launchpad GT hasn't integrated yet.**

## Practical numbers for Groupie's pipeline

- GT free: 30 req/min; `new_pools` returns 20/page; PONS launch rate ~5–10/min → polling every 15–30s + call-triggered lookups fits in budget for one group.
- DexScreener free: 300 req/min on `tokens/v1/{chainId}/{addresses}` (comma-separated batch — 4 tested fine; docs indicate up to ~30 per call) → good for refreshing the live board of graduated/older tokens.
- Historical price for late processing: GT minute OHLCV on the pool (works during bonding). DexScreener has no free historical OHLCV endpoint.
- Use `fdv_usd` not `market_cap_usd` on GT for these tokens (mcap is null pre-graduation; supply is fixed 1B so FDV ≈ mcap).

## Bottom-line recommendation

Make GeckoTerminal (free, network 'robinhood') the PRIMARY market-data source, not DexScreener: it indexes the currently dominant PONS launchpad's bonding-curve pools ~40s–3min after creation, exposes graduation status via launchpad_details, serves minute OHLCV during bonding (so 'mcap at call time' can be back-filled from the call timestamp), and its tokens/multi endpoint resolves token addresses straight from Telegram calls — use fdv_usd as the mcap. Demote DexScreener to a secondary refresher for graduated/older tokens (300 req/min, batched addresses), and ALWAYS select pairs by highest liquidity with a minimum-liquidity filter — on this chain it returns parasitic dust Uniswap v4 pools with absurd FDVs (observed $6.8B 'FDV' on $0.02 liquidity) for tokens still on a curve it can't see. Add a thin per-launchpad fallback adapter for curves GeckoTerminal misses: hood.fun's free public API (hood.fun/api/board + /api/ethprice, price = virtualEth/virtualTokens × 1B supply) covers its now-quiet curve, and Mobula's free almanac gives contract-level recipes (e.g. currentPrice(token) via RPC) for others. On a call for an unknown token, try GT first, fall back to the adapter, and store the number immediately — a token can graduate or die within the hour. Skip Codex.io (launchpad data requires the $350/mo Growth plan); keep Bitquery (from $49/mo, has dedicated Robinhood launchpad streams incl. a cross-launchpad new-token feed) as the paid escape hatch if the meta rotates to a launchpad GT hasn't integrated and for multi-group scale where GT's 30 req/min becomes the bottleneck.

## Open questions for the owner

- Which launchpads do the group's calls actually come from today (PONS vs pools.trade vs hoodit vs others)? A week of group history would let us rank adapter priority — PONS alone may cover 90%+ right now.
- How exact must 'market cap at call time' be — is a value backfilled from GeckoTerminal minute-candles acceptable, or do you want second-level precision at the call instant (which pushes toward launchpad-native APIs/RPC or a websocket source)?
- Is the budget strictly $0, or is up to ~$49/mo (Bitquery) acceptable as insurance for launchpad-meta rotation and for the later multi-group SaaS phase where GeckoTerminal's 30 req/min free limit will not scale?
- Should tokens that never leave the bonding curve (the vast majority — e.g. 10,561 of 10,581 hood.fun tokens never graduated) automatically count as 'died after call', and after how long?
- For the future multi-chain/multi-group version: are you comfortable building the small per-launchpad adapter layer now (clean interface: source -> price/mcap), knowing every new hot chain will repeat this same coverage gap?

## Sources consulted

- https://api.geckoterminal.com/api/v2/networks/robinhood/dexes
- https://api.geckoterminal.com/api/v2/networks/robinhood/new_pools?page=1
- https://api.geckoterminal.com/api/v2/networks/robinhood/pools/0xebd3c04527eb2c12aa65f882f666abe7879875c1
- https://api.geckoterminal.com/api/v2/networks/robinhood/dexes/pons-v2/pools?page=1
- https://api.geckoterminal.com/api/v2/networks/robinhood/dexes/pons-v2-dex/pools?page=1
- https://api.geckoterminal.com/api/v2/networks/robinhood/pools/0xb4e56367a6e77568c064f466d7d3700dba354641/ohlcv/minute?limit=5
- https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/multi/0xfa70b92ddd40981ff8c7ef4f4cadd06549c28111,0x29157156a2d445e202FDA2649357406Eede7600d
- https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/0x29157156a2d445e202FDA2649357406Eede7600d/pools
- https://api.dexscreener.com/tokens/v1/robinhood/0xfa70b92ddd40981ff8c7ef4f4cadd06549c28111,0x1f23b85f8cc539dbf7b7eed488f6364d8de11bff,0x3f7b2bfd49511e99f3b4d0473e84a0fa6186f60c,0x37dd4843472239d4bcd2fb6d973227b8bfd555f3
- https://api.dexscreener.com/tokens/v1/robinhood/0xe9ab3214a9b77baebfde2b6d17dec4823599ff6f,0x04a2df398b60d528ee7d1a0b5f20159eab922b36
- https://api.dexscreener.com/latest/dex/pairs/robinhood/0x177e26bc396d8a264542033533d71a94957375027bf4b47a7467cc444233bdfa
- https://api.dexscreener.com/latest/dex/search?q=PLUSHKEY
- https://hood.fun/api/board
- https://hood.fun/api/token/list
- https://apiguide.geckoterminal.com/faq
- https://www.coingecko.com/en/api/launchpads
- https://docs.dexscreener.com/api/reference
- https://uwuu.ai/blog/dexscreener-api
- https://docs.mobula.io/llms.txt
- https://docs.mobula.io/almanac/robinhood-launchpads/hoodfun
- https://docs.mobula.io/almanac/robinhood-launchpads/noxafun
- https://docs.mobula.io/almanac/robinhood-launchpads/bowfun
- https://docs.codex.io/recipes/launchpads
- https://www.codex.io/pricing
- https://docs.bitquery.io/docs/blockchain/robinhood/
- https://fun.noxa.fi
- https://nockterminal.com/best/robinhood-chain-token-screeners
- https://www.manilatimes.net/2026/07/09/tmt-newswire/globenewswire/hoodfun-announces-official-launch-as-the-premier-fair-launch-token-platform-for-the-robinhood-chain-ecosystem/2381528
- https://robinhood.com/us/en/support/articles/robinhood-chain-mainnet/
- https://docs.robinhood.com/chain/
