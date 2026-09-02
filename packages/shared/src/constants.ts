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

/**
 * Round 21's two new death rules, kept together because they answer the same
 * question the THRESHOLDS above could not: a coin can be DUMPED without its
 * pool ever draining.
 *
 * The live case is $VLR — 0.4x, $106K -> $46K on $19K of liquidity — alive by
 * every rule in THRESHOLDS (liquidity intact, mcap far above the rug floor)
 * and yet finished: the residual holders are too small to bother selling, so
 * the market cap simply sits there with nothing trading against it. $DOSS has
 * the same shape.
 *
 * So: members may call it (the manual verdict, `death_reason = 'member'`), and
 * the poller can see it on its own when the tape goes quiet for six hours
 * (`death_reason = 'flatline'`). Both live here rather than in THRESHOLDS
 * because both are about ACTIVITY, not about price levels.
 */
export const DEATH = {
  /**
   * The flatline condition must hold CONTINUOUSLY for this long before the
   * token dies. The clock is `tokens.flat_since`; any reading that fails the
   * condition — or that cannot measure it — resets it to null.
   */
  flatlineHours: 6,
  /** ...retrace from peak-since-call, in percent, at or above which it holds. */
  flatlineRetracePct: 85,
  /** ...and 24h volume STRICTLY below this. */
  flatlineVolumeUsd: 500,
  /** ...and at most this many trades in 24h. Both readings are required. */
  flatlineTxns24: 5,
  /**
   * A flatline corpse needs VOLUME back, not only market cap: the usual
   * `revivalMcapUsd` bar alone would resurrect it on the very next poll, since
   * a flatlined coin keeps the mcap that killed it. Unknown volume is not
   * evidence of a comeback either — it revives nothing.
   */
  flatlineRevivalVolumeUsd: 2_000,
  /**
   * COVERAGE, not just elapsed time (round 21 amendment a): an OUTAGE is not
   * six quiet hours. `tokens.flat_readings` counts the polls that actually held
   * the condition, and the death needs at least this many of them. Sized to the
   * SLOWEST live tier: an idle coin (POLL_TIERS.idleSeconds, hourly) yields six
   * readings in six hours, and the old quiet coin is exactly what this rule is
   * for — a higher floor would make flatline unreachable for that tier.
   */
  flatlineMinReadings: 6,
  /**
   * ...and no HOLE in the run: a reading whose predecessor is older than this
   * does not extend the previous run, it starts a new one. Without it, six
   * readings taken in ten minutes plus a six-hour outage would read as six
   * unbroken hours of silence. Just over two idle-tier polls, so one missed
   * hourly poll does not restart the clock while a real outage still does.
   */
  flatlineMaxGapMinutes: 125,
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
  /**
   * Round 17b, the unresolved back-off. An address nothing has indexed is the
   * one tier that can retry forever without ever learning anything: the live
   * case sat in FRESH for 8h at 45 seconds a try because it was a Base
   * contract. New PONS launches index within minutes, so the fast tier only has
   * to cover those minutes:
   *
   *   - `freshSeconds` for the first `unresolvedFastMinutes`,
   *   - `activeSeconds` until `unresolvedSlowHours`,
   *   - `idleSeconds` from there to the existing 48h never_graduated death.
   *
   * The middle tier runs to SIX hours rather than one (round 17b review): a CA
   * pasted before its pool exists — a pre-launch call, which the group does
   * make — takes its first reading, and therefore its mcap-at-call, whenever
   * the tier next fires. Five minutes stale is a baseline worth having; an hour
   * stale is the moat quietly mismeasured.
   *
   * Measured from first_seen_at, not from the last poll — the question being
   * asked is "how long has nobody indexed this", and the answer must not reset
   * because a poll was late.
   */
  unresolvedFastMinutes: 15,
  unresolvedSlowHours: 6,
  /**
   * A wrong-chain verdict is permanent, so it waits longer than the fast tier
   * does: an address pasted before its Robinhood pool exists that also has a
   * twin on another chain (CREATE2 / omnichain deploys) must be given an hour
   * for the pool to open and index before "not here" can mean anything.
   */
  wrongChainMinMinutes: 60,
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
  /**
   * Round 19: fired when the market cap crosses this far BELOW the mcap the
   * coin had when the watch was set (watches.mcap_at_watch) — not below a peak.
   */
  buyRetracePct: 30,
  /**
   * RETIRED by round 19 (the buy-opp rule ignores both). Kept as keys so stored
   * group settings and old `/overseer set buyopp <pct> <hours>` invocations
   * still merge and clamp instead of failing; remove them only with a migration
   * that rewrites groups.settings.alerts.
   */
  buyPeakWindowHours: 24,
  buyMinDeclineHours: 1,
  /** Per (token, type). */
  cooldownMin: 60,
} as const;

export const ALERT_TYPES = ['nuke', 'buy_opp'] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

export type AlertSettings = { -readonly [K in keyof typeof ALERT_DEFAULTS]: number };

/**
 * Discovery alerts (docs/decisions.md rounds 18 and 20) share the `alerts` table
 * and the delivery path with the watchlist alerts above, but they are a
 * different FAMILY: they are about a coin nobody in the group has called (there
 * is no token row, no call, and therefore no message to reply to), and they are
 * capped per hour across both kinds rather than cooled down per coin.
 */
export const DISCOVERY_ALERT_TYPES = ['launch', 'graduation'] as const;
export type DiscoveryAlertType = (typeof DISCOVERY_ALERT_TYPES)[number];

/** Every value `alerts.type` may hold. */
export type AnyAlertType = AlertType | DiscoveryAlertType;

/**
 * Per-group discovery settings (`groups.settings.discovery`), merged over these
 * (docs/decisions.md rounds 18 and 20). `bundleMaxPct` is deliberately NOT a
 * group setting — it is a filter the board and the chat share, and the round-20
 * note that thresholds are "tunable later via /overseer set" is exactly that:
 * later. It lives here so the board can echo the number it filtered on.
 */
export const DISCOVERY_DEFAULTS = {
  /**
   * Minimum initial liquidity, in ETH, for a launch to earn a CHAT message.
   * The owner's line was "even a 5 ETH paired launch is something to look at",
   * so 5 is the floor rather than an aspiration. 0 mutes launch alerts.
   */
  launchMinEth: 5,
  /** Whether filtered graduations are posted to the chat (round 20: wanted). */
  gradsOn: true,
  /** Chat messages per hour across BOTH kinds; the overflow stays board-only. */
  alertsPerHour: 3,
  /**
   * The launch-block share (0-100) at or above which an entry is hidden by the
   * bundle filter. Round 20 starts it at 25%. An UNKNOWN share is not hidden:
   * unknown is not evidence, and the row says "unknown" instead.
   */
  bundleMaxPct: 25,
} as const;

/** Bounds for the two tunable discovery settings, enforced on write and on read. */
export const DISCOVERY_LIMITS = {
  /** 0 is legal and means muted, so the floor is a floor on a REAL threshold. */
  launchMinEth: { min: 0.1, max: 1_000 },
  alertsPerHour: { min: 0, max: 20 },
} as const;

/**
 * The discovery engine's own constants — the shape of the stream, not a group's
 * taste in it. Kept beside the defaults so the board, the scanner and the tests
 * read one source.
 */
export const DISCOVERY = {
  /**
   * Everything at or above this initial reserve is KEPT ON THE BOARD, whatever
   * the group's chat threshold is. Round 18's zone is "launches from the last
   * 24h" — a research surface — and a 0.6 ETH launch is still a launch. The
   * chat threshold sits on top of this, never under it.
   */
  boardMinEth: 0.5,
  /** A pool older than this when we first see it is a backfill, not a launch. */
  maxDetectionAgeMinutes: 10,
  /** Default window of the discovery zones, in hours, and its ceiling. */
  defaultHours: 24,
  maxHours: 168,
  /** Rows older than this are pruned; the zones never look back further. */
  retentionDays: 7,
  /** How often the chain listener asks for new logs. */
  pollIntervalMs: 20_000,
  /**
   * The most chain a restart will ever replay. A process that has been down
   * longer simply resumes at (head - this): the discovery zones show the last
   * 24h and nothing is owed for an outage older than the poll cadence, while an
   * unbounded backfill would spend a day of Alchemy budget catching up to a
   * stream nobody can act on any more.
   */
  backfillMaxHours: 2,
  /** ~100ms blocks. Only used to size the backfill bound in blocks. */
  blocksPerSecond: 10,
  /** One eth_getLogs never spans more than this many blocks (provider ceiling). */
  maxBlocksPerRequest: 2_000,
  /** ...and one tick never asks for more than this many of those ranges. */
  maxRangesPerTick: 4,
  /**
   * The most CHUNKS one logical `eth_getLogs` may be split into when the
   * provider caps its block range (chain/client.ts learns that cap from the
   * refusal). Alchemy's free tier serves 10 blocks per query, so a steady-state
   * 20s range (~200 blocks of a ~100ms chain) is 20 chunks and fits, while a
   * 2,000-block catch-up range would be 200 and does not: that range is refused
   * whole and re-read next tick rather than quietly turned into a burst of 200
   * billed requests. On PAYG the cap is thousands of blocks and nothing splits
   * at all.
   */
  maxLogChunksPerQuery: 40,
  /**
   * Milliseconds between CONSECUTIVE chunks of one chunked `eth_getLogs` (none
   * before the first). A tier that caps the block range also caps throughput —
   * Alchemy's free tier answered the 20-chunk steady-state tick with
   * "exceeded its compute units per second capacity" every 20 seconds — so the
   * chunks a range is split into are spread out rather than fired as a burst.
   */
  logChunkGapMs: 250,
  /**
   * How long the chain loop stops asking after the provider answers 429, and
   * the ceiling that back-off doubles up to. A throughput refusal is not a
   * failure the next tick can fix: retrying at the poll cadence spends the
   * budget on more 429s and keeps the provider's per-second meter pinned.
   */
  throttleBackoffMs: 60_000,
  throttleBackoffMaxMs: 600_000,
  /**
   * The launch block plus this many after it: the window the bundle facts are
   * read over (round 20: "the launch block and the first few blocks").
   */
  bundleBlockSpan: 2,
  /**
   * A candidate is enriched (DexScreener socials/mcap/liquidity, GeckoTerminal
   * lock %) once it is this old — new enough to still be a launch, old enough
   * that the indexers have seen the pool.
   */
  enrichAfterSeconds: 90,
  /** ...and never more than this many rows per pass, so a backlog paces itself. */
  enrichPerPass: 30,
  /** An unenriched row this old is given up on; it keeps whatever it has. */
  enrichGiveUpHours: 6,
  /**
   * The head is not read to its tip: a block that has not settled can be
   * re-orged away, and a launch decoded out of an orphaned block would be a row
   * pointing at a pool that never existed. Three blocks of a ~100ms chain is
   * sub-second of latency for a stream measured in minutes.
   */
  headLagBlocks: 3,
  /**
   * How often the enrichment loop runs. Separate from `pollIntervalMs`: the
   * chain tick must never wait behind a DexScreener batch or a GeckoTerminal
   * back-off (that coupling was the review's finding), so the two loops have
   * their own timers and their own `running` flags.
   */
  enrichIntervalMs: 30_000,
  /**
   * GeckoTerminal lock reads per enrichment pass. The lock percentage is the
   * ONE field DexScreener has not got, and GT is the budget the whole app
   * competes for (docs/decisions.md round 16b), so the pass takes a few and
   * leaves the rest for the next one.
   */
  lockReadsPerPass: 3,
  /**
   * ...and stops asking after this long. A null `lock_checked_at` is what makes
   * the next pass retry, so without a give-up bound a permanently unlockable
   * pool would be asked about forever.
   */
  lockGiveUpHours: 6,
  /**
   * Rows younger than a day are re-read on this cadence, so a launch that
   * added its socials (or lost its liquidity) an hour after the pool opened is
   * not frozen at its first reading. `data_as_of` on the row is what the board
   * prints so the age of the numbers is never implied.
   */
  reenrichMinutes: 10,
  /** ...and only rows this young are re-read at all. */
  reenrichWithinHours: 24,
  /**
   * An event older than this never earns a CHAT message. The board keeps the
   * whole window; the chat only ever hears about something that just happened,
   * which is also what stops a backfill after a restart from replaying an hour
   * of launches into the group.
   */
  maxAlertAgeMinutes: 15,
  /**
   * Half-width, in blocks, of the window the graduation hunt reads for a coin's
   * `TokenLaunched` once DexScreener has dated its PONS curve pool. 200 blocks
   * is 20 seconds of a ~100ms chain either side of the located block — enough
   * slack for a second-resolution timestamp and a bisection bracket, while the
   * whole query stays at 400 blocks: one request on PAYG, and exactly the
   * 40 x 10-block chunk budget on a capped tier.
   */
  launchHuntWindowBlocks: 200,
  /**
   * The most `eth_getBlockByNumber` reads one launch hunt may spend locating
   * that block. A linear estimate plus a bisection converges in well under this;
   * anything that does not is a chain whose block times do not behave, and the
   * hunt gives up (unknown) rather than paying for an open-ended search.
   */
  launchHuntMaxBlockReads: 12,
} as const;

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
  /**
   * Served per band by the API, after the per-group and twitter filters — and
   * per KIND since round 17, so up to this many coins AND, when the reader asks
   * for stocks, this many stocks. A single cut over the union would let a band
   * of equities push its coins off the page, which would make the stocks toggle
   * subtract rather than add.
   */
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
  /**
   * Short holds (docs/decisions.md round 17). Hourly candles cannot see half an
   * hour, so a NEW entry whose hourly residency lands under `shortHoldMaxHours`
   * gets one 15-minute read, and BELOW that threshold the minute reading is the
   * authoritative one: it replaces the hourly figure rather than competing with
   * it, because an hourly close cannot tell a coin still in its band from one
   * that left forty-five minutes ago. `shortCandleLimit` candles is
   * `shortHoldMaxHours` of history, and the figure is capped one candle below
   * that threshold — the hourly walk already declined to establish it, and the
   * newest bucket is still in progress.
   *
   * `shortMaxCandleAgeMinutes` is the freshness rule, applied to the newest
   * candle's START — the same discipline as inBandMaxCandleAgeHours, at the
   * shorter timescale. A residency of 30 minutes is a claim about right now.
   */
  shortHoldMaxHours: 3,
  shortCandleMinutes: 15,
  shortCandleLimit: 12,
  shortMaxCandleAgeMinutes: 30,
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
