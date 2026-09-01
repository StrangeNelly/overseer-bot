import { useCallback, useEffect, useState } from 'react';
import type { SleeperBand, SleeperEntry, SleepersResponse } from '@groupie/shared';
import { SLEEPERS } from '@groupie/shared';
import { copyText } from '../clipboard';
import { avatarHue, fmtAge, fmtHours, fmtTurnover, fmtUsd, shortAddress } from '../format';

/**
 * Sleepers (docs/decisions.md round 9) — the first UNCURATED surface in the
 * app. Everything here is a chain-wide research lead, not something the group
 * called, and the tab is written to say so before it says anything else.
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
  /** Shared clock, ticked once a minute by App. */
  now: number;
}

function bandLabel(band: SleeperBand): string {
  return `${fmtUsd(band.loUsd)}–${fmtUsd(band.hiUsd)}`;
}

function title(entry: SleeperEntry): string {
  return entry.symbol ? `$${entry.symbol}` : shortAddress(entry.address);
}

export function Sleepers({ data, loading, error, onRetry, xOnly, onXOnly, now }: SleepersProps) {
  // One open link row at a time, exactly like the board's rows.
  const [openAddress, setOpenAddress] = useState<string | null>(null);
  useEffect(() => setOpenAddress(null), [xOnly]);

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
  now,
  openAddress,
  onToggle,
}: {
  data: SleepersResponse | null;
  loading: boolean;
  total: number | null;
  xOnly: boolean;
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
    return (
      <p className="empty">
        {xOnly
          ? 'Nothing with an X account cleared the floors this scan. Try showing all.'
          : 'Nothing on the chain cleared the floors this scan.'}
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
        · pool age {SLEEPERS.minPoolAgeHours}h–{SLEEPERS.maxPoolAgeDays}d · nothing here is tracked or
        watched
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
