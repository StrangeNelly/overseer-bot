/**
 * Every address and event signature the discovery listener reads on Robinhood
 * Chain, with the provenance written down in docs/research-onchain.md.
 *
 * Nothing here was guessed. Each topic0 was computed from its signature AND
 * observed on a live log; each address was read off the chain (a `factory()`
 * round-trip, an `Initialize` log, a decoded graduation) rather than taken from
 * a chat message. The one thing that is NOT verified — the meaning of
 * PoolGraduated's three uint256 arguments — is therefore not decoded anywhere
 * below, and the graduation row carries no liquidity figure it cannot back.
 *
 * Addresses are lowercase because that is how logs come back and how the
 * database stores them; every comparison in this build is on lowercase strings.
 */

/** Uniswap v2 factory. Verified: `factory()` off two live pairs; 40,323 pairs. */
export const UNISWAP_V2_FACTORY = '0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f';

/** Uniswap v4 singleton. Verified: Uniswap's own deployments page + live logs. */
export const UNISWAP_V4_POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';

/** PONS v2 launchpad factory (docs/research-features-2.md §6, re-confirmed live). */
export const PONS_V2_FACTORY = '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e';

/**
 * The Uniswap v4 hook a PONS graduation lands on. An `Initialize` carrying this
 * hook is a MIGRATION, not a launch — the coin already lived on the curve — so
 * the launch listener skips it and the graduation stream owns it.
 */
export const PONS_GRADUATION_HOOK = '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044';

/** Quote tokens a launch may be paired against (docs/decisions.md round 18). */
export const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
export const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
/** Uniswap v4's encoding of native ETH. */
export const NATIVE_ETH = '0x0000000000000000000000000000000000000000';

/**
 * Decimals of the quote tokens, verified by `decimals()`. USDG is SIX, not 18 —
 * read as 18 every USDG launch would look like dust and never alert.
 */
export const QUOTE_DECIMALS: Readonly<Record<string, number>> = {
  [WETH]: 18,
  [USDG]: 6,
  [NATIVE_ETH]: 18,
};

/** Is this a quote token a launch may be paired against? */
export function isQuoteToken(address: string): boolean {
  const a = address.toLowerCase();
  return a === WETH || a === USDG || a === NATIVE_ETH;
}

/** Event topic0s. Each computed by keccak-256 AND observed on a live log. */
export const TOPICS = {
  /** UniswapV2Factory.PairCreated(address,address,address,uint256) */
  pairCreated: '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9',
  /** PoolManager.Initialize(bytes32,address,address,uint24,int24,address,uint160,int24) */
  initialize: '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438',
  /** PONS factory.PoolGraduated(address,uint256,uint256,uint256) — token indexed. */
  poolGraduated: '0x0a44ef75df69c534f43cd6c1aa3ef8983065fe5fe79ef9e79f6494e6f258c259',
  /** PONS hook.PoolRegistered(bytes32,address,address,address) — pool id indexed. */
  poolRegistered: '0x01bf263a1db1652580721573296e1a1fa70b3d4c87f61d02a69c4e1109d2d573',
  /** ERC20.Transfer(address,address,uint256) */
  transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  /**
   * UniswapV2Pair.Mint(address indexed sender, uint256 amount0, uint256 amount1)
   * — a DEPOSIT into the pair. This is what "initial liquidity" means: the
   * quote side of the deposits in the launch window, never the quote a sniper
   * paid in a buy that settled through the same pair in the same block.
   */
  v2Mint: '0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f',
  /**
   * PoolManager.Swap(bytes32 indexed id, address indexed sender, int128 amount0,
   * int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick,
   * uint24 fee) — the v4 singleton settles deposits and buys through one
   * address, so the buys have to be subtracted by name (see chain/reserve.ts).
   */
  v4Swap: '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f',
  /**
   * PONS factory.TokenLaunched(address indexed token, address indexed curve,
   * address indexed deployer, address pairToken, uint256 launchConfigId,
   * uint256 graduationThreshold) — the graduation stream's way back to the
   * coin's original launch block and its curve address (topics[2]).
   */
  tokenLaunched: '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607',
} as const;

/**
 * GeckoTerminal/DexScreener dex ids, so a row's `dex` reads the same on the
 * board as it does on those sites.
 *
 * Every `Initialize` that is not a PONS graduation is reported as
 * `uniswap-v4-robinhood`: the chain says which SINGLETON minted the pool, never
 * which launchpad routed the transaction, and a hook address is not a dex id.
 * A pool some launchpad later claims (bankr, orvex) is still a Uniswap v4 pool.
 */
export const DEX_IDS = {
  uniswapV2: 'uniswap-v2-robinhood',
  uniswapV4: 'uniswap-v4-robinhood',
  ponsDex: 'pons-v2-dex',
} as const;

/**
 * Addresses that are never a "wallet" for bundle purposes: the pool itself, the
 * v4 singleton, the token contract, the burn address, a launchpad hook holding
 * supply in custody, and PONS's own infrastructure. Supply sitting in any of
 * these is not supply someone bought.
 *
 * `sinks` are the addresses supply LEAVES when it is bought (the pair, the v4
 * singleton, a PONS curve); they are excluded as recipients too, so a sell back
 * into one of them nets the buyer out rather than creating a new holder.
 */
export function bundleExclusions(
  sinks: readonly string[],
  tokenAddress: string,
  hook?: string | null,
): Set<string> {
  const out = new Set(
    [
      ...sinks,
      tokenAddress,
      NATIVE_ETH,
      '0x000000000000000000000000000000000000dead',
      UNISWAP_V4_POOL_MANAGER,
      UNISWAP_V2_FACTORY,
      PONS_V2_FACTORY,
      PONS_GRADUATION_HOOK,
    ].map((a) => a.toLowerCase()),
  );
  // A v4 hook can hold the launch supply in custody and hand it out over time;
  // counting the hook as a wallet would read every hooked launch as one whale.
  // The zero hook is already the zero address, which is excluded above.
  if (hook) out.add(hook.toLowerCase());
  return out;
}
