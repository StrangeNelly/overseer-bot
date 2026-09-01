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

/** Only these schemes ever reach an href we render (docs/decisions.md round 9). */
function httpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'https:' || url.protocol === 'http:' ? trimmed : null;
  } catch {
    return null;
  }
}

const TWITTER_HOSTS = new Set(['twitter.com', 'x.com', 'www.twitter.com', 'www.x.com']);

/**
 * The token's X (Twitter) profile, out of whatever we stored in
 * `tokens.socials`. That column is untyped jsonb filled from DexScreener's
 * `info.socials` array (keyed by its own `type` strings) and could hold an old
 * shape, a null, or an array — so this reads it as unknown and proves the URL
 * rather than trusting a key name.
 *
 * A `twitter`/`x` key wins; otherwise any value pointing at twitter.com/x.com
 * does. Returns null when nothing qualifies.
 */
export function twitterUrlFrom(socials: unknown): string | null {
  if (!socials || typeof socials !== 'object' || Array.isArray(socials)) return null;
  const record = socials as Record<string, unknown>;
  for (const key of ['twitter', 'x'] as const) {
    const direct = httpUrl(record[key]);
    if (direct !== null) return direct;
  }
  for (const value of Object.values(record)) {
    const url = httpUrl(value);
    if (url === null) continue;
    try {
      if (TWITTER_HOSTS.has(new URL(url).hostname.toLowerCase())) return url;
    } catch {
      // httpUrl already parsed it; this can only fail if URL is unavailable.
    }
  }
  return null;
}

/** The token's website, same defensive reading as twitterUrlFrom. */
export function websiteUrlFrom(socials: unknown): string | null {
  if (!socials || typeof socials !== 'object' || Array.isArray(socials)) return null;
  const record = socials as Record<string, unknown>;
  return httpUrl(record.website) ?? httpUrl(record.websites);
}
