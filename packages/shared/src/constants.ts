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
  /**
   * Round 6: a hidden token back at/above this mcap is a revival candidate.
   *
   * Round 13 promoted it to THE revival bar, the only one in the codebase: a
   * DEAD token's comeback (death.ts's isRevived) is judged against this exact
   * number too, so probation's comeback and a corpse's comeback can never
   * drift. Liquidity is not a revival signal anywhere any more — PONS fair
   * launches lock LP permanently, so every graduated corpse keeps ~$5-6k of
   * residual liquidity forever and the old $1k liquidity bar would have
   * resurrected the dead on a ~25h loop (revive -> probation -> die -> revive).
   */
  revivalMcapUsd: 30_000,
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
  /**
   * Round 11: a liquidity-based death (the $250 token floor AND the per-call
   * 95% collapse) must hold for at least this long before it is believed.
   *
   * Live case OMNI: a 6-minute-old pool was called at 19:02:11 and declared
   * dead three seconds later off a single liquidity=$0 first reading, while the
   * chart traded happily to $132k — newborn-pool indexing lag, not a rug. A
   * real drain stays drained, so confirmation costs nothing.
   */
  liquidityDeathMinMinutes: 10,
  /** Round 11: ...and across at least this many readings — one lonely observation is not "sustained". */
  liquidityDeathMinReadings: 3,
  /**
   * Round 11: no liquidity-based death at all this soon after the launch clock
   * (token_created_at, else first_seen_at). Brand-new pools are exactly where
   * the indexers lie. Mcap rules (rug probation floor/collapse, the 48h
   * never-graduated rule) are NOT affected — they read a different signal.
   */
  newbornGraceMinutes: 30,
  /** Launchpad token that never graduates dies after this long. */
  ungraduatedDeathHours: 48,
  /** DexScreener pair below this liquidity is dust — not proof of a real pool. */
  dustLiquidityUsd: 1_000,
  /**
   * Round 10 (collapse rule): mcap at or below this fraction of peak-since-call
   * is a collapse, not a dip. Sell-off rugs park just ABOVE the absolute floor
   * above (HDFI died at $8,249 with the floor at $8,000), so the second way into
   * rug probation is relative to what the token actually was.
   */
  collapseFromPeakRatio: 0.1,
  /**
   * Round 10: ...but only below this absolute mcap. A big bleeder is a loss, not
   * a rug — LIGMA at $996k and 0.37x is still a market, and the board must keep
   * showing it.
   */
  collapseCeilingUsd: 30_000,
  /** Runner = current/peak mcap at least this multiple of mcap-at-call. */
  runnerMultiple: 3,
  /** Retraced = peak >= runnerMultiple x call AND now this far below peak. */
  retraceFromPeakRatio: 0.4,
  /**
   * Round 10 (retraced liveness): ...and NOT further below peak than this.
   * Beyond it the coin is in collapse territory, which is rug probation's job —
   * "Retraced 0.03x" was the lie this clause closes.
   */
  retraceMaxFromPeakRatio: 0.85,
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
  /**
   * Round 15: a corpse is checked every `deadRecentSeconds` for the first
   * `deadRecentHours` after death, then daily.
   *
   * The OMNI case is why: a token declared dead minutes after the call (and
   * trading happily meanwhile) had to wait a full day for its first revival
   * check, so the board carried a corpse that was not one. Deaths that are
   * hours old are the ones most likely to be wrong or reversible; a month-old
   * grave is not, and it keeps the daily cadence.
   */
  deadRecentSeconds: 10_800,
  deadRecentHours: 48,
  /** Confirmed dead and past that window: daily revival check. */
  deadSeconds: 86_400,
} as const;

/**
 * Alert watchlist cap (docs/decisions.md round 15): each member may hold this
 * many ACTIVE watches per group, counted by watches.added_by. Unwatching frees
 * a slot; a watch someone else added is theirs, not yours.
 */
export const WATCH_CAP_PER_MEMBER = 3;

/**
 * The one over-cap sentence, shared by the bot reply and the API error body so
 * the two surfaces cannot drift.
 */
export function watchCapMessage(cap: number = WATCH_CAP_PER_MEMBER): string {
  return `You already have ${cap} coins on watch — unwatch one first.`;
}

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
  /**
   * ...and the same floor as a FRACTION of market cap (docs/decisions.md round
   * 14, the FORESKIN case): an unlocked-LP coin that gets pulled mid-cycle keeps
   * a crumb of liquidity against a mcap the market has not repriced yet — $5.4K
   * against $1.85M is 0.29%, and the absolute $10K bar alone lets it through.
   * Both floors apply; a coin has to clear each one.
   */
  liqToMcapMinRatio: 0.02,
  /** Younger than this is a launch, not a sleeper — it has no 24h to judge. */
  minPoolAgeHours: 1,
  /**
   * Age ceiling for the SHORT-duration views (under 2w), enforced by the API
   * at serve time: on a quick horizon, older than this is not "quietly trading
   * hard", it is just old. The scan itself admits pools up to inBandMaxDays —
   * a coin with weeks in band is necessarily older than 10 days, and the 2w/1m
   * chips (round 14) exist to surface exactly those.
   */
  maxPoolAgeDays: 10,
  /** Fewer trades than this in 24h is one whale moving size, not activity. */
  minTxns24: 20,
  /**
   * Kept per band by the scan. Deliberately more than the API serves: the
   * "X only" toggle, the per-group call exclusion and (round 14) the duration
   * filter all cut entries at read time, and a band kept shallow would run dry
   * the moment a member asked for anything but the default 3h.
   */
  keepPerBand: 12,
  /** Served per band by the API, after the per-group and twitter filters. */
  servePerBand: 3,
  /**
   * Time-in-band measurement (round 14). Hourly candles are asked for first —
   * 100 of them reach ~4 days back — and only a window that is in-band all the
   * way through is worth extending with daily candles.
   */
  inBandHourlyLimit: 100,
  inBandDailyLimit: 35,
  /**
   * The newest hourly candle must be at most this old or the streak is not
   * reported at all: residency is a claim about right now, and stale candles
   * cannot support it.
   */
  inBandMaxCandleAgeHours: 2,
  /**
   * Reported residency is capped here. Beyond a month the exact number stops
   * meaning anything, and it is the depth the daily window can actually back.
   */
  inBandMaxDays: 35,
  /**
   * An entry still in the SAME band as the previous scan, still trading,
   * extends its residency by the elapsed time instead of re-reading candles —
   * but a carried figure is re-measured off OHLCV once it is this old.
   *
   * The bound the carry accepts: a coin that left its band and came back
   * BETWEEN two scans is credited for the gap it was away, until the next full
   * measurement corrects it. At a 3h scan cadence that is at most 8 carried
   * steps, and the error only ever shows up as too MUCH residency on a coin
   * that is, by definition, back in the band.
   */
  residencyReverifyHours: 24,
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
