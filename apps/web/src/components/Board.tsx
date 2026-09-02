import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { BoardCard, BoardResponse } from '@groupie/shared';
import { WATCH_CAP_PER_MEMBER } from '@groupie/shared';
import {
  deriveWatchRows,
  mySlots,
  rankRetraced,
  rankRunners,
  rankReviving,
} from '../derive';
import type { Ceremony } from '../motion';
import type { WatchProps } from '../watch';
import { watchForCard } from '../watch';
import { SectionTabs, BOARD_SECTIONS } from './SectionTabs';
import type { BoardSectionKey, SectionKey } from './SectionTabs';
import { RetracedCard, RevivingCard, RunnerHero } from './Spotlight';
import { TokenCard } from './TokenCard';
import { WatchRows } from './WatchRows';
import { Zone } from './Zone';
import type { ZoneTone } from './Zone';

/** Kept verbatim from the pre-redesign board — the copy was already right. */
export const EMPTY_LINES: Record<BoardSectionKey, string> = {
  fresh: 'No calls in this window. Try a longer one.',
  reviving: 'Nothing has come back from the dead lately.',
  runners: 'Nothing is running yet in this window.',
  retraced: 'Nothing has pulled back off a peak here.',
  died: 'Nothing has died in this window.',
};

/** ON WATCH is new in round 16, so it needed a line of its own. */
export const WATCH_EMPTY_LINE = 'Nobody is watching a coin in this group right now.';

/** The zone bands, per 3A/3F: tone, headline and the note that frames the rule. */
export const ZONE_META: Record<
  BoardSectionKey | 'watch',
  { tone: ZoneTone; headline: string; note: string; short: string }
> = {
  fresh: {
    tone: 'fresh',
    headline: 'FRESH',
    note: 'chronology · newest first',
    short: 'newest first',
  },
  runners: {
    tone: 'runners',
    headline: 'RUNNERS',
    note: '≥3x since call · moving now first (1h move)',
    short: '≥3x · moving now first',
  },
  retraced: {
    tone: 'retraced',
    headline: 'RETRACED',
    note: 'peaked ≥3x, now ≥40% below peak · liquidity intact first (LP ÷ mcap)',
    short: 'peaked ≥3x · liquidity intact first',
  },
  reviving: {
    tone: 'reviving',
    headline: 'REVIVING',
    note: 'back over $30K for 3h+ · strongest comeback first',
    short: 'back over $30K for 3h+',
  },
  watch: {
    tone: 'watch',
    headline: 'ON WATCH',
    note: 'alerts on in the chat · biggest 1h move first',
    short: 'alerts on in the chat',
  },
  died: {
    tone: 'died',
    headline: 'DIED',
    note: 'bin purges for the whole group · dim, never red',
    short: 'bin purges for the group',
  },
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
  /** Discovery tab body — launches and graduations off the chain (rounds 18/20). */
  discovery: ReactNode;
  /** null until discovery has loaded once, and null while the feed is dormant. */
  discoveryCount: number | null;
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

/**
 * Mobile board (design pass 2, 3F). The tab strip became zone CHIPS, and each
 * tab body became a bounded zone: a 46px tinted headline band over a bordered
 * panel, in the tab's own tone. One tab, one region — the round-2 board was a
 * continuous scroll with a label on top of it.
 */
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
  discovery,
  discoveryCount,
  ceremonies,
}: BoardProps) {
  const visible = useVisibleSections(board, hiddenCallIds);
  // One open link row at a time (design: row anatomy).
  const [openId, setOpenId] = useState<number | null>(null);
  const [openWatch, setOpenWatch] = useState<string | null>(null);

  useEffect(() => {
    setOpenId(null);
    setOpenWatch(null);
  }, [section]);

  // A tab is a whole view, so no de-duplication here: every slot the reader
  // holds has to be visible and freeable from this one screen.
  const watchRows = useMemo(() => deriveWatchRows(board, visible), [board, visible]);
  const slots = useMemo(() => mySlots(board), [board]);

  const counts = useMemo(() => {
    const out = {
      ranging: rangingCount,
      sleepers: sleepersCount,
      discovery: discoveryCount,
      watch: watchRows.length,
    } as Record<SectionKey, number | null>;
    for (const { key } of BOARD_SECTIONS) out[key] = visible[key].length;
    return out;
  }, [visible, rangingCount, sleepersCount, discoveryCount, watchRows.length]);

  const toggle = (callId: number) => setOpenId((prev) => (prev === callId ? null : callId));
  const toggleWatch = (key: string) => setOpenWatch((prev) => (prev === key ? null : key));

  return (
    <>
      <SectionTabs value={section} counts={counts} onChange={onSection} />

      {section === 'ranging' ? (
        ranging
      ) : section === 'sleepers' ? (
        sleepers
      ) : section === 'discovery' ? (
        discovery
      ) : section === 'watch' ? (
        <Zone
          key="watch"
          tone="watch"
          headline="ON WATCH"
          count={watchRows.length}
          className="zone-tab"
          headExtra={
            <span className="zone-note">
              {'your slots '}
              <strong>{`${slots} / ${WATCH_CAP_PER_MEMBER}`}</strong>
              {' · alerts on in the chat'}
            </span>
          }
        >
          {watchRows.length === 0 ? (
            <p className="empty">{WATCH_EMPTY_LINE}</p>
          ) : (
            /* 3G is a desktop ceremony: mobile gets the Pulse line only, no
               bloom (and therefore no re-sort to rank 1 either). */
            <WatchRows
              rows={watchRows}
              now={now}
              watch={watch}
              mode="mobile"
              openKey={openWatch}
              onToggle={toggleWatch}
            />
          )}
        </Zone>
      ) : (
        <Zone
          key={section}
          tone={ZONE_META[section].tone}
          headline={ZONE_META[section].headline}
          count={visible[section].length}
          note={ZONE_META[section].short}
          className="zone-tab"
        >
          <TabBody
            section={section}
            cards={visible[section]}
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
          {section === 'reviving' && visible.reviving.length > 0 ? (
            <p className="footnote">
              spotlight, not exile — these coins still file into their normal sections; the badge and
              this tab expire 24h after revival
            </p>
          ) : null}
        </Zone>
      )}
    </>
  );
}

/**
 * One tab's contents. RUNNERS and RETRACED lead with their spotlight card (3F:
 * "spotlight card then 52px rows"); REVIVING is spotlight cards all the way
 * down; FRESH and DIED are rows, which is all they ever needed to be.
 */
function TabBody({
  section,
  cards,
  now,
  binningId,
  onBin,
  watch,
  ceremonies,
  openId,
  onToggle,
}: {
  section: BoardSectionKey;
  cards: BoardCard[];
  now: number;
  binningId: number | null;
  onBin: (card: BoardCard) => void;
  watch: WatchProps;
  ceremonies: ReadonlyMap<number, Ceremony>;
  openId: number | null;
  onToggle: (callId: number) => void;
}) {
  if (cards.length === 0) return <p className="empty">{EMPTY_LINES[section]}</p>;

  if (section === 'reviving') {
    return (
      <div className="spotlights">
        {rankReviving(cards).map((card, index) => (
          <RevivingCard
            key={card.callId}
            card={card}
            now={now}
            featured={index === 0}
            watch={watchForCard(card, watch)}
          />
        ))}
      </div>
    );
  }

  const ranked =
    section === 'runners' ? rankRunners(cards) : section === 'retraced' ? rankRetraced(cards) : cards;
  const hero = section === 'runners' || section === 'retraced' ? ranked[0]! : null;
  const rest = hero ? ranked.slice(1) : ranked;

  return (
    <>
      {hero ? (
        <div className="spotlights spotlights-tab">
          {section === 'runners' ? (
            <RunnerHero key={hero.callId} card={hero} now={now} breathing watch={watchForCard(hero, watch)} />
          ) : (
            <RetracedCard card={hero} now={now} watch={watchForCard(hero, watch)} />
          )}
        </div>
      ) : null}
      {rest.length > 0 ? (
        <div className="rows">
          {rest.map((card) => (
            <TokenCard
              key={card.callId}
              card={card}
              section={section}
              now={now}
              links="tap"
              expanded={openId === card.callId}
              onToggle={onToggle}
              onBin={section === 'died' ? onBin : undefined}
              binning={binningId === card.callId}
              watch={watchForCard(card, watch)}
              ceremony={ceremonies.get(card.callId)}
            />
          ))}
        </div>
      ) : null}
    </>
  );
}
