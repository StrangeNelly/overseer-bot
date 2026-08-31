import { useState } from 'react';
import type { BoardCard } from '@groupie/shared';
import {
  ageMs,
  avatarHue,
  fmtAge,
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

interface TokenCardProps {
  card: BoardCard;
  section: SectionKey;
  /** Shared clock so every age on the board ticks together. */
  now: number;
  onBin?: (card: BoardCard) => void;
  binning?: boolean;
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

export function TokenCard({ card, section, now, onBin, binning }: TokenCardProps) {
  const title = card.symbol ? `$${card.symbol}` : shortAddress(card.address);
  const tone = multipleTone(card.multiple);
  const dataAge = ageMs(card.dataAsOf, now);
  const stale = dataAge !== null && dataAge > STALE_AFTER_MS;

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
