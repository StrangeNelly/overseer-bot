import type { ReactNode } from 'react';
import { fmtSignedPct, fmtUsd } from '../format';

/**
 * The zone — design pass 2's separation mechanism (3A).
 *
 * Every section is a bounded region: a lifted panel (#0F0819, one step above the
 * page), a 44px header band tinted in the section's own tone, a Space Grotesk
 * headline, the count in dim mono, and a right-aligned note. The eye lands on
 * the tint before it reads a word, which is the whole point — Round 2's board
 * was one continuous surface with labels on it.
 *
 * Tones are the palette law restated: FRESH neutral, RUNNERS green (a P&L fact:
 * >= 3x), RETRACED lavender (neutral BY law — a drawdown is not a verdict),
 * REVIVING and ON WATCH cyan (state/analysis), DIED dim, RANGING and SLEEPERS
 * cyan. Magenta stays the brand and is spent on IN PLAY and the Pulse.
 */
export type ZoneTone =
  | 'fresh'
  | 'runners'
  | 'retraced'
  | 'reviving'
  | 'watch'
  | 'died'
  | 'cyan';

interface ZoneProps {
  tone: ZoneTone;
  headline: string;
  /** null renders an em dash — "not loaded" is not zero. */
  count?: number | null;
  note?: ReactNode;
  /** Rendered right of the headline, inside the band (the slot counter). */
  headExtra?: ReactNode;
  children: ReactNode;
  /** Glow the panel: the reviving spotlight only. */
  glow?: boolean;
  className?: string;
}

export function Zone({
  tone,
  headline,
  count,
  note,
  headExtra,
  children,
  glow,
  className,
}: ZoneProps) {
  return (
    <section
      className={`zone zone-${tone}${glow ? ' is-glow' : ''}${className ? ` ${className}` : ''}`}
    >
      <div className="zone-band">
        <span className="zone-id">
          {tone === 'watch' ? <span className="zone-dot" aria-hidden="true" /> : null}
          <span className="zone-headline">{headline}</span>
          {count === undefined ? null : (
            <span className="zone-count">{count === null ? '—' : count}</span>
          )}
        </span>
        {headExtra ?? (note ? <span className="zone-note">{note}</span> : null)}
      </div>
      {children}
    </section>
  );
}

/**
 * The wayfinding header the Ranging and Sleepers views gained in pass 2
 * (3B/3C): a breadcrumb back to the board, a 30px display headline that says
 * where you are, the subline that frames what the view claims, and a
 * right-hand note or control. The owner's gripe was literal — "no wayfinding" —
 * and this is the answer, on desktop and mobile alike.
 */
export function ViewHeader({
  title,
  sub,
  right,
  onBack,
}: {
  title: string;
  sub: ReactNode;
  right?: ReactNode;
  /** Omitted on mobile, where the zone-chip strip is already the way back. */
  onBack?: () => void;
}) {
  return (
    <div className="view-head">
      <div className="view-id">
        {onBack ? (
          <button type="button" className="view-crumb" onClick={onBack}>
            ◂ board
          </button>
        ) : null}
        <div className="view-line">
          <h2 className="view-title">{title}</h2>
          <span className="view-sub">{sub}</span>
        </div>
      </div>
      {right ? <div className="view-right">{right}</div> : null}
    </div>
  );
}

/**
 * The 1h-move chip. P&L coloured because it IS a P&L number, and shown only on
 * IN PLAY cards and rows — a Fresh row keeps its sparkline alone (3D rules).
 * Absent, never zero, when the trace does not reach back an hour.
 */
export function MoveChip({ pct }: { pct: number | null }) {
  if (pct === null) return null;
  const tone = pct >= 0 ? 'up' : 'down';
  return <span className={`move-chip move-${tone}`}>{`${fmtSignedPct(pct)} 1h`}</span>;
}

/**
 * The mcap-position gauge on a retraced card (3D): a linear dollar scale from
 * the call price to the peak, green from call to now, red from now to peak, a
 * white now-tick, a magenta peak dot and a hollow call ring. The drawdown told
 * twice — spark and gauge — and judged neither time.
 */
export function Gauge({ position }: { position: number | null }) {
  if (position === null) return null;
  const pct = `${(position * 100).toFixed(1)}%`;
  return (
    <div className="gauge" aria-hidden="true">
      <span className="gauge-up" style={{ width: pct }} />
      <span className="gauge-down" style={{ left: pct }} />
      <span className="gauge-tick" style={{ left: pct }} />
      <span className="gauge-call" />
      <span className="gauge-peak" />
    </div>
  );
}

/**
 * A band bar. Ranging draws the range actually held as a cyan fill with the live
 * mcap as a glowing tick; Sleepers has no observed range, so it draws the tick
 * alone — the tick says where in the band the coin sits.
 */
export function BandBar({
  lowPct,
  highPct,
  tickPct,
  size = 'sm',
  className,
}: {
  /** 0-100 within the queried band, or null for a tick-only bar. */
  lowPct?: number | null;
  highPct?: number | null;
  tickPct: number | null;
  size?: 'hero' | 'sm';
  className?: string;
}) {
  const held =
    typeof lowPct === 'number' && typeof highPct === 'number' && highPct >= lowPct
      ? { left: `${lowPct}%`, right: `${100 - highPct}%` }
      : null;
  return (
    <div
      className={`bandbar bandbar-${size}${className ? ` ${className}` : ''}`}
      aria-hidden="true"
    >
      {held ? <span className="bandbar-held" style={held} /> : null}
      {tickPct === null ? null : (
        <span className="bandbar-tick" style={{ left: `${tickPct}%` }} />
      )}
    </div>
  );
}

/** `LP $140K · 47% of mcap` — printed, never judged (3A retraced). */
export function LpChip({
  liquidityUsd,
  ratioPct,
}: {
  liquidityUsd: number | null;
  ratioPct: number | null;
}) {
  if (liquidityUsd === null) return null;
  return (
    <span className="lp-chip">
      {ratioPct === null
        ? `LP ${fmtUsd(liquidityUsd)}`
        : `LP ${fmtUsd(liquidityUsd)} · ${Math.round(ratioPct)}% of mcap`}
    </span>
  );
}
