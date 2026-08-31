# Robinhood Chain (4663) direct on-chain access — RPC free tiers + launchpad contract addresses
All facts checked live on 2026-09-01 unless noted.

## Part 1 — RPC / indexer free tiers

### Alchemy (robinhood-mainnet) — VERIFIED
- Endpoint: `https://robinhood-mainnet.g.alchemy.com/v2/{API_KEY}`, WSS: `wss://robinhood-mainnet.g.alchemy.com/v2/{API_KEY}`; chain ID 4663 (alchemy.com/rpc/robinhood). Robinhood's own docs name Alchemy the recommended provider (docs.robinhood.com/chain/connecting).
- Free tier (docs "Pricing Plans" page): **30M compute units (CU)/month, 300 CU/s throughput, 5 apps, 5 webhooks**. Marketing pricing page phrases it as "25 requests/second"; the docs' engineering number is 300 CU/s — plan around 300 CU/s. Pay-as-you-go: $0.45/M CU (first 300M), $0.40/M after; 10,000 CU/s.
- WebSockets ARE on the free tier. Limits (Subscription API docs): **100 WS connections (free), 1,000 unique subscriptions per connection**. `eth_subscribe`/`eth_unsubscribe` supported on Robinhood Chain (Alchemy Robinhood Chain API Overview lists them). Subscription types on EVM chains: `logs`, `newHeads`, `newPendingTransactions` (alchemy_minedTransactions/pendingTransactions are Ethereum/Arbitrum/Polygon/Optimism-only, NOT Robinhood).
- CU costs: `eth_getLogs` 60 CU, `eth_call` 26 CU, `eth_blockNumber` 10 CU, `eth_subscribe` 10 CU; subscription event delivery is byte-priced (~40 CU per typical ~1KB event).
- **eth_getLogs on Robinhood: Alchemy changelog, July 16 2026: "Robinhood Mainnet is now on the eth_getLogs unlimited block-range list, removing the default range limit for event and log queries."** (150MB response cap still applies platform-wide.) Whether "unlimited" also holds on the free tier is not stated per-tier — UNCERTAIN, but the changelog wording is chain-wide, unlike the Ethereum/Base tables that explicitly restrict free tier to small ranges.
- Workability math for 100 ms blocks (I measured the real block time via the public RPC: blocks 50,892,560→50,992,560 spanned 10,123 s = **101.2 ms avg block time**, ~864k blocks/day):
  - `newHeads` subscription = ~10 events/s x ~40 CU = ~400 CU/s → exceeds the 300 CU/s free cap and would be ~1B CU/month. **Do not subscribe to newHeads on the free tier.**
  - `logs` subscription filtered to the handful of launchpad singleton addresses/topics: launch/graduation events are rare (even 1,000/day ≈ 1.2M CU/month). **Easily fits free tier.**
  - Polling `eth_getLogs` every 3 s = 60 CU x 28.8k/day ≈ 52M CU/month → over budget; every 6 s ≈ 26M CU/month → fits but leaves little headroom. WS `logs` subscription is strictly cheaper than polling here.
- Verdict: free tier is workable for *filtered log subscriptions + occasional backfill*, not for full-block firehose.

### QuickNode — VERIFIED
- Robinhood mainnet (4663) and testnet (46630) supported, HTTP + WSS, **full archive, no pruning** (quicknode.com/docs/robinhood).
- Free plan (quicknode.com/pricing): **10M API credits/month, 15 requests/s, 1 endpoint, includes Streams + Webhooks**. Build $49/mo = 80M credits, 50 rps. Per-method credit multipliers for Robinhood not individually verified — UNCERTAIN (typically 20 credits for simple calls).

### dRPC — VERIFIED (numbers), Robinhood free-node reliability UNCERTAIN
- Robinhood mainnet listed (drpc.org/chainlist/robinhood-mainnet-rpc, "Free & Paid Nodes"); dRPC is on Robinhood's official provider list.
- Free tier (dRPC docs/blog, post June-2025 changes): **210M CU per 30 days, public nodes only**; rate limit **120,000 CU/min per IP** normally (can degrade to 50,400 CU/min under load); **WebSockets available on free; trace/debug/filter methods disabled on free**. Biggest raw free allowance of the four, but "public nodes" = weaker latency/reliability guarantees. (dRPC's site is JS-rendered; numbers came via their docs/blog as surfaced in search — treat exact figures as high-confidence but re-check at signup.)

### Validation Cloud — VERIFIED
- Robinhood endpoints: `https://mainnet.robinhood.validationcloud.io/v1/<KEY>`, HTTPS+WSS, full archive (docs.validationcloud.io/v1/robinhood-chain/overview).
- Free tier: **50M CU/month**, no credit card; Scale plan is pure pay-as-you-go. Robinhood method costs from their docs: **eth_getLogs 80 CU, eth_subscribe 20 CU**. WS clients must answer server pings or get disconnected every minute. Per-event delivery pricing for subscriptions not published — UNCERTAIN.

### Managed indexers
- **Envio HyperSync — VERIFIED Robinhood support**: listed in HyperSync supported networks as `Robinhood / 4663`, URLs `https://robinhood.hypersync.xyz` (HyperSync) and `https://robinhood.rpc.hypersync.xyz` (HyperRPC). API tokens required since Nov 3 2025 (free token from dashboard). HyperIndex hosted free "development" tier is tight: soft limits 100k events / 5GB, deployments >20GB or older than 30 days auto-deleted; each paid plan includes 800 indexing hours/month. Exact HyperSync free query quotas not published on the rendered pricing page — UNCERTAIN. Self-hosting the indexer and querying HyperSync directly with a free token is the budget path.
- **Goldsky — VERIFIED Robinhood support**: dedicated page (goldsky.com/chains/robinhood): Subgraphs ("sub-second latency after confirmation"), Turbo Pipelines (Mirror successor → Postgres/ClickHouse/S3/Kafka), Edge RPC. **$100 free credit, no credit card**; ongoing always-free allowance beyond the credit UNCERTAIN.
- **The Graph — VERIFIED Robinhood support**: official supported-network entry, manifest identifier `robinhood`, chain `eip155:4663`, subgraph + substreams quickstarts. Query pricing: **Free Plan 100,000 queries/month**, then $2 per 100k (Growth). Indexing latency on a 100ms chain and decentralized-network indexer coverage for this chain — UNCERTAIN.

## Part 2 — Deployed contracts & event signatures on chain 4663
Method: launchpad docs + hood.fun's own frontend JS config, then cross-verified against the chain via Blockscout API v2 (verified-contract ABIs + real logs). Every topic0 marked "observed" was read from actual on-chain logs AND matches my keccak-256 recomputation of the ABI signature.

### hood.fun (bonding curve → Uniswap v3)
Source: hood.fun Next.js bundle config (LAUNCHPAD_ADDRESS etc.), contract names/ABIs from Blockscout verified source.
- **HoodCustomLaunchpad (the launchpad/curve — ONE contract emits all launch, trade, graduation events): `0x8c529f0a77c07ce0e6796f153d292501ee6f66f6`**
  - `TokenCreated(address,address,string,string,string,uint256,uint256,uint256)` topic0 `0x91de26bc430b3a4f1d6cfb11d72f2e5ca75d7622d37b2a88a8998ec28e747a11` (observed)
  - `Trade(address,address,bool,uint256,uint256,uint256,uint256,uint256)` topic0 `0x2c76e7a47fd53e2854856ac3f0a5f3ee40d15cfaa82266357ea9779c486ab9c3` (observed)
  - `Graduated(address,uint256)` topic0 `0x3a11b9c0ca38b86101cb9e6e1dd2f752c31467c6eaa353f931b801a338406de6` (keccak of verified ABI; not in sampled log pages)
  - `Migrated(address,address,uint256,uint256,uint256)` topic0 `0x57aa04076c8e8e00f17b6f082eb7c65ec1aa90f07da036638ccfcb07dcae6cc8` (keccak of verified ABI)
  - `PlatformLaunch(address,address,address)` topic0 `0x1665bd3d716be830f7ab29ad1c8381a8b4a79afb8569e7b82ec7f00957c0671c` (observed)
- **Migrators** (frontend `NEXT_PUBLIC_MIGRATOR_ADDRESSES`, all five verified on Blockscout): HoodV3Migrator `0x88B4cde518272033F48862CEF728203aF219D02e` and `0x5790Ef23bE2E1543442C12F4550FaE147ba8eDBe`; HoodV3MigratorV2 `0x86c6FAF889eBAC8621BBb6dd8CA86aa6d51c9e6C` and `0x6d36DcD6fab842a2B29896c5c58f32304B824711`; HoodStockPairMigrator `0xC14F3Be12F5c0f3eE544Fc4E8883be981197f0be` (pairs vs tokenized stocks, falls back to WETH).
  - Graduation-to-v3 event on migrators: `V3Migrated(address,address,uint256,uint256,uint256)` topic0 `0x992845b53354dcd9aaa6bac6563775e438b83ec3765539e9c09b0ffb3e92421b` (observed). Watch topic0 across all migrator addresses (the active one rotates).
- HoodBurnLocker `0xd2a7c92fcb240c755919e9230c8db066e9ca1500` — `Locked(uint256,address,address,uint16)` topic0 `0x39932a1c9735a8caea8d262f7accd733416d9e7fbe36fc63859a6270a140f3a4`.
- hood.fun swap router `0x52E31d7E2A3A71a55C4527bd5b5cA3FeE2975866`; Uniswap router it uses `0xCaf681a66D020601342297493863E78C959E5cb2`; USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`.
- Curve economics (whitepaper): 80% of supply on curve, 20% (200M of 1B default) paired at graduation into a 1% Uniswap v3 pool, ~6.5 ETH raise, ~$44k graduation mcap, LP locked forever.

### NOXA Fun (no curve — instant Uniswap v3 launch)
Source: docs.noxa.fi/contracts/noxa-fun/ + on-chain logs.
- **Launch Factory `0xD9eC2db5f3D1b236843925949fe5bd8a3836FCcB`** (source NOT verified on Blockscout, but logs decode), Launch Locker `0x7F03effbd7ceB22A3f80Dd468f67eF27826acD85`, Multicall3 `0xcA11bde05977b3631167028862bE2a173976CA11`, WETH `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`.
- Observed factory events: `TokenLaunched` topic0 `0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a` and `TokenDeployed` topic0 `0x1461370115e1c2be79cb529f8cfcbd11316e789d9c6099fc83417b0b4c48c62a` — **identical topic0s to Pons V1** (same codebase lineage; signatures below). One tx deploys ERC-20 + single-sided v3 1% pool; **no graduation/migration event exists**.

### Pons (V1 instant-v3; V2 bonding curve → Uniswap v4)
Sources: docs.ponsfamily.com + Mobula almanac + on-chain.
- **V1 PonsLaunchFactory (active): `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB`** (start block 8,991,118); legacy factory `0x0c37a24F5D23A486FA692d1500881d698B1F77a4` (start 8,600,612); active locker `0x736D76699C26D0d966744cAe304C000d471f7F35`, legacy locker `0x31ca5E101941A93A7DD6d0497928700625CF54B5`.
  - `TokenLaunched(address token, address deployer, address dexFactory, address pairToken, address pool, uint256 dexId, uint256 launchConfigId, uint256 positionId, uint256 restrictionsEndBlock, uint256 initialBuyAmount)` topic0 `0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a` (docs + observed + keccak match). `TokenDeployed(address,address,address,address,uint256,uint256)` topic0 `0x1461370115e1c2be79cb529f8cfcbd11316e789d9c6099fc83417b0b4c48c62a`. Docs: "There is no migration event" for V1.
- **V2 PonsV2LaunchFactory: `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`** (verified) — the launch-event source:
  - `TokenLaunched(address,address,address,address,uint256,uint256)` topic0 `0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607` (observed + keccak match)
  - **Graduation to Uniswap v4: `PoolGraduated(address,uint256,uint256,uint256)` topic0 `0x0a44ef75df69c534f43cd6c1aa3ef8983065fe5fe79ef9e79f6494e6f258c259`** (keccak of verified ABI); `GraduationTokensPermanentlyLocked(address,uint256)` topic0 `0xa0a18f5bf205becee8b268d7cf69addab8548ae8ef361791464cf0e0e17c1361`.
  - Helpers: PonsV2LaunchDeployer `0x3711ceA4feaDE896C913C68F01Eda97Cb06D1A42` (CREATE-deploys per-token contracts, emits nothing); PonsV2LaunchAndBuy router `0xe33E9E479dF8802cb0866d5d05258bEc4cF62948` (`Launched` topic0 `0xdcacba5e347ae7abd91cb519eb877af8fa7774e347b85dd3ddcd24a2ba8cdf37` observed; full signature UNCERTAIN).
  - **Per-token `PonsV2BondingCurve` contracts** (one per launch — dynamic addresses!): `CurveBuy(address,address,uint256,uint256,uint256,uint256)` topic0 `0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455` (observed), `CurveSell(...)` topic0 `0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df`, `CurveCompleted(address,uint256,uint256)` topic0 `0xf8d37a90738ae063b8b8058b66f5880cf3cf7ab0c5d4fa78219696591dfbfb67`. Sampled V2 launch traded against the USDG proxy (`0x5fc5360D...`), not WETH.

### Uniswap v4 on Robinhood Chain (official deployments page)
- **PoolManager `0x8366a39cc670b4001a1121b8f6a443a643e40951`** (Blockscout-verified name "PoolManager"); PositionManager `0x58daec3116aae6d93017baaea7749052e8a04fa7`; Universal Router `0x8876789976decbfcbbbe364623c63652db8c0904`; StateView `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b`; Quoter `0x8dc178efb8111bb0973dd9d722ebeff267c98f94`.
- v4 `Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)` topic0 `0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f` (observed on this PoolManager + keccak match). v4 `Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)` topic0 `0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438` (keccak of canonical ABI; contract code verified as standard PoolManager).
- Cross-checks: v3 factory `0x1f7d7550b1b028f7571e69a784071f0205fd2efa` appears independently in hood.fun's frontend config and Pons docs (matches the known address). Canonical WETH `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` (NOXA docs + hood.fun config agree).

## Blockscout explorer API usability — TESTED
- Anonymous `robinhoodchain.blockscout.com/api/v2/*`: **HTTP 403 Cloudflare challenge from a datacenter IP** (reproduced via server-side fetch today) and 403 even locally with curl's default UA. With a browser User-Agent from a residential IP it returns 200 — that's how I ran the on-chain verification above. **Do not build a hosted server on the anonymous API; it will break.**
- Sanctioned route: **Blockscout Pro API** (blog.blockscout.com, includes Robinhood Chain): account at dev.blockscout.com, `proapi_` keys, **free tier 100K credits/day at 5 RPS (~5,000 requests/day at 20 credits/endpoint)**; Builder $49/mo 100M credits @15 RPS; Pro $199/mo 500M credits @30 RPS. Same key works across 100+ chains — nice for later multi-chain.
- Robinhood public RPC `https://rpc.mainnet.chain.robinhood.com` answered unauthenticated JSON-RPC from my test machine (rate-limited, "not recommended for production" per docs); public WSS feed `wss://feed.mainnet.chain.robinhood.com`.

## Ingestion-architecture implication
Chain-events ingestion is cheap and fully specified now: all four launch flows are detectable from ~8 static addresses + ~10 topic0 hashes, and launch/graduation events are low-volume. Only Pons V2 per-curve *trades* require dynamic address handling (or topic0-only filtering, which HyperSync and Alchemy `logs` subscriptions both support). Aggregator-only is no longer forced by missing data.

## Bottom-line recommendation

Commit to aggregator-plus-chain-events. The chain-events leg costs $0 and is now fully specified: open one Alchemy free-tier WebSocket (robinhood-mainnet) with `eth_subscribe` `logs` filters on the launchpad singletons (hood.fun HoodCustomLaunchpad 0x8c529f0a..., its 5 migrators, NOXA factory 0xD9eC2db5..., Pons V1/V2 factories, v4 PoolManager) plus the topic0 list above — that detects every new launch and every graduation within ~1 block (~100 ms) while consuming well under 1% of the free 30M CU/month. Never subscribe to newHeads on a 100 ms chain (would blow the 300 CU/s cap). Backfill after downtime with eth_getLogs (unlimited block range on robinhood-mainnet since July 16, 2026). Keep Validation Cloud (50M CU/mo free, archive, WSS) or dRPC (210M CU/30d, public nodes) as a zero-cost failover, and QuickNode free (10M credits) as a third key. For launchpad-phase price/mcap, read the hood.fun Trade and PonsV2 CurveBuy/CurveSell events or eth_call the curve — no indexer required at v1 scale; adopt Envio HyperSync (Robinhood supported, robinhood.hypersync.xyz, free token) if historical/trade-level indexing grows. For explorer data on a hosted server, use Blockscout Pro API keys (free 100K credits/day @ 5 RPS) — the anonymous robinhoodchain.blockscout.com API is Cloudflare-blocked from datacenter IPs (confirmed today).

## Open questions for the owner

- Does Groupie need per-trade indexing of Pons V2 bonding-curve tokens (dynamic per-token curve addresses, higher volume), or are launch + graduation + on-demand price reads enough for the board?
- How much historical backfill (weeks? full chain since launch ~block 0-51M?) should v1 ingest — deep backfill is the one place a free RPC tier gets tight and where a one-off HyperSync pull would help?
- Is a ~$49/mo budget acceptable as a fallback (QuickNode Build or Blockscout Builder) if the group's volume or a second chain pushes past free tiers?
- Should the launch monitor also watch Uniswap v4 PoolManager Initialize events globally (catches ALL new v4 pools, incl. non-launchpad stealth launches) or only launchpad events — the global feed is noisier and costs more CU?
- Alchemy vs Validation Cloud as the primary WebSocket: do you want the fallback provider actively hot (double ingestion, more quota burn) or cold-standby?

## Sources consulted

- https://www.alchemy.com/rpc/robinhood
- https://www.alchemy.com/docs/reference/pricing-plans
- https://www.alchemy.com/pricing
- https://www.alchemy.com/docs/reference/throughput
- https://www.alchemy.com/docs/reference/subscription-api
- https://www.alchemy.com/docs/reference/compute-unit-costs
- https://www.alchemy.com/docs/reference/robinhood-chain-api-faq
- https://www.alchemy.com/docs/robinhood-chain/robinhood-chain-api-overview
- https://www.alchemy.com/docs/changelog
- https://www.quicknode.com/pricing
- https://www.quicknode.com/docs/robinhood
- https://drpc.org/docs/pricing/requests
- https://drpc.org/docs/howitworks/ratelimiting
- https://drpc.org/chainlist/robinhood-mainnet-rpc
- https://docs.validationcloud.io/v1/robinhood-chain/overview
- https://www.validationcloud.io/post/node-api-updated-pricing-compute-unit-pricing-for-limitless-scalability
- https://docs.envio.dev/docs/HyperSync/hypersync-supported-networks
- https://envio.dev/pricing
- https://goldsky.com/chains/robinhood
- https://thegraph.com/docs/en/supported-networks/robinhood/
- https://thegraph.com/studio-pricing/
- https://docs.robinhood.com/chain/connecting
- https://developers.uniswap.org/docs/protocols/v4/deployments
- https://hood.fun/whitepaper
- https://hood.fun/ (frontend JS bundle config)
- https://docs.noxa.fi/contracts/noxa-fun/
- https://docs.mobula.io/almanac/robinhood-launchpads/pons
- https://docs.ponsfamily.com/
- https://www.blog.blockscout.com/build-on-robinhood-chain-with-the-blockscout-pro-api/
- https://robinhoodchain.blockscout.com/api/v2/ (smart-contracts, address logs, transaction logs endpoints)
- https://rpc.mainnet.chain.robinhood.com (block-time measurement)
