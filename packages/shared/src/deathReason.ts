/**
 * How a WRONG-CHAIN death is written into the free-text `death_reason` column
 * (docs/decisions.md round 17b).
 *
 * v1 tracks Robinhood Chain only, so a contract address pasted from another
 * EVM chain can never resolve here — it used to sit in FRESH as "indexing…"
 * until the 48h never-graduated rule swept it up. When both Robinhood-Chain
 * lookups miss and DexScreener's any-chain endpoint finds the token trading
 * somewhere else, the death is stamped as `wrong_chain:<chainId>`.
 *
 * The encoding lives in shared because three surfaces have to agree on it: the
 * poller writes it, the scheduler reads it to keep the corpse off every market
 * (there is no market on THIS chain to re-read), and the board turns it into a
 * label. A bare string comparison in three places would drift.
 */
export const WRONG_CHAIN_PREFIX = 'wrong_chain:';

/** `wrong_chain:base` — the shape `wrongChainReason` produces. */
export type WrongChainReason = `${typeof WRONG_CHAIN_PREFIX}${string}`;

/** Chain id (DexScreener's `chainId`, e.g. "base") -> the stored reason. */
export function wrongChainReason(chainId: string): WrongChainReason {
  return `${WRONG_CHAIN_PREFIX}${chainId.trim().toLowerCase()}`;
}

/**
 * The chain a wrong-chain death names, or null for every other reason.
 *
 * A reason carrying the prefix but no chain id answers null: there is no chain
 * to name, so nothing may be printed as one. `isWrongChainDeath` is the test
 * for the DEATH (it only reads the prefix) — a corpse must never become
 * pollable again just because its chain id was lost.
 */
export function wrongChainOf(reason: string | null | undefined): string | null {
  if (!isWrongChainDeath(reason)) return null;
  const chain = reason.slice(WRONG_CHAIN_PREFIX.length).trim();
  return chain.length > 0 ? chain : null;
}

/** Was this death "the address trades on another chain"? */
export function isWrongChainDeath(reason: string | null | undefined): reason is string {
  return typeof reason === 'string' && reason.startsWith(WRONG_CHAIN_PREFIX);
}

/**
 * A MEMBER's verdict (docs/decisions.md round 21) — the only death in the
 * system a rule did not reach. Written on the CALL, never on the token: the
 * coin still trades, the group has simply decided it is done with it.
 *
 * Its one hard consequence lives in the revival paths: a member-marked death is
 * exempt from every automatic comeback, because the bar those comebacks use
 * ($30K of market cap) is a bar a dumped coin with residual holders clears
 * standing still. Only a member can undo it — RESTORE on the board, or
 * `/overseer undead`.
 */
export const MEMBER_DEATH_REASON = 'member';

/**
 * The board's fallback name for a member verdict whose marker we cannot name
 * (they have never posted here and Telegram gave us nothing). `deathMarkedBy`
 * is null ONLY for rule deaths — attributing this one to nobody would read as
 * one — so an unnamed member is still named as a member.
 */
export const UNNAMED_MEMBER = 'a member';

/** Was this call killed by a member rather than by a rule? */
export function isMemberDeath(reason: string | null | undefined): boolean {
  return reason === MEMBER_DEATH_REASON;
}

/**
 * The token DUMPED but never drained (docs/decisions.md round 21): far below
 * its peak, with no volume and no trades, for six unbroken hours. Written by
 * the poller on the token, exactly like the other rule deaths — and read again
 * by the revival path, which asks a flatline corpse for volume as well as mcap.
 */
export const FLATLINE_DEATH_REASON = 'flatline';

/** Was this death the round-21 quiet-tape rule? */
export function isFlatlineDeath(reason: string | null | undefined): boolean {
  return reason === FLATLINE_DEATH_REASON;
}
