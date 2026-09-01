import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { BoardCard, BoardResponse } from '@groupie/shared';
import type { Ceremony } from '../motion';
import type { WatchControl } from './LinkPills';
import { SectionTabs, BOARD_SECTIONS } from './SectionTabs';
import type { BoardSectionKey, SectionKey } from './SectionTabs';
import { RevivingCard } from './Spotlight';
import { TokenCard } from './TokenCard';

/**
 * The watch toggle, per card: one handler for the whole board plus the id of
 * the card whose request is in flight. Passed down rather than contexted, like
 * every other action on this board.
 */
export interface WatchProps {
  onWatch: (card: BoardCard, next: boolean) => void;
  /** tokenId of the toggle currently in flight, or null. */
  watchingTokenId: number | null;
}

/** The per-card slice of that, or undefined where no toggle should render. */
export function watchFor(card: BoardCard, props: WatchProps | undefined): WatchControl | undefined {
  if (!props) return undefined;
  return { onWatch: props.onWatch, pending: props.watchingTokenId === card.tokenId };
}

/** Kept verbatim from the pre-redesign board — the copy was already right. */
export const EMPTY_LINES: Record<BoardSectionKey, string> = {
  fresh: 'No calls in this window. Try a longer one.',
  reviving: 'Nothing has come back from the dead lately.',
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
  watch: WatchProps;
  /** Ranging tab body (its own controls + list); it has its own endpoint. */
  ranging: ReactNode;
  /** null until the ranging board has loaded once. */
  rangingCount: number | null;
  /** Sleepers tab body — the chain-wide stream, also its own endpoint. */
  sleepers: ReactNode;
  /** null until the sleepers stream has loaded once. */
  sleepersCount: number | null;
  /** Per-card state changes worth a ceremony this update. */
  ceremonies: ReadonlyMap<number, Ceremony>;
}

export function useVisibleSections(
  board: BoardResponse,
  hiddenCallIds: ReadonlySet<number>,
): Record<BoardSectionKey, BoardCard[]> {
  return useMemo(() => {
    const out = {} as Record<BoardSectionKey, BoardCard[]>;
    for (const { key } of BOARD_SECTIONS) {
      const cards = board.sections[key] ?? [];
      out[key] = hiddenCallIds.size === 0 ? cards : cards.filter((c) => !hiddenCallIds.has(c.callId));
    }
    return out;
  }, [board, hiddenCallIds]);
}

/** Mobile board (design 2c/2g): Pulse sits above; this is tabs plus bodies. */
export function Board({
  board,
  section,
  onSection,
  now,
  hiddenCallIds,
  binningId,
  onBin,
  watch,
  ranging,
  rangingCount,
  sleepers,
  sleepersCount,
  ceremonies,
}: BoardProps) {
  const visible = useVisibleSections(board, hiddenCallIds);
  // One open link row at a time (design: row anatomy).
  const [openId, setOpenId] = useState<number | null>(null);

  useEffect(() => setOpenId(null), [section]);

  const counts = useMemo(() => {
    const out = { ranging: rangingCount, sleepers: sleepersCount } as Record<
      SectionKey,
      number | null
    >;
    for (const { key } of BOARD_SECTIONS) out[key] = visible[key].length;
    return out;
  }, [visible, rangingCount, sleepersCount]);

  const toggle = (callId: number) => setOpenId((prev) => (prev === callId ? null : callId));

  return (
    <>
      <SectionTabs value={section} counts={counts} onChange={onSection} />
      {section === 'ranging' ? (
        ranging
      ) : section === 'sleepers' ? (
        sleepers
      ) : section === 'reviving' ? (
        <RevivingList cards={visible.reviving} now={now} watch={watch} />
      ) : (
        <>
          <BoardList
            cards={visible[section]}
            section={section}
            now={now}
            binningId={binningId}
            onBin={onBin}
            watch={watch}
            ceremonies={ceremonies}
            openId={openId}
            onToggle={toggle}
          />
          {/*
            Probation hides a card from every section, died included (round 6),
            so the Died tab is where a member goes looking for a coin that
            vanished. Round 15: say how many are being held back.
          */}
          {section === 'died' && board.hiddenProbationCount > 0 ? (
            <p className="footnote">
              {`${board.hiddenProbationCount} more ${board.hiddenProbationCount === 1 ? 'coin is' : 'coins are'} hidden on rug probation — under the floor, not yet rugged. They come back on their own if they recover.`}
            </p>
          ) : null}
        </>
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
  watch,
  ceremonies,
  openId,
  onToggle,
}: {
  cards: BoardCard[];
  section: BoardSectionKey;
  now: number;
  binningId: number | null;
  onBin: (card: BoardCard) => void;
  watch: WatchProps;
  ceremonies: ReadonlyMap<number, Ceremony>;
  openId: number | null;
  onToggle: (callId: number) => void;
}) {
  if (cards.length === 0) return <p className="empty">{EMPTY_LINES[section]}</p>;
  return (
    <div className="rows">
      {cards.map((card, index) => (
        <TokenCard
          key={card.callId}
          card={card}
          section={section}
          now={now}
          // Runners are sorted by multiple desc: the first is THE top runner,
          // the only card on the board allowed to breathe.
          size={section === 'runners' && index === 0 ? 'hero' : 'row'}
          topRunner={section === 'runners' && index === 0}
          links="tap"
          expanded={openId === card.callId}
          onToggle={onToggle}
          onBin={section === 'died' ? onBin : undefined}
          binning={binningId === card.callId}
          watch={watchFor(card, watch)}
          ceremony={ceremonies.get(card.callId)}
        />
      ))}
    </div>
  );
}

function RevivingList({
  cards,
  now,
  watch,
}: {
  cards: BoardCard[];
  now: number;
  watch: WatchProps;
}) {
  if (cards.length === 0) return <p className="empty">{EMPTY_LINES.reviving}</p>;
  return (
    <div className="spotlights">
      {cards.map((card, index) => (
        <RevivingCard
          key={card.callId}
          card={card}
          now={now}
          featured={index === 0}
          watch={watchFor(card, watch)}
        />
      ))}
      <p className="footnote">
        spotlight, not exile — these coins still file into their normal sections; the badge and this
        tab expire 24h after revival
      </p>
    </div>
  );
}
