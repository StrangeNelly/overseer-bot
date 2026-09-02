import { eq, sql } from 'drizzle-orm';
import { discoveryEvents, type Db } from '@groupie/db';
import { summarizeRpcError, type ChainClient } from '../chain/client.js';
import { findTokenLaunch } from '../discovery/scan.js';

/**
 * When did this token actually come into existence? (docs/decisions.md round 23)
 *
 * The pool's creation date is the WEAKEST of the three answers we can give, and
 * it is the one that flatters a hijack: a token minted an hour before the post
 * whose pool opened seconds ago reads as brand new on the pool clock alone. So
 * the earliest evidence wins, in order:
 *
 *   1. our OWN discovery row — the listener saw the launch (or the graduation)
 *      on chain and dated it from the block;
 *   2. the PONS `TokenLaunched` block, found the way a graduation's bundle
 *      window is found (discovery/scan.ts);
 *   3. the pool clock, which is what the market source hands us.
 *
 * Every step above the pool clock is BEST EFFORT: a read that fails falls
 * through to the next answer rather than blocking the confirmation, because an
 * unreadable chain is not evidence that a token is young.
 */

export type LaunchClockSource = 'discovery' | 'chain' | 'pool';

export interface LaunchClock {
  at: Date;
  source: LaunchClockSource;
}

/** The earliest instant our own listener recorded for this address, if any. */
async function discoveryClock(db: Db, address: string): Promise<Date | null> {
  const rows = await db
    .select({ at: sql<string | Date | null>`min(${discoveryEvents.at})` })
    .from(discoveryEvents)
    .where(eq(discoveryEvents.tokenAddress, address));
  const raw = rows[0]?.at ?? null;
  if (raw === null) return null;
  // min() comes back as a string from postgres-js; a Date survives untouched.
  const at = raw instanceof Date ? raw : new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** The PONS launch block's timestamp, or null when the chain cannot say. */
async function chainClock(chain: ChainClient, address: string): Promise<Date | null> {
  try {
    const head = await chain.getBlockNumber();
    const launch = await findTokenLaunch(chain, address, head);
    if (launch === null) return null;
    const seconds = await chain.getBlockTimestamp(launch.launchBlock);
    if (seconds === null || !Number.isFinite(seconds)) return null;
    return new Date(seconds * 1000);
  } catch (err) {
    console.warn(`xwatch: launch clock read failed for ${address}: ${summarizeRpcError(err)}`);
    return null;
  }
}

export interface LaunchClockDeps {
  db: Db | null;
  chain: ChainClient | null;
}

/**
 * The earliest creation instant we can evidence for `address`, never later than
 * the pool clock we were handed.
 */
export async function resolveLaunchClock(
  address: string,
  poolCreatedAt: Date,
  deps: LaunchClockDeps,
): Promise<LaunchClock> {
  const lower = address.toLowerCase();
  if (deps.db !== null) {
    const seen = await discoveryClock(deps.db, lower).catch(() => null);
    // Only when it is EARLIER: a discovery row written after the pool opened
    // (a graduation, say) dates the migration, not the token.
    if (seen !== null && seen.getTime() <= poolCreatedAt.getTime()) {
      return { at: seen, source: 'discovery' };
    }
  }
  if (deps.chain !== null) {
    const launched = await chainClock(deps.chain, lower);
    if (launched !== null && launched.getTime() <= poolCreatedAt.getTime()) {
      return { at: launched, source: 'chain' };
    }
  }
  return { at: poolCreatedAt, source: 'pool' };
}
