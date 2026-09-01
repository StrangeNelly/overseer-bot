import { useMemo } from 'react';
import type { ReactNode } from 'react';
import type { BoardCard, BoardResponse } from '@groupie/shared';
import { SectionTabs, BOARD_SECTIONS } from './SectionTabs';
import type { BoardSectionKey, SectionKey } from './SectionTabs';
import { TokenCard } from './TokenCard';

const EMPTY_LINES: Record<BoardSectionKey, string> = {
  fresh: 'No calls in this window. Try a longer one.',
  runners: 'Nothing is running yet in this window.',
  retraced: 'Nothing has pulled back off a peak here.',
  died: 'Nothing has died in this window.',
};

interface BoardProps {
  board: BoardResponse;
  section: SectionKey;
  onSection: (next: SectionKey) => void;
  /** Shared clock, ticked once a minute by App. */
  now: number;
  /** Optimistically binned call ids, hidden until the refetch lands. */
  hiddenCallIds: ReadonlySet<number>;
  binningId: number | null;
  onBin: (card: BoardCard) => void;
  /** Ranging tab body (its own controls + list); it has its own endpoint. */
  ranging: ReactNode;
  /** null until the ranging board has loaded once. */
  rangingCount: number | null;
}

export function Board({
  board,
  section,
  onSection,
  now,
  hiddenCallIds,
  binningId,
  onBin,
  ranging,
  rangingCount,
}: BoardProps) {
  const visible = useMemo(() => {
    const out = {} as Record<BoardSectionKey, BoardCard[]>;
    for (const { key } of BOARD_SECTIONS) {
      const cards = board.sections[key] ?? [];
      out[key] = hiddenCallIds.size === 0 ? cards : cards.filter((c) => !hiddenCallIds.has(c.callId));
    }
    return out;
  }, [board, hiddenCallIds]);

  const counts = useMemo(() => {
    const out = { ranging: rangingCount } as Record<SectionKey, number | null>;
    for (const { key } of BOARD_SECTIONS) out[key] = visible[key].length;
    return out;
  }, [visible, rangingCount]);

  return (
    <>
      <SectionTabs value={section} counts={counts} onChange={onSection} />
      {section === 'ranging' ? (
        ranging
      ) : (
        <BoardList
          cards={visible[section]}
          section={section}
          now={now}
          binningId={binningId}
          onBin={onBin}
        />
      )}
    </>
  );
}

function BoardList({
  cards,
  section,
  now,
  binningId,
  onBin,
}: {
  cards: BoardCard[];
  section: BoardSectionKey;
  now: number;
  binningId: number | null;
  onBin: (card: BoardCard) => void;
}) {
  if (cards.length === 0) return <p className="empty">{EMPTY_LINES[section]}</p>;
  return (
    <div className="cards">
      {cards.map((card) => (
        <TokenCard
          key={card.callId}
          card={card}
          section={section}
          now={now}
          onBin={section === 'died' ? onBin : undefined}
          binning={binningId === card.callId}
        />
      ))}
    </div>
  );
}
