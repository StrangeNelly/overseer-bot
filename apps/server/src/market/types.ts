/** Normalized market state for one token at one moment. */
export interface MarketSnapshot {
  priceUsd: number | null;
  /** FDV-preferred on launchpad tokens (supply is fixed 1B, FDV ≈ mcap). */
  mcapUsd: number | null;
  liquidityUsd: number | null;
  vol24Usd: number | null;
}

export interface ResolvedToken {
  symbol: string | null;
  name: string | null;
  imageUrl: string | null;
  socials: Record<string, string> | null;
  launchpad: string | null;
  phase: 'curve' | 'graduated';
  poolAddress: string | null;
  tokenCreatedAt: Date | null;
  snapshot: MarketSnapshot;
}

export function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
