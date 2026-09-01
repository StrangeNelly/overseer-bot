import type { RangeBoardResponse, RangeCard, RangeDurationHours } from '@groupie/shared';
import { RANGE_DURATION_HOURS, RANGE_PRESETS } from '@groupie/shared';
import {
  avatarHue,
  fmtAge,
  fmtExactUsd,
  fmtHours,
  fmtUsd,
  parseMoney,
  shortAddress,
} from '../format';

/** Mirrors the server's floor (lo >= $1,000) and ceiling (hi <= $1B). */
const MIN_USD = 1_000;
const MAX_USD = 1_000_000_000;

export interface RangeBand {
  loUsd: number;
  hiUsd: number;
}

export interface RangeControls {
  /** Index into RANGE_PRESETS, or null while the custom band is in use. */
  presetIndex: number | null;
  /**
   * Raw input text, in DOLLARS with an optional K/M suffix (round 8 behaviour
   * change — the old bare-K reading is what the dollar echo exists to kill).
   * Kept as typed so a half-finished number is not lost.
   */
  customLo: string;
  customHi: string;
  hours: RangeDurationHours;
}

export const DEFAULT_CONTROLS: RangeControls = {
  presetIndex: 0,
  customLo: '',
  customHi: '',
  hours: 6,
};

function parseBound(raw: string): number | null {
  const value = parseMoney(raw);
  if (value === null || value < MIN_USD || value > MAX_USD) return null;
  return value;
}

/** The band to query, or null when the custom inputs do not describe one yet. */
export function resolveBand(controls: RangeControls): RangeBand | null {
  if (controls.presetIndex !== null) {
    const preset = RANGE_PRESETS[controls.presetIndex];
    return preset ? { loUsd: preset.loUsd, hiUsd: preset.hiUsd } : null;
  }
  const loUsd = parseBound(controls.customLo);
  const hiUsd = parseBound(controls.customHi);
  if (loUsd === null || hiUsd === null || loUsd >= hiUsd) return null;
  return { loUsd, hiUsd };
}

interface RangingProps {
  controls: RangeControls;
  onControls: (next: RangeControls) => void;
  /** Resolved from `controls`; null means the custom inputs are incomplete. */
  band: RangeBand | null;
  data: RangeBoardResponse | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  /** Shared clock, ticked once a minute by App. */
  now: number;
}

/**
 * The dollar echo under a custom input: what the field actually means, so
 * "150000" can never quietly become $150M.
 */
function Echo({ raw, other, isLow }: { raw: string; other: string; isLow: boolean }) {
  if (raw.trim() === '') return <span className="echo echo-idle">enter 50K, 1.5M or 50000</span>;
  const value = parseMoney(raw);
  if (value === null) return <span className="echo echo-bad">not a number</span>;
  if (value < MIN_USD || value > MAX_USD) {
    return <span className="echo echo-bad">{`${fmtExactUsd(value)} · out of range`}</span>;
  }
  const partner = parseMoney(other);
  const invalid =
    partner !== null && (isLow ? value >= partner : value <= partner) && partner >= MIN_USD;
  return (
    <span className={invalid ? 'echo echo-bad' : 'echo'}>
      {`= ${fmtExactUsd(value)}${invalid ? ' · low must sit below high' : ''}`}
    </span>
  );
}

export function Ranging({
  controls,
  onControls,
  band,
  data,
  loading,
  error,
  onRetry,
  now,
}: RangingProps) {
  const custom = controls.presetIndex === null;

  return (
    <>
      <div className="range-controls">
        <div className="chips" role="group" aria-label="Market cap band">
          {RANGE_PRESETS.map((preset, index) => (
            <button
              key={preset.label}
              type="button"
              className={`chip${controls.presetIndex === index ? ' is-active' : ''}`}
              aria-pressed={controls.presetIndex === index}
              onClick={() => onControls({ ...controls, presetIndex: index })}
            >
              {preset.label}
            </button>
          ))}
          <button
            type="button"
            className={`chip${custom ? ' is-active' : ''}`}
            aria-pressed={custom}
            onClick={() => onControls({ ...controls, presetIndex: null })}
          >
            CUSTOM
          </button>
        </div>

        {custom ? (
          <div className="range-custom">
            <div className="range-field-wrap">
              <label className="range-field">
                <span className="range-field-label">LOW</span>
                <input
                  className="range-input"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="50K"
                  aria-label="Band low, in dollars — K and M suffixes accepted"
                  value={controls.customLo}
                  onChange={(e) => onControls({ ...controls, customLo: e.target.value })}
                />
              </label>
              <Echo raw={controls.customLo} other={controls.customHi} isLow />
            </div>
            <span className="range-dash">–</span>
            <div className="range-field-wrap">
              <label className="range-field">
                <span className="range-field-label">HIGH</span>
                <input
                  className="range-input"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="150K"
                  aria-label="Band high, in dollars — K and M suffixes accepted"
                  value={controls.customHi}
                  onChange={(e) => onControls({ ...controls, customHi: e.target.value })}
                />
              </label>
              <Echo raw={controls.customHi} other={controls.customLo} isLow={false} />
            </div>
          </div>
        ) : null}

        <div className="chips chips-hours" role="group" aria-label="Minimum time in range">
          <span className="chips-label">HELD FOR ≥</span>
          {RANGE_DURATION_HOURS.map((hours) => (
            <button
              key={hours}
              type="button"
              className={`chip chip-hours${controls.hours === hours ? ' is-active' : ''}`}
              aria-pressed={controls.hours === hours}
              onClick={() => onControls({ ...controls, hours })}
            >
              {`${hours}h`}
            </button>
          ))}
        </div>
      </div>

      {custom && band === null ? (
        <p className="empty">Enter a low and a high — 50K, 1.5M or 50000 — with low below high.</p>
      ) : error && !data ? (
        <div className="screen">
          <h2 className="screen-title">Could not load ranging</h2>
          <p className="screen-message">{error}</p>
          <button type="button" className="retry-btn" onClick={onRetry}>
            Try again
          </button>
        </div>
      ) : (
        <>
          {error && data ? (
            <p className="banner banner-warn" role="status">
              Could not refresh: {error}{' '}
              <button type="button" className="banner-btn" onClick={onRetry}>
                Retry
              </button>
            </p>
          ) : null}
          <RangeList data={data} loading={loading} now={now} />
        </>
      )}
    </>
  );
}

function RangeList({
  data,
  loading,
  now,
}: {
  data: RangeBoardResponse | null;
  loading: boolean;
  now: number;
}) {
  if (!data) return <p className="empty">{loading ? 'Looking for coilers…' : 'Nothing here yet.'}</p>;
  if (data.cards.length === 0) {
    // The response's own band, so the sentence always describes what was asked.
    return (
      <p className="empty">
        {`Nothing holding ${fmtUsd(data.loUsd)}–${fmtUsd(data.hiUsd)} for ${data.minHours}h+ right now.`}
      </p>
    );
  }
  return (
    <div className="range-list">
      {data.cards.map((card) => (
        <RangeRow key={card.callId} card={card} loUsd={data.loUsd} hiUsd={data.hiUsd} now={now} />
      ))}
    </div>
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

/**
 * One coiler: the queried band as a dark track, the range it actually held as a
 * translucent cyan fill, and the live mcap as a glowing tick. Time in band is
 * this tab's hero number.
 */
function RangeRow({
  card,
  loUsd,
  hiUsd,
  now,
}: {
  card: RangeCard;
  loUsd: number;
  hiUsd: number;
  now: number;
}) {
  const title = card.symbol ? `$${card.symbol}` : shortAddress(card.address);
  const span = hiUsd - loUsd;
  const pct = (value: number) =>
    span <= 0 ? 0 : Math.min(100, Math.max(0, ((value - loUsd) / span) * 100));
  const left = pct(card.range.observedLowUsd);
  const right = pct(card.range.observedHighUsd);
  const tick = card.mcapUsd === null ? null : pct(card.mcapUsd);
  const seed = card.symbol ?? card.address;

  return (
    <article className="range-row" data-call={card.callId}>
      <div className="range-top">
        <span
          className="avatar avatar-fallback"
          style={{ width: 20, height: 20, background: `hsl(${avatarHue(seed)} 45% 28%)` }}
          aria-hidden="true"
        >
          {(card.symbol ?? '?').trim().charAt(0).toUpperCase() || '?'}
        </span>
        <span className="range-sym">{title}</span>
        {card.mentionsCount > 1 ? (
          <span className="badge badge-recall">{`×${card.mentionsCount}`}</span>
        ) : null}
        <span className="range-meta">{`${card.callerName} · ${fmtUsd(card.mcapUsd)} now`}</span>
        <span
          className="range-hero"
          title={`In range since ${fullTime(card.range.inRangeSince) ?? '—'} (${card.range.bucketCount} 5-minute buckets)`}
        >
          {fmtHours(card.range.inRangeHours)}
          <span className="range-hero-unit">in band</span>
        </span>
      </div>

      <div className="band">
        <span
          className="band-held"
          style={{ left: `${left}%`, right: `${100 - right}%` }}
          aria-hidden="true"
        />
        {tick === null ? null : (
          <span className="band-tick" style={{ left: `${tick}%` }} aria-hidden="true" />
        )}
      </div>

      <div className="band-labels">
        <span>{fmtUsd(loUsd)}</span>
        <span className="band-held-label">
          {`held ${fmtUsd(card.range.observedLowUsd)}–${fmtUsd(card.range.observedHighUsd)}`}
        </span>
        <span>{fmtUsd(hiUsd)}</span>
      </div>
      {/* The band bar is the visual; screen readers still get the call's age. */}
      <span className="visually-hidden">{`Called by ${card.callerName}, ${fmtAge(card.calledAt, now)} ago`}</span>
    </article>
  );
}
