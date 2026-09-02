import { describe, expect, it } from 'vitest';
import { DISCOVERY, DISCOVERY_DEFAULTS } from '@groupie/shared';
import {
  PONS_GRADUATION_HOOK,
  PONS_V2_FACTORY,
  QUOTE_DECIMALS,
  TOPICS,
  UNISWAP_V2_FACTORY,
  UNISWAP_V4_POOL_MANAGER,
  USDG,
  WETH,
  bundleExclusions,
  isQuoteToken,
} from '../src/chain/addresses.js';
import { computeLaunchBlockShare } from '../src/chain/bundle.js';
import {
  sumV2MintQuote,
  swapQuotePaid,
  v4DepositFromTx,
  v4NativeDeposit,
} from '../src/chain/reserve.js';
import type { ChainLog } from '../src/chain/client.js';
import {
  MAX_BACKFILL_BLOCKS,
  MAX_BLOCKS_PER_TICK,
  planRange,
  splitRanges,
} from '../src/chain/cursor.js';
import {
  dataWord,
  unitsToNumber,
  wordToAddress,
  wordToBigInt,
  wordToSignedBigInt,
} from '../src/chain/decode.js';
import { passesDiscoveryFilters, passesGraduationFloor } from '../src/discovery/filters.js';
import {
  decideLaunch,
  launchAlertQualifies,
  parseInitialize,
  parsePairCreated,
  parsePoolGraduated,
  parsePoolRegistered,
} from '../src/discovery/launchLogic.js';
import { graduationMessage, launchMessage } from '../src/discovery/message.js';
import { routeRangeLogs } from '../src/discovery/scan.js';
import {
  clampLaunchMinEth,
  discoverySettingsOf,
  mergeDiscoverySettings,
} from '../src/discovery/settings.js';
import { toReserve } from '../src/discovery/scan.js';

/**
 * The discovery build's decisions, as pure functions (docs/decisions.md rounds
 * 18 and 20).
 *
 * Every log fixture below is a REAL log, read off Robinhood Chain on 2026-09-02
 * and recorded with its provenance in docs/research-onchain.md — the graduation
 * of `Stride` (whose PoolRegistered pool id is byte-for-byte the id
 * GeckoTerminal lists for its pons-v2-dex pool) and a live Uniswap v2
 * PairCreated. A decoder that agrees with a synthetic fixture and disagrees
 * with the chain is worth nothing.
 */

/* ------------------------------------------------------------ real fixtures */

const GRAD_TX = '0x012e2f9382225c9c93fcb4e61d5cae640d79c975fa901dce5b85b533ecdafd24';
const GRAD_BLOCK = 0x31cd756;
const STRIDE = '0x446d76590389b371fbbf53a5d9649522d1946d7e';
const STRIDE_POOL_ID = '0x5564cb672e00e6bc03200b0f13d0377180544201f550da352b632efae7b8ee88';

const poolGraduatedLog: ChainLog = {
  address: PONS_V2_FACTORY,
  topics: [TOPICS.poolGraduated, `0x000000000000000000000000${STRIDE.slice(2)}`],
  data:
    '0x0000000000000000000000000000000000000000000000000000000000167337' +
    '000000000000000000000000000000000000000000a8cff7796e783708ab984f' +
    '0000000000000000000000000000000000000000000000003a4965bf58a400fa',
  blockNumber: GRAD_BLOCK,
  transactionHash: GRAD_TX,
  logIndex: 26,
};

const poolRegisteredLog: ChainLog = {
  address: PONS_GRADUATION_HOOK,
  topics: [TOPICS.poolRegistered, STRIDE_POOL_ID],
  data:
    `0x000000000000000000000000${STRIDE.slice(2)}` +
    '0000000000000000000000000000000000000000000000000000000000000000' +
    '000000000000000000000000ad6b3c64caf01997ff2708dfe3ece6ee164ffa03',
  blockNumber: GRAD_BLOCK,
  transactionHash: GRAD_TX,
  logIndex: 14,
};

/** The v4 Initialize of that same graduation — a MIGRATION, not a launch. */
const graduationInitializeLog: ChainLog = {
  address: UNISWAP_V4_POOL_MANAGER,
  topics: [
    TOPICS.initialize,
    STRIDE_POOL_ID,
    '0x0000000000000000000000000000000000000000000000000000000000000000',
    `0x000000000000000000000000${STRIDE.slice(2)}`,
  ],
  data:
    '0x0000000000000000000000000000000000000000000000000000000000000000' +
    '00000000000000000000000000000000000000000000000000000000000000c8' +
    `000000000000000000000000${PONS_GRADUATION_HOOK.slice(2)}` +
    '0000000000000000000000000000000000001b3ab6fd93aa99faaf1bec46383e' +
    '000000000000000000000000000000000000000000000000000000000002b366',
  blockNumber: GRAD_BLOCK,
  transactionHash: GRAD_TX,
  logIndex: 13,
};

/** A live Uniswap v2 PairCreated: WETH (token0) against a new coin (token1). */
const NEW_V2_TOKEN = '0xdd050541fc432d4ce93f3286246a3bd086440ccd';
const NEW_V2_PAIR = '0x887c2718bfc9133ce881c09f0df18ba572189236';
const pairCreatedLog: ChainLog = {
  address: UNISWAP_V2_FACTORY,
  topics: [
    TOPICS.pairCreated,
    `0x000000000000000000000000${WETH.slice(2)}`,
    `0x000000000000000000000000${NEW_V2_TOKEN.slice(2)}`,
  ],
  data:
    `0x000000000000000000000000${NEW_V2_PAIR.slice(2)}` +
    '0000000000000000000000000000000000000000000000000000000000009d82',
  blockNumber: 0x31cb705,
  transactionHash: '0x87d5adcc4dcacf19166839b91bf4960bcb05a564470acc157d98643acc9f32e2',
  logIndex: 28,
};

/* ------------------------------------------------------------------ decoding */

describe('word decoding', () => {
  it('reads an address out of a left-padded word', () => {
    expect(wordToAddress(`0x000000000000000000000000${WETH.slice(2)}`)).toBe(WETH);
  });

  it('refuses a word with junk above the address — that is not an address', () => {
    expect(wordToAddress(`0x0000000000000001000000000${WETH.slice(3)}`)).toBeNull();
  });

  it('answers null for a short, absent or malformed word rather than guessing', () => {
    expect(wordToAddress('0xdeadbeef')).toBeNull();
    expect(wordToBigInt(undefined)).toBeNull();
    expect(dataWord('0x', 0)).toBeNull();
    expect(dataWord('not hex', 0)).toBeNull();
    expect(dataWord(`0x${'0'.repeat(64)}`, 1)).toBeNull();
  });

  it('converts base units at the token decimals — including USDG at SIX', () => {
    expect(QUOTE_DECIMALS[USDG]).toBe(6);
    expect(unitsToNumber(5_800_000_000_000_000_000n, 18)).toBeCloseTo(5.8, 9);
    expect(unitsToNumber(24_000_000_000n, 6)).toBe(24_000);
    // Read at 18 decimals a USDG amount would vanish — the trap this pins.
    expect(unitsToNumber(24_000_000_000n, 18)).toBeCloseTo(2.4e-8, 12);
  });

  it('keeps precision past 2^53 by dividing in BigInt', () => {
    // 1e27 wei = 1e9 tokens: exact, and impossible via Number(units).
    expect(unitsToNumber(10n ** 27n, 18)).toBe(1e9);
  });

  it('answers null for a negative amount or an absurd decimals', () => {
    expect(unitsToNumber(-1n, 18)).toBeNull();
    expect(unitsToNumber(1n, 99)).toBeNull();
  });
});

/* ------------------------------------------------------ graduation decoding */

describe('graduation decoding (real PONS logs)', () => {
  it('reads the token out of PoolGraduated', () => {
    expect(parsePoolGraduated(poolGraduatedLog)).toEqual({
      tokenAddress: STRIDE,
      blockNumber: GRAD_BLOCK,
      txHash: GRAD_TX,
    });
  });

  it('joins the pool id and the token out of the hook PoolRegistered', () => {
    expect(parsePoolRegistered(poolRegisteredLog)).toEqual({
      poolAddress: STRIDE_POOL_ID,
      tokenAddress: STRIDE,
      txHash: GRAD_TX,
    });
  });

  it('keeps all 32 bytes of a v4 pool id — it is not an address', () => {
    expect(parsePoolRegistered(poolRegisteredLog)?.poolAddress).toHaveLength(66);
  });

  it('ignores a log of the wrong type instead of decoding it anyway', () => {
    expect(parsePoolGraduated(poolRegisteredLog)).toBeNull();
    expect(parsePoolRegistered(poolGraduatedLog)).toBeNull();
  });

  it('never reads the graduation as a launch: the PONS hook is skipped', () => {
    expect(parseInitialize(graduationInitializeLog)).toBeNull();
  });
});

/* ----------------------------------------------------------- launch parsing */

describe('launch parsing', () => {
  it('reads a v2 PairCreated, with the non-quote side as the coin', () => {
    expect(parsePairCreated(pairCreatedLog)).toEqual({
      dex: 'uniswap-v2-robinhood',
      poolAddress: NEW_V2_PAIR,
      tokenAddress: NEW_V2_TOKEN,
      quoteToken: WETH,
      quoteIsCurrency0: true,
      blockNumber: 0x31cb705,
      txHash: pairCreatedLog.transactionHash,
      hook: null,
    });
  });

  it('rejects a pool of two quote tokens — there is no coin in a WETH/USDG pool', () => {
    const bothQuotes: ChainLog = {
      ...pairCreatedLog,
      topics: [
        TOPICS.pairCreated,
        `0x000000000000000000000000${WETH.slice(2)}`,
        `0x000000000000000000000000${USDG.slice(2)}`,
      ],
    };
    expect(parsePairCreated(bothQuotes)).toBeNull();
  });

  it('rejects a pool with no quote token at all — nothing to price a reserve in', () => {
    const noQuote: ChainLog = {
      ...pairCreatedLog,
      topics: [
        TOPICS.pairCreated,
        `0x000000000000000000000000${NEW_V2_TOKEN.slice(2)}`,
        `0x000000000000000000000000${STRIDE.slice(2)}`,
      ],
    };
    expect(parsePairCreated(noQuote)).toBeNull();
    expect(isQuoteToken(NEW_V2_TOKEN)).toBe(false);
  });

  it('reads a v4 Initialize on an ordinary hook as a launch', () => {
    const ordinary: ChainLog = {
      ...graduationInitializeLog,
      data: graduationInitializeLog.data.replace(PONS_GRADUATION_HOOK.slice(2), '0'.repeat(40)),
    };
    const candidate = parseInitialize(ordinary);
    expect(candidate?.dex).toBe('uniswap-v4-robinhood');
    expect(candidate?.tokenAddress).toBe(STRIDE);
    expect(candidate?.poolAddress).toBe(STRIDE_POOL_ID);
  });
});

/* ---------------------------------------------------- the decision table */

const KEEPABLE = {
  tokenTracked: false,
  tokenSeen: false,
  poolSeen: false,
  hasOlderPool: false as boolean | null,
  isStock: false,
  initialLiquidityEth: 5.8,
  ageMinutes: 0.3,
};

describe('decideLaunch — the round-18 table', () => {
  it('keeps a fresh, first, well-funded pool for a coin nobody has seen', () => {
    expect(decideLaunch(KEEPABLE)).toEqual({ keep: true });
  });

  it('drops a pool we already recorded (the listener replayed a range)', () => {
    expect(decideLaunch({ ...KEEPABLE, poolSeen: true })).toEqual({
      keep: false,
      reason: 'duplicate',
    });
  });

  it('drops a SECOND pool for a coin we already recorded — the fee-tier case', () => {
    expect(decideLaunch({ ...KEEPABLE, tokenSeen: true })).toEqual({
      keep: false,
      reason: 'second_pool',
    });
  });

  it('drops a coin the group already tracks with a pool', () => {
    expect(decideLaunch({ ...KEEPABLE, tokenTracked: true })).toEqual({
      keep: false,
      reason: 'known_token',
    });
  });

  it('drops a coin whose first pool predates this one — the PONS graduate case', () => {
    expect(decideLaunch({ ...KEEPABLE, hasOlderPool: true })).toEqual({
      keep: false,
      reason: 'not_first_pool',
    });
  });

  it('keeps it when DexScreener could not answer: an outage is not evidence', () => {
    expect(decideLaunch({ ...KEEPABLE, hasOlderPool: null })).toEqual({ keep: true });
  });

  it('drops a tokenized stock', () => {
    expect(decideLaunch({ ...KEEPABLE, isStock: true })).toEqual({ keep: false, reason: 'stock' });
  });

  it('drops a pool under the board floor, and keeps one exactly on it', () => {
    expect(decideLaunch({ ...KEEPABLE, initialLiquidityEth: DISCOVERY.boardMinEth - 0.01 })).toEqual(
      { keep: false, reason: 'thin' },
    );
    expect(decideLaunch({ ...KEEPABLE, initialLiquidityEth: DISCOVERY.boardMinEth })).toEqual({
      keep: true,
    });
  });

  it('drops an unreadable reserve rather than storing a null-liquidity launch', () => {
    expect(decideLaunch({ ...KEEPABLE, initialLiquidityEth: null })).toEqual({
      keep: false,
      reason: 'unknown_reserve',
    });
  });

  it('drops a pool that was already old when we first saw it', () => {
    expect(
      decideLaunch({ ...KEEPABLE, ageMinutes: DISCOVERY.maxDetectionAgeMinutes + 1 }),
    ).toEqual({ keep: false, reason: 'stale' });
    expect(decideLaunch({ ...KEEPABLE, ageMinutes: DISCOVERY.maxDetectionAgeMinutes })).toEqual({
      keep: true,
    });
  });

  it('answers the CHEAPEST disqualification first, so no RPC call is wasted', () => {
    // Everything is wrong at once; the free database answer is the one returned.
    const verdict = decideLaunch({
      tokenTracked: true,
      tokenSeen: true,
      poolSeen: true,
      hasOlderPool: true,
      isStock: true,
      initialLiquidityEth: null,
      ageMinutes: 999,
    });
    expect(verdict).toEqual({ keep: false, reason: 'duplicate' });
  });
});

describe('launchAlertQualifies', () => {
  it('needs the group threshold met', () => {
    expect(launchAlertQualifies(5.8, 5)).toBe(true);
    expect(launchAlertQualifies(4.9, 5)).toBe(false);
    expect(launchAlertQualifies(5, 5)).toBe(true);
  });

  it('treats 0 as the mute, whatever the launch looked like', () => {
    expect(launchAlertQualifies(50, 0)).toBe(false);
  });

  it('never fires on an unknown reserve', () => {
    expect(launchAlertQualifies(null, 5)).toBe(false);
  });
});

/* ---------------------------------------------------------------- reserves */

describe('toReserve', () => {
  it('reads a WETH reserve as ETH, and prices it when ETH has a price', () => {
    expect(toReserve(5_800_000_000_000_000_000n, WETH, 4_000)).toEqual({ eth: 5.8, usd: 23_200 });
  });

  it('keeps the ETH figure when no ETH price is available, and omits the USD', () => {
    expect(toReserve(5_800_000_000_000_000_000n, WETH, null)).toEqual({ eth: 5.8, usd: null });
  });

  it('reads a USDG reserve as dollars and derives the ETH figure', () => {
    const reserve = toReserve(24_000_000_000n, USDG, 4_000);
    expect(reserve.usd).toBe(24_000);
    expect(reserve.eth).toBe(6);
  });

  it('answers unknown, never zero, for an unreadable amount', () => {
    expect(toReserve(null, WETH, 4_000)).toEqual({ eth: null, usd: null });
    expect(toReserve(1n, '0xnot-a-quote-token', 4_000)).toEqual({ eth: null, usd: null });
  });
});

/* ------------------------------------------------------------ bundle facts */

const TOKEN = '0x1111111111111111111111111111111111111111';
const POOL = '0x2222222222222222222222222222222222222222';
const SUPPLY = 1_000_000_000n * 10n ** 18n;
const SINKS = new Set([POOL]);
const EXCLUDED = bundleExclusions([POOL], TOKEN);

function transfer(from: string, to: string, tokens: bigint): ChainLog {
  return {
    address: TOKEN,
    topics: [
      TOPICS.transfer,
      `0x000000000000000000000000${from.slice(2)}`,
      `0x000000000000000000000000${to.slice(2)}`,
    ],
    data: `0x${(tokens * 10n ** 18n).toString(16).padStart(64, '0')}`,
    blockNumber: 100,
    transactionHash: '0xtx',
    logIndex: 0,
  };
}

const wallet = (n: number) => `0x${String(n).padStart(40, 'a')}`;

describe('computeLaunchBlockShare', () => {
  it('counts what left the pool into real wallets, and how many took it', () => {
    const logs = [
      transfer(POOL, wallet(1), 60_000_000n),
      transfer(POOL, wallet(2), 60_000_000n),
    ];
    expect(computeLaunchBlockShare(logs, SUPPLY, SINKS, EXCLUDED)).toEqual({ pct: 12, wallets: 2 });
  });

  it('ignores the mint into the pool itself — that is not a purchase', () => {
    const logs = [
      transfer('0x0000000000000000000000000000000000000000', POOL, 1_000_000_000n),
      transfer(POOL, wallet(1), 120_000_000n),
    ];
    expect(computeLaunchBlockShare(logs, SUPPLY, SINKS, EXCLUDED)).toEqual({ pct: 12, wallets: 1 });
  });

  it('NETS a fan-out through an intermediate wallet instead of double counting', () => {
    const logs = [
      transfer(POOL, wallet(1), 120_000_000n),
      transfer(wallet(1), wallet(2), 60_000_000n),
      transfer(wallet(1), wallet(3), 60_000_000n),
    ];
    // Gross receipts would read 24%; the supply that actually moved is 12%.
    expect(computeLaunchBlockShare(logs, SUPPLY, SINKS, EXCLUDED)).toEqual({ pct: 12, wallets: 2 });
  });

  it('counts a sell back into the pool against the buyer', () => {
    const logs = [
      transfer(POOL, wallet(1), 120_000_000n),
      transfer(wallet(1), POOL, 120_000_000n),
    ];
    expect(computeLaunchBlockShare(logs, SUPPLY, SINKS, EXCLUDED)).toEqual({ pct: 0, wallets: 0 });
  });

  it('reads a clean launch with no buyers as 0% of 0 wallets', () => {
    expect(computeLaunchBlockShare([], SUPPLY, SINKS, EXCLUDED)).toEqual({ pct: 0, wallets: 0 });
  });

  it('answers UNKNOWN — not 0% — when the logs or the supply are missing', () => {
    expect(computeLaunchBlockShare(null, SUPPLY, SINKS, EXCLUDED)).toBeNull();
    expect(computeLaunchBlockShare([], null, SINKS, EXCLUDED)).toBeNull();
    expect(computeLaunchBlockShare([], 0n, SINKS, EXCLUDED)).toBeNull();
  });

  it('skips a Transfer it cannot decode rather than inventing a recipient', () => {
    const broken: ChainLog = { ...transfer(POOL, wallet(1), 60_000_000n), data: '0x' };
    expect(computeLaunchBlockShare([broken], SUPPLY, SINKS, EXCLUDED)).toEqual({ pct: 0, wallets: 0 });
  });

  it('never reports more than 100% of supply', () => {
    const logs = [transfer(POOL, wallet(1), 5_000_000_000n)];
    expect(computeLaunchBlockShare(logs, SUPPLY, SINKS, EXCLUDED)?.pct).toBe(100);
  });

  it('excludes the burn address and the v4 singleton', () => {
    const logs = [
      transfer(POOL, '0x000000000000000000000000000000000000dead', 500_000_000n),
      transfer(POOL, UNISWAP_V4_POOL_MANAGER, 400_000_000n),
      transfer(POOL, wallet(1), 100_000_000n),
    ];
    expect(computeLaunchBlockShare(logs, SUPPLY, SINKS, EXCLUDED)).toEqual({ pct: 10, wallets: 1 });
  });
});

/* ------------------------------------------------------------ serve filters */

const PASSING = {
  twitterUrl: 'https://x.com/coin',
  websiteUrl: 'https://coin.xyz',
  isStock: false,
  launchBlockPct: 12,
};

describe('passesDiscoveryFilters', () => {
  it('needs BOTH an X account and a website', () => {
    expect(passesDiscoveryFilters(PASSING)).toBe(true);
    expect(passesDiscoveryFilters({ ...PASSING, twitterUrl: null })).toBe(false);
    expect(passesDiscoveryFilters({ ...PASSING, websiteUrl: null })).toBe(false);
  });

  it('hides tokenized stocks', () => {
    expect(passesDiscoveryFilters({ ...PASSING, isStock: true })).toBe(false);
  });

  it('hides a heavily bundled launch at or above the threshold', () => {
    expect(passesDiscoveryFilters({ ...PASSING, launchBlockPct: 24.9 })).toBe(true);
    expect(passesDiscoveryFilters({ ...PASSING, launchBlockPct: 25 })).toBe(false);
    expect(passesDiscoveryFilters({ ...PASSING, launchBlockPct: 80 })).toBe(false);
    expect(DISCOVERY_DEFAULTS.bundleMaxPct).toBe(25);
  });

  it('does NOT hide an unknown launch block — unknown is not evidence', () => {
    expect(passesDiscoveryFilters({ ...PASSING, launchBlockPct: null })).toBe(true);
  });
});

describe('passesGraduationFloor (round 22)', () => {
  it('drops a graduation under the floor and keeps one at it', () => {
    expect(DISCOVERY.graduationMinMcapUsd).toBe(15_000);
    expect(passesGraduationFloor({ kind: 'graduation', mcapUsd: 14_999 })).toBe(false);
    expect(passesGraduationFloor({ kind: 'graduation', mcapUsd: 15_000 })).toBe(true);
    expect(passesGraduationFloor({ kind: 'graduation', mcapUsd: 250_000 })).toBe(true);
  });

  it('does NOT hide a graduation we have no reading for', () => {
    expect(passesGraduationFloor({ kind: 'graduation', mcapUsd: null })).toBe(true);
  });

  it('never touches a launch, however small', () => {
    expect(passesGraduationFloor({ kind: 'launch', mcapUsd: 1_200 })).toBe(true);
    expect(passesGraduationFloor({ kind: 'launch', mcapUsd: null })).toBe(true);
  });
});

/* ---------------------------------------------------------------- settings */

describe('discovery settings', () => {
  it('defaults when the group has never set anything', () => {
    expect(discoverySettingsOf({})).toEqual({
      launchMinEth: DISCOVERY_DEFAULTS.launchMinEth,
      gradsOn: DISCOVERY_DEFAULTS.gradsOn,
      alertsPerHour: DISCOVERY_DEFAULTS.alertsPerHour,
    });
    expect(discoverySettingsOf(null)).toEqual(discoverySettingsOf({}));
    expect(discoverySettingsOf('nonsense')).toEqual(discoverySettingsOf({}));
  });

  it('leaves graduations OFF until a group opts in (round 22)', () => {
    expect(DISCOVERY_DEFAULTS.gradsOn).toBe(false);
    expect(discoverySettingsOf({}).gradsOn).toBe(false);
    expect(discoverySettingsOf({ discovery: { gradsOn: true } }).gradsOn).toBe(true);
  });

  it('merges only the keys it understands, and keeps 0 as the mute', () => {
    const merged = mergeDiscoverySettings({ launchMinEth: 0, gradsOn: false, junk: 5 });
    expect(merged).toEqual({ launchMinEth: 0, gradsOn: false, alertsPerHour: 3 });
  });

  it('clamps rather than trusting a hand-edited blob', () => {
    expect(mergeDiscoverySettings({ launchMinEth: 99_999 }).launchMinEth).toBe(1_000);
    expect(mergeDiscoverySettings({ alertsPerHour: 500 }).alertsPerHour).toBe(20);
    expect(mergeDiscoverySettings({ alertsPerHour: -3 }).alertsPerHour).toBe(0);
  });

  it('ignores a key of the wrong type instead of discarding the rest', () => {
    const merged = mergeDiscoverySettings({ launchMinEth: 'lots', gradsOn: false });
    expect(merged.launchMinEth).toBe(DISCOVERY_DEFAULTS.launchMinEth);
    expect(merged.gradsOn).toBe(false);
  });

  it('rounds a tiny threshold UP to the floor — only 0 is the off switch', () => {
    expect(clampLaunchMinEth(0)).toBe(0);
    expect(clampLaunchMinEth(0.01)).toBe(0.1);
    expect(clampLaunchMinEth(-5)).toBe(DISCOVERY_DEFAULTS.launchMinEth);
  });

  it('reads settings.discovery out of the whole group blob', () => {
    expect(discoverySettingsOf({ alerts: { nukeDropPct: 50 }, discovery: { gradsOn: false } })).toEqual(
      { launchMinEth: 5, gradsOn: false, alertsPerHour: 3 },
    );
  });
});

/* ------------------------------------------------------------------ cursor */

describe('cursor planning', () => {
  const HEAD = 1_000_000;

  it('does nothing until a cursor exists — a fresh install replays no history', () => {
    expect(planRange(null, HEAD)).toBeNull();
  });

  it('reads the blocks since the cursor, stopping short of the head', () => {
    const plan = planRange(HEAD - 100, HEAD);
    expect(plan).toEqual({
      fromBlock: HEAD - 99,
      // The last DISCOVERY.headLagBlocks are left for the next tick: a block at
      // the tip can still be re-orged away.
      toBlock: HEAD - DISCOVERY.headLagBlocks,
      skippedBlocks: 0,
      behind: false,
    });
  });

  it('does nothing when the cursor is already at (or past) the readable head', () => {
    expect(planRange(HEAD, HEAD)).toBeNull();
    expect(planRange(HEAD + 5, HEAD)).toBeNull();
  });

  it('caps one tick, and says it is behind', () => {
    const plan = planRange(HEAD - MAX_BLOCKS_PER_TICK * 2, HEAD);
    expect(plan?.toBlock).toBe(plan!.fromBlock + MAX_BLOCKS_PER_TICK - 1);
    expect(plan?.behind).toBe(true);
  });

  it('BOUNDS the backfill after a long outage, and reports what it skipped', () => {
    const plan = planRange(1, HEAD);
    const safeHead = HEAD - DISCOVERY.headLagBlocks;
    expect(plan?.fromBlock).toBe(safeHead - MAX_BACKFILL_BLOCKS);
    expect(plan?.skippedBlocks).toBe(safeHead - MAX_BACKFILL_BLOCKS - 2);
    // ...and the bound is the decided two hours of chain, not an accident.
    expect(MAX_BACKFILL_BLOCKS).toBe(
      DISCOVERY.backfillMaxHours * 3_600 * DISCOVERY.blocksPerSecond,
    );
  });

  it('splits a plan into provider-sized ranges that tile it exactly', () => {
    const plan = planRange(HEAD - MAX_BLOCKS_PER_TICK, HEAD)!;
    const ranges = splitRanges(plan);
    expect(ranges).toHaveLength(DISCOVERY.maxRangesPerTick);
    expect(ranges[0]!.fromBlock).toBe(plan.fromBlock);
    expect(ranges.at(-1)!.toBlock).toBe(plan.toBlock);
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i]!.fromBlock).toBe(ranges[i - 1]!.toBlock + 1);
    }
  });
});

/* ---------------------------------------------------------------- messages */

const MESSAGE = {
  label: 'STRIDE',
  dex: 'uniswap-v4-robinhood',
  initialLiquidityEth: 5.8,
  initialLiquidityUsd: 23_200,
  quoteSymbol: 'ETH' as 'ETH' | 'USDG' | null,
  mcapUsd: 23_000,
  liquidityUsd: 22_000,
  lpLockedPct: 0,
  launchBlockPct: 12,
  launchBlockWallets: 9,
  twitterUrl: 'https://x.com/stride',
  websiteUrl: 'https://stride.xyz',
};

describe('discovery alert wording', () => {
  it('states the launch as facts, in order', () => {
    expect(launchMessage(MESSAGE)).toBe(
      'STRIDE launched on Uniswap v4 · 5.8 ETH liquidity · LP locked 0% · $23K mcap · ' +
        'launch block 12% / 9 wallets · https://x.com/stride · https://stride.xyz',
    );
  });

  it('states the graduation with its LP and lock', () => {
    expect(graduationMessage({ ...MESSAGE, dex: 'pons-v2-dex', lpLockedPct: 100 })).toBe(
      'STRIDE graduated · $23K mcap · LP $22K (locked 100%) · launch block 12% / 9 wallets · ' +
        'https://x.com/stride · https://stride.xyz',
    );
  });

  it('DROPS an unknown clause rather than printing a zero for it', () => {
    const text = launchMessage({
      ...MESSAGE,
      lpLockedPct: null,
      launchBlockPct: null,
      launchBlockWallets: null,
      mcapUsd: null,
    });
    expect(text).toBe(
      'STRIDE launched on Uniswap v4 · 5.8 ETH liquidity · https://x.com/stride · https://stride.xyz',
    );
    expect(text).not.toContain('locked');
    expect(text).not.toContain('launch block');
  });

  it('keeps the share when the wallet count alone is unknown', () => {
    expect(launchMessage({ ...MESSAGE, launchBlockWallets: null })).toContain('launch block 12%');
    expect(launchMessage({ ...MESSAGE, launchBlockWallets: 1 })).toContain('12% / 1 wallet');
  });

  it('trims a round ETH amount instead of printing "6.0"', () => {
    expect(launchMessage({ ...MESSAGE, initialLiquidityEth: 6 })).toContain('6 ETH liquidity');
    expect(launchMessage({ ...MESSAGE, initialLiquidityEth: 0.5 })).toContain('0.5 ETH liquidity');
    expect(launchMessage({ ...MESSAGE, initialLiquidityEth: 128.4 })).toContain('128 ETH liquidity');
  });

  it('carries no adjective, no verdict and no emoji', () => {
    for (const text of [launchMessage(MESSAGE), graduationMessage(MESSAGE)]) {
      expect(text).not.toMatch(/hot|opportunity|buy|safe|rug|moon/i);
      expect(text).toMatch(/^[\x20-\x7E·—]+$/);
    }
  });
});

/* ------------------------------------------- the deposit, never the buy (B1) */

const V4_POOL_ID = '0x5564cb672e00e6bc03200b0f13d0377180544201f550da352b632efae7b8ee88';
const OTHER_POOL_ID = '0x1111111111111111111111111111111111111111111111111111111111111111';
const MANAGER = UNISWAP_V4_POOL_MANAGER;

const hexWord = (value: bigint): string =>
  (value < 0n ? (1n << 256n) + value : value).toString(16).padStart(64, '0');

/** A v2 pair `Mint(sender, amount0, amount1)`. */
function mintLog(pair: string, amount0: bigint, amount1: bigint): ChainLog {
  return {
    address: pair,
    topics: [TOPICS.v2Mint, `0x000000000000000000000000${wallet(7).slice(2)}`],
    data: `0x${hexWord(amount0)}${hexWord(amount1)}`,
    blockNumber: 100,
    transactionHash: '0xmint',
    logIndex: 1,
  };
}

/** A v4 `Swap` with the caller's signed deltas. */
function swapLog(poolId: string, amount0: bigint, amount1: bigint): ChainLog {
  return {
    address: MANAGER,
    topics: [TOPICS.v4Swap, poolId, `0x000000000000000000000000${wallet(8).slice(2)}`],
    data:
      `0x${hexWord(amount0)}${hexWord(amount1)}` +
      `${hexWord(0n)}${hexWord(0n)}${hexWord(0n)}${hexWord(0n)}`,
    blockNumber: 100,
    transactionHash: '0xcreate',
    logIndex: 2,
  };
}

describe('signed word decoding', () => {
  it('reads a negative int128 delta as a negative number', () => {
    expect(wordToSignedBigInt(`0x${hexWord(-3_000_000_000_000_000_000n)}`)).toBe(
      -3_000_000_000_000_000_000n,
    );
    expect(wordToSignedBigInt(`0x${hexWord(5n)}`)).toBe(5n);
    expect(wordToSignedBigInt('0xshort')).toBeNull();
  });
});

describe('v2 deposit = Mint, never a buy', () => {
  it('sums the quote side of every Mint in the window', () => {
    const logs = [mintLog(POOL, 3n * 10n ** 18n, 1n), mintLog(POOL, 2n * 10n ** 18n, 1n)];
    expect(sumV2MintQuote(logs, POOL, true)).toBe(5n * 10n ** 18n);
  });

  it('reads the OTHER side when the quote is token1', () => {
    expect(sumV2MintQuote([mintLog(POOL, 1n, 7n)], POOL, false)).toBe(7n);
  });

  it('IGNORES a same-block buy: a Transfer into the pair is not a Mint', () => {
    const buy = transfer(wallet(1), POOL, 40n);
    expect(sumV2MintQuote([buy], POOL, true)).toBeNull();
    expect(sumV2MintQuote([buy, mintLog(POOL, 2n * 10n ** 18n, 1n)], POOL, true)).toBe(
      2n * 10n ** 18n,
    );
  });

  it('ignores a Mint emitted by some OTHER pair', () => {
    expect(sumV2MintQuote([mintLog(wallet(9), 5n, 5n)], POOL, true)).toBeNull();
  });

  it('answers unknown, never 0, when there is no Mint at all', () => {
    expect(sumV2MintQuote([], POOL, true)).toBeNull();
    expect(sumV2MintQuote(null, POOL, true)).toBeNull();
  });
});

describe('v4 deposit = inbound minus the same-tx buy', () => {
  it('subtracts what the buyer paid through THIS pool', () => {
    const deposit = v4DepositFromTx({
      quoteIn: 42n * 10n ** 18n,
      txLogs: [swapLog(V4_POOL_ID, -40n * 10n ** 18n, 1n)],
      poolId: V4_POOL_ID,
      poolManager: MANAGER,
      quoteIsCurrency0: true,
    });
    expect(deposit).toBe(2n * 10n ** 18n);
  });

  it('leaves the deposit alone when nothing was swapped', () => {
    expect(
      v4DepositFromTx({
        quoteIn: 5n,
        txLogs: [],
        poolId: V4_POOL_ID,
        poolManager: MANAGER,
        quoteIsCurrency0: true,
      }),
    ).toBe(5n);
  });

  it('ignores swaps belonging to another pool id', () => {
    expect(swapQuotePaid([swapLog(OTHER_POOL_ID, -9n, 1n)], V4_POOL_ID, MANAGER, true)).toBe(0n);
    expect(swapQuotePaid([swapLog(V4_POOL_ID, -9n, 1n)], V4_POOL_ID, MANAGER, true)).toBe(9n);
  });

  it('ignores a POSITIVE quote delta — a sell took nothing out of the deposit', () => {
    expect(swapQuotePaid([swapLog(V4_POOL_ID, 9n, -1n)], V4_POOL_ID, MANAGER, true)).toBe(0n);
  });

  it('reads the quote delta off the right side when the quote is currency1', () => {
    expect(swapQuotePaid([swapLog(V4_POOL_ID, 1n, -6n)], V4_POOL_ID, MANAGER, false)).toBe(6n);
  });

  it('answers unknown when the buy exceeds everything that came in', () => {
    expect(
      v4DepositFromTx({
        quoteIn: 1n,
        txLogs: [swapLog(V4_POOL_ID, -5n, 1n)],
        poolId: V4_POOL_ID,
        poolManager: MANAGER,
        quoteIsCurrency0: true,
      }),
    ).toBeNull();
  });

  it('answers unknown when nothing inbound could be read', () => {
    expect(
      v4DepositFromTx({
        quoteIn: null,
        txLogs: [],
        poolId: V4_POOL_ID,
        poolManager: MANAGER,
        quoteIsCurrency0: true,
      }),
    ).toBeNull();
  });
});

describe('native-ETH v4 deposits are MEASURED (round 18/20 review)', () => {
  it('reads the transaction value, minus the same-tx buy', () => {
    expect(
      v4NativeDeposit({
        txValueWei: 6n * 10n ** 18n,
        txLogs: [swapLog(V4_POOL_ID, -1n * 10n ** 18n, 1n)],
        poolId: V4_POOL_ID,
        poolManager: MANAGER,
        quoteIsCurrency0: true,
      }),
    ).toBe(5n * 10n ** 18n);
  });

  it('keeps the whole value when the creation bought nothing', () => {
    expect(
      v4NativeDeposit({
        txValueWei: 6n * 10n ** 18n,
        txLogs: [],
        poolId: V4_POOL_ID,
        poolManager: MANAGER,
        quoteIsCurrency0: true,
      }),
    ).toBe(6n * 10n ** 18n);
  });

  it('stays unknown when the transaction could not be read', () => {
    expect(
      v4NativeDeposit({
        txValueWei: null,
        txLogs: [],
        poolId: V4_POOL_ID,
        poolManager: MANAGER,
        quoteIsCurrency0: true,
      }),
    ).toBeNull();
  });
});

/* ------------------------------------------ bundle facts are OUTFLOWS */

describe('computeLaunchBlockShare counts pool OUTFLOWS only', () => {
  it('reads a mint-to-deployer then addLiquidity as 0% of 0 wallets', () => {
    const deployer = wallet(4);
    const logs = [
      transfer('0x0000000000000000000000000000000000000000', deployer, 1_000_000_000n),
      transfer(deployer, POOL, 1_000_000_000n),
    ];
    expect(computeLaunchBlockShare(logs, SUPPLY, SINKS, EXCLUDED)).toEqual({ pct: 0, wallets: 0 });
  });

  it('excludes a v4 hook holding launch supply in custody', () => {
    const hook = wallet(5);
    const excluded = bundleExclusions([POOL], TOKEN, hook);
    const logs = [transfer(POOL, hook, 500_000_000n), transfer(POOL, wallet(1), 100_000_000n)];
    expect(computeLaunchBlockShare(logs, SUPPLY, SINKS, excluded)).toEqual({ pct: 10, wallets: 1 });
  });

  it('BURNS out of the count: a send to an excluded address debits the sender', () => {
    const logs = [
      transfer(POOL, wallet(1), 120_000_000n),
      transfer(wallet(1), '0x000000000000000000000000000000000000dead', 120_000_000n),
    ];
    expect(computeLaunchBlockShare(logs, SUPPLY, SINKS, EXCLUDED)).toEqual({ pct: 0, wallets: 0 });
  });

  it('counts a router fan-out ONCE, for the buyer at the end of it', () => {
    const router = wallet(6);
    const buyer = wallet(2);
    const logs = [transfer(POOL, router, 120_000_000n), transfer(router, buyer, 120_000_000n)];
    expect(computeLaunchBlockShare(logs, SUPPLY, SINKS, EXCLUDED)).toEqual({ pct: 12, wallets: 1 });
  });

  it('measures a PONS graduation off the CURVE as the sink', () => {
    const curve = wallet(3);
    const logs = [transfer(curve, wallet(1), 60_000_000n)];
    expect(
      computeLaunchBlockShare(logs, SUPPLY, new Set([curve]), bundleExclusions([curve], TOKEN)),
    ).toEqual({ pct: 6, wallets: 1 });
    // ...and the same logs read against the wrong sink say nothing at all —
    // UNKNOWN, not a confident 0%: the sink never appears, so the assumption
    // behind the measurement did not hold here (docs/research-onchain.md).
    expect(computeLaunchBlockShare(logs, SUPPLY, SINKS, EXCLUDED)).toBeNull();
  });

  it('answers UNKNOWN when a window of Transfers never touches the sink at all', () => {
    // The live reading behind this rule: a real launch always shows the supply
    // arriving at its sink (`0x0 -> curve`, then `curve -> buyer`). A window
    // with neither is evidence the sink is wrong, not evidence of a clean coin.
    const logs = [
      transfer(wallet(1), wallet(2), 60_000_000n),
      transfer(wallet(2), wallet(3), 10_000_000n),
    ];
    expect(computeLaunchBlockShare(logs, SUPPLY, SINKS, EXCLUDED)).toBeNull();
    // ...while the mint into the sink alone is a TRUE 0%: supply arrived and
    // nobody bought any of it.
    const mintOnly = [transfer('0x0000000000000000000000000000000000000000', POOL, 1_000_000_000n)];
    expect(computeLaunchBlockShare(mintOnly, SUPPLY, SINKS, EXCLUDED)).toEqual({
      pct: 0,
      wallets: 0,
    });
  });

  it('still answers UNKNOWN — not 0% — when a read failed', () => {
    expect(computeLaunchBlockShare(null, SUPPLY, SINKS, EXCLUDED)).toBeNull();
    expect(computeLaunchBlockShare([], null, SINKS, EXCLUDED)).toBeNull();
  });
});

/* ----------------------------------------------- one query per range */

describe('routeRangeLogs', () => {
  const at = (address: string, topic0: string): ChainLog => ({
    address,
    topics: [topic0],
    data: '0x',
    blockNumber: 1,
    transactionHash: '0xt',
    logIndex: 0,
  });

  it('sorts one combined read back into its four streams', () => {
    const routed = routeRangeLogs([
      at(UNISWAP_V2_FACTORY, TOPICS.pairCreated),
      at(UNISWAP_V4_POOL_MANAGER, TOPICS.initialize),
      at(PONS_V2_FACTORY, TOPICS.poolGraduated),
      at(PONS_GRADUATION_HOOK, TOPICS.poolRegistered),
    ]);
    expect(routed.pairLogs).toHaveLength(1);
    expect(routed.initLogs).toHaveLength(1);
    expect(routed.gradLogs).toHaveLength(1);
    expect(routed.registerLogs).toHaveLength(1);
  });

  it('routes on the ADDRESS as well as the topic — a signature is not unique', () => {
    const routed = routeRangeLogs([
      at(PONS_GRADUATION_HOOK, TOPICS.poolGraduated),
      at(UNISWAP_V2_FACTORY, TOPICS.initialize),
    ]);
    expect(routed.gradLogs).toHaveLength(0);
    expect(routed.initLogs).toHaveLength(0);
  });
});

/* ------------------------------------------------------------ head lag */

describe('planRange stops short of the head', () => {
  const HEAD_NOW = 1_000_000;

  it('leaves DISCOVERY.headLagBlocks unread so a re-org cannot be recorded', () => {
    const plan = planRange(HEAD_NOW - 100, HEAD_NOW);
    expect(plan?.toBlock).toBe(HEAD_NOW - DISCOVERY.headLagBlocks);
    expect(DISCOVERY.headLagBlocks).toBe(3);
  });

  it('does nothing when the only unread blocks are inside the lag', () => {
    expect(planRange(HEAD_NOW - DISCOVERY.headLagBlocks, HEAD_NOW)).toBeNull();
    expect(planRange(HEAD_NOW - 1, HEAD_NOW)).toBeNull();
  });
});

/* ------------------------------------------------------------ USDG honesty */

describe('the chat line names the asset that was actually deposited', () => {
  it('prints ETH for an ETH-quoted pool', () => {
    expect(launchMessage(MESSAGE)).toContain('5.8 ETH liquidity');
  });

  it('prints DOLLARS for a USDG-quoted pool — nobody deposited ETH into it', () => {
    const text = launchMessage({
      ...MESSAGE,
      quoteSymbol: 'USDG',
      initialLiquidityUsd: 12_000,
      initialLiquidityEth: 3.1,
    });
    expect(text).toContain('$12K USDG liquidity');
    expect(text).not.toContain('ETH liquidity');
  });

  it('says nothing at all when the USDG figure is unknown', () => {
    const text = launchMessage({
      ...MESSAGE,
      quoteSymbol: 'USDG',
      initialLiquidityUsd: null,
    });
    expect(text).not.toContain('liquidity');
  });
});
