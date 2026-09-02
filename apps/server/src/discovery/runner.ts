import type { Db } from '@groupie/db';
import { DISCOVERY } from '@groupie/shared';
import type { ChainClient } from '../chain/client.js';
import { deliverDiscoveryAlerts, retireStaleDiscoveryAlerts } from './alerts.js';
import {
  pruneDiscovery,
  runDiscoveryTick,
  runEnrichment,
  runLockReads,
  runReEnrichment,
} from './scan.js';

/**
 * The discovery listener's clocks, isolated the way the poller isolates its
 * tick: a failing pass logs and is retried on the next one, and nothing here
 * can crash the process.
 *
 * TWO loops, not one. The chain tick reads block ranges and must keep its ~20s
 * cadence; enrichment talks to DexScreener and GeckoTerminal, which back off,
 * rate-limit and time out. Running them on one timer meant a market-data hiccup
 * delayed the next block range — a launch missed because a price API was slow.
 * Each loop has its own interval, its own `running` flag and its own isolate,
 * so neither can hold the other up.
 *
 * Separate from the market poller for the same reason one level up: its own
 * provider, its own budget, its own cadence.
 */

/** Hourly, like the snapshot prune — the window it clears is seven days wide. */
const PRUNE_INTERVAL_MS = 3_600_000;

export interface DiscoveryHandle {
  stop(): void;
  /**
   * Whether the listener is actually LIVE IN THIS PROCESS. The route serves
   * this as `enabled`, so a WEB_ONLY dev box says the feed is off even when the
   * deployment has a key — an empty stream and a stream nobody is reading are
   * different answers and the board must not conflate them.
   */
  readonly running: boolean;
}

const DORMANT: DiscoveryHandle = { stop: () => {}, running: false };

export function startDiscovery(db: Db, chain: ChainClient | null): DiscoveryHandle {
  if (chain === null) {
    // No RPC URL: the feature is DORMANT. Nothing polls, nothing throws, and
    // /discovery answers enabled:false. Said once, at boot, so an operator
    // wondering why the zones are empty finds the reason in the logs.
    console.log('discovery: no ALCHEMY_API_KEY / ALCHEMY_RPC_URL — chain listener disabled');
    return DORMANT;
  }

  let chainRunning = false;
  const chainTimer = setInterval(async () => {
    if (chainRunning) return;
    chainRunning = true;
    try {
      await runDiscoveryTick(db, chain);
    } catch (err) {
      console.error('discovery tick failed:', err);
    } finally {
      chainRunning = false;
    }
  }, DISCOVERY.pollIntervalMs);

  let enriching = false;
  let lastPruneMs = 0;
  const enrichTimer = setInterval(async () => {
    if (enriching) return;
    enriching = true;
    try {
      // In order, and each isolated by the one try: a first enrichment feeds
      // the lock read, which feeds what the chat is allowed to say. A throw in
      // any of them costs this pass and nothing else.
      const enriched = await runEnrichment(db);
      const refreshed = await runReEnrichment(db);
      await runLockReads(db);
      await retireStaleDiscoveryAlerts(db);
      const alerted = await deliverDiscoveryAlerts(db);
      if (alerted > 0) {
        console.log(`discovery: ${enriched} enriched, ${refreshed} refreshed, ${alerted} alerted`);
      }
    } catch (err) {
      console.error('discovery enrichment failed:', err);
    } finally {
      enriching = false;
    }
    // Outside the try/finally so a failed prune can never hold `enriching`
    // high, and after it so a slow pass never delays the stream for a sweep.
    if (Date.now() - lastPruneMs < PRUNE_INTERVAL_MS) return;
    lastPruneMs = Date.now();
    try {
      await pruneDiscovery(db);
    } catch (err) {
      console.error('discovery prune failed:', err);
    }
  }, DISCOVERY.enrichIntervalMs);

  console.log(
    `discovery listener started (chain ${DISCOVERY.pollIntervalMs / 1000}s, ` +
      `enrichment ${DISCOVERY.enrichIntervalMs / 1000}s)`,
  );
  let live = true;
  return {
    stop() {
      clearInterval(chainTimer);
      clearInterval(enrichTimer);
      live = false;
    },
    get running() {
      return live;
    },
  };
}
