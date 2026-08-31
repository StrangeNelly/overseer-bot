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
 * launches ~$5k mcap; retracing to <= ~$8k means back at the curve floor.
 * Will move into per-group settings when multi-group lands.
 */
export const THRESHOLDS = {
  /** Curve-phase token at or below this mcap = dead. */
  curveFloorMcapUsd: 8_000,
  /**
   * The curve floor is a RETRACE rule, so it only arms once the token has been
   * observed above this mcap. Launches start ~$5k, i.e. below the floor.
   */
  curveFloorArmMcapUsd: 12_000,
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
  /** Confirmed dead: daily revival check. */
  deadSeconds: 86_400,
} as const;

/** No mention for this long demotes a living token to the idle tier. */
export const IDLE_AFTER_HOURS = 7 * 24;

/** Snapshot age tiers (docs/plan.md: snapshots are pruned by age tiers). */
export const SNAPSHOT_RETENTION = {
  /** Older than this: thinned to one row per bucket per token. */
  thinAfterHours: 48,
  /** Bucket width the thinning keeps one row per. */
  thinBucketSeconds: 900,
  /** Older than this: deleted outright. Caps how far back M3 charts can go. */
  hardDeleteDays: 90,
} as const;
