import { DISCOVERY_DEFAULTS, tradingLinks } from '@groupie/shared';
import { dexLabel } from '../discovery/message.js';
import { bold, code, esc, link } from '../bot/telegramHtml.js';
import { fmtElapsed, fmtUsd } from '../poller/alertLogic.js';

/**
 * The launch ping (docs/decisions.md round 23, reformatted in round 27) — the
 * one message this feature ever sends, once per monitor, as a reply to the
 * message that added it.
 *
 * Five lines, TELEGRAM HTML, and no adjective anywhere: who posted, what the
 * coin is, the numbers, the launch block, the links. We are the CONFIRMED
 * contract address, not the first — snipers act in 19 seconds and this arrives
 * in 60 to 150 — so the message claims nothing about being early.
 *
 * ROUND 27 CHANGED THE SHAPE, not the facts. The owner's report on the first
 * live fire (@crumbsfamily, 2026-09-09) was that the launch-block share read as
 * two unrelated numbers buried mid-line, and that three raw 90-character URLs
 * were neither readable nor tappable. So: the address is `<code>` (tap to copy,
 * and printed IN FULL — a shortened address cannot be pasted into a trading
 * app), the launch block gets its own line as a sentence, and the links are
 * four short words instead of three URLs. Round 23's plain-text reasoning ("a
 * symbol carrying `*` or `_` must not break the send") was about Markdown; HTML
 * has three special characters and bot/telegramHtml.ts escapes all of them.
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

/**
 * `CRUMBS · 0x80baa4…889136` — the symbol AND the address, because both are
 * checked, and the address IN FULL inside `<code>` so it can be tapped to copy.
 */
function identityLine(symbol: string | null, address: string): string {
  const tappable = code(address);
  const trimmed = symbol?.trim();
  return trimmed ? `${bold(trimmed)} · ${tappable}` : tappable;
}

/** The market numbers. The launch block is NOT here — it has its own line. */
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
  return parts.length === 0 ? esc('') || null : esc(parts.join(' · '));
}

/**
 * `launch block: 71% of supply to 16 wallets` — its own line, as a sentence.
 *
 * Round 27, from the owner's report on the first live fire: as a mid-line
 * clause ("launch block 71% · 16 wallets") the two numbers read as unrelated
 * facts rather than as the one thing they measure — how much of the supply left
 * the pool into real wallets in the launch window (chain/bundle.ts).
 *
 * BOLD AT OR ABOVE `DISCOVERY_DEFAULTS.bundleMaxPct`, and that is emphasis
 * rather than a verdict: 25% is the owner's OWN bundle filter, the share this
 * product already hides a Discovery row for. The message still says no
 * adjective and draws no conclusion — it just stops burying the reading that
 * the group's own rule calls heavy. The DEFAULT is used deliberately rather
 * than the group's current setting: this is a typographic threshold, not a
 * filter decision, and it is not worth threading group settings through a pure
 * builder to style one line. Null (unreadable) prints nothing at all: unknown
 * is not evidence, here as everywhere.
 */
function launchBlockLine(args: LaunchPingArgs): string | null {
  const pct = args.launchBlockPct;
  if (pct === null || !Number.isFinite(pct)) return null;
  const rounded = Math.round(pct);
  const wallets =
    args.launchBlockWallets !== null && Number.isFinite(args.launchBlockWallets)
      ? Math.round(args.launchBlockWallets)
      : null;
  const sentence =
    wallets === null
      ? `launch block: ${rounded}% of supply`
      : `launch block: ${rounded}% of supply to ${wallets} wallet${wallets === 1 ? '' : 's'}`;
  return rounded >= DISCOVERY_DEFAULTS.bundleMaxPct ? bold(sentence) : esc(sentence);
}

/**
 * `post · AXIOM · GMGN · DEXS` — four tappable words.
 *
 * Round 23 printed the URLs themselves because plain text cannot make a word
 * tappable; in HTML it can, and the owner's report was that three 90-character
 * URLs made the ping unreadable. The post comes first because it is the
 * receipt — the thing that says WHY this message exists.
 */
function linksLine(address: string, tweetUrl: string | null): string {
  const links = tradingLinks(address);
  const parts: string[] = [];
  if (tweetUrl !== null && tweetUrl.trim() !== '') parts.push(link('post', tweetUrl));
  parts.push(link('AXIOM', links.axiom));
  parts.push(link('GMGN', links.gmgn));
  parts.push(link('DEXS', links.dexscreener));
  return parts.join(' · ');
}

/** Telegram HTML. The caller MUST send it with parse_mode 'HTML'. */
export function launchPingMessage(args: LaunchPingArgs): string {
  const lines: string[] = [
    `${bold('@' + args.handle)} posted a contract address.`,
    identityLine(args.symbol, args.address),
  ];
  const facts = factsLine(args);
  if (facts !== null && facts !== '') lines.push(facts);
  const launchBlock = launchBlockLine(args);
  if (launchBlock !== null) lines.push(launchBlock);
  lines.push(linksLine(args.address, args.tweetUrl));
  return lines.join('\n');
}
