import type { RangeBoardResponse, RangeDurationHours } from '@groupie/shared';
import { RANGE_DURATION_HOURS, RANGE_PRESETS } from '@groupie/shared';
import { fmtUsd } from '../format';
import { TokenCard } from './TokenCard';

/** Custom inputs are typed in thousands: "150" means $150K. */
const K = 1_000;
/** Mirrors the server's floor (lo >= $1,000) and ceiling (hi <= $1B). */
const MIN_K = 1;
const MAX_K = 1_000_000;

export interface RangeBand {
  loUsd: number;
  hiUsd: number;
}

export interface RangeControls {
  /** Index into RANGE_PRESETS, or null while the custom band is in use. */
  presetIndex: number | null;
  /** Raw input text, in K. Kept as typed so a half-finished number is not lost. */
  customLoK: string;
  customHiK: string;
  hours: RangeDurationHours;
}

export const DEFAULT_CONTROLS: RangeControls = {
  presetIndex: 0,
  customLoK: '',
  customHiK: '',
  hours: 6,
};

function parseK(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < MIN_K || value > MAX_K) return null;
  return value * K;
}

/** The band to query, or null when the custom inputs do not describe one yet. */
export function resolveBand(controls: RangeControls): RangeBand | null {
  if (controls.presetIndex !== null) {
    const preset = RANGE_PRESETS[controls.presetIndex];
    return preset ? { loUsd: preset.loUsd, hiUsd: preset.hiUsd } : null;
  }
  const loUsd = parseK(controls.customLoK);
  const hiUsd = parseK(controls.customHiK);
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
            Custom
          </button>
        </div>

        {custom ? (
          <div className="range-custom">
            <label className="range-field">
              <span className="range-field-label">Low</span>
              <input
                className="range-input"
                type="number"
                inputMode="numeric"
                min={MIN_K}
                max={MAX_K}
                step={1}
                placeholder="50"
                aria-label="Band low, in thousands of dollars"
                value={controls.customLoK}
                onChange={(e) => onControls({ ...controls, customLoK: e.target.value })}
              />
              <span className="range-field-unit">K</span>
            </label>
            <span className="range-dash">–</span>
            <label className="range-field">
              <span className="range-field-label">High</span>
              <input
                className="range-input"
                type="number"
                inputMode="numeric"
                min={MIN_K}
                max={MAX_K}
                step={1}
                placeholder="100"
                aria-label="Band high, in thousands of dollars"
                value={controls.customHiK}
                onChange={(e) => onControls({ ...controls, customHiK: e.target.value })}
              />
              <span className="range-field-unit">K</span>
            </label>
          </div>
        ) : null}

        <div className="chips" role="group" aria-label="Minimum time in range">
          {RANGE_DURATION_HOURS.map((hours) => (
            <button
              key={hours}
              type="button"
              className={`chip${controls.hours === hours ? ' is-active' : ''}`}
              aria-pressed={controls.hours === hours}
              onClick={() => onControls({ ...controls, hours })}
            >
              {`${hours}h`}
            </button>
          ))}
        </div>
      </div>

      {custom && band === null ? (
        <p className="empty">Enter a low and a high in thousands, low below high.</p>
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
    <div className="cards">
      {data.cards.map((card) => (
        <TokenCard
          key={card.callId}
          card={card}
          section="ranging"
          now={now}
          range={card.range}
          band={{ loUsd: data.loUsd, hiUsd: data.hiUsd }}
        />
      ))}
    </div>
  );
}
