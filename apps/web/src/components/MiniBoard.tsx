import { useState } from 'react';
import type { BoardCard, BoardResponse } from '@groupie/shared';
import type { PulseData } from '../derive';
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
  /** Grow the sheet to full height — the member asked, we never do it on load. */
  onExpand: () => void;
}

/**
 * Telegram Mini App half-sheet (design 2a). Round 8 stopped auto-expanding and
 * gave this surface its own job: today's Pulse, the freshest rows, and one
 * obvious bridge to the full board in the browser.
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

      <div className="mini-listhead">
        <span className="mini-label">{`FRESH · ${fresh.length}`}</span>
        <button type="button" className="link-btn" onClick={onExpand}>
          all tabs ▾
        </button>
      </div>

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
              onToggle={(callId) => setOpenId((prev) => (prev === callId ? null : callId))}
              // Design: list rows never animate in the half-sheet.
              animate={false}
            />
          ))
        )}
      </div>

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
