import { useCallback, useEffect, useRef, useState } from 'react';
import type { TradingLinkRow } from '@groupie/shared';
import { copyText } from '../clipboard';
import { CONFIRM_MS, confirmStep, pressedOutside } from '../confirm';
import type { ConfirmState } from '../confirm';
import type { DeadControl } from '../dead';

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
   * The member verdict (round 21). The 'mark' pill rides every link row.
   * RESTORE belongs beside BIN on the died row, where the reader is already
   * looking at a corpse — EXCEPT on the desktop hover strip (`compact`), which
   * paints over the row head the moment the mouse arrives: there the strip is
   * the only place a pill can be clicked, so RESTORE rides it too.
   */
  dead?: DeadControl;
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
export function LinkPills({ target, watch, dead, compact = false }: LinkPillsProps) {
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
      {dead && (dead.mode === 'mark' || compact) ? <DeadPill dead={dead} /> : null}
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

/**
 * MARK DEAD / RESTORE — the member verdict (docs/decisions.md round 21).
 *
 * Same family as WATCH: dim by default, never green or red. A death is not a
 * P&L colour and this pill is not an alarm; it is the group writing down what
 * it already believes.
 *
 * Two taps, because it sits in a hover strip a thumb passes over: the first
 * arms it into SURE?, the second commits. Four seconds, a tap elsewhere, or
 * focus leaving all put it back — the machine is `confirmStep`, so the rule can
 * be read (and tested) without a browser.
 */
export function DeadPill({ dead, className }: { dead: DeadControl; className?: string }) {
  const [state, setState] = useState<ConfirmState>('idle');
  const ref = useRef<HTMLButtonElement>(null);
  const restore = dead.mode === 'restore';

  useEffect(() => {
    if (state !== 'armed') return;
    const id = window.setTimeout(
      () => setState(confirmStep('armed', 'timeout').state),
      CONFIRM_MS,
    );
    // Capture, so a tap that lands on a control which stops propagation still
    // disarms this one. The press that armed it is already past.
    const onAway = (event: Event) => {
      if (!pressedOutside(ref.current, event.target)) return;
      setState(confirmStep('armed', 'outside').state);
    };
    document.addEventListener('pointerdown', onAway, true);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('pointerdown', onAway, true);
    };
  }, [state]);

  // A pill that goes into flight, or whose card changed underneath it, must not
  // stay armed: the next render is a different question.
  useEffect(() => {
    if (dead.pending) setState((prev) => confirmStep(prev, 'disable').state);
  }, [dead.pending]);

  const armed = state === 'armed';
  // Spelled out on every surface, including the 8.5px strip: a control that
  // ends a call for the whole group does not get an abbreviation.
  const label = restore ? 'RESTORE' : 'MARK DEAD';
  const action = restore
    ? `Put ${dead.label} back on the board`
    : `Mark ${dead.label} dead for the whole group`;

  return (
    <button
      ref={ref}
      type="button"
      className={`pill pill-dead${restore ? ' pill-dead-restore' : ''}${armed ? ' is-armed' : ''}${className ? ` ${className}` : ''}`}
      aria-label={armed ? `${action} — press again to confirm` : action}
      title={
        restore
          ? 'Only a member can undo a member’s verdict — the call goes back live, with no alert'
          : 'Any member can call it: the card moves to DIED for the whole group. A member can restore it.'
      }
      disabled={dead.pending}
      onBlur={() => setState(confirmStep(state, 'blur').state)}
      onClick={() => {
        const step = confirmStep(state, 'press');
        setState(step.state);
        if (step.fire) dead.onFire();
      }}
    >
      {dead.pending ? '…' : armed ? 'SURE?' : label}
    </button>
  );
}
