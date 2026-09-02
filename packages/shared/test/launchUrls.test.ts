import { describe, expect, it } from 'vitest';
import { extractLaunchAddresses, isLaunchUrl, LAUNCH_URL_HOSTS } from '../src/launchUrls.js';
import { tradingLinks } from '../src/links.js';

/**
 * What counts as "the account posted a contract address" (docs/decisions.md
 * round 23): anything address-shaped in its own text, and an address in an
 * attached link ONLY when that link is a launchpad or chart URL.
 */

const CA = '0xb2790f5f4d4c1e1a2f0e2b7a9c4d6e8f0a1b260c';
const CHECKSUMMED = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const BROKEN_CHECKSUM = '0x5aaeb6053F3E94C9b9A09f33669435E7Ef1BeAed';

describe('extractLaunchAddresses — the text', () => {
  it('reads a bare contract address', () => {
    expect(extractLaunchAddresses(`live now ${CA} lfg`)).toEqual([CA]);
  });

  it('strips an ethereum: URI prefix', () => {
    expect(extractLaunchAddresses(`ethereum:${CA}`)).toEqual([CA]);
  });

  it('strips an eip155 chain prefix', () => {
    expect(extractLaunchAddresses(`eip155:4663:${CA}`)).toEqual([CA]);
  });

  it('accepts a valid EIP-55 address and lowercases it', () => {
    expect(extractLaunchAddresses(`CA: ${CHECKSUMMED}`)).toEqual([CHECKSUMMED.toLowerCase()]);
  });

  it('rejects a broken checksum — a corrupted paste is not an announcement', () => {
    expect(extractLaunchAddresses(`CA: ${BROKEN_CHECKSUM}`)).toEqual([]);
  });

  it('answers nothing for a post with no address', () => {
    expect(extractLaunchAddresses('something big is coming')).toEqual([]);
    expect(extractLaunchAddresses(null)).toEqual([]);
    expect(extractLaunchAddresses(undefined, [])).toEqual([]);
  });

  it('de-duplicates and keeps first-appearance order', () => {
    const other = '0x1111111111111111111111111111111111111111';
    expect(extractLaunchAddresses(`${CA} then ${other} then ${CA}`)).toEqual([CA, other]);
  });
});

describe('extractLaunchAddresses — attached links', () => {
  const shapes: Array<[string, string]> = [
    ['PONS launchpad', `https://ponsfamily.com/launchpad/${CA}`],
    ['long.xyz', `https://app.long.xyz/tokens/${CA}`],
    ['o1 exchange', `https://launch.o1.exchange/token/${CA}?chain=4663`],
    ['dexscreener', `https://dexscreener.com/robinhood/${CA}`],
    ['axiom', tradingLinks(CA).axiom],
    ['gmgn', tradingLinks(CA).gmgn],
  ];
  for (const [name, url] of shapes) {
    it(`reads the address out of a ${name} link`, () => {
      expect(extractLaunchAddresses('new token', [url])).toEqual([CA]);
    });
  }

  it('ignores an address inside an UNKNOWN host link', () => {
    expect(extractLaunchAddresses('see this', [`https://basescan.org/token/${CA}`])).toEqual([]);
  });

  it('ignores junk that is not a URL at all', () => {
    expect(extractLaunchAddresses('x', ['not a url', '', CA])).toEqual([]);
  });

  it('the three link targets the app itself builds are all trusted hosts', () => {
    const links = tradingLinks(CA);
    for (const url of [links.axiom, links.gmgn, links.dexscreener]) {
      expect(isLaunchUrl(url)).toBe(true);
    }
  });

  it('accepts www. and rejects a lookalike host', () => {
    expect(isLaunchUrl(`https://www.dexscreener.com/robinhood/${CA}`)).toBe(true);
    expect(isLaunchUrl(`https://dexscreener.com.evil.example/${CA}`)).toBe(false);
  });

  it('rejects non-http schemes', () => {
    expect(isLaunchUrl(`javascript:fetch('https://axiom.trade/t/${CA}')`)).toBe(false);
  });

  it('lists every host it trusts, so the set is reviewable', () => {
    expect(LAUNCH_URL_HOSTS).toContain('ponsfamily.com');
    expect(LAUNCH_URL_HOSTS).toContain('axiom.trade');
  });
});
