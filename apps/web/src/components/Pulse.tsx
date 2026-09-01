import type { PulseData } from '../derive';
import { fmtAge, fmtMultiple, fmtSignedPct } from '../format';
import { Odometer } from './Odometer';

interface PulseProps {
  data: PulseData;
  /** `hero` is the half-sheet block; `strip` is the one-line band. */
  variant: 'hero' | 'strip';
  /** A ceremony line — "SABLE is back", "MOMO crossed 10x". */
  announcement?: string | null;
  /** Only the Pulse numbers shimmer while a silent refetch is in flight. */
  revalidating?: boolean;
  /** Desktop only: the ranging one-liner, when that board has been loaded. */
  rangingNote?: string | null;
}

function asOf(ms: number | null): string | null {
  if (ms === null) return null;
  const iso = new Date(Date.now() - ms).toISOString();
  return `as of ${fmtAge(iso)} ago`;
}

/**
 * The Pulse band: today's story, derived entirely from the board payload.
 * Magenta is the brand/state colour here; green and red stay reserved for P&L.
 */
export function Pulse({ data, variant, announcement, revalidating, rangingNote }: PulseProps) {
  const age = asOf(data.asOfMs);
  const numbers = `pulse-numbers${revalidating ? ' is-revalidating' : ''}`;

  if (variant === 'hero') {
    return (
      <section className="pulse pulse-hero" aria-label="Pulse">
        <div className="pulse-head">
          <span className="pulse-tag">PULSE · TODAY</span>
          {age ? <span className="pulse-age">{age}</span> : null}
        </div>
        <div className={`${numbers} pulse-big`}>
          <span className="pulse-calls">
            <Odometer value={String(data.calls)} />
            <span className="pulse-unit">calls</span>
          </span>
          {data.best ? (
            <span className="pulse-best">
              {`${data.best.label} `}
              <Odometer value={fmtMultiple(data.best.multiple)} />
              <span className="pulse-unit">best</span>
            </span>
          ) : null}
        </div>
        <div className="pulse-line">
          <span className="pulse-died">
            <Odometer value={String(data.died)} /> died
          </span>
          <span className="pulse-reviving">
            <Odometer value={String(data.reviving)} /> reviving
            {data.bestReviving ? ` — ${data.bestReviving.label} ${fmtSignedPct(data.bestReviving.pct)}` : ''}
          </span>
          {announcement ? <span className="pulse-say">{announcement}</span> : null}
        </div>
      </section>
    );
  }

  return (
    <section className="pulse pulse-strip" aria-label="Pulse">
      <span className="pulse-tag">PULSE</span>
      <span className={numbers}>
        <span className="pulse-item">
          <Odometer value={String(data.calls)} /> calls today
        </span>
        {data.best ? (
          <>
            <span className="pulse-dot">·</span>
            <span className="pulse-item">
              best{' '}
              <span className="pulse-best">
                {`${data.best.label} `}
                <Odometer value={fmtMultiple(data.best.multiple)} />
              </span>
            </span>
          </>
        ) : null}
        <span className="pulse-dot">·</span>
        <span className="pulse-item">
          <Odometer value={String(data.died)} /> died
        </span>
        {data.reviving > 0 ? (
          <>
            <span className="pulse-dot">·</span>
            <span className="pulse-item pulse-reviving">
              {data.bestReviving
                ? `${data.bestReviving.label} reviving ${fmtSignedPct(data.bestReviving.pct)}`
                : `${data.reviving} reviving`}
            </span>
          </>
        ) : null}
        {rangingNote ? (
          <>
            <span className="pulse-dot">·</span>
            <span className="pulse-item pulse-muted">{rangingNote}</span>
          </>
        ) : null}
        {announcement ? (
          <>
            <span className="pulse-dot">·</span>
            <span className="pulse-say">{announcement}</span>
          </>
        ) : null}
      </span>
    </section>
  );
}
