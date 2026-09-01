import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { BoardCard } from '@groupie/shared';
import { copyText } from '../clipboard';
import {
  RUNNER_MULTIPLE,
  isDied,
  isReviving,
  isStale,
  isUnresolved,
  revivalDelta,
  statusEdge,
} from '../derive';
import {
  avatarHue,
  fmtAge,
  fmtDeathReason,
  fmtMultiple,
  fmtRetrace,
  fmtSignedPct,
  fmtUsd,
  multipleTone,
  shortAddress,
} from '../format';
import { canFlash, requestMotion, useReducedMotion } from '../motion';
import type { Ceremony } from '../motion';
import { Odometer } from './Odometer';
import { Sparkline } from './Sparkline';
import type { SparkTone } from './Sparkline';
import type { SectionKey } from './SectionTabs';

/** Row heights from the handoff: half-sheet, mobile, desktop feed, top runner, died rail. */
export type RowSize = 'mini' | 'row' | 'desk' | 'hero' | 'rail';

/** How the link pills are reached on this surface. */
export type LinkMode = 'tap' | 'hover' | 'none';

/** How long each ceremony holds its class (design: Motion). */
const CEREMONY_MS: Record<Ceremony, number> = {
  death: 600,
  revival: 700,
  tenx: 900,
  new: 500,
};

const FLASH_MS = 400;
/** Reduced motion swaps the flash for a direction arrow, which needs longer to read. */
const ARROW_MS = 2_000;

interface TokenCardProps {
  card: BoardCard;
  /** Which list this row is being drawn in — decides badge wording and subline. */
  section: SectionKey;
  /** Shared clock so every age on the board ticks together. */
  now: number;
  size?: RowSize;
  links?: LinkMode;
  expanded?: boolean;
  onToggle?: (callId: number) => void;
  onBin?: (card: BoardCard) => void;
  binning?: boolean;
  /** The one state change this row should play, if any. */
  ceremony?: Ceremony;
  /** The single breathing glow on the board. */
  topRunner?: boolean;
  /** Half-sheet rows never animate (design: noise budget). */
  animate?: boolean;
}

function TokenAvatar({ card, unresolved }: { card: BoardCard; unresolved: boolean }) {
  const [broken, setBroken] = useState(false);
  const seed = card.symbol ?? card.address;
  const letter = (card.symbol ?? '?').trim().charAt(0).toUpperCase() || '?';

  if (card.imageUrl && !broken) {
    return (
      <img
        className="avatar"
        src={card.imageUrl}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
      />
    );
  }

  if (unresolved) {
    return (
      <span className="avatar avatar-unresolved" aria-hidden="true">
        ?
      </span>
    );
  }

  return (
    <span
      className={`avatar avatar-fallback${isDied(card) ? ' avatar-dead' : ''}`}
      style={isDied(card) ? undefined : { background: `hsl(${avatarHue(seed)} 45% 28%)` }}
      aria-hidden="true"
    >
      {letter}
    </span>
  );
}

function fullTime(iso: string | null): string | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return undefined;
  try {
    return new Date(t).toLocaleString();
  } catch {
    return undefined;
  }
}

interface Badge {
  text: string;
  kind: 'died' | 'reviving' | 'revived' | 'recall';
}

/** Design: ONE badge, highest priority only. DIED > REVIVING > REVIVED > xN. */
function badgeFor(card: BoardCard, section: SectionKey, now: number): Badge | null {
  if (isDied(card)) {
    const reason = fmtDeathReason(card.deathReason);
    // Inside the Died list the section already says "died"; elsewhere it must.
    const text = section === 'died' ? (reason ?? 'DIED') : reason ? `DIED · ${reason}` : 'DIED';
    return { text, kind: 'died' };
  }
  if (isReviving(card, now)) return { text: 'REVIVING', kind: 'reviving' };
  if (card.revived) return { text: 'REVIVED', kind: 'revived' };
  if (card.mentionsCount > 1) return { text: `×${card.mentionsCount}`, kind: 'recall' };
  return null;
}

export function TokenCard({
  card,
  section,
  now,
  size = 'row',
  links = 'none',
  expanded = false,
  onToggle,
  onBin,
  binning,
  ceremony,
  topRunner = false,
  animate = true,
}: TokenCardProps) {
  const reduced = useReducedMotion();
  const title = card.symbol ? `$${card.symbol}` : shortAddress(card.address);
  const died = isDied(card);
  const unresolved = isUnresolved(card);
  const reviving = isReviving(card, now);
  const stale = isStale(card, now);
  const edge = statusEdge(card, now);
  const tone = multipleTone(card.multiple);
  const badge = badgeFor(card, section, now);
  const runner = card.multiple !== null && card.multiple >= RUNNER_MULTIPLE;

  const [copied, setCopied] = useState(false);
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);
  const [playing, setPlaying] = useState<Ceremony | null>(null);
  const [climbing, setClimbing] = useState(true);
  const prevMcap = useRef(card.mcapUsd);
  const prevMultiple = useRef(card.multiple);

  // Row update flash: tint toward the P&L colour, throttled 1 per row per 10s.
  useEffect(() => {
    const prev = prevMcap.current;
    const next = card.mcapUsd;
    prevMcap.current = next;
    if (!animate || prev === null || next === null || prev === next) return;
    if (!canFlash(card.callId)) return;
    setFlash(next > prev ? 'up' : 'down');
    const id = window.setTimeout(() => setFlash(null), reduced ? ARROW_MS : FLASH_MS);
    return () => window.clearTimeout(id);
  }, [card.mcapUsd, card.callId, animate, reduced]);

  // Only the top runner breathes, and only while its multiple is climbing.
  useEffect(() => {
    const prev = prevMultiple.current;
    prevMultiple.current = card.multiple;
    if (prev === null || card.multiple === null || prev === card.multiple) return;
    setClimbing(card.multiple > prev);
  }, [card.multiple]);

  // Ceremony, inside the noise budget: overflow queues instead of piling up.
  useEffect(() => {
    if (!ceremony || !animate) return;
    let cancelled = false;
    let timer = 0;
    const ms = CEREMONY_MS[ceremony];
    requestMotion(() => {
      if (cancelled) return;
      setPlaying(ceremony);
      timer = window.setTimeout(() => setPlaying(null), ms);
    }, ms);
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [ceremony, animate]);

  const onCopy = useCallback(() => {
    void copyText(card.address).then((ok) => {
      if (!ok) return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_400);
    });
  }, [card.address]);

  const pills = (
    <>
      <a className="pill" href={card.links.axiom} target="_blank" rel="noopener">
        AXIOM
      </a>
      <a className="pill" href={card.links.gmgn} target="_blank" rel="noopener">
        GMGN
      </a>
      <a className="pill" href={card.links.dexscreener} target="_blank" rel="noopener">
        DEXS
      </a>
      <button type="button" className="pill pill-copy" onClick={onCopy}>
        {copied ? 'COPIED ✓' : 'COPY CA'}
      </button>
      {/* The project's X account, where we have one (docs/decisions.md round 9). */}
      {card.twitterUrl ? (
        <a className="pill" href={card.twitterUrl} target="_blank" rel="noopener">
          X
        </a>
      ) : null}
    </>
  );

  // ---- the died rail (desktop right column) is its own, flatter anatomy.
  if (size === 'rail') {
    return (
      <div className="rail-row" data-call={card.callId}>
        <span className="rail-sym">{title}</span>
        {badge ? <span className={`badge badge-${badge.kind}`}>{badge.text}</span> : null}
        <span className="rail-meta">
          {`${fmtUsd(card.mcapUsd)} at death · ${fmtAge(card.diedAt ?? card.calledAt, now)}`}
        </span>
        {onBin ? (
          <button type="button" className="bin-btn" disabled={binning} onClick={() => onBin(card)}>
            {binning ? 'binning' : 'bin'}
          </button>
        ) : null}
      </div>
    );
  }

  const sparkTone: SparkTone | undefined = died ? 'dead' : reviving ? 'cyan' : undefined;
  const showSpark = size !== 'mini' && !died && !unresolved;
  const revived = reviving ? revivalDelta(card) : null;

  const sub: ReactNode[] = [];
  if (card.callerName) sub.push(card.callerName);
  if (unresolved) {
    sub.push('awaiting first data');
  } else if (reviving) {
    sub.push(
      revived === null
        ? `revived ${fmtAge(card.revivingAt, now)} ago`
        : `${fmtSignedPct(revived)} since revival · ${fmtAge(card.revivingAt, now)}`,
    );
  } else if (died) {
    sub.push(`died ${fmtAge(card.diedAt ?? card.calledAt, now)} ago`);
  } else if (section === 'retraced') {
    sub.push(
      <span key="retrace" className="sub-retrace">
        {`${fmtRetrace(card.retraceFromPeakPct)} from peak ${fmtUsd(card.peakMcapSinceCall)}`}
      </span>,
    );
  } else if (section === 'runners') {
    sub.push(`peak ${fmtUsd(card.peakMcapSinceCall)}`);
  } else if (card.watched) {
    sub.push('on watchlist');
  } else if (size === 'desk' && card.liquidityUsd !== null) {
    sub.push(`LP ${fmtUsd(card.liquidityUsd)}`);
  }
  if (stale) {
    sub.push(
      <span key="stale" className="sub-stale" title={fullTime(card.dataAsOf)}>
        {`as of ${fmtAge(card.dataAsOf, now)} ago`}
      </span>,
    );
  }

  const rowClass = [
    'row',
    `row-${size}`,
    `edge-${edge}`,
    died ? 'is-died' : '',
    stale ? 'is-stale' : '',
    runner ? 'is-runner' : '',
    topRunner && climbing ? 'is-breathing' : '',
    expanded ? 'is-open' : '',
    flash && !reduced ? `is-flash-${flash}` : '',
    playing ? `is-${playing}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={rowClass} data-call={card.callId}>
      <div className="row-head">
        {links === 'tap' && onToggle ? (
          <button
            type="button"
            className="row-hit"
            aria-expanded={expanded}
            aria-label={`Trading links for ${title}`}
            onClick={() => onToggle(card.callId)}
          />
        ) : null}

        <TokenAvatar card={card} unresolved={unresolved} />

        <div className="row-id">
          <div className="row-name">
            <span className="sym">{title}</span>
            {badge ? (
              <span className={`badge badge-${badge.kind}${playing === 'death' ? ' badge-stamp' : ''}`}>
                {badge.text}
              </span>
            ) : null}
            {card.watched ? <span className="watch-dot" title="On the group watchlist" /> : null}
          </div>
          <div className="row-sub">
            {sub.map((part, index) => (
              <span key={index} className="sub-part">
                {index > 0 ? <span className="sub-sep">·</span> : null}
                {part}
              </span>
            ))}
          </div>
        </div>

        {showSpark ? (
          <span className="row-spark">
            <Sparkline
              points={card.sparkline}
              mcapAtCall={card.mcapAtCall}
              peak={card.peakMcapSinceCall}
              tone={sparkTone}
              drawdown={section === 'retraced'}
            />
          </span>
        ) : null}

        {links === 'hover' ? <span className="row-hoverlinks">{pills}</span> : null}

        <div className="row-num">
          {unresolved ? (
            <>
              <span className="mult mult-null">—</span>
              <span className="mcaps mcaps-null">indexing…</span>
            </>
          ) : died ? (
            <>
              <span className="mult mult-dead">{fmtMultiple(card.multiple)}</span>
              <span className="mcaps">{`${fmtUsd(card.mcapUsd)} at death`}</span>
            </>
          ) : (
            <>
              <span className={`mult mult-${tone}`}>
                <Odometer value={fmtMultiple(card.multiple)} />
                {reduced && flash ? (
                  <span className="row-arrow" aria-hidden="true">
                    {flash === 'up' ? '▲' : '▼'}
                  </span>
                ) : null}
              </span>
              <span className="mcaps">
                <Odometer value={fmtUsd(card.mcapUsd)} />
                <span className="mcaps-arrow">←</span>
                {fmtUsd(card.mcapAtCall)}
              </span>
            </>
          )}
        </div>

        {section === 'died' && onBin ? (
          <button type="button" className="bin-btn" disabled={binning} onClick={() => onBin(card)}>
            {binning ? 'binning' : 'bin'}
          </button>
        ) : (
          <span className="row-age" title={fullTime(card.calledAt)}>
            {fmtAge(card.calledAt, now)}
          </span>
        )}
      </div>

      {links === 'tap' && expanded ? <div className="row-pills">{pills}</div> : null}
    </div>
  );
}
