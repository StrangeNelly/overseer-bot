import { useEffect, useRef } from 'react';
import type { BoardCard, BoardResponse } from '@groupie/shared';
import { fmtUsd } from '../format';
import { prefersReducedMotion, requestMotion } from '../motion';
import type { Ceremony } from '../motion';
import { EMPTY_LINES, useVisibleSections } from './Board';
import type { SectionKey } from './SectionTabs';
import { RetracedCard, RevivingCard, RunnerHero, SectionHead } from './Spotlight';
import { TokenCard } from './TokenCard';

/** Design: a card that changes section physically travels, over 450ms. */
const TRANSIT_MS = 450;

export interface RangeSummary {
  count: number;
  loUsd: number;
  hiUsd: number;
  minHours: number;
  longest: { label: string; hours: number } | null;
}

interface DesktopBoardProps {
  board: BoardResponse;
  now: number;
  hiddenCallIds: ReadonlySet<number>;
  binningId: number | null;
  onBin: (card: BoardCard) => void;
  ceremonies: ReadonlyMap<number, Ceremony>;
  /** Cards that changed section on this update — the transit set. */
  moved: ReadonlySet<number>;
  rangeSummary: RangeSummary | null;
  /** Total sleeper entries, or null before the stream has loaded once. */
  sleepersCount: number | null;
  onOpenTab: (section: SectionKey) => void;
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
 * Desktop >= 1100px (design 2b): every section at once, no tabs. Fresh feed on
 * the left, the runner/retraced stories in the middle, the reviving spotlight,
 * died rail and ranging summary on the right.
 */
export function DesktopBoard({
  board,
  now,
  hiddenCallIds,
  binningId,
  onBin,
  ceremonies,
  moved,
  rangeSummary,
  sleepersCount,
  onOpenTab,
}: DesktopBoardProps) {
  const visible = useVisibleSections(board, hiddenCallIds);
  const rootRef = useRef<HTMLDivElement>(null);
  const rectsRef = useRef(new Map<number, DOMRect>());

  // Transit, then re-snapshot: this frame's geometry is the next update's "from".
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    if (moved.size > 0 && !prefersReducedMotion()) {
      for (const callId of moved) {
        const from = rectsRef.current.get(callId);
        if (!from) continue;
        const element = root.querySelector<HTMLElement>(`[data-call="${callId}"]`);
        if (!element) continue;
        requestMotion(() => fly(element, from), TRANSIT_MS);
      }
    }

    const next = new Map<number, DOMRect>();
    for (const element of root.querySelectorAll<HTMLElement>('[data-call]')) {
      const id = Number(element.dataset.call);
      if (Number.isFinite(id) && !next.has(id)) next.set(id, element.getBoundingClientRect());
    }
    rectsRef.current = next;
  }, [board, moved]);

  const runners = visible.runners;
  const retraced = visible.retraced;
  const topRunner = runners[0] ?? null;

  return (
    <div className="desk" ref={rootRef}>
      <div className="desk-col desk-feed">
        <SectionHead title="FRESH" count={visible.fresh.length} note="newest activity first" />
        {visible.fresh.length === 0 ? (
          <p className="empty">{EMPTY_LINES.fresh}</p>
        ) : (
          <div className="feed">
            {visible.fresh.map((card) => (
              <TokenCard
                key={card.callId}
                card={card}
                section="fresh"
                now={now}
                size="desk"
                links="hover"
                ceremony={ceremonies.get(card.callId)}
              />
            ))}
          </div>
        )}
      </div>

      <div className="desk-col desk-stories">
        <section className="desk-block">
          <SectionHead title="RUNNERS" count={runners.length} note="≥3x since call" />
          {topRunner ? (
            <>
              <RunnerHero card={topRunner} now={now} breathing />
              {runners.length > 1 ? (
                <div className="feed feed-attached">
                  {runners.slice(1).map((card) => (
                    <TokenCard
                      key={card.callId}
                      card={card}
                      section="runners"
                      now={now}
                      size="desk"
                      links="hover"
                      ceremony={ceremonies.get(card.callId)}
                    />
                  ))}
                </div>
              ) : null}
            </>
          ) : (
            <p className="empty">{EMPTY_LINES.runners}</p>
          )}
        </section>

        <section className="desk-block">
          <SectionHead
            title="RETRACED"
            count={retraced.length}
            note="peaked ≥3x, now ≥40% below peak — data, not advice"
          />
          {retraced.length === 0 ? (
            <p className="empty">{EMPTY_LINES.retraced}</p>
          ) : (
            <>
              <RetracedCard card={retraced[0]!} now={now} />
              {retraced.length > 1 ? (
                <div className="feed feed-attached">
                  {retraced.slice(1).map((card) => (
                    <TokenCard
                      key={card.callId}
                      card={card}
                      section="retraced"
                      now={now}
                      size="desk"
                      links="hover"
                      ceremony={ceremonies.get(card.callId)}
                    />
                  ))}
                </div>
              ) : null}
            </>
          )}
        </section>
      </div>

      <div className="desk-col desk-rail">
        <section className="desk-block">
          <SectionHead
            title="REVIVING"
            count={visible.reviving.length}
            note="back over $30K for 3h+"
            tone="cyan"
          />
          {visible.reviving.length === 0 ? (
            <p className="empty">{EMPTY_LINES.reviving}</p>
          ) : (
            <div className="spotlights">
              {visible.reviving.map((card, index) => (
                <RevivingCard key={card.callId} card={card} now={now} featured={index === 0} />
              ))}
            </div>
          )}
        </section>

        <section className="desk-block">
          <SectionHead
            title="DIED"
            count={visible.died.length}
            note="bin to purge for the group"
            tone="dim"
          />
          {visible.died.length === 0 ? (
            <p className="empty">{EMPTY_LINES.died}</p>
          ) : (
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
                />
              ))}
            </div>
          )}
        </section>

        <section className="desk-block">
          <div className="range-summary">
            <div className="sect-head">
              <span className="sect-title">RANGING</span>
              <button type="button" className="link-btn" onClick={() => onOpenTab('ranging')}>
                open tab ▸
              </button>
            </div>
            {rangeSummary ? (
              <>
                <span className="summary-line">
                  {`${rangeSummary.count} coiling in `}
                  <strong>{`${fmtUsd(rangeSummary.loUsd)}–${fmtUsd(rangeSummary.hiUsd)}`}</strong>
                  {` for ${rangeSummary.minHours}h+`}
                </span>
                {rangeSummary.longest ? (
                  <span className="summary-line">
                    {'longest: '}
                    <strong>{`${rangeSummary.longest.label} · ${Math.round(rangeSummary.longest.hours)}h`}</strong>
                  </span>
                ) : null}
              </>
            ) : (
              <span className="summary-line">open the tab to scan for coilers</span>
            )}
          </div>
        </section>

        {/*
          Sleepers has no column of its own on purpose: the desktop board is
          the GROUP's board, and the chain-wide stream is a door out of it, not
          another section of it (docs/decisions.md round 9).
        */}
        <section className="desk-block">
          <div className="range-summary">
            <div className="sect-head">
              <span className="sect-title">SLEEPERS</span>
              <button type="button" className="link-btn" onClick={() => onOpenTab('sleepers')}>
                open tab ▸
              </button>
            </div>
            <span className="summary-line">
              {sleepersCount === null
                ? 'open the tab to scan the whole chain'
                : `${sleepersCount} chain-wide leads across four bands`}
            </span>
            <span className="summary-line">not group calls — uncurated research</span>
          </div>
        </section>
      </div>
    </div>
  );
}
