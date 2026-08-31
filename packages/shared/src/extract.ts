import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';

/**
 * EVM address candidates: 0x + 40 hex, with lookarounds so the first 40 hex
 * chars of a 64-hex tx hash (or a Uniswap v4 pool id) never match.
 */
const EVM_ADDRESS_RE = /(?<![a-fA-F0-9])0x[a-fA-F0-9]{40}(?![a-fA-F0-9])/g;

export function toChecksumAddress(address: string): string {
  const body = address.slice(2).toLowerCase();
  const hash = bytesToHex(keccak_256(body));
  let out = '0x';
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    out += parseInt(hash[i]!, 16) >= 8 ? c.toUpperCase() : c;
  }
  return out;
}

/**
 * A mixed-case candidate must pass EIP-55; single-case candidates carry no
 * checksum and are accepted as-is. Filters truncated/corrupted pastes.
 */
export function isPlausibleEvmAddress(candidate: string): boolean {
  const body = candidate.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  return candidate === toChecksumAddress(candidate);
}

/**
 * Extract unique, plausibility-checked EVM addresses (lowercased) from any
 * number of text fragments (message text, caption, entity URLs). Order of
 * first appearance is preserved.
 */
export function extractEvmAddresses(...texts: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(EVM_ADDRESS_RE)) {
      const candidate = match[0];
      if (!isPlausibleEvmAddress(candidate)) continue;
      const lower = candidate.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        out.push(lower);
      }
    }
  }
  return out;
}
