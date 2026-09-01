import { useCallback, useEffect, useState } from 'react';
import type {
  SleeperBand,
  SleeperDurationHours,
  SleeperEntry,
  SleepersResponse,
} from '@groupie/shared';
import {
  SLEEPER_BANDS,
  SLEEPER_DURATION_LABELS,
  SLEEPER_DURATIONS_HOURS,
  SLEEPERS,
} from '@groupie/shared';
import { bandPosition } from '../derive';
import { avatarHue, fmtAge, fmtHours, fmtTurnover, fmtUsd, shortAddress } from '../format';
import { hoverCapable } from '../motion';
import type { WatchProps } from '../watch';
import { targetFromSleeper, watchFor } from '../watch';
import { LinkPills } from './LinkPills';
import { BandBar } from './Zone';

/**
 * Sleepers (docs/decisions.md rounds 9, 14 and 16) — the first UNCURATED
 * surface in the app. Everything here is a chain-wide research lead, not
 * something the group called, and the view is written to say so before it says
 * anything else (the trust frame now rides the view headline, where it cannot
 * scroll away behind a filter).
 *
 * No sparkline (there is no history behind an entry) and no multiple (there is
 * no call to be a multiple of): turnover is the hero number, in cyan — the
 * analytical accent, the same one Ranging uses. Magenta stays the brand and
 * green/red stay P&L.
 *
 * Round 16 overrides the handoff on one point: these rows DO carry WATCH. A
 * sleeper is not a call, so it is watched BY ADDRESS — the exact semantics of
 * `/overseer watch <ca>`, which has always accepted a coin nobody has posted.
 */

interface SleepersProps {
  data: SleepersResponse | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  /** Twitter-required is the default view; the chip lives in the view header. */
  xOnly: boolean;
  /** Minimum continuous time in band — the round-14 duration filter. */
  minHours: SleeperDurationHours;
  onMinHours: (next: SleeperDurationHours) => void;
  /** Shared clock, ticked once a minute by App. */
  now: number;
  watch: WatchProps;
}

function bandLabel(band: SleeperBand): string {
  return `${fmtUsd(band.loUsd)}–${fmtUsd(band.hiUsd)}`;
}

function isLongOnly(band: SleeperBand): boolean {
  return SLEEPER_BANDS.some((spec) => spec.loUsd === band.loUsd && spec.longOnly);
}

function title(entry: SleeperEntry): string {
  return entry.symbol ? `$${entry.symbol}` : shortAddress(entry.address);
}

export function Sleepers({
  data,
  loading,
  error,
  onRetry,
  xOnly,
  minHours,
  onMinHours,
  now,
  watch,
}: SleepersProps) {
  // One open link row at a time, exactly like the board's rows.
  const [openAddress, setOpenAddress] = useState<string | null>(null);
  useEffect(() => setOpenAddress(null), [xOnly, minHours]);

  const toggle = useCallback(
    (address: string) => setOpenAddress((prev) => (prev === address ? null : address)),
    [],
  );

  const total = data ? data.bands.reduce((sum, band) => sum + band.entries.length, 0) : null;

  return (
    <>
      {/*
        The duration filter (round 14). Cyan when active, exactly like Ranging's
        "HELD FOR ≥" chips — same question, asked of the whole chain instead of
        the group's own calls.
      */}
      <div className="ctl-panel">
        <div className="ctl-row">
          <span className="ctl-label">IN BAND ≥</span>
          <div className="chips chips-hours" role="group" aria-label="Minimum time in band">
            {SLEEPER_DURATIONS_HOURS.map((hours) => (
              <button
                key={hours}
                type="button"
                className={`chip chip-hours${minHours === hours ? ' is-active' : ''}`}
                aria-pressed={minHours === hours}
                onClick={() => onMinHours(hours)}
              >
                {SLEEPER_DURATION_LABELS[hours]}
              </button>
            ))}
          </div>
          <span className="ctl-note">
            {total === null
              ? '$1M–$3M appears from 2w up — at 3h a $2M coin is just a big coin'
              : `${total} leads across ${data?.bands.length ?? 0} bands · $1M–$3M appears from 2w up`}
          </span>
        </div>
      </div>

      {error && !data ? (
        <div className="screen">
          <h2 className="screen-title">Could not load sleepers</h2>
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
          <SleeperBody
            data={data}
            loading={loading}
            total={total}
            xOnly={xOnly}
            minHours={minHours}
            now={now}
            watch={watch}
            openAddress={openAddress}
            onToggle={toggle}
          />
        </>
      )}
    </>
  );
}

function SleeperBody({
  data,
  loading,
  total,
  xOnly,
  minHours,
  now,
  watch,
  openAddress,
  onToggle,
}: {
  data: SleepersResponse | null;
  loading: boolean;
  total: number | null;
  xOnly: boolean;
  minHours: SleeperDurationHours;
  now: number;
  watch: WatchProps;
  openAddress: string | null;
  onToggle: (address: string) => void;
}) {
  if (!data) {
    return <p className="empty">{loading ? 'Scanning the chain…' : 'Nothing here yet.'}</p>;
  }

  // Nothing anywhere: either the first scan has not run, or the chain simply
  // has nothing quiet enough to be interesting right now. Say which.
  if (total === 0 && data.refreshedAt === null) {
    return (
      <p className="empty">
        The first chain-wide scan has not run yet. It sweeps every {SLEEPERS.scanIntervalHours} hours
        — check back shortly.
      </p>
    );
  }
  if (total === 0) {
    // Two independent reasons to be empty, and the duration is the one the
    // reader just changed — name it first so the fix is obvious.
    const held = `held its band for ${SLEEPER_DURATION_LABELS[minHours]}+`;
    return (
      <p className="empty">
        {xOnly
          ? `Nothing with an X account ${held} this scan. Try a shorter duration, or showing all.`
          : `Nothing on the chain ${held} this scan. Try a shorter duration.`}
      </p>
    );
  }

  return (
    <>
      {/* Keyed on the filters so a chip change remounts the grid: that is what
          plays the 200ms cross-fade, and it is the only motion this surface has. */}
      <div className="zone-grid slp-grid" key={`${minHours}-${xOnly ? 'x' : 'all'}`}>
        {data.bands.map((band, index) => (
          <section
            className={`zone zone-cyan zone-slp${isLongOnly(band) ? ' is-glow' : ''}`}
            key={band.loUsd}
          >
            <div className="zone-band">
              <span className="zone-id">
                <span className="zone-headline zone-headline-band">{bandLabel(band)}</span>
                <span className="zone-count">{band.entries.length}</span>
              </span>
              {isLongOnly(band) ? (
                <span className="zone-note">long holds only · unlocked at 2w+</span>
              ) : index === 0 ? (
                <span className="zone-note">ranked by turnover (24h vol ÷ mcap)</span>
              ) : null}
            </div>
            {band.entries.length === 0 ? (
              <p className="slp-band-empty">nothing qualifying in this band right now.</p>
            ) : (
              <div className="slp-rows">
                {band.entries.map((entry) => (
                  <SleeperRow
                    key={entry.address}
                    entry={entry}
                    loUsd={band.loUsd}
                    hiUsd={band.hiUsd}
                    now={now}
                    watch={watch}
                    expanded={openAddress === entry.address}
                    onToggle={onToggle}
                  />
                ))}
              </div>
            )}
          </section>
        ))}
      </div>
      <p className="footnote slp-footnote">
        ranked by turnover (24h volume ÷ market cap) · liquidity ≥ {fmtUsd(SLEEPERS.minLiquidityUsd)}{' '}
        and ≥ {Math.round(SLEEPERS.liqToMcapMinRatio * 100)}% of market cap · pool age{' '}
        {SLEEPERS.minPoolAgeHours}h–{SLEEPERS.maxPoolAgeDays}d · time in band from hourly/daily
        candles · nothing here is tracked
      </p>
    </>
  );
}

function Disc({ entry }: { entry: SleeperEntry }) {
  const [broken, setBroken] = useState(false);
  const seed = entry.symbol ?? entry.address;
  const letter = (entry.symbol ?? '?').trim().charAt(0).toUpperCase() || '?';

  if (entry.imageUrl && !broken) {
    return (
      <img
        className="avatar"
        src={entry.imageUrl}
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

/**
 * One lead. Same row anatomy as the board — disc, identity, shape, hero, age —
 * with the X link promoted onto the head line rather than buried in the tap
 * reveal: this surface defaults to coins that have one, and it is the fastest
 * way to research a name nobody in the group has mentioned.
 *
 * The shape slot carries a band bar with a tick and no fill: a sleeper has no
 * observed range, so the tick says only where in the band the coin sits.
 */
function SleeperRow({
  entry,
  loUsd,
  hiUsd,
  now,
  watch,
  expanded,
  onToggle,
}: {
  entry: SleeperEntry;
  loUsd: number;
  hiUsd: number;
  now: number;
  watch: WatchProps;
  expanded: boolean;
  onToggle: (address: string) => void;
}) {
  const label = title(entry);
  const persistent = entry.onListSinceHours >= SLEEPERS.persistenceMarkerHours;
  // Measured off candles, so it reaches back before we ever saw the coin — and
  // it is capped, which the "+" says out loud rather than pretending precision.
  const capped = entry.inBandHours >= SLEEPERS.inBandMaxDays * 24;
  const inBand = entry.inBandHours > 0 ? `${fmtHours(entry.inBandHours)}${capped ? '+' : ''}` : null;
  const tick = bandPosition(entry.mcapUsd, loUsd, hiUsd);
  const control = watchFor(targetFromSleeper(entry), watch);

  return (
    <div className={`row row-slp row-desk${expanded ? ' is-open' : ''}`}>
      <div className="row-head">
        <button
          type="button"
          className="row-hit"
          aria-expanded={expanded}
          aria-label={`Trading links for ${label}`}
          // Hover already reveals the strip on a mouse; the tap row below is
          // for pointers that cannot hover, and opening both doubled the links.
          onClick={() => {
            if (hoverCapable()) return;
            onToggle(entry.address);
          }}
        />

        <Disc entry={entry} />

        <div className="row-id">
          <div className="row-name">
            <span className="sym">{label}</span>
            {entry.twitterUrl ? (
              <a
                className="pill pill-x"
                href={entry.twitterUrl}
                target="_blank"
                rel="noopener"
                aria-label={`${label} on X`}
              >
                X
              </a>
            ) : null}
            {/*
              Two different clocks, side by side on purpose. "in band" is the
              coin's own history, read off candles that predate us; "on list" is
              how long WE have been showing it. The first is the lead, the
              second is our honesty about it.
            */}
            {inBand ? <span className="badge badge-inband">{`in band ${inBand}`}</span> : null}
            {/* Persistence, not rotation (round 9): still qualifying is still interesting. */}
            {persistent ? (
              <span className="badge badge-onlist">
                {`on list ${fmtHours(entry.onListSinceHours)}`}
              </span>
            ) : null}
            {entry.watched ? <span className="watch-dot" title="On the group watchlist" /> : null}
          </div>
          <div className="row-sub">
            {`${fmtUsd(entry.mcapUsd)} · vol ${fmtUsd(entry.vol24Usd)}`}
          </div>
        </div>

        <BandBar tickPct={tick === null ? null : tick * 100} className="slp-bar" />

        <span className="row-hoverlinks">
          <LinkPills target={entry} watch={control} />
        </span>

        <div className="row-num row-num-slp">
          <span className="slp-turn">{fmtTurnover(entry.turnover)}</span>
          <span className="mcaps">{`LP ${fmtUsd(entry.liquidityUsd)}`}</span>
        </div>

        <span className="row-age">{fmtAge(entry.poolCreatedAt, now)}</span>
      </div>

      {expanded ? (
        <div className="row-pills">
          <LinkPills target={entry} watch={control} />
        </div>
      ) : null}
    </div>
  );
}
