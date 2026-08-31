# What DexScreener & GeckoTerminal actually return for dead/rugged Robinhood Chain tokens

All API probes performed live on **2026-09-01** with curl against production endpoints. Chain slugs verified: DexScreener `chainId: "robinhood"`, GeckoTerminal network id `robinhood`. Robinhood Chain is ~2 months old (oldest pools seen: 2026-07-02), so "dead for 1 month" is the oldest death age that exists; multi-year retention was verified on BSC instead.

## Verified dead/rugged specimen tokens (probed live)

| Token | Token address | Pair/pool | Status at probe time |
|---|---|---|---|
| MACRODUCK | `0xf56CF8Dae9E46B4FD43FF5E56d1448401DA5341D` | Uniswap v2 `0x6ba867b8AB066B9b30b765C76919428c0942AbdE` | Rugged ~hours before probe: liquidity.usd **0.12**, priceUsd 1.264e-9, priceChange.h6 **-100**, h24 -99.95, vol.h24 $962K (the pump), **fdv: 1, marketCap: 1** |
| RICE | `0xCfC9433F75fF467D07d73954836Aa8c9d2eb0EeC` | SushiSwap v3 `0xAA7dC0CE3dA4f839aD2e225B8422759F56D636b8` | Rugged 2026-08-31: liquidity.usd **2.03**, priceUsd 5.48e-24, priceChange h1/h6/h24 all **-100**, `fdv`/`marketCap`/`pairCreatedAt` **keys absent** |
| TAXHOOD | `0xb0aFC525F1de3b7E153fCE02010f090f71729f84` | Uniswap v4 pool id `0xa8f1d576...0de09f` (64-hex) | Dead ~5 weeks (created 2026-07-24): liquidity.usd **0.02**, vol all 0, **priceChange: {} (empty object)**, fdv 69 |
| BABYCASHCAT | `0x63fAD809cc89A9B4BD0E5972EE03b6Bddb146ade` | Uniswap v2 `0xc67da73ed62A94Ae45CE87846cAEc00Ee4E2E36C` | Dead since ~2026-07-15: liquidity.usd **0** (base reserve 1e-18), **priceUsd "171511200004900.32"** — a garbage $171 trillion price from dust-reserve math, priceChange {}, fdv/marketCap absent |
| FRONG/USDG on giga | token `0x6245e67affA44a23077f0Ea7f981a8DC743a0c47` | `0x8865623189b40D0284Bcc6DB1345B3ea191CB4D5` | Dead side-pool (26d) of a token whose main pool is healthy ($558K liq) — see "best pair" semantics below |

## Core answer: pairs remain queryable indefinitely; empty array ≠ dead

**1. DexScreener never deletes dead pairs from the address-based API.** Every rugged/dead pair above — including ones dead for a month with liquidity $0 — still returns full JSON from `/latest/dex/pairs/robinhood/{pair}`, `/tokens/v1/robinhood/{token}` and `/token-pairs/v1/robinhood/{token}`. Retention verified at 5 years: the Nov-2021 SQUID rug on BSC (`0x87230146E138d3F296a9a77e497A2A83012e9Bc5`) still returns 20 pairs with `pairCreatedAt` timestamps from Oct 2021. GeckoTerminal likewise still serves the SQUID token and 1-month-dead robinhood pools.

**2. But an empty array does NOT mean dead — it means "not indexed."** DexScreener returns HTTP **200 + `[]`** (`tokens/v1`) or `{"pairs": null}` (`/latest/dex/tokens/`) for a nonexistent address — never 404. Critically, **actively-trading tokens on the `pons-v2` launchpad (Robinhood Chain's bonding-curve launchpad) also return `[]`** — probed live: DOZA (`0x68bd9ce6...`, $8.3K reserve, 102 txns/24h) and HUSTLE (`0x41ec66c6...`, $9.7K reserve, 81 txns) both return empty from DexScreener while GeckoTerminal shows them trading. So a Groupie poller that treats empty-array as "died" will mislabel every pre-graduation launchpad call. GeckoTerminal DOES index pons-v2 (dex ids seen: `pons-v2`, `pons-v2-dex`, `pons-dot-family`, `clanker-robinhood`, `uniswap-v4-robinhood`, `up-v3`, etc.).

**3. The only "hiding" DexScreener does is UI-level.** Official help article ("Why did my token disappear from DEX Screener?", help.dexscreener.com article 1167553): a token with **no transactions in the past 24 hours is hidden from the screener and website search**; it reappears on the next trade. This is why every row in ranked list pages had ≥1 txn/24h. It does NOT apply to address-based API lookups (empirically proven above), and even the API `/latest/dex/search?q=TAXHOOD` still returned the dead pair (liq $0.02). A third-party SEO site (listing.help) claims scam tokens are "removed automatically" — **no official corroboration found and directly contradicted by my probes** (rugged pairs all still served). No scam-flag field exists anywhere in the pair JSON; DexScreener's on-page warnings are not exposed via API.

**4. GeckoTerminal's silent-loss mode is real but different: the token endpoint nulls out.** For dead TAXHOOD, `GET /networks/robinhood/tokens/{addr}` returns 200 with `price_usd: null`, `fdv_usd: null`, `market_cap_usd: null`, `volume_usd.h24: "0.0"`, and **`top_pools: []` (empty relationship)** — while `GET /networks/robinhood/tokens/{addr}/pools` still lists the pools and `GET /networks/robinhood/pools/{pool}` still returns the dead pool. A never-indexed/garbage address returns a proper **HTTP 404** with a JSON:API `errors` array. So GT distinguishes "never existed" (404) from "dead" (nulls + empty top_pools); DexScreener does not (both are `[]`).

## Which fields reliably distinguish dead/rugged from merely quiet

**`liquidity.usd` is the one reliable death signal.** Empirical contrast on the same token (FRONG): rugged/dead pools show liquidity.usd of 0, 0.02, 0.12, 2.03; a merely-quiet pool (FRONG on Ramses) shows liquidity.usd **$7,753 with vol24 $0.15** — liquidity persists when trading merely stops. Suggested classifier from observed data: liquidity.usd < ~$100-500 => rugged/dead (the ranked UI itself showed nothing alive below that); liquidity healthy + txns/volume ≈ 0 => quiet, not dead.

Field-by-field reliability (DexScreener):
- **`liquidity.usd`** — reliable; goes to ~0 on rug and stays there. Caveat: schema marks `liquidity` and `liquidity.usd` nullable, so code must guard for absence (observed present on v2/v3/v4 alike).
- **`volume.h24` / `txns.h24`** — reliable for "quiet" detection, but a rug day shows HUGE volume (MACRODUCK: $962K vol24 with $0.12 liquidity). Dead pairs also still get occasional dust sells (TAXHOOD: 1 sell/24h a month after death). So volume/txns alone cannot detect rugs — combine: high-ish volume + near-zero liquidity = rug in progress.
- **`priceUsd`** — NOT reliable after death: 5.48e-24 (RICE) but also garbage-huge $1.7e14 (BABYCASHCAT) from dust-reserve division. Never compute "x from call" off a dead pair's priceUsd without sanity-clamping.
- **`priceChange`** — shows **-100** in the h1/h6/h24 windows only during/just after the rug, then decays to an **empty object `{}`** once windows roll past all activity. Death detection must therefore be based on Groupie's own stored call-time baseline (mcap/liquidity at call) vs current values, not on the API's priceChange. Code must not assume `priceChange.h24` exists.
- **`fdv` / `marketCap`** — keys are **sometimes absent entirely** on dead pairs (RICE, BABYCASHCAT) and sometimes present-but-tiny (MACRODUCK fdv=1, TAXHOOD fdv=69). `pairCreatedAt` can also be absent on dead pairs. Parse defensively.

GeckoTerminal fields: `reserve_in_usd` is the liquidity analog but has **serious freshness problems for small pools**: hours after the RICE rug, GT still reported reserve_in_usd **$25,721** and price 3.19e-5 (priceChange only -2.8%) while DexScreener correctly showed $2.03 and -100%. Long-dead GT pools are served as a **frozen snapshot** — the dead TAXHOOD/WETH pool still embeds `quote_token_price_usd: 1862.93` (WETH's price at time of last activity; actual WETH was ~$2,460), with no "as-of" timestamp field. One pool even showed a **negative** reserve (-$490,845, STEROID). GT `market_cap_usd` is usually null (only set for CoinGecko-listed tokens) — use `fdv_usd`. A third-party client repo (cryptoscan-pro/gecko-api-public, unofficial) describes GT update tiers by liquidity: <$100 "ULTRA_LOW" pools are updated at the lowest priority, consistent with the staleness observed. UNCERTAIN: exact official refresh intervals — not documented.

## Endpoint semantics that shape the death-detection design

- **`/tokens/v1/robinhood/{addr1,addr2,...}`** returns exactly **ONE pair per token — the current best/primary pair** (probed: HOOD token has 11 pairs, endpoint returns 1; FRONG returned its $558K main pool, not its dead giga pool; VAULT returned its healthy $184K WETH pool, not its drained USDG pool). This is exactly right for Groupie: a token only looks dead when ALL its pools are dead. Batching works with comma-separated addresses (max 30 per call per docs); **unknown addresses are silently omitted from the result array** — map results back via `baseToken.address` and treat missing entries as "not indexed," never as dead.
- **`/token-pairs/v1/robinhood/{addr}`** returns up to 30 pools for the token including dead ones (FRONG: 30 pools, from $558K liq down to the $0 giga pool) — use for exhaustive checks/debugging.
- **`/latest/dex/tokens/{addr}`** returns ALL pairs cross-chain (11 for HOOD) — legacy; chain-scoped `tokens/v1` is safer since the same 0x address can exist on multiple EVM chains.
- Uniswap **v4 pools have 64-hex pool ids** (not 0x40-hex addresses) as `pairAddress`; token addresses stay normal 0x40-hex; all endpoints handle them identically (TAXHOOD probe).

## Rate limits (verified in official DexScreener OpenAPI spec + CoinGecko support, 2026-09-01)

- DexScreener: **300 req/min** for `/latest/dex/pairs/*`, `/tokens/v1/*`, `/token-pairs/v1/*`, `/latest/dex/search`; **60 req/min** for token-profiles/boosts/orders endpoints. No API key. With 30-address batching: up to ~9,000 token refreshes/min — far more than Groupie needs.
- GeckoTerminal public API: **30 calls/min** keyless (hit empirically: burst of ~12 calls triggered 429s with a CoinGecko upsell message); higher limits require a paid CoinGecko API plan (GT endpoints on keyless CoinGecko API are even lower, ~10/min).

## Implications for Groupie's death-detection and polling-decay policy

1. Detect death as: DexScreener best-pair `liquidity.usd` below threshold (e.g. <$250) OR liquidity dropped >95-99% from Groupie's stored call-time/peak value. Confirm "rug vs quiet" with txns: quiet = healthy liquidity + zero txns.
2. Never use API `priceChange` or `priceUsd` as death signals; store call-time mcap/liquidity and compare.
3. Empty `[]` => keep the token in an "unindexed/launchpad" state and (optionally) check GeckoTerminal before concluding anything; on GT, 404 = never existed, nulls+empty top_pools = dead.
4. Dead tokens can be polled forever (no delisting risk), so retention is purely Groupie's choice; decay polling frequency for confirmed-dead tokens (e.g. hourly -> daily) purely to save request budget, and to catch the rare revival (SQUID-style) a daily re-check suffices.

## UNCERTAIN / caveats
- Whether DexScreener would ever manually remove an impersonation pair from the API: no documented policy either way; no removal observed for ordinary rugs.
- Exact GT refresh intervals per liquidity tier (third-party info only).
- Whether pons-v2 tokens appear on DexScreener after "graduation" to Uniswap (pattern strongly suggested by launchpad norms and by graduated pons tokens being visible, but a single token was not tracked through the transition).
- The `/latest/dex/search` API's inclusion rules for zero-activity tokens (dead TAXHOOD appeared, but it had 1 dust txn in 24h).

## Bottom-line recommendation

Build the "died after call" feature on DexScreener as the primary source: dead/rugged pairs are never delisted from the address-based API (verified at 1 month on Robinhood Chain and 5 years on BSC), and `liquidity.usd` on the best pair returned by `/tokens/v1/robinhood/{addrs}` (30-address batches, 300 req/min) is the single reliable death signal — declare "died" when liquidity.usd falls below ~$250 or drops >95% from the call-time value Groupie stored, and "quiet" when liquidity is healthy but txns/volume are ~0. Do NOT use priceUsd or priceChange for death detection (priceUsd becomes garbage after rugs, priceChange becomes an empty object), and NEVER interpret an empty-array response as death — it means "not indexed", which on Robinhood Chain includes actively-trading pons-v2 launchpad tokens; route those through GeckoTerminal (which indexes pons-v2, 30 calls/min, 404 = never existed) but distrust GT's freshness for small pools since it served hours-stale reserve data for a fresh rug. Once a token is confirmed dead, decay its polling to ~daily indefinitely — there is no delisting risk, only request-budget cost.

## Open questions for the owner

- What death threshold matches the group's intuition — absolute liquidity floor (e.g. <$250), percentage drop from call-time liquidity, or drawdown from call-time market cap — and should 'quiet' (liquidity intact, zero volume for N days) be shown in the died section or a separate 'inactive' state?
- How many launchpad-phase (pons-v2) calls does the group actually make? If most calls are pre-graduation, GeckoTerminal integration (or a Pons-specific source) becomes near-mandatory for v1 rather than a fallback — is the 30 calls/min free GT budget acceptable, or is a paid CoinGecko API key (for higher GT limits) in budget?
- How long should dead tokens stay visible in the 'died after call' section before archiving (the APIs impose no limit — retention is purely a product/storage decision)?
- Should Groupie do a slow revival check (e.g. daily) on dead tokens to catch SQUID-style resurrections, or is 'dead is final' acceptable for the group?
- For multi-pool tokens, is the intended semantics 'dead only when the BEST pool is dead' (what /tokens/v1 gives for free) — or should a rug of the specific pool that was hot at call time count as died even if liquidity migrated to a new pool?

## Sources consulted

- https://api.dexscreener.com/tokens/v1/robinhood/0xf56cf8dae9e46b4fd43ff5e56d1448401da5341d
- https://api.dexscreener.com/latest/dex/pairs/robinhood/0xaa7dc0ce3da4f839ad2e225b8422759f56d636b8
- https://api.dexscreener.com/token-pairs/v1/robinhood/0x6245e67affA44a23077f0Ea7f981a8DC743a0c47
- https://api.dexscreener.com/latest/dex/tokens/0x45C83b37C5BAF4dad26f3845C28295e2DE010962
- https://api.dexscreener.com/latest/dex/search?q=robinhood
- https://api.geckoterminal.com/api/v2/networks/robinhood/new_pools
- https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/0xb0aFC525F1de3b7E153fCE02010f090f71729f84
- https://api.geckoterminal.com/api/v2/networks/robinhood/pools/0xc67da73ed62a94ae45ce87846caec00ee4e2e36c
- https://api.geckoterminal.com/api/v2/networks/bsc/tokens/0x87230146E138d3F296a9a77e497A2A83012e9Bc5
- https://docs.dexscreener.com/api/reference
- https://198140802-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2F7OmRM9NOmlC1POtFwsnX%2Fuploads%2FyW7tUJPqX1ECjLZX0TfH%2Fopenapi-spec.yml
- https://help.dexscreener.com/en/articles/1167553
- https://apiguide.geckoterminal.com/faq
- https://support.coingecko.com/hc/en-us/articles/23407777579801-The-rate-limit-for-the-public-GeckoTerminal-API-is-too-low-Can-I-request-a-higher-rate-limit
- https://dexscreener.com/robinhood?rankBy=volume&order=asc&maxLiq=100&minAge=240
- https://github.com/cryptoscan-pro/gecko-api-public
