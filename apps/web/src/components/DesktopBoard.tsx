import { useEffect, useMemo, useRef, useState } from 'react';
import type { BoardCard, BoardResponse } from '@groupie/shared';
import { WATCH_CAP_PER_MEMBER, fmtDurationHours } from '@groupie/shared';
import { deriveInPlay, mySlots } from '../derive';
import { fmtHours, fmtUsd } from '../format';
import { canReorder, hasMotionRoom, prefersReducedMotion, requestMotion } from '../motion';
import type { Ceremony } from '../motion';
import type { WatchProps } from '../watch';
import { watchForCard } from '../watch';
import { EMPTY_LINES, WATCH_EMPTY_LINE, ZONE_META, useVisibleSections } from './Board';
import { GREW_MS, NOTHING_GREW } from './Pulse';
import type { SectionKey } from './SectionTabs';
import { RetracedCard, RevivingCard, RunnerHero } from './Spotlight';
import { TokenCard } from './TokenCard';
import { WatchRows } from './WatchRows';
import { BandBar, Zone } from './Zone';

/** Design: a card that changes section physically travels, over 450ms. */
const TRANSIT_MS = 450;
/** Design pass 2: a rank change inside a zone slides, over 300ms. */
const FLIP_MS = 300;

/**
 * The Died zone's band note. Rug probation hides a card from EVERY section,
 * died included (docs/decisions.md round 6), so until round 15 those coins
 * simply were not on the board and nothing said so.
 */
export function diedNote(hiddenProbation: number): string | null {
  // Positive-or-nothing rather than `<= 0`: a payload that somehow carries no
  // number must print nothing, never "+undefined hidden".
  if (!(hiddenProbation > 0)) return null;
  return `+${hiddenProbation} hidden on rug probation`;
}

/** One row of the desktop RANGING summary — a band bar at rail size. */
export interface RangeSummaryRow {
  /** The row's identity: tickers collide, two $PEPEs are two different coins. */
  callId: number;
  label: string;
  hours: number;
  lowPct: number;
  highPct: number;
  tickPct: number | null;
}

export interface RangeSummary {
  count: number;
  loUsd: number;
  hiUsd: number;
  minHours: number;
  rows: RangeSummaryRow[];
}

/**
 * The desktop SLEEPERS summary: every band drawn as one segment of a count
 * strip (seven of them since round 17). `label` is the band's floor, already
 * abbreviated by the caller to what fits the 330px rail.
 */
export interface SleepersSummary {
  total: number;
  bands: { label: string; count: number }[];
  refreshedAt: string | null;
  xOnly: boolean;
  /** Whether the payload behind these counts excluded tokenized stocks. */
  excludeStocks: boolean;
  minHoursLabel: string;
}

interface DesktopBoardProps {
  board: BoardResponse;
  now: number;
  hiddenCallIds: ReadonlySet<number>;
  binningId: number | null;
  onBin: (card: BoardCard) => void;
  watch: WatchProps;
  ceremonies: ReadonlyMap<number, Ceremony>;
  /** Cards that changed section on this update — the transit set. */
  moved: ReadonlySet<number>;
  rangeSummary: RangeSummary | null;
  sleepersSummary: SleepersSummary | null;
  onOpenTab: (section: SectionKey) => void;
  /** 3G: the address a watch-move announcement just named. */
  alertedAddress: string | null;
}

/**
 * Fly a ghost of the row from where it used to sit to where it sits now: lift,
 * dim, arc, land. The real row fades in underneath as the ghost fades out.
 */
function fly(element: HTMLElement, from: DOMRect): void {
  const to = element.getBoundingClientRect();
  const dx = from.left - to.left;
  const dy = from.top - to.top;
  if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
  if (typeof element.animate !== 'function') return;

  const ghost = element.cloneNode(true) as HTMLElement;
  ghost.classList.add('transit-ghost');
  ghost.style.position = 'fixed';
  ghost.style.left = `${to.left}px`;
  ghost.style.top = `${to.top}px`;
  ghost.style.width = `${to.width}px`;
  ghost.style.height = `${to.height}px`;
  ghost.style.margin = '0';
  document.body.appendChild(ghost);
  element.classList.add('is-arriving');

  const lift = -Math.min(70, Math.abs(dy) * 0.25 + 22);
  const animation = ghost.animate(
    [
      { transform: `translate(${dx}px, ${dy}px)`, opacity: 1 },
      { transform: `translate(${dx * 0.5}px, ${dy * 0.5 + lift}px) scale(1.02)`, opacity: 0.7, offset: 0.5 },
      { transform: 'translate(0, 0)', opacity: 0 },
    ],
    { duration: TRANSIT_MS, easing: 'cubic-bezier(.4, 0, .2, 1)' },
  );

  const done = () => {
    ghost.remove();
    element.classList.remove('is-arriving');
  };
  animation.onfinish = done;
  animation.oncancel = done;
  window.setTimeout(done, TRANSIT_MS + 120);
}

/**
 * Desktop >= 1100px (design pass 2, 3A): opportunity first. The chronology is a
 * 350px rail on the left, the middle is IN PLAY — RUNNERS, RETRACED, REVIVING
 * and ON WATCH, each ranked by the data rather than by when it was called — and
 * the right rail carries what is finished (DIED) and what is being analysed
 * (RANGING and SLEEPERS summaries, each a door into its own view).
 */
export function DesktopBoard({
  board,
  now,
  hiddenCallIds,
  binningId,
  onBin,
  watch,
  ceremonies,
  moved,
  rangeSummary,
  sleepersSummary,
  onOpenTab,
  alertedAddress,
}: DesktopBoardProps) {
  const visible = useVisibleSections(board, hiddenCallIds);
  const inPlay = useMemo(() => deriveInPlay(board, visible), [board, visible]);
  const slots = useMemo(() => mySlots(board), [board]);
  const rootRef = useRef<HTMLDivElement>(null);
  const rectsRef = useRef(new Map<number, DOMRect>());
  /** Row tops measured against their own zone, so a page scroll is not a reorder. */
  const flipRef = useRef(new Map<string, number>());

  // Transit, then re-snapshot: this frame's geometry is the next update's "from".
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const reduced = prefersReducedMotion();

    if (moved.size > 0 && !reduced) {
      for (const callId of moved) {
        const from = rectsRef.current.get(callId);
        if (!from) continue;
        const element = root.querySelector<HTMLElement>(`[data-call="${callId}"]`);
        if (!element) continue;
        requestMotion(() => fly(element, from), TRANSIT_MS);
      }
    }

    // Rank changes inside a zone: a FLIP slide, throttled to one per zone per
    // 10s so a board that re-ranks on every refetch is not permanently sliding.
    const nextFlip = new Map<string, number>();
    for (const zone of root.querySelectorAll<HTMLElement>('[data-zone]')) {
      const name = zone.dataset.zone ?? '';
      // Positions are measured against the ZONE, not the viewport: the desktop
      // board scrolls as a document, so viewport tops turn a 300px scroll
      // between two refetches into a 300px "rank change" for every row.
      const zoneTop = zone.getBoundingClientRect().top;
      // A row is identified by its call, or by its address where there is no
      // call (a watch set from the chat or from Sleepers).
      const items = Array.from(zone.querySelectorAll<HTMLElement>('[data-call],[data-flip]'));
      const deltas: { element: HTMLElement; dy: number }[] = [];
      for (const item of items) {
        const key = `${name}:${item.dataset.call ?? item.dataset.flip}`;
        const top = item.getBoundingClientRect().top - zoneTop;
        nextFlip.set(key, top);
        const previous = flipRef.current.get(key);
        if (previous !== undefined && Math.abs(previous - top) >= 2) {
          deltas.push({ element: item, dy: previous - top });
        }
      }
      if (deltas.length === 0 || reduced || moved.size > 0) continue;
      // Dropped, never queued: a slide replayed after the rows were already
      // painted in place would animate from geometry that no longer exists.
      if (!hasMotionRoom()) continue;
      if (!canReorder(name)) continue;
      // One job per zone, inside the noise budget: four zones re-ranking at once
      // would otherwise animate everything simultaneously on top of the
      // ceremonies, which already queue.
      requestMotion(() => {
        for (const { element, dy } of deltas) {
          if (typeof element.animate !== 'function') continue;
          element.animate(
            [{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }],
            { duration: FLIP_MS, easing: 'cubic-bezier(.4, 0, .2, 1)' },
          );
        }
      }, FLIP_MS);
    }
    flipRef.current = nextFlip;

    const next = new Map<number, DOMRect>();
    for (const element of root.querySelectorAll<HTMLElement>('[data-call]')) {
      const id = Number(element.dataset.call);
      if (Number.isFinite(id) && !next.has(id)) next.set(id, element.getBoundingClientRect());
    }
    rectsRef.current = next;
  }, [board, moved]);

  const { runners, retraced, reviving, watch: watchRows } = inPlay;
  const topRunner = runners[0] ?? null;
  const topRetraced = retraced[0] ?? null;

  return (
    <div className="desk" ref={rootRef}>
      <div className="desk-col desk-feed">
        <Zone
          tone="fresh"
          headline="FRESH"
          count={visible.fresh.length}
          note={ZONE_META.fresh.note}
        >
          {visible.fresh.length === 0 ? (
            <p className="empty">{EMPTY_LINES.fresh}</p>
          ) : (
            <div className="feed feed-flat">
              {visible.fresh.map((card) => (
                <TokenCard
                  key={card.callId}
                  card={card}
                  section="fresh"
                  now={now}
                  size="desk"
                  links="hover"
                  watch={watchForCard(card, watch)}
                  ceremony={ceremonies.get(card.callId)}
                />
              ))}
            </div>
          )}
        </Zone>
      </div>

      <div className="desk-col desk-play">
        <div className="inplay-head">
          <span className="inplay-id">
            <span className="inplay-title">IN PLAY</span>
            <span className="inplay-note">ranked by the data, not by when it was called</span>
          </span>
          <span className="inplay-note inplay-note-right">
            multiple · 1h move · LP · retrace — never advice
          </span>
        </div>

        <Zone
          tone="runners"
          headline="RUNNERS"
          count={runners.length}
          note={ZONE_META.runners.note}
        >
          {topRunner ? (
            <div data-zone="runners">
              <RunnerHero
                key={topRunner.callId}
                card={topRunner}
                now={now}
                breathing
                watch={watchForCard(topRunner, watch)}
              />
              {runners.length > 1 ? (
                <div className="feed feed-flat feed-attached">
                  {runners.slice(1).map((card) => (
                    <TokenCard
                      key={card.callId}
                      card={card}
                      section="runners"
                      now={now}
                      size="desk"
                      links="hover"
                      watch={watchForCard(card, watch)}
                      ceremony={ceremonies.get(card.callId)}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <p className="empty">{EMPTY_LINES.runners}</p>
          )}
        </Zone>

        <Zone
          tone="retraced"
          headline="RETRACED"
          count={retraced.length}
          note={ZONE_META.retraced.note}
        >
          {topRetraced ? (
            <div data-zone="retraced">
              <RetracedCard card={topRetraced} now={now} watch={watchForCard(topRetraced, watch)} />
              {retraced.length > 1 ? (
                <div className="feed feed-flat feed-attached">
                  {retraced.slice(1).map((card) => (
                    <TokenCard
                      key={card.callId}
                      card={card}
                      section="retraced"
                      now={now}
                      size="desk"
                      links="hover"
                      watch={watchForCard(card, watch)}
                      ceremony={ceremonies.get(card.callId)}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <p className="empty">{EMPTY_LINES.retraced}</p>
          )}
        </Zone>

        <Zone
          tone="reviving"
          headline="REVIVING"
          count={reviving.length}
          note={ZONE_META.reviving.note}
          glow
        >
          {reviving.length === 0 ? (
            <p className="empty">{EMPTY_LINES.reviving}</p>
          ) : (
            <div className="spotlights spotlights-zone" data-zone="reviving">
              {reviving.map((card, index) => (
                <RevivingCard
                  key={card.callId}
                  card={card}
                  now={now}
                  featured={index === 0}
                  watch={watchForCard(card, watch)}
                />
              ))}
            </div>
          )}
        </Zone>

        <Zone
          tone="watch"
          headline="ON WATCH"
          count={watchRows.length}
          headExtra={
            <span className="zone-note">
              {'your slots '}
              <strong>{`${slots} / ${WATCH_CAP_PER_MEMBER}`}</strong>
              {' · alerts on in the chat · biggest 1h move first'}
            </span>
          }
        >
          {watchRows.length === 0 ? (
            <p className="empty">{WATCH_EMPTY_LINE}</p>
          ) : (
            <div data-zone="watch">
              <WatchRows
                rows={watchRows}
                now={now}
                watch={watch}
                mode="desk"
                alertedAddress={alertedAddress}
              />
            </div>
          )}
        </Zone>
      </div>

      <div className="desk-col desk-rail">
        <Zone
          tone="died"
          headline="DIED"
          count={visible.died.length}
          note={diedNote(board.hiddenProbationCount) ?? undefined}
        >
          {visible.died.length === 0 ? (
            <p className="empty">{EMPTY_LINES.died}</p>
          ) : (
            <>
              <div className="rail">
                {visible.died.map((card) => (
                  <TokenCard
                    key={card.callId}
                    card={card}
                    section="died"
                    now={now}
                    size="rail"
                    onBin={onBin}
                    binning={binningId === card.callId}
                    watch={watchForCard(card, watch)}
                  />
                ))}
              </div>
              <p className="zone-foot">bin purges for the whole group · dim, never red</p>
            </>
          )}
        </Zone>

        <Zone
          tone="cyan"
          headline="RANGING"
          count={rangeSummary ? rangeSummary.count : null}
          headExtra={
            <button type="button" className="zone-open" onClick={() => onOpenTab('ranging')}>
              open view ▸
            </button>
          }
        >
          {rangeSummary ? (
            <>
              <p className="summary-line">
                {`${rangeSummary.count} coiling in `}
                <strong>{`${fmtUsd(rangeSummary.loUsd)}–${fmtUsd(rangeSummary.hiUsd)}`}</strong>
                {` for ${fmtDurationHours(rangeSummary.minHours)}+`}
              </p>
              {rangeSummary.rows.length > 0 ? (
                <>
                  <div className="rng-rows">
                    {rangeSummary.rows.map((row) => (
                      <div className="rng-row" key={row.callId}>
                        <span className="rng-sym">{row.label}</span>
                        <BandBar
                          lowPct={row.lowPct}
                          highPct={row.highPct}
                          tickPct={row.tickPct}
                          className="rng-bar"
                        />
                        <span className="rng-hours">{fmtHours(row.hours)}</span>
                      </div>
                    ))}
                  </div>
                  <div className="rng-ends">
                    <span>{fmtUsd(rangeSummary.loUsd)}</span>
                    <span>{fmtUsd(rangeSummary.hiUsd)}</span>
                  </div>
                </>
              ) : null}
            </>
          ) : (
            <p className="summary-line">open the view to scan for coilers</p>
          )}
        </Zone>

        {/*
          Sleepers has no column of its own on purpose: the desktop board is
          the GROUP's board, and the chain-wide stream is a door out of it, not
          another section of it (docs/decisions.md round 9).
        */}
        <Zone
          tone="cyan"
          headline="SLEEPERS"
          count={sleepersSummary ? sleepersSummary.total : null}
          headExtra={
            <button type="button" className="zone-open" onClick={() => onOpenTab('sleepers')}>
              open view ▸
            </button>
          }
        >
          {sleepersSummary ? (
            <>
              <p className="summary-line">
                <strong>{`${sleepersSummary.total} chain-wide leads`}</strong>
                {' · not group calls — uncurated research'}
              </p>
              <SleeperStrip summary={sleepersSummary} />
              <p className="zone-foot">
                {[
                  sleepersSummary.refreshedAt
                    ? `refreshed ${fmtAgeSafe(sleepersSummary.refreshedAt, now)} ago`
                    : 'first scan pending',
                  sleepersSummary.xOnly ? 'X only' : 'showing all',
                  sleepersSummary.excludeStocks ? 'no stocks' : 'with stocks',
                  `in band ≥ ${sleepersSummary.minHoursLabel}`,
                ].join(' · ')}
              </p>
            </>
          ) : (
            <p className="summary-line">open the view to scan the whole chain</p>
          )}
        </Zone>
      </div>
    </div>
  );
}

/** Local wrapper so the rail never has to import the clock formatter twice. */
function fmtAgeSafe(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  return fmtHours(Math.max(0, now - t) / (60 * 60 * 1000));
}

/**
 * The per-band count strip: one segment per band (seven since round 17), widths
 * proportional to the counts. An empty band draws neither segment nor legend
 * entry — a zero-width segment is not a smaller bar, it is an invisible one.
 */
function SleeperStrip({ summary }: { summary: SleepersSummary }) {
  // Same rule as the day-outcome strip: the band that grew flashes once, at 6%
  // of its own colour.
  const [grew, setGrew] = useState<ReadonlySet<string>>(NOTHING_GREW);
  const previous = useRef(summary.bands);

  useEffect(() => {
    const before = new Map(previous.current.map((band) => [band.label, band.count]));
    previous.current = summary.bands;
    const next = new Set<string>();
    for (const band of summary.bands) {
      const was = before.get(band.label);
      if (was !== undefined && band.count > was) next.add(band.label);
    }
    if (next.size === 0) return;
    setGrew(next);
    const id = window.setTimeout(() => setGrew(NOTHING_GREW), GREW_MS);
    return () => window.clearTimeout(id);
  }, [summary.bands]);

  const total = summary.bands.reduce((sum, band) => sum + band.count, 0);
  if (total === 0) return null;
  return (
    <>
      <div className="slp-strip" aria-hidden="true">
        {summary.bands.map((band, index) =>
          band.count === 0 ? null : (
            <span
              key={band.label}
              className={`slp-seg slp-seg-${index}${grew.has(band.label) ? ' is-grew' : ''}`}
              style={{ flex: band.count }}
            />
          ),
        )}
      </div>
      <div className="slp-legend">
        {summary.bands.map((band) =>
          band.count === 0 ? null : (
            <span key={band.label} style={{ flex: band.count }}>
              {`${band.label} `}
              <strong>{band.count}</strong>
            </span>
          ),
        )}
      </div>
    </>
  );
}
