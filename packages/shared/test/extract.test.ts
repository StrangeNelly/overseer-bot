import { describe, expect, it } from 'vitest';
import { extractEvmAddresses, isPlausibleEvmAddress, toChecksumAddress } from '../src/extract.js';

// EIP-55 spec test vectors
const CHECKSUMMED = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const LOWER = CHECKSUMMED.toLowerCase();

describe('toChecksumAddress', () => {
  it('reproduces the EIP-55 spec vectors', () => {
    expect(toChecksumAddress(LOWER)).toBe(CHECKSUMMED);
    expect(toChecksumAddress('0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359')).toBe(
      '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
    );
  });
});

describe('isPlausibleEvmAddress', () => {
  it('accepts all-lowercase and all-uppercase (no checksum info)', () => {
    expect(isPlausibleEvmAddress(LOWER)).toBe(true);
    expect(isPlausibleEvmAddress('0x' + LOWER.slice(2).toUpperCase())).toBe(true);
  });
  it('accepts valid mixed-case checksums and rejects invalid ones', () => {
    expect(isPlausibleEvmAddress(CHECKSUMMED)).toBe(true);
    // flip one letter's case -> checksum broken
    expect(isPlausibleEvmAddress('0x5aaeb6053F3E94C9b9A09f33669435E7Ef1BeAed')).toBe(false);
  });
});

describe('extractEvmAddresses', () => {
  it('finds a plain pasted CA', () => {
    expect(extractEvmAddresses(`ape this ${LOWER} now`)).toEqual([LOWER]);
  });

  it('finds CAs inside URLs (axiom, gmgn ref-prefixed, dexscreener)', () => {
    const ca = '0x39dbed3a2bd333467115de45665cc57f813c4571';
    expect(extractEvmAddresses(`https://axiom.trade/t/${ca}?chain=robinhood`)).toEqual([ca]);
    expect(extractEvmAddresses(`https://gmgn.ai/robinhood/token/C7KoyPop_${ca}`)).toEqual([ca]);
    expect(extractEvmAddresses(`https://dexscreener.com/robinhood/${ca}`)).toEqual([ca]);
  });

  it('does not match inside a 64-hex tx hash or v4 pool id', () => {
    const txHash = '0xa8f1d576000000000000000000000000000000000000000000000000000de09f';
    expect(extractEvmAddresses(`tx: ${txHash}`)).toEqual([]);
  });

  it('rejects mixed-case candidates with broken checksums', () => {
    expect(extractEvmAddresses('0x5aaeb6053F3E94C9b9A09f33669435E7Ef1BeAed')).toEqual([]);
  });

  it('dedupes across fragments and normalizes to lowercase', () => {
    const out = extractEvmAddresses(`${CHECKSUMMED} and again`, LOWER, undefined, null);
    expect(out).toEqual([LOWER]);
  });

  it('preserves order for multiple distinct CAs', () => {
    const a = '0x1f7d7550b1b028f7571e69a784071f0205fd2efa';
    const b = '0x8c529f0a77c07ce0e6796f153d292501ee6f66f6';
    expect(extractEvmAddresses(`${a} then ${b}`)).toEqual([a, b]);
  });
});
