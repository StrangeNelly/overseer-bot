import { useEffect, useState } from 'react';
import type { RangeBoardResponse, RangeCard, RangeDurationHours } from '@groupie/shared';
import {
  RANGE_DURATION_HOURS,
  RANGE_PRESETS,
  fmtDurationHours,
  rangeHoursAllowed,
} from '@groupie/shared';
import type { DeadProps } from '../dead';
import { deadForCard } from '../dead';
import { bandPosition } from '../derive';
import {
  avatarHue,
  fmtAge,
  fmtExactUsd,
  fmtHours,
  fmtUsd,
  parseMoney,
  shortAddress,
} from '../format';
import type { WatchProps } from '../watch';
import { watchForCard } from '../watch';
import { LinkPills } from './LinkPills';
import { BandBar } from './Zone';

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

/**
 * Where a duration the current band cannot offer falls back to. The shortest
 * duration every band supports — never a longer one, which would silently
 * answer a different question than the one on screen.
 */
const FALLBACK_HOURS: RangeDurationHours = 3;

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

/**
 * Controls the current band can actually ask for. A persisted 30m against a
 * 500K–1M band is a real state (the band chip moved after the duration was
 * chosen, or the blob was hand-edited) and it would otherwise leave the first
 * fetch of the session asking the server for something it answers with a 400.
 */
export function sanitizeRangeControls(controls: RangeControls): RangeControls {
  const band = resolveBand(controls);
  if (band === null || rangeHoursAllowed(controls.hours, band.hiUsd)) return controls;
  return { ...controls, hours: FALLBACK_HOURS };
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
  /** Round 16: every coin the app shows carries watch/unwatch, this one too. */
  watch: WatchProps;
  /**
   * Round 21 amendment (e): these are the group's own live calls, so the member
   * verdict rides them here as well — a coiler that has stopped being a coin is
   * exactly the thing a member spots on this view.
   */
  dead?: DeadProps;
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
  watch,
  dead,
}: RangingProps) {
  const custom = controls.presetIndex === null;
  // One open link row at a time, exactly like the board's rows.
  const [openAddress, setOpenAddress] = useState<string | null>(null);
  // The band decides which durations exist (30m/1h are a small-cap instrument,
  // enforced server-side); a null band is mid-typing, so nothing is disabled yet.
  const allows = (hours: RangeDurationHours) => band === null || rangeHoursAllowed(hours, band.hiUsd);

  // Switching to a bigger band while a short duration is selected would leave
  // the chips describing a query the server refuses. Fall back rather than show
  // an error for a state the user did not choose.
  useEffect(() => {
    if (band !== null && !rangeHoursAllowed(controls.hours, band.hiUsd)) {
      onControls({ ...controls, hours: FALLBACK_HOURS });
    }
  }, [band, controls, onControls]);

  return (
    <>
      <div className="ctl-panel">
        <div className="ctl-row">
          <span className="ctl-label">BAND</span>
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
          <span className="ctl-note">custom: LOW / HIGH with a K/M suffix and a dollar echo</span>
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

        <div className="ctl-row">
          <span className="ctl-label">HELD FOR ≥</span>
          <div className="chips chips-hours" role="group" aria-label="Minimum time in range">
            {RANGE_DURATION_HOURS.map((hours) => {
              const enabled = allows(hours);
              return (
                <button
                  key={hours}
                  type="button"
                  className={`chip chip-hours${controls.hours === hours ? ' is-active' : ''}`}
                  aria-pressed={controls.hours === hours}
                  disabled={!enabled}
                  title={enabled ? undefined : 'Only for bands up to $500K'}
                  onClick={() => onControls({ ...controls, hours })}
                >
                  {fmtDurationHours(hours)}
                </button>
              );
            })}
          </div>
          <span className="ctl-note">30m and 1h are small-cap instruments — bands up to $500K</span>
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
          <RangeList
            data={data}
            loading={loading}
            now={now}
            watch={watch}
            dead={dead}
            openAddress={openAddress}
            onToggle={(address) => setOpenAddress((prev) => (prev === address ? null : address))}
          />
        </>
      )}
    </>
  );
}

function RangeList({
  data,
  loading,
  now,
  watch,
  dead,
  openAddress,
  onToggle,
}: {
  data: RangeBoardResponse | null;
  loading: boolean;
  now: number;
  watch: WatchProps;
  dead?: DeadProps;
  openAddress: string | null;
  onToggle: (address: string) => void;
}) {
  if (!data) return <p className="empty">{loading ? 'Looking for coilers…' : 'Nothing here yet.'}</p>;
  if (data.cards.length === 0) {
    // The response's own band, so the sentence always describes what was asked.
    return (
      <p className="empty">
        {`Nothing holding ${fmtUsd(data.loUsd)}–${fmtUsd(data.hiUsd)} for ${fmtDurationHours(data.minHours)}+ right now.`}
      </p>
    );
  }
  return (
    <div className="zone-grid range-grid">
      {data.cards.map((card) => (
        <RangeRow
          key={card.callId}
          card={card}
          loUsd={data.loUsd}
          hiUsd={data.hiUsd}
          now={now}
          watch={watch}
          dead={dead}
          expanded={openAddress === card.address}
          onToggle={onToggle}
        />
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

/** "Tue 09:12" — when the streak started, short enough for a 9px footnote. */
function sinceLabel(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  try {
    return new Date(t).toLocaleString(undefined, {
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

/**
 * One coiler (design pass 2, 3B): the queried band as a 10px dark track, the
 * range it actually held as a translucent cyan fill, and the live mcap as a
 * glowing tick. Time in band is this view's hero number — and the card carries
 * links now, which range cards never had: hover (desktop) or tap (mobile)
 * replaces the meta line with the pills, WATCH included.
 */
function RangeRow({
  card,
  loUsd,
  hiUsd,
  now,
  watch,
  dead,
  expanded,
  onToggle,
}: {
  card: RangeCard;
  loUsd: number;
  hiUsd: number;
  now: number;
  watch: WatchProps;
  dead?: DeadProps;
  expanded: boolean;
  onToggle: (address: string) => void;
}) {
  const title = card.symbol ? `$${card.symbol}` : shortAddress(card.address);
  const pct = (value: number) => (bandPosition(value, loUsd, hiUsd) ?? 0) * 100;
  const left = pct(card.range.observedLowUsd);
  const right = pct(card.range.observedHighUsd);
  const tick = bandPosition(card.mcapUsd, loUsd, hiUsd);
  const seed = card.symbol ?? card.address;

  const meta = [card.callerName, `${fmtUsd(card.mcapUsd)} now`];
  if (card.liquidityUsd !== null) meta.push(`LP ${fmtUsd(card.liquidityUsd)}`);

  return (
    <article className={`range-row${expanded ? ' is-open' : ''}`} data-call={card.callId}>
      <div className="range-top">
        <span
          className="avatar avatar-fallback"
          style={{ width: 22, height: 22, background: `hsl(${avatarHue(seed)} 45% 28%)` }}
          aria-hidden="true"
        >
          {(card.symbol ?? '?').trim().charAt(0).toUpperCase() || '?'}
        </span>
        <span className="range-sym">{title}</span>
        {card.watched ? <span className="watch-dot" title="On the group watchlist" /> : null}
        {card.mentionsCount > 1 ? (
          <span className="badge badge-recall">{`×${card.mentionsCount}`}</span>
        ) : null}

        {/* The reveal: pills take the meta line's place, so nothing reflows. */}
        <span className="range-meta">{meta.join(' · ')}</span>
        <span className="range-links">
          <LinkPills target={card} watch={watchForCard(card, watch)} dead={deadForCard(card, dead)} />
        </span>
        <button
          type="button"
          className="range-hit"
          aria-expanded={expanded}
          aria-label={`Trading links for ${title}`}
          onClick={() => onToggle(card.address)}
        />

        <span
          className="range-hero"
          title={`In range since ${fullTime(card.range.inRangeSince) ?? '—'} (${card.range.bucketCount} 5-minute buckets)`}
        >
          {fmtHours(card.range.inRangeHours)}
          <span className="range-hero-unit">in band</span>
        </span>
      </div>

      <BandBar lowPct={left} highPct={right} tickPct={tick === null ? null : tick * 100} size="hero" />

      <div className="band-labels">
        <span>{fmtUsd(loUsd)}</span>
        <span className="band-held-label">
          {`held ${fmtUsd(card.range.observedLowUsd)}–${fmtUsd(card.range.observedHighUsd)}`}
        </span>
        <span>{fmtUsd(hiUsd)}</span>
      </div>

      <span className="range-since">
        {`in band since ${sinceLabel(card.range.inRangeSince)} · ${card.range.bucketCount} five-minute buckets`}
      </span>
      {/* The band bar is the visual; screen readers still get the call's age. */}
      <span className="visually-hidden">{`Called by ${card.callerName}, ${fmtAge(card.calledAt, now)} ago`}</span>
    </article>
  );
}
