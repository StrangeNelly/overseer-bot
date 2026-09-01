import { useState } from 'react';
import type { BoardCard, RangeInfo } from '@groupie/shared';
import {
  ageMs,
  avatarHue,
  fmtAge,
  fmtHours,
  fmtMultiple,
  fmtRetrace,
  fmtUsd,
  multipleTone,
  shortAddress,
} from '../format';
import { Sparkline } from './Sparkline';
import type { SectionKey } from './SectionTabs';

/** Market numbers older than this get a visible "as of" hint. */
const STALE_AFTER_MS = 5 * 60 * 1000;
/** The comeback badge runs for 24h (docs/decisions.md round 6), same as the section. */
const REVIVING_WINDOW_MS = 24 * 60 * 60 * 1000;

interface TokenCardProps {
  card: BoardCard;
  section: SectionKey;
  /** Shared clock so every age on the board ticks together. */
  now: number;
  onBin?: (card: BoardCard) => void;
  binning?: boolean;
  /**
   * Ranging tab only: the token's in-band streak plus the band it was matched
   * against (RangeInfo carries the observed extremes, not the query). Both are
   * needed for the line, so it renders only when both arrive.
   */
  range?: RangeInfo;
  band?: { loUsd: number; hiUsd: number };
}

function TokenAvatar({ card }: { card: BoardCard }) {
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

  return (
    <span
      className="avatar avatar-fallback"
      style={{ background: `hsl(${avatarHue(seed)} 45% 28%)` }}
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

export function TokenCard({ card, section, now, onBin, binning, range, band }: TokenCardProps) {
  const title = card.symbol ? `$${card.symbol}` : shortAddress(card.address);
  const tone = multipleTone(card.multiple);
  const dataAge = ageMs(card.dataAsOf, now);
  const stale = dataAge !== null && dataAge > STALE_AFTER_MS;
  // The server never clears a stale reviving_at (a later hide does), so the
  // window lives on the read side — here and in classifySections.
  const revivingAge = ageMs(card.revivingAt, now);
  const reviving = revivingAge !== null && revivingAge < REVIVING_WINDOW_MS;

  return (
    <article className="card">
      <div className="card-head">
        <TokenAvatar card={card} />
        <div className="head-text">
          <div className="head-line">
            <span className="sym">{title}</span>
            {card.mentionsCount > 1 ? (
              <span className="badge badge-recall" title={`Called ${card.mentionsCount} times`}>
                {`×${card.mentionsCount}`}
              </span>
            ) : null}
            {card.revived ? <span className="badge badge-revived">REVIVED</span> : null}
            {reviving ? (
              <span className="badge badge-reviving" title={`Back from rug probation ${fullTime(card.revivingAt) ?? ''}`}>
                REVIVING
              </span>
            ) : null}
            {section === 'died' ? (
              <span className="badge badge-died">
                {card.deathReason ? `DIED ${card.deathReason}` : 'DIED'}
              </span>
            ) : null}
          </div>
          {card.name ? <div className="name">{card.name}</div> : null}
        </div>
        <span className="age" title={fullTime(card.calledAt)}>
          {fmtAge(card.calledAt, now)}
        </span>
      </div>

      <div className="card-headline">
        <div className="headline-main">
          <div className="headline-top">
            <span className={`mult mult-${tone}`}>{fmtMultiple(card.multiple)}</span>
            <span className="mcaps">
              {fmtUsd(card.mcapUsd)}
              <span className="mcaps-arrow">{'←'}</span>
              {fmtUsd(card.mcapAtCall)}
            </span>
          </div>
          {section === 'retraced' ? (
            <div className="retrace">
              {`${fmtRetrace(card.retraceFromPeakPct)} from peak ${fmtUsd(card.peakMcapSinceCall)}`}
            </div>
          ) : null}
        </div>
        <Sparkline points={card.sparkline} />
      </div>

      {range && band ? (
        <div className="range-line" title={`In range since ${fullTime(range.inRangeSince) ?? '—'} (${range.bucketCount} 5-minute buckets)`}>
          {`in ${fmtUsd(band.loUsd)}–${fmtUsd(band.hiUsd)} for ${fmtHours(range.inRangeHours)}`}
          <span className="range-sep">·</span>
          {`band ${fmtUsd(range.observedLowUsd)}–${fmtUsd(range.observedHighUsd)}`}
        </div>
      ) : null}

      <div className="card-meta">
        <span className="meta-caller">{card.callerName}</span>
        <span className="meta-item">LP {fmtUsd(card.liquidityUsd)}</span>
        <span className="meta-item">Vol {fmtUsd(card.vol24Usd)}</span>
        {stale ? (
          <span className="meta-stale" title={fullTime(card.dataAsOf)}>
            as of {fmtAge(card.dataAsOf, now)} ago
          </span>
        ) : null}
      </div>

      <div className="card-links">
        <a className="link-btn" href={card.links.axiom} target="_blank" rel="noopener">
          AXIOM
        </a>
        <a className="link-btn" href={card.links.gmgn} target="_blank" rel="noopener">
          GMGN
        </a>
        <a className="link-btn" href={card.links.dexscreener} target="_blank" rel="noopener">
          DEXS
        </a>
        {section === 'died' && onBin ? (
          <button
            type="button"
            className="bin-btn"
            disabled={binning}
            onClick={() => onBin(card)}
          >
            {binning ? 'Binning' : 'Bin'}
          </button>
        ) : null}
      </div>
    </article>
  );
}
