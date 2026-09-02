# On-chain reference — Robinhood Chain (4663)

Every address and every event signature the discovery build reads, with **how it
was verified**. Nothing here was copied from a chat message or guessed from a
name: each row was either read off the chain from this machine on 2026-09-02, or
cross-checked against two independent sources.

Verification transport: the public RPC `https://rpc.mainnet.chain.robinhood.com`
(read-only `eth_chainId` / `eth_call` / `eth_getLogs` / `eth_getTransactionReceipt`).
It answered `eth_chainId` = `0x1237` = **4663**, which is what makes every reading
below a reading of THIS chain. The public RPC is rate-limited and unusable in
production — the runtime client talks to Alchemy — but it is fine for one-off
verification.

Signature hashes were computed locally with `@noble/hashes/sha3` (keccak-256) and
independently confirmed against openchain.xyz's signature database, which reports
`hasVerifiedContract: true` for both PONS events.

The three signatures added by the round 18/20 review — v2 `Mint`, v4 `Swap`,
PONS `TokenLaunched` argument positions — were verified the same way on
2026-09-03: keccak-256 locally from the exact signature string, then the topic0
queried against the live chain over the same public RPC and the log SHAPE
(topic count and data-word count) checked against what the signature predicts.
A hash that matches nothing on chain is not a verification, which is how the
7-argument v4 `Swap` variant was ruled out.

---

## Tokens

| What | Address | How verified |
|------|---------|--------------|
| WETH | `0x0bd7d308f8e1639fab988df18a8011f41eacad73` | `symbol()` → `WETH`, `decimals()` → 18. It is `token0` of the v2 pair GeckoTerminal names "Rabbit / WETH" AND of the v3 pool it names "USDG / WETH 0.01%". |
| USDG | `0x5fc5360d0400a0fd4f2af552add042d716f1d168` | `symbol()` → `USDG`, `decimals()` → **6**. `token1` of the same v3 pool. |
| native ETH (v4) | `0x0000000000000000000000000000000000000000` | Uniswap v4's currency encoding; seen as `currency0` on the PONS graduation pool below. |

USDG's 6 decimals are the trap here: a quote amount read as 18 decimals would be
out by 10^12 and every USDG-quoted launch would look like dust.

## Uniswap v2

| What | Value | How verified |
|------|-------|--------------|
| Factory | `0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f` | `factory()` (`0xc45a0155`) read off TWO independent live pairs — `0x0c65b17e3dd8d04b24503630a333c73d51a29678` ("Rabbit / WETH") and `0x4a6a85252a6f6b383a5f747259ee157e65ff1307` ("SHRUB / WETH"), both taken from GeckoTerminal's `uniswap-v2-robinhood` listings. Both answered this address. `allPairsLength()` on it returned `0x9d83` = 40,323 pairs, so it is a real UniswapV2Factory and not a proxy that merely answers the selector. |
| `PairCreated(address,address,address,uint256)` | topic0 `0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9` | keccak-256 computed locally; confirmed live by `eth_getLogs` on the factory over blocks `0x31c1000`–`0x31cddc3` (~50K blocks, ~1.4h) → **2 logs**, e.g. tx `0x87d5adcc4dcacf19166839b91bf4960bcb05a564470acc157d98643acc9f32e2`, `topics[1]` = WETH, `data` = pair `0x887c2718bfc9133ce881c09f0df18ba572189236` + index `0x9d82`. |
| `Mint(address indexed sender, uint256 amount0, uint256 amount1)` (pair) | topic0 `0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f` | keccak-256 computed locally with `@noble/hashes/sha3` from that exact signature, then **observed live** (2026-09-03) on the Rabbit/WETH pair `0x0c65b17e3dd8d04b24503630a333c73d51a29678`: 3 Mint logs, each with **2 topics** (topic0 + indexed sender) and **2 data words** (amount0, amount1) — exactly the signature's shape. The first carries `amount0 = amount1 = 1e18`. **This is the v2 deposit source** (see "initial reserve"). |

v2 is a trickle on this chain (2 pairs in 1.4h) next to v4, which is why the v4
listener carries the weight.

## Uniswap v4

| What | Value | How verified |
|------|-------|--------------|
| PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` | developers.uniswap.org's v4 deployments page lists chain 4663 with this PoolManager; confirmed on chain by `eth_getLogs` against it (45 `Initialize` logs in 3,000 blocks). A docs address that emits the right event at the right rate is verified, not merely quoted. |
| `Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)` | topic0 `0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438` | keccak-256 computed locally; every one of those 45 logs carries it. Indexed: `id`, `currency0`, `currency1`. Data words: `fee`, `tickSpacing`, `hooks`, `sqrtPriceX96`, `tick`. |
| `ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)` | topic0 `0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec` | keccak-256; seen in the graduation receipt below. Carries liquidity UNITS, not token amounts — which is why it is not the reserve source. |
| `Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)` | topic0 `0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f` | keccak-256 computed locally from that exact signature (the 7-argument variant without `fee` hashes to `0x9cd312f3…`, which matches nothing on chain), then **observed live** (2026-09-03) on the PoolManager: 1,620 logs in 200 blocks, every one with **3 topics** (topic0 + pool id + sender) and **6 data words** — amount0, amount1, sqrtPriceX96, liquidity, tick, fee. `amount0`/`amount1` are the CALLER's `BalanceDelta`: negative = what the caller paid in. **This is what makes a v4 deposit separable from a v4 buy** (see "initial reserve"). |

Also listed for 4663 by the same Uniswap docs page (recorded, not used):
PositionManager `0x58daec3116aae6d93017baaea7749052e8a04fa7`, StateView
`0xf3334192d15450cdd385c8b70e03f9a6bd9e673b`, Quoter
`0x8dc178efb8111bb0973dd9d722ebeff267c98f94`, UniversalRouter
`0x8876789976decbfcbbbe364623c63652db8c0904`. Uniswap **v3** factory
`0x1f7d7550b1b028f7571e69a784071f0205fd2efa` was already recorded in
`docs/research-robinhood-chain.md`; round 18 scopes launch detection to v2 + v4,
so v3 is out of the listener by decision, not by ignorance.

A v4 "pool address" is a 32-byte **pool id**, not a contract. GeckoTerminal
reports it in the `address` field exactly as the id, so the two agree and
`discovery_events.pool_address` stores whichever the chain gave.

### Hooks seen in one 3,000-block sample (why the hook matters)

| Hook | Initialize logs | Reading |
|------|-----------------|---------|
| `0x0000…0000` | 24 | plain Uniswap v4 pools |
| `0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544` | 12 | a launchpad's own hook (dynamic fee `0x800000`) |
| `0x778b0c4eea7d35d66513b587ba87fc9084b0eacc` | 5 | another hook |
| four others | 1 each | — |

The listener treats every `Initialize` as a Uniswap v4 launch EXCEPT the PONS
graduation hook below, which is a migration and belongs on the graduation
stream.

## PONS v2

| What | Value | How verified |
|------|-------|--------------|
| Factory | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` | carried over from `docs/research-features-2.md` §6 and re-confirmed live: 48 logs in 3,000 blocks, all from this address. |
| `TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)` | topic0 `0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607` | keccak-256 of that exact signature reproduces the topic0 the earlier research pass observed but could not name; openchain confirms the name. 40 of the 48 logs. Data sample carried `0x3a4965bf58a40000` = 4.2 ETH, matching the "2.61 of 4.2 ETH" reading in the earlier pass. **Argument POSITIONS re-verified live** (2026-09-03) by filtering the factory on `[tokenLaunched, addressTopic(Stride)]`: exactly one log, block 52,216,963, 4 topics + 3 data words, `topics[1]` = Stride, `topics[2]` = curve `0x7b2864c490875f64ec2666d7055074c1c9e182af`, `topics[3]` = deployer `0xad6b3c64caf01997ff2708dfe3ece6ee164ffa03` — the same deployer the graduation's `PoolRegistered` carries. **This is the graduation stream's way back to a coin's launch block and its curve** (see "launch-block bundle facts"). |
| `CreatorFeeRecipientUpdated(address,address,address)` | topic0 `0x308c390ed1ab5873392818e036cabdf408bc8ad042fbaead3108954ff75ba980` | the other 8 logs. Recorded because it is the event a graduation hunt trips over first: three indexed addresses, no data, ~1 per 5 launches — it LOOKS like a graduation and is not. |
| **`PoolGraduated(address,uint256,uint256,uint256)`** | topic0 `0x0a44ef75df69c534f43cd6c1aa3ef8983065fe5fe79ef9e79f6494e6f258c259` | **VERIFIED, three ways.** (1) openchain resolves the topic0 to this signature with `hasVerifiedContract: true`; (2) keccak-256 of the signature reproduces the topic0 exactly; (3) decoded live from tx `0x012e2f9382225c9c93fcb4e61d5cae640d79c975fa901dce5b85b533ecdafd24`, emitted by the PONS factory, `topics[1]` = `0x446d76590389b371fbbf53a5d9649522d1946d7e` — whose `symbol()` is `Stride`, the token of the `pons-v2-dex` pool GeckoTerminal listed as "Stride / WETH" created at the same moment. Only the token argument is named with confidence; see the caveat below. |
| Graduation hook | `0xe5e702641ea86f4ae6cc3cdaed2b886f976be044` | the `hooks` word of the v4 `Initialize` in that same graduation tx. Matches the hook `docs/research-features-2.md` §3.3 recorded as `0xE5e7…e044`. |
| `PoolRegistered(bytes32,address,address,address)` | topic0 `0x01bf263a1db1652580721573296e1a1fa70b3d4c87f61d02a69c4e1109d2d573` | emitted by that hook in the same tx; openchain + keccak agree. `topics[1]` = pool id `0x5564cb672e00e6bc03200b0f13d0377180544201f550da352b632efae7b8ee88` — **byte-for-byte the pool id GeckoTerminal lists for the `pons-v2-dex` "Stride / WETH" pool** — and the first data word is the token. This is the join that gives a graduation its destination pool. |

### The curve is the SINK — observed live (2026-09-03 ~04:45Z)

Follow-up to the `TokenLaunched` row above, over the same public RPC at head
52,295,285. The bundle measurement further down assumes a PONS coin's supply is
sold OUT of its curve, so a buy is `Transfer(from = curve)`. Two coins were read
end to end to check that assumption rather than repeat it:

- `0x72eb2f3948914ac8350520ad59bd07a0f96bede1` — `TokenLaunched` at block
  52,289,609 (graduated at 52,293,705), curve
  `0x9fdb7bdd16b820f088d2055e211512b15782ca6f`, deployer
  `0x29e9bc56d4d48c383177690b8bebc5cdd8bd298a`. Its token `Transfer`s over
  [52,289,609 – 52,289,611] are exactly two, both inside the launch tx
  `0xfcce54fd88…`: `0x0 -> curve` (the ENTIRE supply mint) and then
  `curve -> deployer` for ~23.45% of supply. Supply arrives at the curve first,
  and a curve buy is literally `Transfer(from = curve, to = buyer)`.
- `0x54eb1d415cd1fb8dddfec708c55ae700c944e20d` — `TokenLaunched` at 52,287,663
  (graduated at 52,294,813), curve `0x64c07628003ecdfd298eeb6c77186ac30a9e6678`.
  Its window holds ONLY the `0x0 -> curve` mint, so **0% / 0 wallets is a TRUE
  reading** there, not a failed one.

Hence the defensive rule in `computeLaunchBlockShare`: a window with decodable
`Transfer`s in which the sink appears as neither `from` nor `to` in ANY of them
answers **null**. A real curve, pair or singleton launch always shows supply
arriving at its sink; total absence proves the sink assumption wrong for that
coin, and any share computed from it would be a confident 0% about the wrong
address. Unknown is the honest answer.

### UNVERIFIED, and therefore not used

`PoolGraduated`'s three `uint256` arguments have no names in any source available
here (the public Blockscout instance is Cloudflare-gated to non-browser clients —
`api/v2/smart-contracts/...` answered 403 — and the keyed `api.blockscout.com/4663`
host needs a free key nobody has provisioned). The sample decoded to
`1471287`, `204081632653061227960571983` (~2.04e26, plausibly a token amount) and
`4200000000000000250` (~4.2 ETH, suspiciously equal to that launch's
`graduationThreshold` plus 250 wei).

The third word is *probably* the ETH migrated into the pool. Probably is not a
number the board may print, so **graduation rows carry no initial-liquidity
figure**: `initial_liquidity_eth` / `initial_liquidity_usd` stay null and the
row's LP number comes from DexScreener enrichment, which is measured rather than
inferred. If the verified ABI ever lands, naming those words is a one-line change
in `apps/server/src/chain/addresses.ts`.

## ERC-20

`Transfer(address,address,uint256)`, topic0
`0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef` (keccak-256,
canonical). Used in both measurements below.

## Initial reserve — the DEPOSIT, never a buy

**Corrected after the round 18/20 review.** The first cut summed the quote
token's transfers INTO the new pool over the launch window and called that
"exact". It is not exact and it is not the deposit: a buy in the same window
settles through the same address, so a launch sniped for 40 ETH would have
printed "40 ETH liquidity" in the chat while the team put up two. Both venues
are now measured by the event that actually names a deposit
(`apps/server/src/chain/reserve.ts`, pure, fixture-tested):

- **Uniswap v2** — sum the QUOTE side of every `Mint(sender, amount0, amount1)`
  emitted by the pair itself over `[launch block, +bundleBlockSpan]`. Which side
  is the quote comes from the `PairCreated` `token0`/`token1` ordering
  (`LaunchCandidate.quoteIsCurrency0`); a buy is not a Mint, so it cannot be
  counted. Several Mints in the window are several deposits and they sum.
- **Uniswap v4, ERC-20 quote** — one singleton holds every pool, so nothing is
  separable by address; it is separable by EVENT. Both events live inside the
  CREATING transaction, so ONE `eth_getTransactionReceipt` (15 CU) supplies
  both: quote transferred into the PoolManager, MINUS what a same-transaction
  buyer paid, read off this pool id's own `Swap` logs (a negative caller delta
  on the quote side is what the buyer handed over; subtract its magnitude). A
  positive delta is the caller RECEIVING quote (a sell) and takes nothing out of
  the deposit. The receipt replaced two `eth_getLogs` (150 CU) for the same two
  answers; a receipt that cannot be read is `unknown_reserve`, never "no swaps
  happened".
- **Uniswap v4, native ETH** — no ERC-20 moves at all, so the inbound side is
  `eth_getTransactionByHash(txHash).value`, minus the same swap subtraction off
  the same receipt (15 + 17 = 32 CU), and only for a candidate that already
  cleared every free check. A read that fails keeps the existing
  `unknown_reserve` rejection — it is the same provider that just served the
  range's logs, so a failure there is a provider problem, not a property of the
  launch. This closes the previous "native-ETH launches are silently dropped"
  gap. `value` is an UPPER BOUND: same-tx native refunds, sweeps back to the
  deployer and launchpad ETH fees emit no log and are therefore not subtracted.

Cost of the whole deposit read, after the free checks and before the bundle
reads: **v4 with an ERC-20 quote 15 CU, v4 native 32 CU, v2 75 CU** (one
`eth_getLogs` over the pair's `Mint`s, which span blocks a single receipt cannot
cover).

Residuals, stated rather than hidden. A multi-hop route that swaps THROUGH the
new pool on its way elsewhere settles its other legs through the same singleton,
and those legs are not this pool's `Swap` logs — such a transaction can
OVERSTATE a v4 deposit, and the launch-block share printed on the same row is
what exposes that pattern. The subtraction is also exact only when the buyer's
quote entered via an ERC-20 `Transfer` in the same transaction: a routed or
claim-funded buy is subtracted without ever having been added, so the figure can
UNDERSTATE too and, at the extreme, drive the difference to zero or below — which
is reported as unknown and rejects the launch rather than printing a small
deposit nobody made.

Which figure is measured and which is derived depends on the quote, and the row
records it in `discovery_events.quote_symbol`: an ETH pool's ETH amount is the
measurement and its dollars come from the ETH price; a USDG pool's dollars are
the measurement (units / 1e6) and its ETH is derived. `initialLiquidityEth` is
the ETH-equivalent every threshold compares against either way, and the chat
line prints what was actually deposited — "5.8 ETH liquidity" or
"$12K USDG liquidity".

## Launch-block bundle facts — pool OUTFLOWS

Also corrected by the review. Netting every non-excluded recipient counted the
deployer's own mint (`0x0 -> deployer -> pool`) as a 100% bundle — the exact
opposite of the truth about a clean launch. The measurement
(`computeLaunchBlockShare`) is now: over `[launch block, +bundleBlockSpan]`,
count only `Transfer`s whose **sender is a SINK** — the v2 pair, the v4
singleton, or the PONS curve — to a non-excluded recipient; net each recipient
against what it sends back to a sink or forwards onward (a router fan-out
`pool -> router -> buyer` therefore counts once, for the buyer); wallets are the
distinct recipients with a positive net balance. The excluded set holds the
sinks, the token itself, `0x0`, `0xdead`, the two Uniswap factories/singleton,
the PONS factory and hook, and — for v4 — the pool's own hook, which can hold
launch supply in custody and would otherwise read as one whale. Unreadable logs
or an unreadable `totalSupply()` answer **null**, which is rendered as unknown
and is never hidden by the bundle filter.

**Graduations** measure this from the coin's ORIGINAL launch, not the graduation
block (round 20: "measured from the launch"). One `eth_getLogs` on the PONS
factory filtered to `[tokenLaunched, addressTopic(token)]` gives the launch block
and the curve address (`topics[2]`); the token's `Transfer` logs over that
window, with the curve as the sink, give the share. The range is `earliest` — a
coin can sit on its curve for weeks — and a provider that REFUSES THE RANGE gets
ONE retry over the last `DISCOVERY.gradLaunchLookbackDays` (35) of blocks. (The
public Robinhood RPC does refuse it: it answered `expected fromBlock to be a hex
string starting with 0x` to `earliest`, which is why the retry exists rather than
being theoretical.) Only a range refusal is retried — JSON-RPC `-32602`, or a
provider text (`details`, never viem's `message`, which always carries the
request body) naming the block range / too many results; a timeout, a 429 or an
auth failure would fail the narrower query identically, so those are NOT retried:
the graduation is stored with its share unknown (null, printed as unknown) and,
being a known pool from then on, is not re-measured. That is the accepted
trade-off — one failed hunt can neither wedge the listener nor spend a second
call. `totalSupply()` is read AT the
launch window (`eth_call` with an explicit block tag, which assumes the archive
`eth_call` Alchemy serves on this plan): the share is a fraction of the supply
that existed when those Transfers happened, and a coin that minted or burned in
the weeks it sat on its curve would otherwise be divided by a denominator from a
different day. Any read that fails leaves the row's bundle facts null and the
board says "launch block unknown".

Graduations are also DEDUPED before any of that is spent: one `seenPools` query
per block range, plus a per-range set of pool ids, so a replayed range cannot pay
for a launch hunt per graduation only for the insert's `on conflict do nothing`
to discard the row.

## Listener shape and constants

- **One `eth_getLogs` per block range**, not four: address
  `[v2 factory, v4 PoolManager, PONS factory, PONS hook]`, topics
  `[[pairCreated, initialize, poolGraduated, poolRegistered]]`, and the logs are
  routed back to their streams by (address, topic0) — an event signature is not
  unique to a contract, so the address has to be part of the test.
- **`DISCOVERY.headLagBlocks` = 3.** The range stops short of the head: a block
  at the tip can still be re-orged away, and the cursor is written to the block
  actually read, so a launch decoded out of an orphan would never be re-read.
- **Request metering is by CU, not by request count.** `chain/client.ts` weights
  each method (`eth_getLogs` 75, `eth_call` 26, `eth_getBlockByNumber` 16,
  `eth_getTransactionByHash` 17, `eth_getTransactionReceipt` 15,
  `eth_blockNumber` 10) and logs "chain client: N CU/hour (M requests)" hourly.
  The free tier is denominated in CU and the methods differ by 7.5x, so a request
  count would have said the listener was cheap on exactly the ticks a batch of
  log queries made it dear. The meter is fed from the transport's own
  `onFetchRequest`, not from the method wrappers, so a viem RETRY — a second
  request the provider bills for — is counted rather than hidden.
- **`chain_cursor.updated_at` is the heartbeat**, stamped on every successful
  tick including ones with no range to read, and served as
  `DiscoveryResponse.lastTickAt`. A quiet feed and a dead one look identical
  without it.
- Other constants added by the review: `maxAlertAgeMinutes` 15 (replaces 60 — a
  restart's backfill must not replay an hour of launches into the chat),
  `lockReadsPerPass` 3 and `lockGiveUpHours` 6 (the GeckoTerminal lock read is
  the one field DexScreener has not got, and GT is the budget the whole app
  competes for), `enrichGiveUpHours` 6, `reenrichMinutes` 10 and
  `reenrichWithinHours` 24 (rows younger than a day are re-read, and
  `data_as_of` is what the board prints as "read 3h ago"),
  `enrichIntervalMs` 30s (enrichment runs on its OWN loop, so a DexScreener
  batch or a GT back-off can never delay the next block range).

## Rates observed (2026-09-02, one 3,000-block ≈ 5-minute window)

- PONS `TokenLaunched`: 40 — the ~20K/day firehose that keeps GeckoTerminal's
  `/new_pools` from ever being the launch feed.
- Uniswap v4 `Initialize`: 45.
- Uniswap v2 `PairCreated`: 2 per ~50K blocks (~1.4h).
- PONS `PoolGraduated`: the sampled window held one confirmed graduation
  (`Stride`); GeckoTerminal's `pons-v2-dex` new-pool listings ran at a couple per
  minute, so the chat cap of 3/h is doing real work.
