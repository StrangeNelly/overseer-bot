import { useCallback, useState } from 'react';
import type { BoardCard } from '@groupie/shared';
import { copyText } from '../clipboard';

/**
 * The link row, in one place (docs/decisions.md round 15).
 *
 * It used to live inline in TokenCard, so the desktop spotlight cards — the
 * top runner, the retraced story, the reviving comeback — shipped with three
 * bare text links and no COPY CA, no X, no watch. Those are the cards a member
 * actually acts on, and they were the ones you could not act from.
 *
 * WEBSITE is round 15's other half: `websiteUrlFrom` has always existed, so a
 * coin whose socials carry a site now offers it everywhere links render.
 *
 * WATCH is a real state toggle, not a link: it turns the group's nuke/buy-opp
 * Telegram alerts on for this coin, exactly like `/overseer watch`. Cyan when
 * on — the analysis accent, never green/red (those are P&L) and never magenta
 * (that is the brand).
 */

export interface WatchControl {
  /** Omit to render no watch pill at all (surfaces with no session action). */
  onWatch: (card: BoardCard, next: boolean) => void;
  /** This card's toggle is in flight. */
  pending: boolean;
}

interface LinkPillsProps {
  card: BoardCard;
  watch?: WatchControl;
}

/**
 * Renders bare pills, no wrapper: the surface owns the container (the tap-reveal
 * `.row-pills`, the desktop `.row-hoverlinks`, a spotlight card's `.card-links`)
 * and sizes them from it.
 */
export function LinkPills({ card, watch }: LinkPillsProps) {
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(() => {
    void copyText(card.address).then((ok) => {
      if (!ok) return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_400);
    });
  }, [card.address]);

  const label = card.symbol ? `$${card.symbol}` : 'this coin';

  return (
    <>
      <a className="pill" href={card.links.axiom} target="_blank" rel="noopener">
        AXIOM
      </a>
      <a className="pill" href={card.links.gmgn} target="_blank" rel="noopener">
        GMGN
      </a>
      <a className="pill" href={card.links.dexscreener} target="_blank" rel="noopener">
        DEXS
      </a>
      <button type="button" className="pill pill-copy" onClick={onCopy}>
        {copied ? 'COPIED ✓' : 'COPY CA'}
      </button>
      {/* The project's X account, where we have one (docs/decisions.md round 9). */}
      {card.twitterUrl ? (
        <a className="pill" href={card.twitterUrl} target="_blank" rel="noopener">
          X
        </a>
      ) : null}
      {/* ...and its website, where we have one (round 15). */}
      {card.websiteUrl ? (
        <a className="pill" href={card.websiteUrl} target="_blank" rel="noopener">
          WEBSITE
        </a>
      ) : null}
      {watch ? (
        <button
          type="button"
          className={`pill pill-watch${card.watched ? ' is-on' : ''}`}
          aria-pressed={card.watched}
          aria-label={
            card.watched ? `Stop watching ${label}` : `Watch ${label} for alerts in the chat`
          }
          title={
            // The cap is per member (3 slots), so the pill has to say WHOSE
            // slot this is — "unwatch one first" is only actionable when your
            // own watches are tellable from everyone else's.
            card.watchedByMe
              ? 'Your watch — one of your 3 slots. Tap to stop.'
              : card.watched
                ? 'Alerts on for the whole group (another member’s slot) — tap to stop'
                : 'Nuke / buy-opp alerts in the chat for this coin'
          }
          disabled={watch.pending}
          onClick={() => watch.onWatch(card, !card.watched)}
        >
          {watch.pending ? '…' : card.watchedByMe ? 'WATCHING·YOU' : card.watched ? 'WATCHING' : 'WATCH'}
        </button>
      ) : null}
    </>
  );
}
