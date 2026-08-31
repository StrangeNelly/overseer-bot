import { useMemo } from 'react';
import type { BoardCard, BoardResponse } from '@groupie/shared';
import { SectionTabs, SECTIONS } from './SectionTabs';
import type { SectionKey } from './SectionTabs';
import { TokenCard } from './TokenCard';

const EMPTY_LINES: Record<SectionKey, string> = {
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
}

export function Board({
  board,
  section,
  onSection,
  now,
  hiddenCallIds,
  binningId,
  onBin,
}: BoardProps) {
  const visible = useMemo(() => {
    const out = {} as Record<SectionKey, BoardCard[]>;
    for (const { key } of SECTIONS) {
      const cards = board.sections[key] ?? [];
      out[key] = hiddenCallIds.size === 0 ? cards : cards.filter((c) => !hiddenCallIds.has(c.callId));
    }
    return out;
  }, [board, hiddenCallIds]);

  const counts = useMemo(() => {
    const out = {} as Record<SectionKey, number>;
    for (const { key } of SECTIONS) out[key] = visible[key].length;
    return out;
  }, [visible]);

  const cards = visible[section];

  return (
    <>
      <SectionTabs value={section} counts={counts} onChange={onSection} />
      {cards.length === 0 ? (
        <p className="empty">{EMPTY_LINES[section]}</p>
      ) : (
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
      )}
    </>
  );
}
