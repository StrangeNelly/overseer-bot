/**
 * ABI word decoding for the discovery listener. Every field it reads is a
 * STATIC 32-byte word — an address, a uint256, a bytes32 pool id — so this is
 * the whole decoder, and it is pure.
 *
 * The rule the whole file obeys: a word that cannot be read answers null. Never
 * 0, never a guess. A launch whose reserve could not be decoded shows "unknown"
 * on the board and can never clear a chat threshold, which is the only safe
 * failure for a number a member might act on.
 */

const HEX = /^0x[0-9a-fA-F]*$/;

/** The `data` blob's i-th 32-byte word as lowercase hex (no 0x), or null. */
export function dataWord(data: string | null | undefined, index: number): string | null {
  if (typeof data !== 'string' || !HEX.test(data)) return null;
  const body = data.slice(2);
  const start = index * 64;
  if (index < 0 || body.length < start + 64) return null;
  return body.slice(start, start + 64).toLowerCase();
}

/** A 32-byte word (or a topic) read as an address: the low 20 bytes, lowercase. */
export function wordToAddress(word: string | null | undefined): string | null {
  if (typeof word !== 'string') return null;
  const body = word.startsWith('0x') ? word.slice(2) : word;
  if (body.length !== 64 || !HEX.test(`0x${body}`)) return null;
  // The high 12 bytes of a properly encoded address word are zero. A word that
  // carries something up there is not an address, and reading its low half
  // anyway would invent one.
  if (!/^0{24}/.test(body)) return null;
  return `0x${body.slice(24).toLowerCase()}`;
}

/** A 32-byte word as an unsigned integer, or null when it is unreadable. */
export function wordToBigInt(word: string | null | undefined): bigint | null {
  if (typeof word !== 'string') return null;
  const body = word.startsWith('0x') ? word.slice(2) : word;
  if (body.length !== 64 || !HEX.test(`0x${body}`)) return null;
  try {
    return BigInt(`0x${body}`);
  } catch {
    return null;
  }
}

/**
 * A 32-byte word as a SIGNED integer (two's complement), or null when it is
 * unreadable. Uniswap v4 reports swap amounts as `int128` deltas — a negative
 * one is what the caller PAID — and reading those unsigned would turn a 3 ETH
 * buy into a number the size of the word.
 *
 * The word is the 256-bit ABI encoding of a smaller signed type, so the sign
 * bit to test is bit 255: solidity sign-extends on the way in.
 */
export function wordToSignedBigInt(word: string | null | undefined): bigint | null {
  const raw = wordToBigInt(word);
  if (raw === null) return null;
  const limit = 1n << 255n;
  return raw >= limit ? raw - (1n << 256n) : raw;
}

/** A topic read as an address (indexed address parameters are left-padded). */
export function topicAddress(topics: readonly string[], index: number): string | null {
  return wordToAddress(topics[index]);
}

/** A topic read verbatim — a bytes32 pool id keeps all 32 bytes. */
export function topicBytes32(topics: readonly string[], index: number): string | null {
  const raw = topics[index];
  if (typeof raw !== 'string' || raw.length !== 66 || !HEX.test(raw)) return null;
  return raw.toLowerCase();
}

/**
 * Base-units to a JS number, given the token's decimals. Returns null for a
 * negative or non-finite result — a reserve the arithmetic could not express is
 * unknown, and unknown is never zero.
 *
 * Precision: a token amount can exceed 2^53, so the division happens in BigInt
 * for the whole part and only the fractional remainder goes through Number.
 */
export function unitsToNumber(units: bigint | null, decimals: number): number | null {
  if (units === null || units < 0n) return null;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  const scale = 10n ** BigInt(decimals);
  const whole = units / scale;
  const fraction = units % scale;
  const value = Number(whole) + Number(fraction) / Number(scale);
  return Number.isFinite(value) ? value : null;
}
