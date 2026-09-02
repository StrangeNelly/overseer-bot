import { afterEach, describe, expect, it, vi } from 'vitest';
import { findChainsFor } from '../src/market/dexscreener.js';

/**
 * `findChainsFor` is the SOLE evidence behind a permanent wrong-chain death
 * (docs/decisions.md round 17b), and every other test in the suite mocks it —
 * so its parsing is pinned here, against real DexScreener-shaped bodies.
 *
 * The failure that matters is a false POSITIVE: a chain named for a pair that
 * is not about the requested address at all would kill a live coin with every
 * other test green.
 */

const address = '0xDEAD00000000000000000000000000000000BEEF';

function pair(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chainId: 'base',
    pairAddress: '0xpair',
    baseToken: { address: address.toLowerCase(), symbol: 'DUD' },
    quoteToken: { address: '0xweth' },
    ...over,
  };
}

/** One fetch answer: `ok` with this JSON body, or a status the client must throw on. */
function stubFetch(body: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('findChainsFor (round 17b)', () => {
  it('names the chain of a pair the address is the BASE token of', async () => {
    stubFetch({ pairs: [pair()] });
    expect(await findChainsFor(address)).toEqual(new Set(['base']));
  });

  it('...and of one it is the QUOTE token of', async () => {
    // Rare, but it is still a pair the token trades in: the question being
    // asked is only "does this address trade anywhere else".
    stubFetch({
      pairs: [
        pair({
          chainId: 'arbitrum',
          baseToken: { address: '0xweth' },
          quoteToken: { address: address.toLowerCase() },
        }),
      ],
    });
    expect(await findChainsFor(address)).toEqual(new Set(['arbitrum']));
  });

  it('ignores a pair that is about some other token', async () => {
    // The false positive that would kill a live coin: DexScreener answering
    // with a neighbouring pair rather than one of ours.
    stubFetch({
      pairs: [
        pair({
          chainId: 'solana',
          baseToken: { address: '0xsomethingelse' },
          quoteToken: { address: '0xweth' },
        }),
      ],
    });
    expect(await findChainsFor(address)).toEqual(new Set());
  });

  it('matches the address case-insensitively and trims the chain id', async () => {
    // Chains disagree about address casing, and the chainId is free text.
    stubFetch({ pairs: [pair({ chainId: ' Base ', baseToken: { address } })] });
    expect(await findChainsFor(address)).toEqual(new Set(['base']));
  });

  it('reads `pairs: null` as an empty set — knowing nothing is not a verdict', async () => {
    stubFetch({ pairs: null });
    expect(await findChainsFor(address)).toEqual(new Set());
    stubFetch({});
    expect(await findChainsFor(address)).toEqual(new Set());
    stubFetch(null);
    expect(await findChainsFor(address)).toEqual(new Set());
  });

  it('drops a pair with no chain id at all rather than naming ""', async () => {
    stubFetch({ pairs: [pair({ chainId: '   ' }), pair({ chainId: undefined })] });
    expect(await findChainsFor(address)).toEqual(new Set());
  });

  it('collects every chain the address really trades on', async () => {
    stubFetch({
      pairs: [pair(), pair({ chainId: 'BASE' }), pair({ chainId: 'ethereum' })],
    });
    expect(await findChainsFor(address)).toEqual(new Set(['base', 'ethereum']));
  });

  it('THROWS on a non-ok status — the caller must not read it as an answer', async () => {
    stubFetch({ pairs: [pair()] }, 502);
    await expect(findChainsFor(address)).rejects.toThrow('dexscreener 502');
  });
});
