import { extractEvmAddresses } from './extract.js';

/**
 * Addresses a tracked X account POSTED (docs/decisions.md round 23).
 *
 * Two sources, deliberately different in what they accept:
 *
 *  - the post's OWN TEXT, where any plausible EVM address counts. An address
 *    the account typed is an address the account typed, whatever punctuation or
 *    link text surrounds it — and it still has to confirm on Robinhood Chain
 *    before anything is said in the chat, so a Base explorer link in the text
 *    costs one confirmation and dies there.
 *  - the post's ATTACHED URLs (X's entity list, which is where a t.co link
 *    expands to its real target), where ONLY a known launchpad or chart URL
 *    counts. Those are links the account attached rather than words it wrote,
 *    and "some URL somewhere in this post contains 40 hex characters" is not a
 *    contract announcement.
 *
 * Never reads a quoted or retweeted post's text: the caller passes the tracked
 * account's own fields, and that separation is what makes a quote-tweet of
 * someone else's CA a non-event (round 23, Tier A).
 */

/**
 * Hosts whose URLs name a token by its contract address. The first three are
 * this chain's launchpads (docs/research-x-monitor.md §4); the last three are
 * exactly the three link targets the app itself builds (packages/shared/src/
 * links.ts, verified against live pages 2026-09-01), so a member clicking
 * through from the board and an account posting the same link are read alike.
 *
 * Matched on hostname only — a path is not part of the trust decision, because
 * every one of these sites names the token in a path segment or a query value
 * and their route shapes change more often than their domains do.
 */
export const LAUNCH_URL_HOSTS: readonly string[] = [
  'ponsfamily.com',
  'app.long.xyz',
  'long.xyz',
  'launch.o1.exchange',
  'dexscreener.com',
  'axiom.trade',
  'gmgn.ai',
];

/**
 * Chain-URI prefixes stripped before the address is read: `ethereum:0x…` and
 * EIP-681/CAIP-10 style `eip155:4663:0x…`. Replaced with a space rather than
 * deleted, so a prefix can never glue two tokens of text together.
 */
const CHAIN_URI_PREFIX_RE = /\b(?:ethereum|eip155:\d+):(?=0x)/gi;

/** Is this one of the launchpad/chart hosts above? `www.` is ignored. */
export function isLaunchUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  return LAUNCH_URL_HOSTS.includes(host);
}

/**
 * Every address this post announced, lowercased, in order of first appearance
 * and de-duplicated. `urls` is the post's own entity URLs (already expanded);
 * pass an empty array when the provider gives none.
 */
export function extractLaunchAddresses(
  text: string | null | undefined,
  urls: readonly string[] = [],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (addresses: string[]): void => {
    for (const address of addresses) {
      if (seen.has(address)) continue;
      seen.add(address);
      out.push(address);
    }
  };
  push(extractEvmAddresses((text ?? '').replace(CHAIN_URI_PREFIX_RE, ' ')));
  for (const url of urls) {
    if (typeof url !== 'string' || !isLaunchUrl(url)) continue;
    push(extractEvmAddresses(url.replace(CHAIN_URI_PREFIX_RE, ' ')));
  }
  return out;
}
