import { ROBINHOOD_SLUG } from './constants.js';

/**
 * Clean (non-referral) deep links for a token's link row.
 * Formats verified against live pages 2026-09-01 (docs/research-trading-links-competitors.md).
 */
export function tradingLinks(address: string, chainSlug: string = ROBINHOOD_SLUG) {
  return {
    axiom: `https://axiom.trade/t/${address}?chain=${chainSlug}`,
    gmgn: `https://gmgn.ai/${chainSlug}/token/${address}`,
    dexscreener: `https://dexscreener.com/${chainSlug}/${address}`,
  } as const;
}
