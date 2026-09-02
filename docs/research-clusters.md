# Cluster-map alerts — research memo (2026-09-03)

Owner's ask: "axiom provides insightx and bubblemaps.io cluster maps. is it possible to get the bot
to flag the telegram group when a pasted contract has a cluster of over 10% with an image
automatically sent to the group chat of the cluster? sometimes bubblemaps misses clusters that
insightx gets and vice versa so i'd want the ping if either of them trigger with their respective
image."

Two Opus researchers (provider APIs; self-computed feasibility) + one synthesis. Every claim below
was verified against a live response or a vendor document on 2026-09-02/03 unless marked
UNVERIFIED.

## 1. Answer

Partly, and not in the shape asked for. The NUMBER is buildable today from exactly one vendor;
neither vendor ships an IMAGE, so the picture is ours to draw either way; and "ping if either
provider triggers" is not achievable on Robinhood Chain because InsightX has no data API for it.

## 2. What was verified

**Bubblemaps** (the one that works)
- `robinhood` is in the live OpenAPI chain enum (https://docs.bubblemaps.io/openapi.json);
  changelog 2026-07-13: "Robinhood is now supported across the Data API" — vendor-flagged BETA.
- `GET https://api.bubblemaps.io/v0/tokens/map/robinhood/{ca}` (header `X-ApiKey`) returns
  `clusters[] {share, amount, holder_count, holders}`, share in 0..1 — the owner's rule is
  literally `clusters.some(c => c.share > 0.10)`. Same call carries `metrics.supply_stats`
  (cexs, dexs, contracts, fresh_wallets, top_10_adjusted, bundles) and decentralisation scores.
- Cost: 25 credits per map call (+50 for limit 250, +100 for 500, +25 return_nodes, +25 refresh,
  +50 historical timestamp). Plans (live plans endpoint, unauthenticated): Starter $170/mo =
  100K credits; Standard $850/mo = 750K. NO free tier listed (a trial field exists; terms unknown).
  Rate limit 10K calls/min per IP; over-credit = 429. Keys self-serve at https://pro.bubblemaps.io.
- Their docs name "a telegram trading bot" as the intended Data API customer.
- The LEGACY iframe API rejects robinhood (HTTP 400 "Invalid chain parameter"); `map-data` 404s.
- No image endpoint: zero occurrences of image/png/svg/screenshot across all 12 OpenAPI paths.
- Fresh-CA coverage on the beta chain is UNVERIFIED (expect 404 "no holders" for minutes-old
  tokens; snapshots dated by `X-Dt-Update`).

**InsightX** (does not work for this chain)
- Data API supported networks: sol, eth, base, bsc, monad, xlayer, abs, sui — NO robinhood;
  unsupported networks return 422. Atlas snapshot API decommissioned.
- Robinhood appears only in the Atlas Live EMBED chain table (iframe; needs a paid `embed_id`
  + domain whitelist; prices "quoted individually"). The embed yields no numbers; its og:image is
  one static card for every token.
- Free API tier exists (5 req/min, 1,000 req/mo) — enough for this group IF they ever add
  robinhood to DEX Metrics. Ask: info@insightx.network.

**Self-computed clusters** (possible, but the signal is not there)
- Data is cheap: on Alchemy PAYG, `eth_getLogs` has an UNLIMITED block range on Robinhood Chain
  (150 MB response cap), so a fresh coin's whole Transfer history is one 75 CU call. Multicall3 is
  deployed at the canonical address → exact `balanceOf` for 150 holders in one 26 CU call.
  GeckoTerminal `/tokens/{ca}/info` gives holders.count, top-10 / 11-30 / 31-50 distribution and
  developer holding for free (GT grant), but as a SNAPSHOT that lands hours after launch.
- Measured on a real group call (HDFI, first 30 min, 2,039 Transfer logs, 442 addresses): the
  ERC-20 transfer graph among the top-150 holders had 0 direct edges and 0 same-transaction edges;
  all 7 "shared funder" candidates were CONTRACTS (routers/aggregators, one fanning out to 113
  recipients). A naive rule printed "29.26% cluster · 45 wallets" for 45 strangers who used the
  same router. With an EOA-only funder rule: 0 edges, largest "cluster" = 1 wallet at 8.16%.
- Why Bubblemaps sees what we cannot: their clustering is on FUNDING (native transfers, which
  emit no logs) + cross-token recurrence + timing. The only affordable funding source is
  `alchemy_getAssetTransfers` (category external, 120 CU per holder, ~18K CU per CA) — UNVERIFIED
  whether it works on robinhood-mainnet (Alchemy's method page does not list the chain).
- Robinhood Chain ships native account abstraction: 5 of HDFI's top-20 holders (incl. the largest,
  8.16%) are nonce=1 smart wallets funded via EntryPoint/paymaster — a funder rule sees the
  infrastructure, not the human. AA holders must stay singletons, never fused.
- Rendering needs no browser: d3-force (headless ticks) → SVG → `@resvg/resvg-js` (bundle a .ttf,
  `loadSystemFonts:false` or text renders blank on Railway), 1000×1000 PNG, then grammY
  `sendPhoto` with the existing reply_parameters onto `calls.messageId`.
- Blockscout: the keyed host now answers HTTP 402 (paid/keyed wall); the public instance is
  Cloudflare-gated. A free dev.blockscout.com key would make `/tokens/{addr}/holders` one call —
  an owner chore, not a build.

## 3. Capability matrix

| | InsightX | Bubblemaps | Self-computed |
|---|---|---|---|
| Robinhood Chain | embed only; REST 422 | yes (V0 API, beta) | yes (own RPC) |
| Cluster data | none | `clusters[].share` (top 80/250/500) | computable, but no signal in the transfer graph |
| Image | no (static card) | no | ours (d3-force → resvg) |
| Cost per CA | n/a | 25 credits ≈ $0.043 | ~600 CU ($0.0003) without funding edges; ~19K CU ($0.009) with |
| Monthly | $0 | $170 fixed | ~$5 at 20 calls/day |
| Latency | n/a | 1–3 s + render | 5–15 s |
| Risk | n/a | fresh CAs may 404 for a while (beta); ToS page unreadable to a fetcher | measured false positive on the first live test |

## 4. Recommendation

A. **Probe before paying** (owner, ~30 min): one month of Starter or a trial key; run the map call
   against 3–5 real group CAs including one minutes old. If fresh calls 404 for ~40 min, the
   feature is a delayed re-check, not a paste-time ping.
B. **Ship the honest half at $0**: GT's top-10 / developer holding + our launch-block bundle share
   as board pills. Real concentration facts; not clusters, never labelled as such.
C. **Cluster alerts = Bubblemaps data + our renderer**, gated on A. One photo reply per token,
   once, caption numbers only ("largest cluster 23% · 9 wallets · top 10 hold 61% · snapshot 4m
   old · via Bubblemaps" + deep link), `/overseer set clusters off`, hard monthly credit ceiling
   in code, own pacing so it never trips the discovery back-off. Do NOT ship self-computed
   clusters as a second opinion until the funding leg is verified on this chain.
D. **Email InsightX** for `robinhood` on DEX Metrics — their free tier covers this group, and it
   is the only thing that makes "either provider" real.

Build estimate (Opus): ~350K tokens for B; ~450K for the vendor client + renderer + sendPhoto +
tests; ~600K–1M for the adversarial review. Deep links to both vendors' maps on every card are
free today and can ship with B.

## 5. Owner questions

1. $170/month recurring for Bubblemaps — the project's first paid subscription. Yes or no?
2. If fresh CAs are not indexed for 20–40 minutes, is a delayed cluster reply still useful?
3. Is an overseer-drawn map acceptable, with the caption saying the data is Bubblemaps' and the
   picture is ours?
4. Owner chores on the critical path for the cheap paths: a free Blockscout Pro key; verifying
   `alchemy_getAssetTransfers` on robinhood-mainnet with the existing key.
