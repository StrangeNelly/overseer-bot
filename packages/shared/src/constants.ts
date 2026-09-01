/** Robinhood Chain (Arbitrum-stack L2). */
export const ROBINHOOD_CHAIN_ID = 4663;

/** Chain slug used by both DexScreener (chainId) and GeckoTerminal (network id). */
export const ROBINHOOD_SLUG = 'robinhood';

/** Call/token lifecycle states shared between db, server, and web. */
export const CALL_STATUSES = ['active', 'died', 'binned'] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

export const TOKEN_PHASES = ['unresolved', 'curve', 'graduated', 'dead'] as const;
export type TokenPhase = (typeof TOKEN_PHASES)[number];

/**
 * v1 death/retrace thresholds (decisions.md). Owner's curve knowledge: PONS
 * launches ~$5k mcap; retracing to ~$8k means back at the curve floor — which
 * round 6 turned from an instant death into rug probation (hide, watch, revive
 * or expire). Will move into per-group settings when multi-group lands.
 */
export const THRESHOLDS = {
  /** Owner rule (decisions.md round 6): mcap below this is the rug floor. */
  rugFloorMcapUsd: 8_000,
  /**
   * Round 6: this long unbroken under the floor hides the token into probation.
   * Round 5's 6h was too slow to clean the feed; the comeback path (below) is
   * what makes an hour safe to act on.
   */
  rugHideHours: 1,
  /** Round 6: probation this long without a revival is the permanent rug. */
  rugProbationHours: 24,
  /** Round 6: a hidden token back at/above this mcap is a revival candidate. */
  rugReviveMcapUsd: 30_000,
  /** Round 6: ...and it must hold that, every reading, for this long. */
  rugReviveHoldHours: 3,
  /**
   * Round 6 item 5a: a re-mention of a token whose cached mcap is under this is
   * INERT (members repost rugged CAs to point at the corpse, which is not
   * renewed attention). Deliberately above the rug floor — hysteresis, so a
   * token hovering at the floor doesn't flip behaviour on every poll.
   */
  inertRementionMcapUsd: 9_000,
  /** Graduated token whose best pair holds less than this = dead. */
  deadLiquidityUsd: 250,
  /** Call dies when liquidity falls below this fraction of liquidity-at-call. */
  liquidityDropDeathRatio: 0.05,
  /** Launchpad token that never graduates dies after this long. */
  ungraduatedDeathHours: 48,
  /** DexScreener pair below this liquidity is dust — not proof of a real pool. */
  dustLiquidityUsd: 1_000,
  /** Dead token showing at least this much liquidity again = revived. */
  reviveLiquidityUsd: 1_000,
  /** Dead curve token back above this mcap = revived. */
  reviveCurveMcapUsd: 16_000,
  /** Runner = current/peak mcap at least this multiple of mcap-at-call. */
  runnerMultiple: 3,
  /** Retraced = peak >= runnerMultiple x call AND now this far below peak. */
  retraceFromPeakRatio: 0.4,
} as const;

/** Poller tiers (seconds between polls per token). */
export const POLL_TIERS = {
  /** Called or re-mentioned within the last 24h. */
  freshSeconds: 45,
  /** Older but still active. */
  activeSeconds: 300,
  /** Alive but not mentioned for over a week. */
  idleSeconds: 3_600,
  /**
   * Hidden into rug probation (decisions.md round 6): quiet background watch
   * for the revival window, cheap enough to run for 24h on every rug.
   */
  probationSeconds: 1_800,
  /** Confirmed dead: daily revival check. */
  deadSeconds: 86_400,
} as const;

/**
 * Watchlist alert defaults (docs/decisions.md round 4). Per-group overrides live
 * in groups.settings.alerts as a partial of this shape and are merged over these.
 */
export const ALERT_DEFAULTS = {
  /** Fired when the drop over nukeWindowMin exceeds this. */
  nukeDropPct: 40,
  nukeWindowMin: 15,
  /** Fired when the retrace from the peak exceeds this. */
  buyRetracePct: 30,
  /** The peak is searched within this lookback. */
  buyPeakWindowHours: 24,
  /** The peak must be at least this old: a slow bleed, not a nuke. */
  buyMinDeclineHours: 1,
  /** Per (token, type). */
  cooldownMin: 60,
} as const;

export const ALERT_TYPES = ['nuke', 'buy_opp'] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

export type AlertSettings = { -readonly [K in keyof typeof ALERT_DEFAULTS]: number };

/** No mention for this long demotes a living token to the idle tier. */
export const IDLE_AFTER_HOURS = 7 * 24;

/**
 * "Sleepers" chain-wide discovery stream (docs/decisions.md round 9). Every
 * scanIntervalHours the poller sweeps ALL of Robinhood Chain by 24h volume and
 * keeps the coins that are quietly trading hard. These are RESEARCH LEADS, not
 * group calls, and nothing here is tracked or polled afterwards.
 */
export const SLEEPERS = {
  /** How often the chain-wide sweep runs. */
  scanIntervalHours: 3,
  /**
   * GeckoTerminal serves 20 pools/page and caps the free tier at page 10, so
   * this is the whole reachable depth: ~200 pools by 24h volume.
   */
  maxPages: 10,
  /** Below this a "pool" is not a market anyone can trade out of. */
  minLiquidityUsd: 10_000,
  /** Younger than this is a launch, not a sleeper — it has no 24h to judge. */
  minPoolAgeHours: 1,
  /** Older than this is not "quietly trading hard", it is just old. */
  maxPoolAgeDays: 10,
  /** Fewer trades than this in 24h is one whale moving size, not activity. */
  minTxns24: 20,
  /**
   * Kept per band by the scan. Deliberately more than the API serves: the
   * "X only" toggle filters at read time and would otherwise run the band dry.
   */
  keepPerBand: 6,
  /** Served per band by the API, after the per-group and twitter filters. */
  servePerBand: 3,
  /** An entry that has been listed this long earns the persistence marker. */
  persistenceMarkerHours: 3,
  /** sleeper_seen rows older than this are pruned. */
  seenRetentionDays: 14,
} as const;

/**
 * The tapering 24h-volume floor a coin must clear for its market cap
 * (owner's spec, docs/decisions.md round 9): `170 * mcap ** 0.4114`.
 *
 * The exponent is what makes it a taper rather than a flat percentage — the
 * two anchors it was fitted to:
 *   - $20K mcap  -> ~$10K volume (~50% turnover)
 *   - $1M  mcap  -> ~$50K volume (~5% turnover)
 *
 * Returns Infinity for a non-finite or non-positive mcap, so a bad reading can
 * never pass the floor by accident.
 */
export function requiredVolumeUsd(mcapUsd: number): number {
  if (!Number.isFinite(mcapUsd) || mcapUsd <= 0) return Number.POSITIVE_INFINITY;
  return 170 * mcapUsd ** 0.4114;
}

/** Snapshot age tiers (docs/plan.md: snapshots are pruned by age tiers). */
export const SNAPSHOT_RETENTION = {
  /** Older than this: thinned to one row per bucket per token. */
  thinAfterHours: 48,
  /** Bucket width the thinning keeps one row per. */
  thinBucketSeconds: 900,
  /** Older than this: deleted outright. Caps how far back M3 charts can go. */
  hardDeleteDays: 90,
} as const;
