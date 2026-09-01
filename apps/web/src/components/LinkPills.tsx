import { useCallback, useEffect, useRef, useState } from 'react';
import type { TradingLinkRow } from '@groupie/shared';
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
 *
 * Round 16 widened both halves. The component takes a plain LinkTarget rather
 * than a BoardCard, because the owner's rule is that EVERY coin the app shows
 * carries watch/unwatch — including the ones that are not the group's calls
 * (Sleepers rows) and the ones with no call on this board (chat watches).
 */

/** The scale-pop's own length (design pass 2: "WATCH toggle 150ms scale-pop"). */
const POP_MS = 150;

/** Anything with an address and a link row: a card, a watch, a sleeper. */
export interface LinkTarget {
  address: string;
  symbol: string | null;
  twitterUrl: string | null;
  websiteUrl: string | null;
  links: TradingLinkRow;
}

/**
 * The watch pill's whole state, resolved by the surface. Self-contained on
 * purpose: a Sleepers row has no BoardCard to hand this component, and the
 * server owns the cap, so the pill only ever reports what the last payload said.
 */
export interface WatchControl {
  watched: boolean;
  /** ...and the active watch is one of the reader's own three slots. */
  watchedByMe: boolean;
  /** This coin's toggle is in flight. */
  pending: boolean;
  onToggle: (next: boolean) => void;
}

interface LinkPillsProps {
  target: LinkTarget;
  watch?: WatchControl;
  /**
   * Short labels (CA, WEB) for the narrow desktop rail, where the strip has to
   * share a 48px row with the symbol and the numbers — the 3A artboard's own
   * wording for that surface.
   */
  compact?: boolean;
}

/**
 * Renders bare pills, no wrapper: the surface owns the container (the tap-reveal
 * `.row-pills`, the desktop `.row-hoverlinks`, a spotlight card's `.card-links`)
 * and sizes them from it.
 */
export function LinkPills({ target, watch, compact = false }: LinkPillsProps) {
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(() => {
    void copyText(target.address).then((ok) => {
      if (!ok) return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_400);
    });
  }, [target.address]);

  return (
    <>
      <a className="pill" href={target.links.axiom} target="_blank" rel="noopener">
        AXIOM
      </a>
      <a className="pill" href={target.links.gmgn} target="_blank" rel="noopener">
        GMGN
      </a>
      <a className="pill" href={target.links.dexscreener} target="_blank" rel="noopener">
        DEXS
      </a>
      <button type="button" className="pill pill-copy" onClick={onCopy}>
        {copied ? (compact ? '✓' : 'COPIED ✓') : compact ? 'CA' : 'COPY CA'}
      </button>
      {/* The project's X account, where we have one (docs/decisions.md round 9). */}
      {target.twitterUrl ? (
        <a className="pill" href={target.twitterUrl} target="_blank" rel="noopener">
          X
        </a>
      ) : null}
      {/* ...and its website, where we have one (round 15). */}
      {target.websiteUrl ? (
        <a className="pill" href={target.websiteUrl} target="_blank" rel="noopener">
          {compact ? 'WEB' : 'WEBSITE'}
        </a>
      ) : null}
      {watch ? <WatchPill target={target} watch={watch} /> : null}
    </>
  );
}

/**
 * The WATCH toggle on its own — pinned right in a links strip, but also usable
 * where there is no strip (the died rail, a range card's reveal).
 */
export function WatchPill({
  target,
  watch,
  className,
}: {
  target: LinkTarget;
  watch: WatchControl;
  className?: string;
}) {
  const label = target.symbol ? `$${target.symbol}` : 'this coin';
  // The 150ms scale-pop answers a TOGGLE. Tied to the on-state it replayed on
  // every hover reveal and on every first paint — motion carrying no news.
  const [popping, setPopping] = useState(false);
  const wasWatched = useRef(watch.watched);
  useEffect(() => {
    if (wasWatched.current === watch.watched) return;
    wasWatched.current = watch.watched;
    if (!watch.watched) return;
    setPopping(true);
    const id = window.setTimeout(() => setPopping(false), POP_MS);
    return () => window.clearTimeout(id);
  }, [watch.watched]);

  return (
    <button
      type="button"
      className={`pill pill-watch${watch.watched ? ' is-on' : ''}${popping ? ' is-just-toggled' : ''}${className ? ` ${className}` : ''}`}
      aria-pressed={watch.watched}
      aria-label={watch.watched ? `Stop watching ${label}` : `Watch ${label} for alerts in the chat`}
      title={
        // The cap is per member (3 slots), so the pill has to say WHOSE slot
        // this is — "unwatch one first" is only actionable when your own
        // watches are tellable from everyone else's. The off state describes
        // what the alerts ARE: their internal names are verdicts the board
        // never prints.
        watch.watchedByMe
          ? 'Your watch — one of your 3 slots. Tap to stop.'
          : watch.watched
            ? 'Alerts on for the whole group (another member’s slot) — tap to stop'
            : 'Turn on the chat alerts for this coin (big moves, sharp drops)'
      }
      disabled={watch.pending}
      onClick={() => watch.onToggle(!watch.watched)}
    >
      {watch.pending ? (
        '…'
      ) : watch.watched ? (
        <>
          <span className="pill-dot" aria-hidden="true">
            ●
          </span>
          {watch.watchedByMe ? ' WATCHING · YOU' : ' WATCHING'}
        </>
      ) : (
        'WATCH'
      )}
    </button>
  );
}
