import { useState } from 'react';
import type { BoardCard, BoardResponse } from '@groupie/shared';
import type { DeadProps } from '../dead';
import { deadForCard } from '../dead';
import type { PulseData } from '../derive';
import type { WatchProps } from '../watch';
import { watchForCard } from '../watch';
import { Pulse } from './Pulse';
import { TokenCard } from './TokenCard';

/** The half-sheet shows this many rows; the rest live behind the full board. */
const MINI_ROWS = 6;

interface MiniBoardProps {
  board: BoardResponse;
  now: number;
  hiddenCallIds: ReadonlySet<number>;
  pulse: PulseData;
  announcement: string | null;
  revalidating: boolean;
  onFullBoard: () => void;
  handoffPending: boolean;
  watch: WatchProps;
  /**
   * The member verdict (round 21 amendment (e)): the half-sheet is where most
   * members read the board, so MARK DEAD has to be reachable from it too.
   */
  dead?: DeadProps;
  /** Grow the sheet to full height — the member asked, we never do it on load. */
  onExpand: () => void;
}

/**
 * Telegram Mini App half-sheet (design pass 2, 3E). Round 8 stopped
 * auto-expanding and gave this surface its own job: today's Pulse, the freshest
 * rows, and one obvious bridge to the full board in the browser.
 *
 * Pass 2 added the day-outcome strip to the Pulse hero and turned the FRESH
 * label into a real 36px zone band — the seam between Pulse and list is a
 * boundary now, not a caption. Still six rows at 560px.
 */
export function MiniBoard({
  board,
  now,
  hiddenCallIds,
  pulse,
  announcement,
  revalidating,
  onFullBoard,
  handoffPending,
  watch,
  dead,
  onExpand,
}: MiniBoardProps) {
  const [openId, setOpenId] = useState<number | null>(null);
  const fresh: BoardCard[] = (board.sections.fresh ?? []).filter(
    (card) => !hiddenCallIds.has(card.callId),
  );
  const rows = fresh.slice(0, MINI_ROWS);

  return (
    <div className="mini">
      <Pulse data={pulse} variant="hero" announcement={announcement} revalidating={revalidating} />

      <div className="mini-band">
        <span className="mini-band-id">
          <span className="mini-band-headline">FRESH</span>
          <span className="mini-band-count">{fresh.length}</span>
        </span>
        <button type="button" className="mini-band-link" onClick={onExpand}>
          all tabs ▾
        </button>
      </div>

      <MiniRows
        rows={rows}
        now={now}
        watch={watch}
        dead={dead}
        openId={openId}
        onToggle={(callId) => setOpenId((prev) => (prev === callId ? null : callId))}
      />

      <div className="bridge">
        <button
          type="button"
          className="bridge-btn"
          onClick={onFullBoard}
          disabled={handoffPending}
        >
          {handoffPending ? 'Opening…' : 'Full board ↗'}
        </button>
        <span className="bridge-note">opens in your browser · already signed in</span>
      </div>
    </div>
  );
}

/**
 * The half-sheet's rows, with the open one lifted out as a prop: the sheet owns
 * which row is open, this owns what a row carries. Links (and with them WATCH
 * and MARK DEAD) are tap-revealed here, because a 560px sheet has no hover and
 * no room for a strip that is always on.
 */
export function MiniRows({
  rows,
  now,
  watch,
  dead,
  openId,
  onToggle,
}: {
  rows: BoardCard[];
  now: number;
  watch: WatchProps;
  dead?: DeadProps;
  openId: number | null;
  onToggle: (callId: number) => void;
}) {
  return (
    <div className="mini-rows">
      {rows.length === 0 ? (
        <p className="empty">No calls in this window. Try a longer one.</p>
      ) : (
        rows.map((card) => (
          <TokenCard
            key={card.callId}
            card={card}
            section="fresh"
            now={now}
            size="mini"
            links="tap"
            expanded={openId === card.callId}
            onToggle={onToggle}
            watch={watchForCard(card, watch)}
            dead={deadForCard(card, dead)}
            // Design: list rows never animate in the half-sheet.
            animate={false}
          />
        ))
      )}
    </div>
  );
}
