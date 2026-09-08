import type { Db } from '@groupie/db';
import { DISCOVERY } from '@groupie/shared';
import {
  refusalStatus,
  shouldPauseTicks,
  summarizeRpcError,
  type ChainClient,
} from '../chain/client.js';
import {
  deliverDiscoveryAlerts,
  recoverDeployerHits,
  retireStaleDiscoveryAlerts,
} from './alerts.js';
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
  /**
   * The refusal back-off. A throughput refusal is one of two failures the next
   * tick cannot fix: retrying at the poll cadence spends budget on more 429s
   * and keeps the provider's per-second meter pinned, so the loop stops asking
   * for a while and doubles the wait each time it is refused again.
   *
   * A REJECTED KEY (401/403) takes the same schedule for the same reason: a
   * revoked or mistyped key answers every 20-second tick identically, and an
   * error line every 20 seconds buries the one thing an operator needs to read.
   * The wording names which of the two it was — one is waited out, the other is
   * fixed in the Railway variables.
   *
   * Deliberately NOT touching the cursor heartbeat: a paused listener reads as
   * stalled on the board after five minutes, which is exactly what it is.
   */
  let backoffMs = 0;
  let pausedUntilMs = 0;
  const chainTimer = setInterval(async () => {
    if (chainRunning) return;
    // Silent: the pause was announced once, and one line per skipped tick would
    // bury the reason under the symptom.
    if (Date.now() < pausedUntilMs) return;
    chainRunning = true;
    try {
      const tick = await runDiscoveryTick(db, chain);
      // Round 26's hits are NOT sent from here. The flip to 'fired' is committed
      // inside the block range that won it and cannot be re-won, so the telling
      // happens in the same range — a throw between the two (a 429 on the next
      // range, a failed cursor write) used to lose the one message this feature
      // owes. What is left over — a crash between the flip and the send — is
      // reconciled by the recovery sweep on the enrichment loop below.
      if (tick.deployerHits.length > 0) {
        console.log(`discovery: ${tick.deployerHits.length} deployer hit(s) this tick`);
      }
      if (backoffMs > 0) {
        console.log('discovery: provider accepting reads again, chain ticks resumed');
        backoffMs = 0;
        pausedUntilMs = 0;
      }
    } catch (err) {
      // Summarised, never the error object: this is the one log line an RPC
      // failure reaches, and viem's error carries the API-keyed URL in its
      // message, metaMessages and url.
      console.error(`discovery tick failed: ${summarizeRpcError(err)}`);
      const refusal = refusalStatus(err);
      if (shouldPauseTicks(err)) {
        backoffMs =
          backoffMs === 0
            ? DISCOVERY.throttleBackoffMs
            : Math.min(DISCOVERY.throttleBackoffMaxMs, backoffMs * 2);
        pausedUntilMs = Date.now() + backoffMs;
        const seconds = Math.round(backoffMs / 1000);
        console.warn(
          refusal === 429
            ? `discovery: provider throttled (429), pausing chain ticks for ${seconds}s`
            : `discovery: provider rejected the key (${refusal}), pausing chain ticks for ${seconds}s`,
        );
      }
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
      // Round 26: fired watches whose message never went out. Here rather than
      // on the chain loop because it is a reconciliation, not a detection — it
      // must not add work to the tick that has to keep its 20-second cadence.
      // Safe to re-run on two counts, and it needs both: the alerts row is the
      // record of the telling and its partial unique index refuses a second one
      // wherever there is a contract address to key on, and the sweep's grace
      // window (DEPLOYER_WATCH.recoveryGraceSeconds) keeps it off rows that are
      // still being delivered — which is the only way the one road with a NULL
      // address (an undecodable registry event) could have been said twice.
      await recoverDeployerHits(db);
      const alerted = await deliverDiscoveryAlerts(db);
      if (alerted > 0) {
        console.log(`discovery: ${enriched} enriched, ${refreshed} refreshed, ${alerted} alerted`);
      }
    } catch (err) {
      console.error(`discovery enrichment failed: ${summarizeRpcError(err)}`);
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
