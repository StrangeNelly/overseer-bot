import { tradingLinks } from '@groupie/shared';
import { dexLabel } from '../discovery/message.js';
import { fmtElapsed, fmtUsd, shortAddress } from '../poller/alertLogic.js';

/**
 * The launch ping (docs/decisions.md round 23) — the one message this feature
 * ever sends, once per monitor, as a reply to the message that added it.
 *
 * Four lines, plain text, no markdown (a symbol carrying `*` or `_` must not
 * break the send) and no adjective anywhere: who posted, what the coin is, the
 * numbers, the receipt, the links. We are the CONFIRMED contract address, not
 * the first — snipers act in 19 seconds and this arrives in 60 to 150 — so the
 * message claims nothing about being early.
 *
 * EVERY CLAUSE IS DROPPED WHEN ITS FIGURE IS UNKNOWN. A ping that prints
 * "mcap $0" because a read failed is worse than one that says nothing about the
 * market cap.
 */

export interface LaunchPingArgs {
  /** Lowercase, no leading @ — printed with the @. */
  handle: string;
  address: string;
  symbol: string | null;
  mcapUsd: number | null;
  liquidityUsd: number | null;
  /** The pool's creation instant, for "launched 4m ago". */
  tokenCreatedAt: Date | null;
  /** Dex/launchpad id, e.g. 'pons-v2-dex'. */
  launchpad: string | null;
  /** Launch-block bundle facts, when the discovery listener measured them. */
  launchBlockPct: number | null;
  launchBlockWallets: number | null;
  /** The post itself. */
  tweetUrl: string | null;
  nowMs: number;
}

/** `LEGS · 0xb279…60cc` — the symbol AND the address, because both are checked. */
function identityLine(symbol: string | null, address: string): string {
  const short = shortAddress(address);
  const trimmed = symbol?.trim();
  return trimmed ? `${trimmed} · ${short}` : short;
}

function factsLine(args: LaunchPingArgs): string | null {
  const parts: string[] = [];
  if (args.mcapUsd !== null && Number.isFinite(args.mcapUsd)) {
    parts.push(`mcap ${fmtUsd(args.mcapUsd)}`);
  }
  if (args.liquidityUsd !== null && Number.isFinite(args.liquidityUsd)) {
    parts.push(`LP ${fmtUsd(args.liquidityUsd)}`);
  }
  if (args.tokenCreatedAt !== null && !Number.isNaN(args.tokenCreatedAt.getTime())) {
    // The age of the TOKEN, not of the post: it is what tells a fresh launch
    // from the hijack case, and it is printed on both.
    parts.push(`launched ${fmtElapsed(args.nowMs - args.tokenCreatedAt.getTime())} ago`);
  }
  if (args.launchpad !== null && args.launchpad.trim() !== '') {
    parts.push(dexLabel(args.launchpad));
  }
  if (args.launchBlockPct !== null && Number.isFinite(args.launchBlockPct)) {
    parts.push(`launch block ${Math.round(args.launchBlockPct)}%`);
    if (args.launchBlockWallets !== null && Number.isFinite(args.launchBlockWallets)) {
      const wallets = Math.round(args.launchBlockWallets);
      parts.push(`${wallets} wallet${wallets === 1 ? '' : 's'}`);
    }
  }
  return parts.length === 0 ? null : parts.join(' · ');
}

/** The three deep links, as URLs — plain text cannot make a word tappable. */
function linksLine(address: string): string {
  const links = tradingLinks(address);
  return [links.axiom, links.gmgn, links.dexscreener].join(' · ');
}

export function launchPingMessage(args: LaunchPingArgs): string {
  const lines: string[] = [
    `@${args.handle} posted a contract address.`,
    identityLine(args.symbol, args.address),
  ];
  const facts = factsLine(args);
  if (facts !== null) lines.push(facts);
  if (args.tweetUrl !== null && args.tweetUrl.trim() !== '') lines.push(args.tweetUrl);
  lines.push(linksLine(args.address));
  return lines.join('\n');
}
