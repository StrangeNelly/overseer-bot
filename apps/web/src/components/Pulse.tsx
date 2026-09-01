import { useEffect, useRef, useState } from 'react';
import type { OutcomeCounts, PulseData } from '../derive';
import { fmtAge, fmtMultiple, fmtSignedPct } from '../format';
import { Odometer } from './Odometer';

/** The segments, in the order the bar draws them. */
const OUTCOME_KEYS = ['runners', 'active', 'reviving', 'died'] as const;
/**
 * "The segment that grew flashes once" — the same 400ms the widths ease over.
 * Exported because the Sleepers rail strip follows the identical rule.
 */
export const GREW_MS = 400;
export const NOTHING_GREW: ReadonlySet<string> = new Set<string>();

interface PulseProps {
  data: PulseData;
  /** `hero` is the half-sheet block; `strip` is the one-line band. */
  variant: 'hero' | 'strip';
  /** A ceremony line — "SABLE is back", "NARCO +41% in 1h — on watch". */
  announcement?: string | null;
  /** Only the Pulse numbers shimmer while a silent refetch is in flight. */
  revalidating?: boolean;
  /** Desktop only: the ranging one-liner, when that board has been loaded. */
  rangingNote?: string | null;
  /**
   * Mobile: one text line plus the strip line, and a ceremony REPLACES the text
   * line while it holds. Desktop has the width to keep both.
   */
  dense?: boolean;
}

function asOf(ms: number | null): string | null {
  if (ms === null) return null;
  const iso = new Date(Date.now() - ms).toISOString();
  return `as of ${fmtAge(iso)} ago`;
}

/**
 * The day-outcome strip (design pass 2): today's calls drawn as a ratio —
 * runners / still active / reviving / died. Widths are proportional to the
 * counts and a zero segment is omitted entirely, so the bar never carries a
 * sliver that means nothing.
 *
 * Green and red stay P&L: runners are green because ">= 3x" is a P&L fact,
 * died is the dim badge border rather than red, and reviving is cyan (state).
 */
function OutcomeStrip({ outcome, height }: { outcome: OutcomeCounts; height: 5 | 6 }) {
  // ...and the segment that GREW flashes once, so a shape change that happens
  // while you are reading something else still says which way the day moved.
  const [grew, setGrew] = useState<ReadonlySet<string>>(NOTHING_GREW);
  const previous = useRef(outcome);

  useEffect(() => {
    const before = previous.current;
    previous.current = outcome;
    const next = new Set<string>();
    for (const key of OUTCOME_KEYS) if (outcome[key] > before[key]) next.add(key);
    if (next.size === 0) return;
    setGrew(next);
    const id = window.setTimeout(() => setGrew(NOTHING_GREW), GREW_MS);
    return () => window.clearTimeout(id);
  }, [outcome]);

  const segments = OUTCOME_KEYS.map((key) => ({ key, count: outcome[key] })).filter(
    (segment) => segment.count > 0,
  );
  if (segments.length === 0) return null;
  return (
    <div className={`out-strip out-strip-${height}`} aria-hidden="true">
      {segments.map((segment) => (
        <span
          key={segment.key}
          className={`out-seg out-${segment.key}${grew.has(segment.key) ? ' is-grew' : ''}`}
          style={{ flex: segment.count }}
        />
      ))}
    </div>
  );
}

function OutcomeLegend({
  data,
  reviving,
}: {
  data: PulseData;
  /** The hero names the strongest comeback; the strip just counts. */
  reviving: 'named' | 'count';
}) {
  const { outcome } = data;
  const revivingText =
    reviving === 'named' && data.bestReviving
      ? `${data.bestReviving.label} reviving ${fmtSignedPct(data.bestReviving.pct)}`
      : `${outcome.reviving} reviving`;
  return (
    <div className="out-legend">
      {outcome.runners > 0 ? (
        <span className="out-leg out-leg-runners">
          <b>{outcome.runners}</b>
          <span className="out-leg-word"> runners</span>
        </span>
      ) : null}
      {outcome.active > 0 ? (
        <span className="out-leg out-leg-active">
          <b>{outcome.active}</b>
          <span className="out-leg-word"> active</span>
        </span>
      ) : null}
      {outcome.reviving > 0 ? (
        <span className="out-leg out-leg-reviving">
          {reviving === 'named' && data.bestReviving ? (
            revivingText
          ) : (
            <>
              <b>{outcome.reviving}</b>
              <span className="out-leg-word"> reviving</span>
            </>
          )}
        </span>
      ) : null}
      {outcome.died > 0 ? (
        <span className="out-leg out-leg-died">
          <b>{outcome.died}</b>
          <span className="out-leg-word"> died</span>
        </span>
      ) : null}
    </div>
  );
}

/**
 * The Pulse band: today's story, derived entirely from the board payload.
 * Magenta is the brand/state colour here; green and red stay reserved for P&L.
 */
export function Pulse({
  data,
  variant,
  announcement,
  revalidating,
  rangingNote,
  dense,
}: PulseProps) {
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
        <OutcomeStrip outcome={data.outcome} height={6} />
        {announcement ? (
          <div className="pulse-line">
            <span className="pulse-say">{announcement}</span>
          </div>
        ) : (
          <OutcomeLegend data={data} reviving="named" />
        )}
      </section>
    );
  }

  // A ceremony owns the text line on mobile for as long as it holds — one line
  // of width means the announcement has to displace something.
  const sayOnly = Boolean(dense && announcement);

  return (
    <section className="pulse pulse-strip" aria-label="Pulse">
      <div className="pulse-row">
        <span className="pulse-tag">PULSE</span>
        {sayOnly ? (
          <span className="pulse-say">{announcement}</span>
        ) : (
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
            {/* 3G: the ceremony takes the ranging note's slot and rolls back to
                it when it lapses — the strip gains a line, never a column. */}
            {announcement ? (
              <>
                <span className="pulse-dot">·</span>
                <span className="pulse-say">{announcement}</span>
              </>
            ) : rangingNote ? (
              <>
                <span className="pulse-dot">·</span>
                <span className="pulse-item pulse-muted">{rangingNote}</span>
              </>
            ) : null}
          </span>
        )}
      </div>

      <div className="pulse-day">
        <span className="pulse-day-tag">{`TODAY'S ${data.calls}`}</span>
        <OutcomeStrip outcome={data.outcome} height={dense ? 5 : 6} />
        <OutcomeLegend data={data} reviving="count" />
      </div>
    </section>
  );
}
