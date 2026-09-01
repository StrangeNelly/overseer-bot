import { useEffect, useRef, useState } from 'react';
import type { BoardCard } from '@groupie/shared';
import { REVIVING_WINDOW_MS, gaugePosition, lpRatioPct, mcapAtRevival, moveOneHour, revivalDelta } from '../derive';
import {
  avatarHue,
  fmtAge,
  fmtHours,
  fmtMultiple,
  fmtRetrace,
  fmtSignedPct,
  fmtUsd,
  multipleTone,
  shortAddress,
} from '../format';
import { LinkPills } from './LinkPills';
import type { WatchControl } from './LinkPills';
import { Gauge, LpChip, MoveChip } from './Zone';
import { Odometer } from './Odometer';
import { Sparkline } from './Sparkline';

/**
 * The cards that get room to breathe: the top runner, the retraced story, and
 * the comeback spotlight. Shared by the desktop IN PLAY column and the mobile
 * tab bodies.
 *
 * Design pass 2 (3D) gave all three the same anatomy: identity row with a
 * P&L-coloured 1h-move chip, a hero-size call-story sparkline, a label row that
 * names the three numbers the trace is drawn against (called / peak / now), and
 * a persistent 20px links strip with WATCH pinned right. The card is rare, so
 * the 20px is earned.
 */

function label(card: BoardCard): string {
  return card.symbol ? `$${card.symbol}` : shortAddress(card.address);
}

function Disc({ card, size }: { card: BoardCard; size: number }) {
  const seed = card.symbol ?? card.address;
  const letter = (card.symbol ?? '?').trim().charAt(0).toUpperCase() || '?';
  if (card.imageUrl) {
    return (
      <img
        className="avatar"
        src={card.imageUrl}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      className="avatar avatar-fallback"
      style={{ width: size, height: size, background: `hsl(${avatarHue(seed)} 45% 28%)` }}
      aria-hidden="true"
    >
      {letter}
    </span>
  );
}

/** The spotlight cards' link strip: 20px of pills under a hairline, WATCH last. */
function CardLinks({ card, watch }: { card: BoardCard; watch?: WatchControl }) {
  return (
    <div className="card-links">
      <LinkPills target={card} watch={watch} />
    </div>
  );
}

/** "@caller · 9h · LP $210K" — the meta line every spotlight card carries. */
function meta(card: BoardCard, now: number): string {
  const parts = [card.callerName, fmtAge(card.calledAt, now)];
  if (card.liquidityUsd !== null) parts.push(`LP ${fmtUsd(card.liquidityUsd)}`);
  return parts.filter(Boolean).join(' · ');
}

/** The runners hero: the one card that breathes while its multiple climbs. */
export function RunnerHero({
  card,
  now,
  breathing,
  watch,
}: {
  card: BoardCard;
  now: number;
  breathing: boolean;
  watch?: WatchControl;
}) {
  const peakMultiple = fmtMultiple(card.peakMultiple);
  // Design law: the top runner breathes WHILE its multiple climbs — a card
  // bleeding from 5x to 3x pulsing green is the wrong signal, and an infinite
  // animation outside the noise budget.
  const [climbing, setClimbing] = useState(true);
  const prevMultiple = useRef(card.multiple);
  useEffect(() => {
    const prev = prevMultiple.current;
    prevMultiple.current = card.multiple;
    if (prev === null || card.multiple === null || prev === card.multiple) return;
    setClimbing(card.multiple > prev);
  }, [card.multiple]);

  return (
    <article
      className={`hero-card${breathing && climbing ? ' is-breathing' : ''}`}
      data-call={card.callId}
    >
      <div className="hero-top">
        <Disc card={card} size={28} />
        <span className="hero-sym">{label(card)}</span>
        <span className="hero-meta">{meta(card, now)}</span>
        <MoveChip pct={moveOneHour(card.sparkline)} />
        <span className="hero-mult">
          <Odometer value={fmtMultiple(card.multiple)} />
        </span>
      </div>
      <Sparkline
        points={card.sparkline}
        mcapAtCall={card.mcapAtCall}
        peak={card.peakMcapSinceCall}
        variant="hero"
        width={600}
        height={72}
        fill
      />
      <div className="spot-labels">
        <span>
          <span className="spot-base" aria-hidden="true">
            ┈
          </span>
          {` called ${fmtUsd(card.mcapAtCall)} `}
          <span className="spot-faint">(1x line)</span>
        </span>
        {card.peakMcapSinceCall === null ? null : (
          <span>
            <span className="spot-peak" aria-hidden="true">
              ●
            </span>
            {` peak ${fmtUsd(card.peakMcapSinceCall)}${peakMultiple === '—' ? '' : ` · ${peakMultiple}`}`}
          </span>
        )}
        <span className="spot-now">
          <Odometer value={fmtUsd(card.mcapUsd)} />
          <span className="spot-faint"> now</span>
        </span>
      </div>
      <CardLinks card={card} watch={watch} />
    </article>
  );
}

/** Retraced: the drawdown told twice — spark and gauge — and judged neither time. */
export function RetracedCard({
  card,
  now,
  watch,
}: {
  card: BoardCard;
  now: number;
  watch?: WatchControl;
}) {
  const peakMultiple = fmtMultiple(card.peakMultiple);
  return (
    <article className="story-card" data-call={card.callId}>
      <div className="hero-top">
        <Disc card={card} size={24} />
        <span className="story-sym">{label(card)}</span>
        <span className="hero-meta">{`${card.callerName} · ${fmtAge(card.calledAt, now)}`}</span>
        <span className="retrace-chip">{`${fmtRetrace(card.retraceFromPeakPct)} from peak`}</span>
        <LpChip liquidityUsd={card.liquidityUsd} ratioPct={lpRatioPct(card)} />
        {/* Retraced cards still print an honest multiple: green if it is still up. */}
        <span className={`story-mult mult-${multipleTone(card.multiple)}`}>
          <Odometer value={fmtMultiple(card.multiple)} />
        </span>
      </div>
      <Sparkline
        points={card.sparkline}
        mcapAtCall={card.mcapAtCall}
        peak={card.peakMcapSinceCall}
        variant="hero"
        width={600}
        height={56}
        drawdown
      />
      <Gauge position={gaugePosition(card)} />
      <div className="spot-labels spot-labels-spread">
        <span>{`called ${fmtUsd(card.mcapAtCall)}`}</span>
        <span className="spot-now">{`now ${fmtUsd(card.mcapUsd)} · ${fmtMultiple(card.multiple)}`}</span>
        <span>
          <span className="spot-peak" aria-hidden="true">
            ●
          </span>
          {` peak ${fmtUsd(card.peakMcapSinceCall)}${peakMultiple === '—' ? '' : ` · ${peakMultiple}`}`}
        </span>
      </div>
      <CardLinks card={card} watch={watch} />
    </article>
  );
}

/**
 * Reviving spotlight. Cyan is the state colour; the multiple from call stays
 * honest (and red) underneath it, and the card says when the spotlight ends —
 * the badge and this zone expire 24h after the revival.
 */
export function RevivingCard({
  card,
  now,
  featured,
  watch,
}: {
  card: BoardCard;
  now: number;
  featured: boolean;
  watch?: WatchControl;
}) {
  const delta = revivalDelta(card);
  const at = mcapAtRevival(card);
  const revivedAge = fmtAge(card.revivingAt, now);
  const endsIn =
    card.revivingAt === null
      ? null
      : (() => {
          const started = Date.parse(card.revivingAt);
          if (Number.isNaN(started)) return null;
          const left = started + REVIVING_WINDOW_MS - now;
          return left > 0 ? fmtHours(left / (60 * 60 * 1000)) : null;
        })();

  return (
    <article className={`revive-card${featured ? ' is-featured' : ''}`} data-call={card.callId}>
      <div className="hero-top">
        <Disc card={card} size={24} />
        <span className="story-sym">{label(card)}</span>
        <span className="badge badge-reviving">REVIVING</span>
        <span className="hero-meta">{meta(card, now)}</span>
        <span className="revive-delta">
          {delta === null ? '—' : fmtSignedPct(delta)}
          <span className="revive-delta-unit">since revival</span>
        </span>
      </div>
      <Sparkline
        points={card.sparkline}
        mcapAtCall={card.mcapAtCall}
        peak={card.peakMcapSinceCall}
        variant="hero"
        width={600}
        height={44}
        tone="cyan"
        revivedAt={card.revivingAt}
      />
      <div className="spot-labels">
        <span className="spot-now">
          <Odometer value={fmtUsd(card.mcapUsd)} />
          <span className="spot-faint"> now</span>
        </span>
        <span>
          <span className="spot-revival" aria-hidden="true">
            ○
          </span>
          {at === null
            ? ` revived ${revivedAge} ago`
            : ` revived ${revivedAge} ago at ${fmtUsd(at)}`}
        </span>
        <span className="spot-down">{`${fmtMultiple(card.multiple)} from call`}</span>
        {endsIn ? <span className="spot-ends">{`spotlight ends in ${endsIn}`}</span> : null}
      </div>
      <CardLinks card={card} watch={watch} />
    </article>
  );
}

/** Skeleton: ghost rows that shimmer exactly once while the first board lands. */
export function GhostRows({ count = 9 }: { count?: number }) {
  return (
    <div className="ghosts" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <div className="ghost-row" key={index}>
          <span className="ghost-disc" />
          <span className="ghost-id">
            <span className="ghost-bar ghost-bar-sym" />
            <span className="ghost-bar ghost-bar-sub" />
          </span>
          <span className="ghost-num">
            <span className="ghost-bar ghost-bar-mult" />
            <span className="ghost-bar ghost-bar-mcap" />
          </span>
        </div>
      ))}
    </div>
  );
}
