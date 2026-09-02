/**
 * Tokenized equities on Robinhood Chain (docs/decisions.md round 17).
 *
 * Robinhood issues its stock and ETF tokens under one naming convention —
 * "Invesco QQQ • Robinhood Token", "Palantir Technologies • Robinhood Token" —
 * so the issuer suffix is the rule, not a heuristic on tickers. Two shapes
 * escape it and are listed explicitly: HOOD's own token (named just "HOOD")
 * and leveraged equity derivatives ("NVDA 3x Long"). Every entry here was read
 * off the live scan on 2026-09-02.
 */

const ISSUER_SUFFIX = /•\s*Robinhood Token\s*$/i;
const LEVERAGED = /\b\d+(?:\.\d+)?x\s+(?:long|short)\b/i;

/** Lowercase addresses of stock-like tokens the name rule cannot catch. */
export const STOCK_TOKEN_ADDRESSES: ReadonlySet<string> = new Set([
  // HOOD — Robinhood's own equity token, named without the issuer suffix.
  '0x32ac8c1d7672667d5ebdea22935f7b06fc8d496f',
]);

/**
 * Whether a token is a tokenized stock, ETF or leveraged equity product —
 * something that holds a market-cap band because it is a security, not a
 * coin. Unknown name and unknown address both answer false: absence of the
 * suffix is not evidence either way, and the filter must never hide a real
 * coin on a guess.
 */
export function isTokenizedStock(name: string | null | undefined, address: string): boolean {
  if (STOCK_TOKEN_ADDRESSES.has(address.toLowerCase())) return true;
  if (!name) return false;
  return ISSUER_SUFFIX.test(name) || LEVERAGED.test(name);
}
