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
  /** tokens.lastSnapshotAt — when the market numbers were last real. */
  dataAsOf: string | null;
  /** on the group's alert watchlist */
  watched: boolean;
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
 */
export const RANGE_DURATION_HOURS = [3, 6, 12, 24, 48] as const;
export type RangeDurationHours = (typeof RANGE_DURATION_HOURS)[number];

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
  links: TradingLinkRow;
}

export interface SleeperBand {
  loUsd: number;
  hiUsd: number;
  /** Up to SLEEPERS.servePerBand, ranked by turnover desc. May be empty. */
  entries: SleeperEntry[];
}

/**
 * GET /api/g/:slug/sleepers?all=0|1
 * `all=1` drops the twitter-required default. Bands are always all four of
 * RANGE_PRESETS, in ascending order, so an empty band can say so.
 */
export interface SleepersResponse {
  /** ISO instant of the scan behind this payload; null before the first one. */
  refreshedAt: string | null;
  bands: SleeperBand[];
}
