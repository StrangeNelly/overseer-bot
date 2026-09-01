import { useCallback, useEffect, useState } from 'react';
import type {
  SleeperBand,
  SleeperDurationHours,
  SleeperEntry,
  SleepersResponse,
} from '@groupie/shared';
import { SLEEPER_DURATION_LABELS, SLEEPER_DURATIONS_HOURS, SLEEPERS } from '@groupie/shared';
import { copyText } from '../clipboard';
import { avatarHue, fmtAge, fmtHours, fmtTurnover, fmtUsd, shortAddress } from '../format';

/**
 * Sleepers (docs/decisions.md rounds 9 and 14) — the first UNCURATED surface in
 * the app. Everything here is a chain-wide research lead, not something the
 * group called, and the tab is written to say so before it says anything else.
 *
 * No sparkline (there is no history behind an entry) and no multiple (there is
 * no call to be a multiple of): turnover is the hero number, in cyan — the
 * analytical accent, the same one Ranging uses. Magenta stays the brand and
 * green/red stay P&L.
 */

interface SleepersProps {
  data: SleepersResponse | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  /** Twitter-required is the default view; the chip toggles it off. */
  xOnly: boolean;
  onXOnly: (next: boolean) => void;
  /** Minimum continuous time in band — the round-14 duration filter. */
  minHours: SleeperDurationHours;
  onMinHours: (next: SleeperDurationHours) => void;
  /** Shared clock, ticked once a minute by App. */
  now: number;
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
  onXOnly,
  minHours,
  onMinHours,
  now,
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
        The trust boundary. It is the first thing in the tab and it never
        scrolls away behind a filter: this is a machine's list of the whole
        chain, not the group's calls.
      */}
      <div className="slp-head">
        <span className="slp-frame">
          chain-wide scan
          <span className="slp-sep">·</span>
          not group calls
          {data?.refreshedAt ? (
            <>
              <span className="slp-sep">·</span>
              {/* Never split "2h ago" across lines — it reads as two facts. */}
              <span className="slp-nowrap">{`refreshed ${fmtAge(data.refreshedAt, now)} ago`}</span>
            </>
          ) : null}
        </span>
        <button
          type="button"
          className={`chip chip-x${xOnly ? ' is-active' : ''}`}
          aria-pressed={xOnly}
          onClick={() => onXOnly(!xOnly)}
        >
          {xOnly ? 'X only' : 'showing all'}
        </button>
      </div>

      {/*
        The duration filter (round 14). Cyan when active, exactly like Ranging's
        "HELD FOR ≥" chips — same question, asked of the whole chain instead of
        the group's own calls.
      */}
      <div className="slp-durations">
        <div className="chips chips-hours" role="group" aria-label="Minimum time in band">
          <span className="chips-label">IN BAND ≥</span>
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
  openAddress,
  onToggle,
}: {
  data: SleepersResponse | null;
  loading: boolean;
  total: number | null;
  xOnly: boolean;
  minHours: SleeperDurationHours;
  now: number;
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
    <div className="slp-bands">
      {data.bands.map((band) => (
        <section className="slp-band" key={band.loUsd}>
          <h3 className="slp-band-head">{bandLabel(band)}</h3>
          {band.entries.length === 0 ? (
            <p className="slp-band-empty">nothing qualifying in this band right now.</p>
          ) : (
            <div className="slp-rows">
              {band.entries.map((entry) => (
                <SleeperRow
                  key={entry.address}
                  entry={entry}
                  now={now}
                  expanded={openAddress === entry.address}
                  onToggle={onToggle}
                />
              ))}
            </div>
          )}
        </section>
      ))}
      <p className="footnote">
        ranked by turnover (24h volume ÷ market cap) · liquidity ≥ {fmtUsd(SLEEPERS.minLiquidityUsd)}{' '}
        and ≥ {Math.round(SLEEPERS.liqToMcapMinRatio * 100)}% of market cap · pool age{' '}
        {SLEEPERS.minPoolAgeHours}h–{SLEEPERS.maxPoolAgeDays}d · time in band from hourly/daily
        candles · nothing here is tracked or watched
      </p>
    </div>
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
 * One lead. Same row anatomy as the board — disc, identity, hero number, age —
 * with the X link promoted onto the head line rather than buried in the tap
 * reveal: this surface defaults to coins that have one, and it is the fastest
 * way to research a name nobody in the group has mentioned.
 */
function SleeperRow({
  entry,
  now,
  expanded,
  onToggle,
}: {
  entry: SleeperEntry;
  now: number;
  expanded: boolean;
  onToggle: (address: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const label = title(entry);
  const persistent = entry.onListSinceHours >= SLEEPERS.persistenceMarkerHours;
  // Measured off candles, so it reaches back before we ever saw the coin — and
  // it is capped, which the "+" says out loud rather than pretending precision.
  const capped = entry.inBandHours >= SLEEPERS.inBandMaxDays * 24;
  const inBand = entry.inBandHours > 0 ? `${fmtHours(entry.inBandHours)}${capped ? '+' : ''}` : null;

  const onCopy = useCallback(() => {
    void copyText(entry.address).then((ok) => {
      if (!ok) return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_400);
    });
  }, [entry.address]);

  return (
    <div className={`row row-slp${expanded ? ' is-open' : ''}`}>
      <div className="row-head">
        <button
          type="button"
          className="row-hit"
          aria-expanded={expanded}
          aria-label={`Trading links for ${label}`}
          onClick={() => onToggle(entry.address)}
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
          </div>
          <div className="row-sub">
            {`${fmtUsd(entry.mcapUsd)} · vol ${fmtUsd(entry.vol24Usd)}`}
          </div>
        </div>

        <div className="row-num">
          <span className="slp-turn">{fmtTurnover(entry.turnover)}</span>
          <span className="mcaps">{`LP ${fmtUsd(entry.liquidityUsd)}`}</span>
        </div>

        <span className="row-age">{fmtAge(entry.poolCreatedAt, now)}</span>
      </div>

      {expanded ? (
        <div className="row-pills">
          <a className="pill" href={entry.links.axiom} target="_blank" rel="noopener">
            AXIOM
          </a>
          <a className="pill" href={entry.links.gmgn} target="_blank" rel="noopener">
            GMGN
          </a>
          <a className="pill" href={entry.links.dexscreener} target="_blank" rel="noopener">
            DEXS
          </a>
          <button type="button" className="pill pill-copy" onClick={onCopy}>
            {copied ? 'COPIED ✓' : 'COPY CA'}
          </button>
          {entry.twitterUrl ? (
            <a className="pill" href={entry.twitterUrl} target="_blank" rel="noopener">
              X
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
