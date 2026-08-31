# Robinhood Chain — State as of 1 Sept 2026

## 1. Chain status and core specs (verified)

- **Mainnet is live and open.** Public testnet launched 10 Feb 2026; public mainnet launched **1 July 2026**. Contract deployment is **permissionless** — anyone can deploy, bridge in ETH, and interact; fully EVM-compatible. (Sources: robinhood.com newsroom, blog.arbitrum.io, defiprime.com, docs.robinhood.com)
- **Tech stack:** dedicated Arbitrum chain ("Arbitrum Dedicated Blockchains" / Orbit stack) settling to Ethereum. **100 ms block times.** Remits 10% of net revenue to the Arbitrum ecosystem. Uniswap and Chainlink integrated from day one.
- **Chain ID:** mainnet **4663** (testnet 46630). Also on chainlist.org/chain/4663.
- **Gas token:** **ETH**. The chain has **no native token of its own** (HOOD the stock ticker / #HOOD hashtag ≠ a gas token).
- **Address format:** standard EVM — 20-byte `0x...` hex addresses (it is an Arbitrum Orbit EVM chain; all tooling confirms 0x addresses).
- **Official endpoints** (from docs.robinhood.com/chain/connecting):
  - Public RPC: `https://rpc.mainnet.chain.robinhood.com` — explicitly **rate-limited, not for production**
  - Alchemy (recommended provider): `https://robinhood-mainnet.g.alchemy.com/v2/{API_KEY}` and `wss://robinhood-mainnet.g.alchemy.com/v2/{API_KEY}`
  - Sequencer feed: `wss://feed.mainnet.chain.robinhood.com`; sequencer: `https://sequencer.mainnet.chain.robinhood.com`
  - Other listed infra providers: QuickNode, Blockdaemon, dRPC, Validation Cloud (Tatum and Dwellir also market support)
- **Block explorer:** official is Blockscout at `https://robinhoodchain.blockscout.com`; third-party `robinscan.io` exists. **Caveat:** my direct request to `robinhoodchain.blockscout.com/api/v2/stats` was met with a Cloudflare challenge from this network — the Blockscout REST API may not be freely reachable from datacenter IPs; UNCERTAIN how usable it is as a backend API, test from your own machine/server.
- Chain narrative: built for tokenized stocks (90+ stock tokens, agentic trading), but **memecoins took over** — RWAs/stock tokens were only ~4% of early volume (CoinDesk, 13 Jul 2026); ~$3.1B DEX volume in first ~10 days; GeckoTerminal showed ~$1.08B 24h volume / ~6.8M daily txs at one point.

## 2. Where memecoins launch and trade

**DEXes:**
- **Uniswap v2, v3, v4 and UniswapX live on day one** — the primary AMM (blog.uniswap.org). DexScreener data also shows `sushiswap`, `ramses`, and a dex id `up` (unidentified — UNCERTAIN what "up" is) active on the chain.
- Verified Uniswap v3 addresses on chain 4663 (developers.uniswap.org): Factory `0x1f7d7550b1b028f7571e69a784071f0205fd2efa`, NonfungiblePositionManager `0x73991a25c818bf1f1128deaab1492d45638de0d3`, SwapRouter02 `0xcaf681a66d020601342297493863e78c959e5cb2`, QuoterV2 `0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7`, UniversalRouter `0x8876789976decbfcbbbe364623c63652db8c0904`, Permit2 canonical `0x...22D473030F116dDEE9F6B43aC78BA3`.

**Launchpads (pump.fun-style):**
- **hood.fun** — "HoodFun", launched 9 Jul 2026 (third-party, despite the name; not run by Robinhood). Fair-launch bonding curve, 1B supply, 80% sold on curve / 20% reserved; a **Migrator contract graduates filled curves into a permanently locked Uniswap v3 pool**. Also runs hood.tools swap UI.
- **Noxa** — `fun.noxa.fi/robinhood`; reported ~18,600 token launches/day on the chain (Yahoo Finance/GeckoTerminal).
- **PONS** — permissionless pump.fun-style launchpad on Robinhood Chain.
- Maestro's launchpad support list for the chain names many more: **Virtuals, Bankr, Flap.sh, Livo.trade, Trench.today, Bags.fm, RobinFun, LeaveHood, HoodFun, ApeStore, Printr, Pons** (maestrobots.com blog).
- **pump.fun itself did NOT deploy a launchpad there** — on ~9 Jul 2026 it added **cross-chain trading** of Robinhood Chain tokens from its app, paid in SOL, no bridging (The Defiant).
- Flagship memecoins: CASHCAT (peaked ~$100–156M cap), Hoodrat, Cash Dog in Hood, PONS, FOX etc.

## 3. Data aggregators (and slugs)

- **DexScreener: YES.** Web: `dexscreener.com/robinhood`. API chainId is exactly **`robinhood`** — verified live via `api.dexscreener.com/latest/dex/search?q=CASHCAT` (all results `"chainId":"robinhood"`, e.g. CASHCAT/WETH pair `0xA70fc67C9F69da90B63a0e4C05D229954574E313` on `uniswap`). Standard free DexScreener API endpoints (`/latest/dex/*`, `/token-profiles/latest/v1`, token-pairs) work for it.
- **GeckoTerminal: YES.** Network id is exactly **`robinhood`** — verified live in `api.geckoterminal.com/api/v2/networks?page=3` (`{"id":"robinhood","name":"Robinhood","coingecko_asset_platform_id":"robinhood"}`). Web: `geckoterminal.com/robinhood/pools`. Its API gives pools, new pools, trending, and OHLCV — useful for the "died after call" section.
- **Birdeye: NO EVIDENCE** of Robinhood Chain support as of Sept 2026 — UNCERTAIN, but repeated searches found nothing; treat as unsupported.
- Others exposing the chain: DEXTools, Nock Terminal, GoBolt, HoodTracker, StalkChain, Stock Terminal, Zardoz (nockterminal.com screener comparison).

## 4. Trading frontends / bots on Robinhood Chain

| App | HOOD support | Notes |
|---|---|---|
| **Axiom** | YES (11 Jul 2026, first major terminal) | Full suite: limit orders, MEV protection, wallet tracker; chains: Solana, BNB, Ethereum, Robinhood |
| **GMGN** | YES | URL format `gmgn.ai/robinhood/token/0x...`, `gmgn.ai/?chain=robinhood`; trades Bags tokens on Robinhood too |
| **Maestro** | YES | Uniswap v2/v3/v4 + the long launchpad list above |
| **Banana Gun** | YES (day one) | Same Telegram bot as ETH/SOL/BNB/Base |
| **Bloom** | YES | Chains: Solana, Ethereum, BSC, Base, **Robinhood**, Arc, HyperEVM |
| **OKX Wallet** | YES (Jul 2026) | Integrated across web / extension / mobile, no manual RPC needed; OKX DEX aggregator routing |
| **BullX** | DEAD | Trading suspended **1 Jun 2026**, never resumed; community treats it as permanent shutdown, airdrop never delivered — do not link to it |
| **Photon** | NO EVIDENCE | Described in 2026 sources as Solana-focused; no Robinhood integration found — UNCERTAIN |
| **Trojan** | NO EVIDENCE for HOOD | Solana-focused; Phanes has labels for it (tro/trt) but nothing ties it to Robinhood Chain — UNCERTAIN |
| Phantom wallet | YES (23 Jul 2026) | Wallet-level support, useful context |
| pump.fun app | Trading only | Trade HOOD tokens in SOL, cross-chain |

**Phanes label decoding** (from Phanes docs/commands, docs.phanes.bot — site blocks direct fetch, decoded via indexed copies; Phanes itself supports Solana, BSC, Ethereum, Base and Robinhood chains):
- **GM** = GMGN (`gm`/`gm_tg`)
- **AXI** = Axiom (`axi`)
- **FMO** = FOMO (`fmo`) — the memecoin trading app "FOMO"
- **OKX** = OKX Wallet (`okx`)
- **BSD** = Based Bot (`bsd`)
- **MAE** = Maestro (`mae`, Pro = `maep`)
- **TRM** = listed in Phanes docs as "Terminal" (`trm`) — distinct from Trojan (`tro`) and Trojan Terminal (`trt`); exactly which "Terminal" product is UNCERTAIN
- **BAN** = Banana Gun (`ban`)
- **SIG** = Sigma Bot (`sig`)
- **COV** = UNCERTAIN — not found in any indexed Phanes documentation or search source
- **BLO** = Bloom (`blo`)
- (Phanes also has: BullX `blx`, BullX NEO `neo`, Photon `pho`, Pepe Boost `pep`, BONKbot `bnk`, Sol Trading Bot `stb`, MevX `mvx`, Ave `ave`, Shuriken `shu`)

## 5. Indexing new token launches directly from chain data

If aggregator APIs lag, an app would:
- **Subscribe to factory events** over WebSocket (`eth_subscribe` logs via Alchemy WS): Uniswap v3 `PoolCreated` on factory `0x1f7d...2efa`, v2 `PairCreated`, v4 `Initialize` on the PoolManager (v4 address not captured — on the same Uniswap deployments docs). New ERC-20s themselves are just contract creations; the tradable moment is pool creation or launchpad curve creation.
- **Watch launchpad contracts** (hood.fun token-create + Migrator "graduation" events; Noxa; Pons) for pump.fun-style pre-DEX activity — contract addresses must be pulled from each launchpad's docs/explorer (not captured here).
- **Real-time option:** the chain publishes an Arbitrum **sequencer feed** at `wss://feed.mainnet.chain.robinhood.com` for pre-confirmation transaction streaming — 100 ms blocks mean very high block cadence, so log subscriptions beat block polling.
- **Managed indexers already support the chain:** Envio **HyperIndex/HyperSync** has a dedicated `robinhood` page (claims up to 2000x faster historical sync); **The Graph** lists Robinhood Chain Mainnet as a supported network for subgraphs; **Goldsky** offers subgraphs + RPC for it; **Ormi Subgraphs** indexes it. All have free hobby tiers historically (pricing not re-verified — UNCERTAIN).
- Blockscout explorer API would be the zero-infra option but see the Cloudflare-challenge caveat above.

## Bottom-line recommendation

Build Groupie v1 exactly as planned on Robinhood Chain — the chain is real, live (mainnet 1 Jul 2026), open, and standard EVM, so ordinary EVM tooling works. Concretely: (1) treat chain id 4663 / ETH gas / 0x addresses as fixed; (2) use DexScreener API (chainId "robinhood") as the primary free market-data source and GeckoTerminal API (network "robinhood", includes OHLCV) as backup and for "died after call" price history — skip Birdeye; (3) for link-outs, mirror what Phanes/Rick users already tap: Axiom, GMGN (gmgn.ai/robinhood/token/{addr}), Maestro, Banana Gun, Bloom, OKX, DexScreener, and the Blockscout explorer — do NOT link BullX (shut down June 2026), and skip Photon/Trojan for HOOD; (4) for direct launch detection, get a free Alchemy key (the officially recommended provider with WebSocket support on robinhood-mainnet) and subscribe to Uniswap v2/v3/v4 factory events plus hood.fun/Noxa/Pons launchpad contracts, or use Envio HyperIndex/Goldsky if you'd rather not run raw log subscriptions — the 100 ms block time makes WS log subscription, not block polling, the right pattern; (5) don't depend on the Blockscout API until you've confirmed it isn't Cloudflare-blocked from your server.

## Open questions for the owner

- Which trading app links do your group's members actually click (Axiom vs GMGN vs OKX vs Telegram bots)? This should drive which of the ~8 possible link-outs Groupie shows per token.
- Monthly budget for infra: is a free Alchemy/QuickNode tier acceptable for v1, or should the app rely purely on free DexScreener/GeckoTerminal APIs with no own RPC at first?
- Should v1 also resolve Solana-side plays (pump.fun trades HOOD tokens in SOL; the group may also call Solana CAs), or is strict Robinhood-Chain-only acceptable?
- Do you need launchpad-phase (pre-Uniswap-graduation) tokens on the board, or only tokens that have a DEX pool? Pre-graduation tracking requires per-launchpad contract integration (hood.fun, Noxa, Pons).
- What exact trading-app link label does 'COV' in Phanes point to in your group's messages? Tapping one of those links in Telegram would settle the one label I could not identify.

## Sources consulted

- https://forum.arbitrum.foundation/t/arbitrumdao-factsheet-robinhood-chain-mainnet-launch/31041
- https://blog.arbitrum.io/robinhood-chain-mainnet/
- https://robinhood.com/us/en/newsroom/robinhood-chain-launches-public-testnet
- https://robinhood.com/us/en/newsroom/robinhood-accelerates-global-expansion-robinhood-chain-mainnet-stock-tokens-agentic-trading/
- https://docs.robinhood.com/chain/connecting/
- https://docs.robinhood.com/chain/
- https://chainlist.org/chain/4663
- https://defiprime.com/robinhood-chain
- https://thedefiant.io/news/tokens/pump-fun-adds-trading-for-robinhood-chain-tokens-as-cashcat-meme-coin-frenzy-builds
- https://www.coindesk.com/tech/2026/07/13/robinhood-built-a-blockchain-for-tokenized-stocks-memecoins-took-over
- https://finance.yahoo.com/markets/crypto/articles/robinhood-chains-unexpected-meme-meta-203946066.html
- https://hood.fun/
- https://technologymagazine.com/globenewswire/3324698
- https://dexscreener.com/robinhood
- https://api.dexscreener.com/latest/dex/search?q=CASHCAT
- https://docs.dexscreener.com/api/reference
- https://api.geckoterminal.com/api/v2/networks?page=3
- https://www.geckoterminal.com/robinhood/pools
- https://blog.uniswap.org/robinhood-chain-is-live
- https://developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-chain-deployments
- https://solana-trading.com/blog/axiom-integrates-robinhood-chain-hood-trading-100k
- https://gmgn.ai/blog/robinhood-chain-meme-coins-with-gmgn/
- https://www.maestrobots.com/blog/robinhood-chain-trading-bot
- https://cryptopotato.com/maestro-supports-robinhood-chain-the-fastest-trading-bot-on-the-new-l2/
- https://blog.bananagun.io/blog/banana-gun-robinhood-chain
- https://www.bloombot.app/
- https://docs.bloombot.app/
- https://fxdailyreport.com/okx-wallet-expands-multi-chain-ecosystem-with-robinhood-chain/
- https://ourcryptotalk.com/news/bullx-shutdown-trading-airdrop
- https://moby.win/learn/bullx-shutdown/
- https://solanacompass.com/news/phantom-adds-robinhood-chain-support-bringing-tokenized-stock-defi-to-solanas-biggest-wallet
- https://docs.phanes.bot/phanes/commands
- https://t.me/s/phaneshub
- https://www.findmini.app/phanes_bot/
- https://docs.envio.dev/docs/HyperIndex/robinhood
- https://thegraph.com/docs/en/supported-networks/robinhood/
- https://goldsky.com/chains/robinhood
- https://blog.ormilabs.com/ormi-subgraphs-robinhood-chain/
- https://robinhoodchain.blockscout.com
- https://robinscan.io/
- https://nockterminal.com/best/robinhood-chain-token-screeners
- https://www.quicknode.com/builders-guide/tools/robinhood-chain-public-rpc-by-robinhood-markets
- https://tatum.io/chain/robinhood
