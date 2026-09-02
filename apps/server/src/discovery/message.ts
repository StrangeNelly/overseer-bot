import { DEX_IDS } from '../chain/addresses.js';
import { fmtUsd } from '../poller/alertLogic.js';

/**
 * The exact text a discovery alert posts (docs/decisions.md rounds 18 and 20).
 *
 * Neutral by construction: a dex name, an amount, a market cap, a lock
 * percentage, a launch-block share, two links. No adjective, no "hot", no
 * "opportunity" — the chat reads the numbers and decides. Plain text with no
 * markdown, like every other alert, so a symbol containing `*` or `_` cannot
 * break the send.
 *
 * Every clause is DROPPED when its figure is unknown rather than printed as a
 * zero or a dash: an alert that says "LP locked 0%" when nobody could read the
 * lock is worse than one that says nothing about locks.
 */

export interface DiscoveryMessageArgs {
  /** Symbol when known, otherwise a shortened address. */
  label: string;
  dex: string;
  initialLiquidityEth: number | null;
  /**
   * The deposit in dollars, and the asset actually deposited. A USDG-quoted
   * pool is opened with dollars, so printing its ETH-equivalent would put a
   * figure in the chat that nobody deposited; the ETH-equivalent stays the
   * THRESHOLD, and the sentence says what happened.
   */
  initialLiquidityUsd: number | null;
  quoteSymbol: 'ETH' | 'USDG' | null;
  mcapUsd: number | null;
  liquidityUsd: number | null;
  lpLockedPct: number | null;
  launchBlockPct: number | null;
  launchBlockWallets: number | null;
  twitterUrl: string | null;
  websiteUrl: string | null;
}

/** How a dex id reads in a sentence. An unknown id prints itself. */
export function dexLabel(dex: string): string {
  if (dex === DEX_IDS.uniswapV4) return 'Uniswap v4';
  if (dex === DEX_IDS.uniswapV2) return 'Uniswap v2';
  if (dex === DEX_IDS.ponsDex) return 'PONS';
  return dex;
}

/**
 * `5.8`, `12`, `0.6`, `6` — an ETH amount at the precision it deserves, with
 * trailing zeros trimmed so a round number reads as one.
 */
export function fmtEth(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value >= 100) return String(Math.round(value));
  if (value >= 10) return value.toFixed(1).replace(/\.0$/, '');
  return value.toFixed(2).replace(/\.?0+$/, '');
}

/** `LP locked 0%` / `locked 100%`, or nothing at all when the lock is unknown. */
function lockClause(pct: number | null): string | null {
  if (pct === null || !Number.isFinite(pct)) return null;
  return `locked ${Math.round(pct)}%`;
}

/** `launch block 12% / 9 wallets` — omitted whole when the block was unreadable. */
function bundleClause(pct: number | null, wallets: number | null): string | null {
  if (pct === null || !Number.isFinite(pct)) return null;
  const share = `launch block ${Math.round(pct)}%`;
  if (wallets === null || !Number.isFinite(wallets)) return share;
  return `${share} / ${wallets} wallet${wallets === 1 ? '' : 's'}`;
}

/**
 * The two links are printed as URLs rather than as the words "X" and "web": the
 * message is plain text with no markdown, so a bare word could not be tapped,
 * and both filters guarantee they are present on anything that alerts.
 */
function linkClauses(twitterUrl: string | null, websiteUrl: string | null): string[] {
  return [twitterUrl, websiteUrl].filter((url): url is string => typeof url === 'string' && url !== '');
}

/**
 * The deposit clause, in the asset that was actually deposited: "5.8 ETH
 * liquidity" for an ETH-quoted pool, "$12K USDG liquidity" for a USDG one.
 * Null when there is nothing honest to say.
 */
export function liquidityClause(args: DiscoveryMessageArgs): string | null {
  if (args.quoteSymbol === 'USDG') {
    if (args.initialLiquidityUsd === null || !Number.isFinite(args.initialLiquidityUsd)) return null;
    return `${fmtUsd(args.initialLiquidityUsd)} USDG liquidity`;
  }
  if (args.initialLiquidityEth === null || !Number.isFinite(args.initialLiquidityEth)) return null;
  return `${fmtEth(args.initialLiquidityEth)} ETH liquidity`;
}

/** "$SYM launched on Uniswap v4 · 5.8 ETH liquidity · LP locked 0% · $23K mcap · ..." */
export function launchMessage(args: DiscoveryMessageArgs): string {
  const parts: string[] = [`${args.label} launched on ${dexLabel(args.dex)}`];
  const liquidity = liquidityClause(args);
  if (liquidity !== null) parts.push(liquidity);
  const lock = lockClause(args.lpLockedPct);
  if (lock !== null) parts.push(`LP ${lock}`);
  if (args.mcapUsd !== null && Number.isFinite(args.mcapUsd)) {
    parts.push(`${fmtUsd(args.mcapUsd)} mcap`);
  }
  const bundle = bundleClause(args.launchBlockPct, args.launchBlockWallets);
  if (bundle !== null) parts.push(bundle);
  parts.push(...linkClauses(args.twitterUrl, args.websiteUrl));
  return parts.join(' · ');
}

/** "$SYM graduated · $84K mcap · LP $22K (locked 100%) · launch block 12% / 9 wallets · ..." */
export function graduationMessage(args: DiscoveryMessageArgs): string {
  const parts: string[] = [`${args.label} graduated`];
  if (args.mcapUsd !== null && Number.isFinite(args.mcapUsd)) {
    parts.push(`${fmtUsd(args.mcapUsd)} mcap`);
  }
  if (args.liquidityUsd !== null && Number.isFinite(args.liquidityUsd)) {
    const lock = lockClause(args.lpLockedPct);
    parts.push(`LP ${fmtUsd(args.liquidityUsd)}${lock === null ? '' : ` (${lock})`}`);
  }
  const bundle = bundleClause(args.launchBlockPct, args.launchBlockWallets);
  if (bundle !== null) parts.push(bundle);
  parts.push(...linkClauses(args.twitterUrl, args.websiteUrl));
  return parts.join(' · ');
}

export function discoveryMessage(
  kind: 'launch' | 'graduation',
  args: DiscoveryMessageArgs,
): string {
  return kind === 'launch' ? launchMessage(args) : graduationMessage(args);
}
