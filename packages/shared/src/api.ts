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
    /** Active, peakMultiple >= 3x AND current <= 60% of peak; sorted by retrace desc. */
    retraced: BoardCard[];
    /**
     * callStatus 'died', activity in window; sorted by diedAt desc. Every death
     * is stamped per call, so nulls-last only catches pre-M3 rows.
     */
    died: BoardCard[];
  };
}

export interface MeResponse {
  userId: number;
}
