import type { Db } from '@groupie/db';
import { XWATCH } from '@groupie/shared';
import {
  NATIVE_ETH,
  PONS_GRADUATION_HOOK,
  PONS_V2_FACTORY,
  UNISWAP_V2_FACTORY,
  UNISWAP_V4_POOL_MANAGER,
  USDG,
  WETH,
} from '../chain/addresses.js';
import type { ChainClient } from '../chain/client.js';
import { resolveToken } from '../market/resolve.js';
import type { Resolution } from '../market/resolve.js';
import { resolveLaunchClock, type LaunchClock } from './launchClock.js';

/**
 * Confirming an address a tracked account posted (docs/decisions.md round 23).
 *
 * A post is not evidence of a token. Before anything is written down — and long
 * before anything is said in the chat — the address has to BE a token on this
 * chain: bytecode at the address, an ERC-20 answering `symbol()` and
 * `decimals()`, not one of the infrastructure contracts everybody links to, and
 * a first pool young enough to be the launch the post is announcing.
 *
 * UNKNOWN IS NEVER A VERDICT, in both directions: a chain read that fails is
 * not "not a contract", and a resolution that fails is not "not a launch". Both
 * answer `ok: false` with a reason, and the caller's response to every one of
 * them is SILENCE — no message, and nothing recorded as a launch.
 */

/** `symbol()` and `decimals()` — the two an ERC-20 always answers. */
const SYMBOL_SELECTOR = '0x95d89b41';
const DECIMALS_SELECTOR = '0x313ce567';

/**
 * Addresses that are never a launch: the quote tokens, the two Uniswap
 * deployments, PONS's factory and graduation hook, and the burn address. These
 * are the contracts a post links to in passing — "trading against WETH" — and
 * every one of them would otherwise pass a code-and-symbol test.
 */
export const KNOWN_CONTRACTS: ReadonlySet<string> = new Set(
  [
    WETH,
    USDG,
    NATIVE_ETH,
    UNISWAP_V2_FACTORY,
    UNISWAP_V4_POOL_MANAGER,
    PONS_V2_FACTORY,
    PONS_GRADUATION_HOOK,
    '0x000000000000000000000000000000000000dead',
  ].map((a) => a.toLowerCase()),
);

export type ConfirmReason =
  /** A quote token, a router, a factory, a hook — never a launch. */
  | 'known_contract'
  /** No chain client in this process: we cannot confirm, so we say nothing. */
  | 'no_chain'
  /** The node would not answer. Unknown, not "no contract". */
  | 'unreadable'
  /** Nothing is deployed there. */
  | 'no_code'
  /** Deployed, but it does not answer as an ERC-20. */
  | 'not_erc20'
  /** No market data source has a pool for it yet. */
  | 'unresolved'
  /** Resolved, but with no pool-creation date to judge the age on. */
  | 'pool_unknown'
  /** Its earliest evidence is older than launchMaxPoolAgeHours — not this launch. */
  | 'pool_too_old';

export interface ConfirmedToken {
  address: string;
  symbol: string | null;
  poolAddress: string | null;
  /** The EARLIEST evidenced creation instant — the launch clock (launchClock.ts). */
  tokenCreatedAt: Date;
  /** Which of the three answers that clock came from. */
  clockSource: LaunchClock['source'];
  mcapUsd: number | null;
  liquidityUsd: number | null;
  /** The launchpad the pool belongs to, when the source names one ('pons-v2-dex'). */
  launchpad: string | null;
  /**
   * The HIJACK HOLD (docs/research-x-monitor.md §2, the @vladtenev takeover:
   * the token was created 46 minutes BEFORE the post). True when the token
   * predates the post by more than XWATCH.hijackHoldMinutes — the board records
   * the sighting and the chat hears nothing.
   */
  hijack: boolean;
}

export type Confirmation =
  | { ok: true; token: ConfirmedToken }
  | { ok: false; reason: ConfirmReason };

export interface ConfirmDeps {
  chain: ChainClient | null;
  /** Our own launch rows, for the earliest-evidence clock. Null skips that step. */
  db?: Db | null;
  /** Injected for tests; production uses the app's own resolution path. */
  resolve?: (address: string) => Promise<Resolution>;
  /** Injected for tests; production reads discovery, then the chain, then the pool. */
  clock?: (address: string, poolCreatedAt: Date) => Promise<LaunchClock>;
  nowMs?: number;
}

/** An eth_call answer that actually carries data (a revert comes back null). */
function answered(result: string | null): boolean {
  return typeof result === 'string' && result.length > 2;
}

export async function confirmAddress(
  address: string,
  postedAt: Date,
  deps: ConfirmDeps,
): Promise<Confirmation> {
  const lower = address.toLowerCase();
  if (KNOWN_CONTRACTS.has(lower)) return { ok: false, reason: 'known_contract' };

  const chain = deps.chain;
  // No listener configured (or a client built without the code read): we cannot
  // prove this is a contract, so we do not claim it is one.
  if (chain === null || typeof chain.getCode !== 'function') {
    return { ok: false, reason: 'no_chain' };
  }

  const code = await chain.getCode(lower);
  if (code === null) return { ok: false, reason: 'unreadable' };
  if (code === '0x' || code === '0x0' || code === '') return { ok: false, reason: 'no_code' };

  // Three reads, once per candidate address, ever: getCode plus the two ERC-20
  // getters. `call` answers null on a revert, which is the token telling us it
  // is not one.
  const [symbolData, decimalsData] = await Promise.all([
    chain.call(lower, SYMBOL_SELECTOR),
    chain.call(lower, DECIMALS_SELECTOR),
  ]);
  if (!answered(symbolData) || !answered(decimalsData)) {
    return { ok: false, reason: 'not_erc20' };
  }

  const resolve = deps.resolve ?? resolveToken;
  const resolution = await resolve(lower);
  const token = resolution.token;
  // A resolution failure is silence: no pool means no launch clock, and round
  // 23 records nothing rather than a launch it cannot date.
  if (token === null) return { ok: false, reason: 'unresolved' };
  const poolCreatedAt = token.tokenCreatedAt;
  if (!(poolCreatedAt instanceof Date) || Number.isNaN(poolCreatedAt.getTime())) {
    return { ok: false, reason: 'pool_unknown' };
  }

  // EARLIEST EVIDENCE, not the pool clock: a token minted an hour before the
  // post whose pool opened seconds ago would otherwise read as brand new, which
  // is exactly the hijack shape the hold exists for.
  //
  // The hunt costs a block bisection, so it is only run for a caller that also
  // brought our own records to check first (the app always does); a caller with
  // neither a `db` nor an injected clock is asking for a bare confirmation and
  // gets the pool's own date.
  const clock: LaunchClock =
    deps.clock !== undefined
      ? await deps.clock(lower, poolCreatedAt)
      : deps.db !== null && deps.db !== undefined
        ? await resolveLaunchClock(lower, poolCreatedAt, { db: deps.db, chain })
        : { at: poolCreatedAt, source: 'pool' };
  const createdAt = clock.at;

  const nowMs = deps.nowMs ?? Date.now();
  if (nowMs - createdAt.getTime() > XWATCH.launchMaxPoolAgeHours * 3_600_000) {
    return { ok: false, reason: 'pool_too_old' };
  }

  return {
    ok: true,
    token: {
      address: lower,
      symbol: token.symbol,
      poolAddress: token.poolAddress,
      tokenCreatedAt: createdAt,
      clockSource: clock.source,
      mcapUsd: token.snapshot?.mcapUsd ?? null,
      liquidityUsd: token.snapshot?.liquidityUsd ?? null,
      launchpad: token.launchpad,
      hijack:
        postedAt.getTime() - createdAt.getTime() > XWATCH.hijackHoldMinutes * 60_000,
    },
  };
}
