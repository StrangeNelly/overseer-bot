import { TOPICS } from './addresses.js';
import { dataWord, topicAddress, wordToBigInt } from './decode.js';
import type { ChainLog } from './client.js';

/**
 * Bundle facts (docs/decisions.md round 20): how much of a new coin's supply
 * left the pool in its launch block window, and how many wallets took it.
 *
 * The owner's ask was "if we could somehow not show coins that have been
 * heavily bundled". This is the measurement behind that filter, and round 20 is
 * explicit that it is also printed on every visible row — "launch block 12% ·
 * 9 wallets" — so the number is never a hidden verdict.
 *
 * Pure, so the arithmetic can be pinned to fixtures rather than to a chain.
 */

export interface LaunchBlockShare {
  /** Share of total supply held by real wallets after the window, 0-100. */
  pct: number;
  /** How many distinct wallets ended the window holding some of it. */
  wallets: number;
}

/**
 * Supply that came OUT OF THE POOL, netted per recipient.
 *
 * Two rules, and the review turned on the first one:
 *
 * 1. Only a transfer whose SENDER is a sink (the pair, the v4 singleton, the
 *    PONS curve) is a purchase. Counting every transfer to a non-excluded
 *    address instead counts the deployer's own mint — supply that goes to the
 *    deployer and then straight into the pool as liquidity — as a 100% bundle,
 *    which is the opposite of the truth about a clean launch.
 * 2. Netted, not gross. A bundler routinely fans supply out through
 *    intermediates in the same block; gross receipts would count the same
 *    tokens twice and could print more than 100% of supply. Sends BACK to a
 *    sink (a sell) net the recipient down again.
 *
 * `supply` is total supply in base units; `excluded` holds the sinks, the token
 * itself, the burn address and any launchpad hook (see bundleExclusions) —
 * supply parked in any of those was never bought by anyone.
 *
 * Returns null when the question cannot be answered: no logs (the read failed),
 * no usable total supply, or a window whose decodable Transfers never touch a
 * sink at all. That last one is the SINK CHECK: a real curve, pair or singleton
 * launch always shows the supply arriving at its sink — the live reading in
 * docs/research-onchain.md has the full mint go `0x0 -> curve` in the launch
 * block — so a window full of Transfers with the sink in neither `from` nor `to`
 * proves the sink assumption wrong for this launch, and every share computed
 * from it would be a confident 0%. Unknown is the honest answer.
 *
 * Null is rendered as "unknown" and is NOT hidden by the bundle filter —
 * unknown is not evidence.
 */
export function computeLaunchBlockShare(
  logs: readonly ChainLog[] | null | undefined,
  supply: bigint | null,
  sinks: ReadonlySet<string>,
  excluded: ReadonlySet<string>,
): LaunchBlockShare | null {
  if (!logs) return null;
  if (supply === null || supply <= 0n) return null;

  const net = new Map<string, bigint>();
  let decodable = 0;
  let sinkSeen = false;
  for (const log of logs) {
    if (log.topics[0]?.toLowerCase() !== TOPICS.transfer) continue;
    const from = topicAddress(log.topics, 1);
    const to = topicAddress(log.topics, 2);
    const value = wordToBigInt(dataWord(log.data, 0));
    // A Transfer we cannot decode is not evidence of anything; skipping it
    // under-reports rather than inventing a recipient.
    if (from === null || to === null || value === null || value === 0n) continue;
    decodable += 1;
    if (sinks.has(from) || sinks.has(to)) sinkSeen = true;
    if (sinks.has(from) && !excluded.has(to)) {
      net.set(to, (net.get(to) ?? 0n) + value);
      continue;
    }
    // A sell back into a sink cancels an earlier buy; a hop between two ordinary
    // wallets moves the position rather than creating a second one. Both are
    // only counted for addresses the pool has already paid out to — an address
    // with no recorded buy stays absent rather than going negative on its own.
    if (sinks.has(to) && net.has(from)) {
      net.set(from, (net.get(from) ?? 0n) - value);
      continue;
    }
    // A send to any OTHER excluded address — the burn address, the token
    // contract, a hook taking custody — leaves the buyer's hands for good. It
    // has to decrement the sender without crediting anyone, or supply somebody
    // burned would still be counted as held by a wallet.
    if (excluded.has(to) && net.has(from)) {
      net.set(from, (net.get(from) ?? 0n) - value);
      continue;
    }
    if (!sinks.has(to) && !excluded.has(to) && net.has(from)) {
      net.set(from, (net.get(from) ?? 0n) - value);
      net.set(to, (net.get(to) ?? 0n) + value);
    }
  }

  // Transfers happened and not one of them touched the sink: whatever this
  // window describes, it is not supply moving through the address we were told
  // sells it. Unknown rather than a 0% nobody could stand behind.
  if (decodable > 0 && !sinkSeen) return null;

  let held = 0n;
  let wallets = 0;
  for (const balance of net.values()) {
    if (balance <= 0n) continue;
    held += balance;
    wallets += 1;
  }

  // Basis points in BigInt, then one division: supply routinely exceeds 2^53,
  // so the ratio must not be taken in floating point.
  const bps = (held * 10_000n) / supply;
  const pct = Math.min(100, Math.max(0, Number(bps) / 100));
  return { pct, wallets };
}

/** ERC20 `totalSupply()` selector — the only call site's whole calldata. */
export const TOTAL_SUPPLY_CALLDATA = '0x18160ddd';
