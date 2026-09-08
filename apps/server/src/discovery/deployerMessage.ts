import { tradingLinks, type DeployerFiredVia } from '@groupie/shared';
import { dexLabel } from './message.js';
import { fmtElapsed, fmtUsd, shortAddress } from '../poller/alertLogic.js';

/**
 * The deployer-watch message (docs/decisions.md round 26) — the one thing this
 * feature ever says in the chat, once per WATCH. Two watches on one team (the
 * wallet and its registry) each speak, by design: the launch and the later
 * publication are different events, and neither is a substitute for the other.
 *
 * The owner's ask was "notify me in the telegram group as soon as its launched
 * on pons or anywhere else", so the FIRST LINE is which of the four signals
 * actually fired, in plain words: the four are not equally strong evidence and
 * a message that flattened them into "launched!" would promise a tradeable coin
 * on a path ('create') that proves only that bytecode exists somewhere.
 *
 * Plain text, no markdown — a symbol carrying `*` or `_` must not break the
 * send — and the same register as the launch ping (xwatch/message.ts): facts and
 * links, no adjectives, no advice. EVERY CLAUSE IS DROPPED WHEN ITS FIGURE IS
 * UNKNOWN, and on the 'create' path essentially all of them are: a raw
 * deployment has no symbol, no pool and no market, so the message has to read
 * correctly with nothing but the two addresses.
 */

export interface DeployerHitMessageArgs {
  via: DeployerFiredVia;
  /** The watched wallet/contract — printed short; it is an identifier, not a link. */
  watchedAddress: string;
  /**
   * What appeared. Printed IN FULL: this is the string a reader pastes.
   *
   * NULL is a real case, not a failure — a registry event whose parameter layout
   * we cannot decode is still a publication worth saying out loud ("fired, and
   * here is the transaction"). The message then carries the receipt and no
   * links, because there is nothing to link to. It is NEVER filled in with a
   * plausible-looking address.
   */
  address: string | null;
  symbol: string | null;
  name: string | null;
  mcapUsd: number | null;
  liquidityUsd: number | null;
  /** The pool's creation instant, for "launched 4m ago"; null when unknown. */
  tokenCreatedAt: Date | null;
  /** Dex/launchpad id, e.g. 'pons-v2-dex'. */
  launchpad: string | null;
  /** The transaction that carried the signal — the receipt, when we have one. */
  txHash: string | null;
  /** The note the adder attached to the watch, when they left one. */
  note: string | null;
  nowMs: number;
}

/**
 * What the signal PROVES, said as a verb. Round 26 fixed these words with the
 * owner: 'pons' and 'pool' are launches, 'create' is a deployment and nothing
 * more, and 'registry' is a publication by a contract that was already watched.
 */
const VIA_VERB: Record<DeployerFiredVia, string> = {
  pons: 'launched on PONS',
  pool: 'opened a pool',
  create: 'deployed a contract',
  registry: 'published its official token',
};

/**
 * The same four verbs, for the `/overseer deployers` list — one wording for the
 * message and the list, so a member reading "opened a pool" in the chat finds
 * the identical phrase against the row that said it.
 */
export function deployerViaPhrase(via: DeployerFiredVia): string {
  return VIA_VERB[via];
}

/**
 * The 'create' path's honesty line. A predicted CREATE address with code at it
 * is a contract — it is NOT a token, not a pool and not something anybody can
 * buy — and the whole value of catching it early is destroyed if the message
 * lets a reader think otherwise (the motivating case was a REGISTRY contract,
 * which is exactly this: a deploy that is not a coin).
 */
export const CREATE_CAVEAT =
  'Not tradeable — a contract deployment, which may not be a token at all.';

/**
 * ...and the corollary, said in the same breath: this watch is NOT spent. The
 * create road is the only one that does not retire the row, precisely because
 * the deployment it reports is so often the step BEFORE the launch — a member
 * who read "deployed a contract" and assumed the watch was finished would stop
 * expecting the launch ping that is still coming.
 */
export const STILL_WATCHING = 'Still watching this address for the launch itself.';

function headline(args: DeployerHitMessageArgs): string {
  const who = shortAddress(args.watchedAddress);
  // The adder's own words, when they left any: it is what tells the reader
  // WHICH of their watches just fired without going to look it up.
  const note = args.note?.trim();
  const named = note ? `${who} (${note})` : who;
  return `${named} ${VIA_VERB[args.via]}.`;
}

/**
 * The address we could not read, said plainly. A message that simply omitted the
 * line would read as "a coin appeared and here are its links" with no coin in
 * it; this one tells the reader exactly what we have and what we do not.
 */
export const UNREADABLE_ADDRESS_LINE =
  'The address in that event could not be read — the transaction below has it.';

/** Symbol, name and the FULL address — the address is the point of the message. */
function identityLine(args: DeployerHitMessageArgs): string {
  if (args.address === null) return UNREADABLE_ADDRESS_LINE;
  const parts: string[] = [];
  const symbol = args.symbol?.trim();
  const name = args.name?.trim();
  if (symbol) parts.push(symbol);
  // The name only earns its place when it says something the symbol did not.
  if (name && name.toLowerCase() !== symbol?.toLowerCase()) parts.push(name);
  parts.push(args.address);
  return parts.join(' · ');
}

function factsLine(args: DeployerHitMessageArgs): string | null {
  const parts: string[] = [];
  if (args.mcapUsd !== null && Number.isFinite(args.mcapUsd)) {
    parts.push(`mcap ${fmtUsd(args.mcapUsd)}`);
  }
  if (args.liquidityUsd !== null && Number.isFinite(args.liquidityUsd)) {
    parts.push(`LP ${fmtUsd(args.liquidityUsd)}`);
  }
  if (args.tokenCreatedAt !== null && !Number.isNaN(args.tokenCreatedAt.getTime())) {
    parts.push(`launched ${fmtElapsed(args.nowMs - args.tokenCreatedAt.getTime())} ago`);
  }
  if (args.launchpad !== null && args.launchpad.trim() !== '') {
    parts.push(dexLabel(args.launchpad));
  }
  return parts.length === 0 ? null : parts.join(' · ');
}

/** The three deep links, as URLs — plain text cannot make a word tappable. */
function linksLine(address: string): string {
  const links = tradingLinks(address);
  return [links.axiom, links.gmgn, links.dexscreener].join(' · ');
}

export function deployerHitMessage(args: DeployerHitMessageArgs): string {
  const lines: string[] = [headline(args), identityLine(args)];
  const facts = factsLine(args);
  if (facts !== null) lines.push(facts);
  // Immediately under the identity: a reader who stops at the first two lines
  // must already know this one is not a coin yet — and that the watch it came
  // from is still running, because the create road never retires one.
  if (args.via === 'create') {
    lines.push(CREATE_CAVEAT);
    lines.push(STILL_WATCHING);
  }
  // The receipt. Printed whole, because half a transaction hash is worth
  // nothing in an explorer.
  const tx = args.txHash?.trim();
  if (tx) lines.push(`tx ${tx}`);
  // No address, no links — and no links on a CREATE either. Three trading deep
  // links under "not tradeable" is the one part of this message that would look
  // like it knows more than it does: a predicted CREATE address has no pool, so
  // all three resolve to nothing.
  if (args.address !== null && args.via !== 'create') lines.push(linksLine(args.address));
  return lines.join('\n');
}
