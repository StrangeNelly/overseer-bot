import type { CallStatus, TokenPhase } from './constants.js';

/** Board time windows (activity-based: a repost pulls a call back into view). */
export const BOARD_WINDOWS = ['6h', '12h', '24h', '3d', '7d', '30d'] as const;
export type BoardWindow = (typeof BOARD_WINDOWS)[number];
export const BOARD_WINDOW_HOURS: Record<BoardWindow, number> = {
  '6h': 6,
  '12h': 12,
  '24h': 24,
  '3d': 72,
  '7d': 168,
  '30d': 720,
};

export interface TradingLinkRow {
  axiom: string;
  gmgn: string;
  dexscreener: string;
}

export interface SparkPoint {
  /** Unix ms. */
  t: number;
  mcap: number;
}

export interface BoardCard {
  callId: number;
  tokenId: number;
  address: string;
  symbol: string | null;
  name: string | null;
  imageUrl: string | null;
  /**
   * The token's X profile, from tokens.socials (docs/decisions.md round 9:
   * every coin card gets a link to its X account where known). null when we
   * have never seen one.
   */
  twitterUrl: string | null;
  /**
   * The token's website, from the same `tokens.socials` blob (round 15: every
   * coin with a stored website gets a link app-wide). null when we have none.
   */
  websiteUrl: string | null;
  phase: TokenPhase;
  callStatus: CallStatus;
  mcapUsd: number | null;
  liquidityUsd: number | null;
  vol24Usd: number | null;
  mcapAtCall: number | null;
  /** mcapUsd / mcapAtCall, null when either side is missing. */
  multiple: number | null;
  peakMcapSinceCall: number | null;
  /** peakMcapSinceCall / mcapAtCall. */
  peakMultiple: number | null;
  /** 0-100, how far current mcap sits below the peak; null without both values. */
  retraceFromPeakPct: number | null;
  /** ISO timestamps. */
  calledAt: string;
  callerName: string;
  mentionsCount: number;
  lastMentionAt: string;
  revived: boolean;
  /**
   * When/why THIS call died — its own death (e.g. a liquidity collapse while
   * the token still trades) if it has one, otherwise the token's last death.
   * Both are null for a call that has never died on a token that is alive.
   */
  diedAt: string | null;
  deathReason: string | null;
  /**
   * Market cap at the moment of THAT death, captured when the death was
   * stamped (round 15). Taken from the same row as diedAt/deathReason, so all
   * three describe one death. null for deaths recorded before the column
   * existed — the card must say "last seen" rather than claim a death price it
   * does not have.
   */
  mcapAtDeath: number | null;
  /**
   * Round 21: a member's verdict. When deathReason is 'member', the display
   * name of who marked it (as the bot would print it); null for every
   * rule-driven death. A member-marked death is never auto-revived — only
   * a member can restore it (DELETE /calls/:id/dead, `/overseer undead`).
   */
  deathMarkedBy: string | null;
  /**
   * DexScreener 24h trade count at the last poll; null when unknown. With
   * vol24Usd this is what a 'flatline' death prints ("flatlined · vol $120 /
   * 24h · 3 trades") — the number, never a verdict.
   */
  txns24: number | null;
  /** tokens.lastSnapshotAt — when the market numbers were last real. */
  dataAsOf: string | null;
  /** on the group's alert watchlist */
  watched: boolean;
  /**
   * ...and the ACTIVE watch was added by the requesting member (round 15
   * review). The cap is per member, so "unwatch one first" is only actionable
   * when the board says which WATCHING pills are the reader's own — the bot's
   * watchlist marks "(yours)" for exactly the same reason.
   */
  watchedByMe: boolean;
  /**
   * Set while the token wears the Reviving badge: it survived rug probation
   * by holding >= the revival mcap (decisions round 6). ISO; null otherwise.
   */
  revivingAt: string | null;
  links: TradingLinkRow;
  /** Last 24h of mcap snapshots, downsampled to <= 30 points, oldest first. */
  sparkline: SparkPoint[];
}

export interface BoardResponse {
  group: { slug: string; title: string | null };
  window: BoardWindow;
  generatedAt: string;
  /**
   * Round 15 (API honesty): every call this group made since the member's own
   * local midnight — counted in SQL, NOT off the payload. The board window
   * truncates what is shown; Pulse's "N calls today" was reading that truncated
   * list and under-reporting a busy day on a 6h window.
   *
   * The client's UTC offset arrives as `?tz=<minutes east of UTC>`; without it
   * the server counts a UTC day.
   */
  todayCallCount: number;
  /**
   * Round 15 (API honesty): this group's non-binned calls whose token is on rug
   * probation RIGHT NOW — hidden from every section, died included
   * (docs/decisions.md round 6), and therefore invisible to members until this
   * number said so.
   *
   * Deliberately NOT windowed: probation lasts at most 24h and the point of the
   * number is that nothing is silently missing, so under-reporting it on a 6h
   * window would defeat it.
   */
  hiddenProbationCount: number;
  sections: {
    /** Every non-binned active call with activity in the window, newest activity first. */
    fresh: BoardCard[];
    /** Active, multiple >= 3x, not retraced; sorted by multiple desc. */
    runners: BoardCard[];
    /**
     * Active, peakMultiple >= 3x, 40-85% off peak, and liquidity above the dust
     * line; sorted by retrace desc. The upper bound and the liquidity clause are
     * round 10's "pulled back but NOT dying": past 85% down is a collapse, which
     * rug probation owns, never a "dip".
     */
    retraced: BoardCard[];
    /**
     * callStatus 'died', activity in window; sorted by diedAt desc. Every death
     * is stamped per call, so nulls-last only catches pre-M3 rows.
     */
    died: BoardCard[];
    /**
     * Came back from rug probation within the last 24h (revivingAt set);
     * sorted by revivingAt desc. These cards ALSO classify into the other
     * sections normally — the section is a spotlight, not an exile.
     */
    reviving: BoardCard[];
  };
  /**
   * The group's ENTIRE active alert watchlist (round 16) — every coin any
   * member is watching, whether or not it has a call on this board: watches
   * set from the chat by address (`/overseer watch <ca>`) and from Sleepers
   * rows have no call at all. This is what the ON WATCH zone renders, and the
   * only place a member can see and free every slot they hold. Ordered by
   * addedAt desc; the client re-ranks (design pass 2: biggest 1h move first).
   */
  watchlist: WatchlistEntry[];
}

/**
 * One active watch (round 16). Carries enough market data to render a row on
 * its own. `callId` is the group's non-binned call for the coin, if any — but
 * that call is NOT guaranteed to be a BoardCard in `sections`: the sections are
 * windowed and probation-filtered, the watchlist is neither (it is the slot
 * inventory). The client joins to the card when one is present and otherwise
 * explains the gap honestly from `callStatus` / `rugHiddenAt` / `phase`:
 * "called, outside this window", "on rug probation", "died", or — only when
 * `callId` is null — "no call" (a chat or Sleepers watch).
 */
export interface WatchlistEntry {
  tokenId: number;
  address: string;
  symbol: string | null;
  imageUrl: string | null;
  phase: TokenPhase;
  /** tokens.rugHiddenAt — set while the coin is hidden on rug probation. ISO or null. */
  rugHiddenAt: string | null;
  /** Status of the joined call ('active' | 'died'); null when there is no call. */
  callStatus: CallStatus | null;
  mcapUsd: number | null;
  liquidityUsd: number | null;
  /** tokens.lastSnapshotAt — the honesty marker for the numbers above. */
  dataAsOf: string | null;
  /** Last 24h of mcap snapshots, downsampled like BoardCard.sparkline. */
  sparkline: SparkPoint[];
  /**
   * Market cap when the watch was activated (round 19) — the BUY OPP baseline:
   * the alert measures its drawdown from here, never from a peak. Null until
   * the first reading after the watch, or for watches older than the column.
   */
  mcapAtWatch: number | null;
  /** The member holding the slot — a Telegram user id, matched against MeResponse.userId. */
  addedBy: number;
  /** Display name for the slot holder when we have one (group_members), else null. */
  addedByName: string | null;
  addedAt: string;
  watchedByMe: boolean;
  /** The group's non-binned call for this coin, if any — null for chat/Sleepers watches. */
  callId: number | null;
  twitterUrl: string | null;
  websiteUrl: string | null;
  links: TradingLinkRow;
}

/**
 * Body of POST /api/g/:slug/watch — watch by ADDRESS (round 16), the same
 * thing `/overseer watch <ca>` does: upserts the token if we have never seen
 * it, then adds the group's watch under the caller's slot. This is the path
 * for coins with no call on the board (Sleepers rows). 204 / 409 cap (body =
 * watchCapMessage) / 400 on a malformed address.
 */
export interface WatchByAddressRequest {
  address: string;
}

/* ------------------------------------------------ upcoming projects (round 23) */

/**
 * A pre-launch X account the group is tracking (launch_monitors). 'launched'
 * once the account itself posted a contract that resolved on Robinhood Chain;
 * 'renamed' / 'suspended' when the stored x_user_id no longer answers to the
 * handle — said out loud rather than silently watching a stranger.
 */
export type ProjectStatus = 'active' | 'launched' | 'expired' | 'removed' | 'renamed' | 'suspended';

/**
 * A candidate under a tracked account, never pinged:
 * - 'posted': the account itself posted this address but it has NOT confirmed
 *   on chain yet (not indexed, or a read failed) — re-checked on a back-off
 *   until it confirms (then it becomes `launched`) or ages out;
 * - 'claims': an on-chain launch whose PONS socials name the handle while the
 *   account never posted it.
 */
export interface ProjectCandidate {
  kind: 'posted' | 'claims';
  address: string;
  symbol: string | null;
  mcapUsd: number | null;
  /** ISO instant: the post ('posted') or the on-chain launch ('claims'). */
  at: string;
  /** The post that carried the address ('posted' only). */
  tweetUrl: string | null;
  /** Why the last confirmation attempt did not confirm ('posted' only), null when never tried. */
  lastReason: string | null;
  links: TradingLinkRow;
}

export interface ProjectEntry {
  id: number;
  /** Lowercase, no leading @. */
  handle: string;
  xUserId: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  followers: number | null;
  /** Follower count when the monitor was added — the delta is the curve. */
  followersAtAdd: number | null;
  accountCreatedAt: string | null;
  /** The account's most recent post we have seen, null before the first check. */
  lastPostAt: string | null;
  /** Our last successful check of this account, null before the first. */
  lastCheckedAt: string | null;
  /** Free text the adder attached (`/overseer track @handle <note>`). */
  note: string | null;
  addedBy: number;
  addedByName: string | null;
  addedAt: string;
  addedByMe: boolean;
  status: ProjectStatus;
  /** Set once the account posted a resolving contract (Tier A). */
  launched: {
    address: string;
    symbol: string | null;
    tokenId: number | null;
    /** ISO instant of the POST that carried the address. */
    at: string;
    /**
     * The token's earliest known creation instant (our own launch listener's
     * row when it saw the launch, else the first pool's clock); null when
     * unknown. The board dates the launch from THIS, never from the ping.
     */
    tokenCreatedAt: string | null;
    tweetUrl: string | null;
    /** Whether the chat ping actually went out. */
    pinged: boolean;
    /** Why it did not: the token predated the post by > 10 min ('hijack') or the group muted launch pings ('muted'). */
    heldReason: 'hijack' | 'muted' | null;
    links: TradingLinkRow;
  } | null;
  /** Tier B: on-chain launches claiming this handle, newest first, never pinged. */
  candidates: ProjectCandidate[];
}

/**
 * GET /api/g/:slug/upcoming
 * `enabled` false = no X provider key in this deployment (the zone says so).
 * `lastCheckAt` = the watcher's last successful poll across all monitors.
 * POST /api/g/:slug/upcoming { handle: string; note?: string } -> 201 ProjectEntry,
 *   409 when capped (caps echoed here) or already tracked, 404 when the handle
 *   does not resolve on X. DELETE /api/g/:slug/upcoming/:id -> 204 (any member).
 * Bot parity: `/overseer track @handle [note]`, `untrack @handle`, `tracking`.
 */
export interface ProjectsResponse {
  enabled: boolean;
  /** Last successful check across the group's still-polled monitors; null when there is nothing left to check. */
  lastCheckAt: string | null;
  capPerGroup: number;
  capPerMember: number;
  /** Slots actually held (active / renamed / suspended) — launched and expired monitors hold none. */
  slotsUsed: number;
  /** ...of which the requesting member holds. */
  slotsUsedByMe: number;
  projects: ProjectEntry[];
}

export interface TrackProjectRequest {
  handle: string;
  note?: string;
}

/** groups.settings.xwatch, merged over XWATCH_DEFAULTS. `/overseer set launchping on|off`. */
export interface XWatchSettings {
  /** Whether a Tier-A launch posts the chat ping (the board row exists either way). */
  launchPing: boolean;
}

/* ------------------------------------------------ member verdict (round 21) */

/**
 * POST   /api/g/:slug/calls/:callId/dead  — mark a LIVE call dead by hand
 *                                           (any member, group-wide): 204, or
 *                                           409 when the call is not live.
 * DELETE /api/g/:slug/calls/:callId/dead  — restore a member-marked death
 *                                           (only deathReason 'member'): 204,
 *                                           or 409 for a rule-driven death.
 * No request body. Bot parity: `/overseer dead <symbol|CA>` and
 * `/overseer undead <symbol|CA>`. Death reasons introduced by round 21:
 * 'member' (a verdict; deathMarkedBy names who) and 'flatline' (the rule:
 * far off its peak with no trades for hours — vol24Usd/txns24 print it).
 */

/* ------------------------------------------------ discovery (rounds 18 + 20) */

/**
 * One coin the chain surfaced on its own — a direct Uniswap launch (round 18)
 * or a PONS graduation (round 20). Neither is a group call: this is the
 * uncurated research stream, and every figure on it is a fact from the pool or
 * the launch block, never a verdict. Filters (X + website present, not heavily
 * bundled, not a tokenized stock) are applied server-side by default and are
 * echoed back on the response.
 */
export type DiscoveryKind = 'launch' | 'graduation';

export interface DiscoveryEntry {
  kind: DiscoveryKind;
  address: string;
  symbol: string | null;
  name: string | null;
  imageUrl: string | null;
  /** The pool the event created (launch) or migrated into (graduation). */
  poolAddress: string;
  /** GeckoTerminal/DexScreener dex id, e.g. 'uniswap-v4-robinhood', 'pons-v2-dex'. */
  dex: string;
  /** ISO instant of the on-chain event. */
  at: string;
  /**
   * The QUOTE-SIDE deposit that opened the pool (the deployer's liquidity add,
   * buys excluded), in USD and in ETH terms. `initialLiquidityEth` is the
   * ETH-equivalent every threshold compares against; `quoteSymbol` names the
   * asset actually deposited so the row prints "$12K USDG", never "3.1 ETH",
   * for a USDG-quoted pool. Null when the deposit could not be measured.
   */
  initialLiquidityUsd: number | null;
  initialLiquidityEth: number | null;
  quoteSymbol: 'ETH' | 'USDG' | null;
  /**
   * Latest enrichment (DexScreener), null until the first read; `dataAsOf`
   * is the instant of that read so a client can print how old the figures are.
   */
  mcapUsd: number | null;
  liquidityUsd: number | null;
  dataAsOf: string | null;
  /** Locked share of LP, 0–100, null when unknown. Uniswap LP is unlocked unless the team locks it. */
  lpLockedPct: number | null;
  twitterUrl: string | null;
  websiteUrl: string | null;
  /**
   * Bundle facts from the launch block(s): share of total supply bought in the
   * launch block, 0–100, and the distinct wallets that took it. Null when the
   * logs could not be read — unknown is shown as unknown, never as 0.
   */
  launchBlockPct: number | null;
  launchBlockWallets: number | null;
  isStock: boolean;
  /** Whether the chat alert for this entry was sent (capped per hour). */
  alerted: boolean;
  watched: boolean;
  watchedByMe: boolean;
  links: TradingLinkRow;
}

/**
 * The three serve-time filters, each its own query flag
 * (`xweb=0|1`, `bundles=0|1`, `stocks=0|1`, all default on) so a chip in the
 * UI always equals what the payload applied.
 */
export interface DiscoveryFilters {
  /** Only entries with both an X account and a website. */
  xWeb: boolean;
  /** Hide entries whose launch-block share is at/above bundleMaxPct; unknown is never hidden. */
  noBundles: boolean;
  /** Hide tokenized stocks. */
  noStocks: boolean;
}

/**
 * GET /api/g/:slug/discovery?kind=launch|graduation|all&hours=24&xweb=1&bundles=1&stocks=1
 *
 * `enabled` is false when the on-chain listener is not configured OR not
 * running in this process (WEB_ONLY dev box): the zones then say so instead of
 * pretending the chain was quiet. `lastTickAt` is the listener's last
 * successful block read (null before the first), so a client can print a
 * stalled feed rather than an empty one.
 */
export interface DiscoveryResponse {
  enabled: boolean;
  lastTickAt: string | null;
  hours: number;
  /** The filters THIS payload applied. */
  filters: DiscoveryFilters;
  /** The launch-block share at/above which an entry is hidden by the bundle filter, 0–100. */
  bundleMaxPct: number;
  launches: DiscoveryEntry[];
  graduations: DiscoveryEntry[];
}

/**
 * Per-group discovery alert settings (groups.settings.discovery), merged over
 * DISCOVERY_DEFAULTS in constants. `/overseer set launch <eth>` (0 = mute),
 * `/overseer set grads on|off`.
 */
export interface DiscoverySettings {
  /** Minimum initial liquidity in ETH for a launch to be posted to the chat; 0 mutes launch alerts. */
  launchMinEth: number;
  /** Whether filtered graduations are posted to the chat. */
  gradsOn: boolean;
  /** Chat alerts per hour across both kinds; overflow stays board-only. */
  alertsPerHour: number;
}

export interface MeResponse {
  userId: number;
}

/**
 * GET /api/auth/telegram/available — whether this deployment has Telegram's
 * OIDC browser login configured (TG_OAUTH_CLIENT_ID/SECRET, docs/decisions.md
 * round 12). False turns the login wall back into plain "open it from Telegram"
 * text; it is a feature flag, never an authorization answer.
 */
export interface TelegramLoginAvailability {
  available: boolean;
}

/**
 * POST /api/g/:slug/handoff — a one-time, short-TTL link that opens the same
 * board in the system browser already signed in (docs/decisions.md round 7).
 * The url carries a secret: open it, never render or log it.
 */
export interface HandoffResponse {
  url: string;
}

/**
 * Ranging board: accumulation-phase detection over the group's own calls.
 * 3h added in the round 8 design pass — the shortest band a coil is readable in.
 * 30m and 1h added later at the owner's ask, for small caps only (see
 * RANGE_SHORT_DURATION_MAX_HI_USD).
 */
export const RANGE_DURATION_HOURS = [0.5, 1, 3, 6, 12, 24, 48] as const;
export type RangeDurationHours = (typeof RANGE_DURATION_HOURS)[number];

/**
 * Durations shorter than this are the "short" ones: they only make sense where
 * a coil is readable in minutes, which is the small end of the board.
 */
export const RANGE_SHORT_DURATION_HOURS = 3;

/**
 * ...and only for a band that tops out here. The owner asked for "the first 3
 * default bands"; expressing it as a ceiling on the band's HIGH means a custom
 * band behaves like the preset it resembles instead of falling through the rule.
 */
export const RANGE_SHORT_DURATION_MAX_HI_USD = 500_000;

/**
 * Whether a duration may be asked for against a band. The server enforces this
 * (400) and the chips mirror it — one rule, two readers.
 */
export function rangeHoursAllowed(hours: number, hiUsd: number): boolean {
  return hours >= RANGE_SHORT_DURATION_HOURS || hiUsd <= RANGE_SHORT_DURATION_MAX_HI_USD;
}

/**
 * A duration's own label. Sub-hour durations read in MINUTES: "0.5h" is not a
 * thing anyone says, and a chip is too small a place to make someone divide.
 */
export function fmtDurationHours(hours: number): string {
  if (!Number.isFinite(hours) || hours < 0) return '—';
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  return `${hours}h`;
}

export const RANGE_PRESETS = [
  { label: '50K–100K', loUsd: 50_000, hiUsd: 100_000 },
  { label: '100K–250K', loUsd: 100_000, hiUsd: 250_000 },
  { label: '250K–500K', loUsd: 250_000, hiUsd: 500_000 },
  { label: '500K–1M', loUsd: 500_000, hiUsd: 1_000_000 },
] as const;

export interface RangeInfo {
  /** ISO instant the continuous in-band streak started. */
  inRangeSince: string;
  inRangeHours: number;
  /** Observed mcap extremes while ranging. */
  observedLowUsd: number;
  observedHighUsd: number;
  /** 5-minute buckets backing the verdict (data-coverage indicator). */
  bucketCount: number;
}

export interface RangeCard extends BoardCard {
  range: RangeInfo;
}

/** GET /api/g/:slug/range?lo=<usd>&hi=<usd>&hours=<RangeDurationHours> */
export interface RangeBoardResponse {
  group: { slug: string; title: string | null };
  loUsd: number;
  hiUsd: number;
  minHours: number;
  generatedAt: string;
  /** Sorted by inRangeHours desc. */
  cards: RangeCard[];
}

/**
 * Sleepers: the chain-wide discovery stream (docs/decisions.md round 9).
 *
 * These are NOT the group's calls. Every three hours the server scans all of
 * Robinhood Chain by 24h volume and keeps the coins that are quietly trading
 * hard for their size. Nothing here is tracked, polled, or alerted on — a coin
 * only becomes tracked when a member posts it in chat.
 *
 * There is no history behind an entry (no sparkline) and no call baseline (no
 * multiple): turnover is the number this surface exists to show.
 */

/**
 * The duration filter (docs/decisions.md rounds 14 and 17): how long the coin
 * has sat inside its band, continuously, up to the scan. 3h is the default;
 * 30m and 1h (round 17) are read off 15-minute candles for entries whose
 * hourly residency is under 3h, so they name new entrants rather than
 * pretending hourly candles can see half an hour.
 */
export const SLEEPER_DURATIONS_HOURS = [0.5, 1, 3, 6, 24, 72, 168, 336, 720] as const;
export type SleeperDurationHours = (typeof SLEEPER_DURATIONS_HOURS)[number];

/** Chip text. Written out rather than derived: "720h" is not how anyone reads a month. */
export const SLEEPER_DURATION_LABELS: Record<SleeperDurationHours, string> = {
  0.5: '30m',
  1: '1h',
  3: '3h',
  6: '6h',
  24: '24h',
  72: '3d',
  168: '7d',
  336: '2w',
  720: '1m',
};

/**
 * Views shorter than this keep round 9's 10-day pool-age ceiling (the scan
 * itself admits pools up to SLEEPERS.inBandMaxDays so the long views can be
 * served at all). It no longer gates any band: round 17 made $1M–$3M a regular
 * band at every duration.
 */
export const SLEEPER_LONG_ONLY_MIN_HOURS = 336;

export interface SleeperBandSpec {
  readonly label: string;
  readonly loUsd: number;
  readonly hiUsd: number;
  /**
   * Served only from SLEEPER_LONG_ONLY_MIN_HOURS up. No shipped band sets it
   * since round 17; the gate stays so a future band can be long-only without
   * touching the serve path.
   */
  readonly longOnly: boolean;
}

/**
 * The bands the SCAN buckets into (round 17): the four Ranging presets plus
 * $1M–$3M, $3M–$5M and $5M–$8M. RANGE_PRESETS itself is untouched — Ranging
 * still has four — so the two surfaces can diverge without either one reaching
 * into the other. The upper bands are what the stocks filter makes usable:
 * without it they are nothing but tokenized equities.
 */
export const SLEEPER_BANDS: readonly SleeperBandSpec[] = [
  ...RANGE_PRESETS.map((preset) => ({
    label: preset.label,
    loUsd: preset.loUsd,
    hiUsd: preset.hiUsd,
    longOnly: false,
  })),
  { label: '1M–3M', loUsd: 1_000_000, hiUsd: 3_000_000, longOnly: false },
  { label: '3M–5M', loUsd: 3_000_000, hiUsd: 5_000_000, longOnly: false },
  { label: '5M–8M', loUsd: 5_000_000, hiUsd: 8_000_000, longOnly: false },
];

/** The bands a given duration is allowed to see, in ascending order. */
export function sleeperBandsFor(minHours: number): readonly SleeperBandSpec[] {
  return SLEEPER_BANDS.filter(
    (band) => !band.longOnly || minHours >= SLEEPER_LONG_ONLY_MIN_HOURS,
  );
}

export interface SleeperEntry {
  address: string;
  symbol: string | null;
  name: string | null;
  imageUrl: string | null;
  /** The default view only serves entries that have one. */
  twitterUrl: string | null;
  websiteUrl: string | null;
  mcapUsd: number;
  vol24Usd: number;
  liquidityUsd: number;
  txns24: number;
  /** vol24Usd / mcapUsd — the ranking number, and the row's hero figure. */
  turnover: number;
  /** ISO; when the pool was created (the coin's age on this surface). */
  poolCreatedAt: string | null;
  /**
   * How long this address has been listed by consecutive scans, from
   * sleeper_seen.firstListedAt. The persistence marker: still qualifying is
   * still interesting (round 9 — this replaces forced rotation).
   */
  onListSinceHours: number;
  /**
   * Continuous residency inside this band, in hours, measured at scan time off
   * GeckoTerminal's hourly/daily candles — so it INCLUDES history from before
   * the coin first appeared here (round 14). Capped at SLEEPERS.inBandMaxDays.
   * 0 means "not established": either the streak broke on the newest candle or
   * the candles could not be read this scan.
   */
  inBandHours: number;
  links: TradingLinkRow;
  /**
   * Round 16: the group's watch state for this coin, so a Sleepers row can
   * carry the same WATCH / WATCHING·YOU pill as every other coin in the app.
   * A sleeper is never one of the group's calls, but it can still be watched
   * (by address) — exactly what `/overseer watch <ca>` has always allowed.
   */
  watched: boolean;
  watchedByMe: boolean;
  /**
   * Round 17: a tokenized stock, ETF or leveraged equity product
   * (isTokenizedStock). Stored at scan time; the default view excludes these
   * and the `stocks=1` query includes them.
   */
  isStock: boolean;
}

export interface SleeperBand {
  loUsd: number;
  hiUsd: number;
  /**
   * Up to SLEEPERS.servePerBand per KIND — coins first, then tokenized stocks
   * when `stocks=1` asked for them — each run in turnover order. Including
   * stocks is purely additive: it can never push a coin out. May be empty.
   */
  entries: SleeperEntry[];
}

/**
 * GET /api/g/:slug/sleepers?all=0|1&stocks=0|1&minHours=<SLEEPER_DURATIONS_HOURS member>
 *
 * `all=1` drops the twitter-required default; `stocks=1` drops the
 * no-tokenized-stocks default (round 17). Bands are every band that duration
 * is allowed to see (sleeperBandsFor), in ascending order and always present,
 * so an empty band can say so rather than silently vanishing.
 */
export interface SleepersResponse {
  /** ISO instant of the scan behind this payload; null before the first one. */
  refreshedAt: string | null;
  /** The duration filter this payload answers — echoed back like Ranging's. */
  minHours: SleeperDurationHours;
  /** Whether tokenized stocks were excluded from this payload (the default). */
  excludeStocks: boolean;
  /**
   * Whether only entries with an X account were served (the default). Echoed
   * so every line that describes the payload's counts reads its filters from
   * the payload itself, never from a toggle that may already be ahead of it.
   */
  xOnly: boolean;
  bands: SleeperBand[];
}
