import type { BoardCard } from '@groupie/shared';
import { revivalDelta } from '../derive';
import {
  avatarHue,
  fmtAge,
  fmtMultiple,
  fmtRetrace,
  fmtSignedPct,
  fmtUsd,
  multipleTone,
  shortAddress,
} from '../format';
import { LinkPills } from './LinkPills';
import type { WatchControl } from './LinkPills';
import { Odometer } from './Odometer';
import { Sparkline } from './Sparkline';

/**
 * The cards that get room to breathe: the top runner, the retraced story, and
 * the comeback spotlight. Shared by the desktop columns and the mobile tabs.
 *
 * Round 15: all three carry the full link row now. They shipped with three bare
 * text links (runner) or none at all (retraced, reviving) — so the cards a
 * member is most likely to act on were the ones they could not act from.
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

export function SectionHead({
  title,
  count,
  note,
  tone,
}: {
  title: string;
  count?: number | null;
  note?: string;
  tone?: 'cyan' | 'dim';
}) {
  return (
    <div className={`sect-head${tone ? ` sect-${tone}` : ''}`}>
      <span className="sect-title">
        {title}
        {count === undefined ? null : <span className="sect-count">{count === null ? '—' : count}</span>}
      </span>
      {note ? <span className="sect-note">{note}</span> : null}
    </div>
  );
}

/** The spotlight cards' link row: the same pills the list rows reveal. */
function CardLinks({ card, watch }: { card: BoardCard; watch?: WatchControl }) {
  return (
    <div className="card-links">
      <LinkPills card={card} watch={watch} />
    </div>
  );
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
  return (
    <article className={`hero-card${breathing ? ' is-breathing' : ''}`} data-call={card.callId}>
      <div className="hero-top">
        <Disc card={card} size={24} />
        <span className="hero-sym">{label(card)}</span>
        <span className="hero-meta">{`${card.callerName} · ${fmtAge(card.calledAt, now)}`}</span>
        <span className="hero-mult">
          <Odometer value={fmtMultiple(card.multiple)} />
        </span>
      </div>
      <Sparkline
        points={card.sparkline}
        mcapAtCall={card.mcapAtCall}
        peak={card.peakMcapSinceCall}
        variant="hero"
        width={400}
        height={52}
        fill
      />
      <div className="hero-foot">
        <span className="foot-now">
          <Odometer value={fmtUsd(card.mcapUsd)} />
          <span className="foot-unit">now</span>
        </span>
        <span>{`called ${fmtUsd(card.mcapAtCall)}`}</span>
        <span>{`peak ${fmtUsd(card.peakMcapSinceCall)}`}</span>
        {card.liquidityUsd !== null ? <span>{`LP ${fmtUsd(card.liquidityUsd)}`}</span> : null}
      </div>
      <CardLinks card={card} watch={watch} />
    </article>
  );
}

/** Retraced: the drawdown told honestly — data, never advice. */
export function RetracedCard({
  card,
  now,
  watch,
}: {
  card: BoardCard;
  now: number;
  watch?: WatchControl;
}) {
  return (
    <article className="story-card" data-call={card.callId}>
      <div className="hero-top">
        <Disc card={card} size={22} />
        <span className="story-sym">{label(card)}</span>
        <span className="hero-meta">{`${card.callerName} · ${fmtAge(card.calledAt, now)}`}</span>
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
        width={400}
        height={44}
        drawdown
      />
      <div className="hero-foot">
        <span className="foot-down">{`${fmtRetrace(card.retraceFromPeakPct)} from peak`}</span>
        <span>{`peaked ${fmtMultiple(card.peakMultiple)} · ${fmtUsd(card.peakMcapSinceCall)}`}</span>
        <span>{`now ${fmtUsd(card.mcapUsd)}`}</span>
      </div>
      <CardLinks card={card} watch={watch} />
    </article>
  );
}

/**
 * Reviving spotlight. Cyan is the state colour; the multiple from call stays
 * honest (and red) underneath it.
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
  return (
    <article className={`revive-card${featured ? ' is-featured' : ''}`} data-call={card.callId}>
      <div className="hero-top">
        <Disc card={card} size={22} />
        <span className="story-sym">{label(card)}</span>
        <span className="badge badge-reviving">REVIVING</span>
        <span className="revive-delta">{delta === null ? '—' : fmtSignedPct(delta)}</span>
      </div>
      {featured ? (
        <Sparkline
          points={card.sparkline}
          mcapAtCall={card.mcapAtCall}
          peak={card.peakMcapSinceCall}
          variant="hero"
          width={340}
          height={34}
          tone="cyan"
        />
      ) : null}
      <div className="hero-foot">
        <span>{`${fmtUsd(card.mcapUsd)} now`}</span>
        <span>{`revived ${fmtAge(card.revivingAt, now)} ago`}</span>
        <span className="foot-strong">{`${fmtMultiple(card.multiple)} from call`}</span>
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
