/**
 * The watch toggle, generalised (docs/decisions.md round 16).
 *
 * The owner's rule is that watch/unwatch exists on EVERY coin the app shows —
 * board rows, spotlight cards, died rows, Ranging cards, Sleepers rows,
 * half-sheet rows and the ON WATCH zone. Those surfaces do not share a type: a
 * Sleepers lead is not one of the group's calls and has no tokenId to address,
 * a chat watch has no call on the board at all. So the toggle is keyed by the
 * one thing every coin has — its contract address — and carries the tokenId
 * only as a routing hint for the card endpoint.
 *
 * Keying pending state by ADDRESS also settles the round-15 clobber finding for
 * good: two in-flight toggles on the same coin from two surfaces are the same
 * request, and two toggles on different coins can never share a key.
 */

import type { BoardCard, SleeperEntry, WatchlistEntry } from '@groupie/shared';
import type { WatchControl } from './components/LinkPills';

export interface WatchTarget {
  address: string;
  /** Present when the coin is one of the group's calls — routes to the card endpoint. */
  tokenId: number | null;
  symbol: string | null;
  watched: boolean;
  watchedByMe: boolean;
}

export interface WatchProps {
  onWatch: (target: WatchTarget, next: boolean) => void;
  /** Lowercased addresses whose toggle is in flight. */
  pending: ReadonlySet<string>;
}

export function watchKey(address: string): string {
  return address.toLowerCase();
}

export function targetFromCard(card: BoardCard): WatchTarget {
  return {
    address: card.address,
    tokenId: card.tokenId,
    symbol: card.symbol,
    watched: card.watched,
    watchedByMe: card.watchedByMe,
  };
}

export function targetFromWatchEntry(entry: WatchlistEntry): WatchTarget {
  return {
    address: entry.address,
    tokenId: entry.tokenId,
    symbol: entry.symbol,
    // It is on the watchlist by construction.
    watched: true,
    watchedByMe: entry.watchedByMe,
  };
}

/**
 * A Sleepers lead. No tokenId exists for it — the coin may never have been seen
 * by this group — so it routes to the by-address endpoint, which upserts the
 * token exactly as `/overseer watch <ca>` does.
 */
export function targetFromSleeper(entry: SleeperEntry): WatchTarget {
  return {
    address: entry.address,
    tokenId: null,
    symbol: entry.symbol,
    watched: entry.watched,
    watchedByMe: entry.watchedByMe,
  };
}

/** The per-coin slice of the board-wide toggle, or undefined where there is none. */
export function watchFor(
  target: WatchTarget,
  props: WatchProps | undefined,
): WatchControl | undefined {
  if (!props) return undefined;
  return {
    watched: target.watched,
    watchedByMe: target.watchedByMe,
    pending: props.pending.has(watchKey(target.address)),
    onToggle: (next: boolean) => props.onWatch(target, next),
  };
}

/** ...straight from a card, which is what most surfaces hold. */
export function watchForCard(
  card: BoardCard,
  props: WatchProps | undefined,
): WatchControl | undefined {
  return watchFor(targetFromCard(card), props);
}
