import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  SleeperBand,
  SleeperDurationHours,
  SleeperEntry,
  SleepersResponse,
} from '@groupie/shared';
import {
  SLEEPER_DURATION_LABELS,
  SLEEPER_DURATIONS_HOURS,
  SLEEPER_LONG_ONLY_MIN_HOURS,
  SLEEPERS,
} from '@groupie/shared';
import { bandPosition } from '../derive';
import {
  avatarHue,
  fmtAge,
  fmtHours,
  fmtHoursFloor,
  fmtTurnover,
  fmtUsd,
  shortAddress,
} from '../format';
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
  /**
   * The X-only / no-stocks chips, when this layout has nowhere else to put
   * them. Desktop draws them in the view header; mobile has only the 46px tone
   * band, which the trust frame owns, so they ride the control panel instead.
   */
  filterChips?: ReactNode;
  /** Shared clock, ticked once a minute by App. */
  now: number;
  watch: WatchProps;
}

function bandLabel(band: SleeperBand): string {
  return `${fmtUsd(band.loUsd)}–${fmtUsd(band.hiUsd)}`;
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
  filterChips,
  now,
  watch,
}: SleepersProps) {
  // One open link row at a time, exactly like the board's rows.
  const [openAddress, setOpenAddress] = useState<string | null>(null);
  // The stocks filter is read off the PAYLOAD rather than a prop: it is the
  // response that decides which rows exist, and the toggle is a request for one.
  const excludeStocks = data?.excludeStocks ?? true;
  useEffect(() => setOpenAddress(null), [xOnly, minHours, excludeStocks]);

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
        {filterChips ? (
          <div className="ctl-row">
            <span className="ctl-label">SHOWING</span>
            <div className="chips" role="group" aria-label="Sleepers filters">
              {filterChips}
            </div>
          </div>
        ) : null}
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
              ? 'residency is read off candles — it reaches back before we first saw the coin'
              : `${total} leads across ${data?.bands.length ?? 0} bands · residency read off candles`}
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
    // Three independent reasons to be empty, and the duration is the one the
    // reader just changed — name it first so the fix is obvious. Every
    // suggestion is a filter that is actually ON: at the shortest chip there is
    // no shorter duration to offer, and offering one sends the reader to a
    // chip they are already standing on.
    // Every figure and flag here is the PAYLOAD's, not the toggles': this
    // sentence explains an empty response, and a toggle can already be ahead of
    // the response it is waiting for (or of one that failed to arrive).
    const held = `held its band for ${SLEEPER_DURATION_LABELS[data.minHours]}+`;
    const options: string[] = [];
    if (data.minHours !== SLEEPER_DURATIONS_HOURS[0]) options.push('a shorter duration');
    if (data.xOnly) options.push('showing all');
    if (data.excludeStocks) options.push('including stocks');
    const suggestion =
      options.length === 0
        ? ''
        : ` Try ${
            options.length === 1
              ? options[0]
              : `${options.slice(0, -1).join(', ')}, or ${options[options.length - 1]}`
          }.`;
    return (
      <p className="empty">
        {data.xOnly
          ? `Nothing with an X account ${held} this scan.${suggestion}`
          : `Nothing on the chain ${held} this scan.${suggestion}`}
      </p>
    );
  }

  return (
    <>
      {/* Keyed on the filters so a chip change remounts the grid: that is what
          plays the 200ms cross-fade, and it is the only motion this surface has. */}
      <div
        className="zone-grid slp-grid"
        key={`${minHours}-${xOnly ? 'x' : 'all'}-${data.excludeStocks ? 'nostock' : 'stock'}`}
      >
        {/* Every band the payload carries, in its own order — round 17 made all
            seven regular, so nothing here is gated on the duration any more. */}
        {data.bands.map((band, index) => (
          <section className="zone zone-cyan zone-slp" key={band.loUsd}>
            <div className="zone-band">
              <span className="zone-id">
                <span className="zone-headline zone-headline-band">{bandLabel(band)}</span>
                <span className="zone-count">{band.entries.length}</span>
              </span>
              {index === 0 ? (
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
        {SLEEPERS.minPoolAgeHours}h+ · under {SLEEPERS.maxPoolAgeDays}d on views shorter than{' '}
        {SLEEPER_DURATION_LABELS[SLEEPER_LONG_ONLY_MIN_HOURS]} · time in band from candle history (
        {SLEEPERS.shortCandleMinutes}-minute candles under {SLEEPERS.shortHoldMaxHours}h) ·{' '}
        {data.xOnly ? 'X account required' : 'X account not required'} ·{' '}
        {data.excludeStocks ? 'tokenized stocks excluded' : 'tokenized stocks included'} · nothing
        here is tracked
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
  // Floored, never rounded: the badge sits under the duration chip that served
  // the row, and a rounded-up figure would name a chip that drops the coin.
  const inBand =
    entry.inBandHours > 0 ? `${fmtHoursFloor(entry.inBandHours)}${capped ? '+' : ''}` : null;
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
              A tokenized equity, not a coin (round 17). It only appears when
              the reader has turned the stocks filter off, and it is a plain
              badge — a fact about what the row IS, never a P&L colour.
            */}
            {entry.isStock ? <span className="badge badge-stock">STOCK</span> : null}
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
