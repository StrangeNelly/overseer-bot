/** Robinhood Chain (Arbitrum-stack L2). */
export const ROBINHOOD_CHAIN_ID = 4663;

/** Chain slug used by both DexScreener (chainId) and GeckoTerminal (network id). */
export const ROBINHOOD_SLUG = 'robinhood';

/** Call/token lifecycle states shared between db, server, and web. */
export const CALL_STATUSES = ['active', 'died', 'binned'] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

export const TOKEN_PHASES = ['unresolved', 'curve', 'graduated', 'dead'] as const;
export type TokenPhase = (typeof TOKEN_PHASES)[number];
