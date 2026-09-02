import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { DiscoveryEntry, DiscoveryResponse } from '@groupie/shared';
import {
  DISCOVERY_DORMANT_LINE,
  DISCOVERY_DURATIONS_HOURS,
  DISCOVERY_EMPTY_LINES,
  bundleText,
  dexLabel,
  feedStatusText,
  filtersKey,
  filtersSentence,
  subline,
} from '../discovery';
import type { DiscoveryHours } from '../discovery';
import { avatarHue, fmtAge, shortAddress } from '../format';
import { hoverCapable } from '../motion';
import type { WatchProps } from '../watch';
import { targetFromDiscovery, watchFor } from '../watch';
import { LinkPills } from './LinkPills';
import { Zone } from './Zone';

/**
 * Discovery (docs/decisions.md rounds 18 and 20) — the SECOND uncurated surface,
 * and the only one fed by the chain itself rather than by a market-data scan.
 * LAUNCHES are new Uniswap pools (a pool CREATION event, never a liquidity add);
 * GRADUATED are PONS graduations. Neither is a group call, and the view says so
 * in its headline before it says anything else, exactly as Sleepers does.
 *
 * Cyan carries the analysis here too (the window chips, the zone tones); magenta
 * stays the brand and green/red stay P&L. There is no P&L on this surface at
 * all: nothing here has a call to be a multiple of.
 *
 * Every figure is a fact from the pool or the launch block — the launch-block
 * share is printed on every visible row precisely so the bundle filter is never
 * a hidden verdict — and an unreadable one prints as unknown, never as zero.
 *
 * Every string on this surface is derived in `../discovery`, which is where the
 * rules are tested; this file is the tree that prints them.
 */

interface DiscoveryProps {
  data: DiscoveryResponse | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  hours: DiscoveryHours;
  onHours: (next: DiscoveryHours) => void;
  /**
   * The `X + web` / `no bundles` / `no stocks` trio — one chip per query flag,
   * so a lit chip can never imply a filter the payload dropped. They ride the
   * control panel on every layout: the desktop header's right slot carries the
   * frame, and on mobile the 46px tone band has room for nothing else.
   */
  filterChips: ReactNode;
  /**
   * The client instant this payload landed, or null before the first successful
   * read. The stall line is judged against it — see `feedStatusText`.
   */
  fetchedAt: number | null;
  /** The server's own instant for this payload (its Date header), or null. */
  serverAt: number | null;
  /** Shared clock, ticked once a minute by App. */
  now: number;
  watch: WatchProps;
}

function title(entry: DiscoveryEntry): string {
  return entry.symbol ? `$${entry.symbol}` : shortAddress(entry.address);
}

export function Discovery({
  data,
  loading,
  error,
  onRetry,
  hours,
  onHours,
  filterChips,
  fetchedAt,
  serverAt,
  now,
  watch,
}: DiscoveryProps) {
  // One open link row at a time, exactly like the board's rows.
  const [openAddress, setOpenAddress] = useState<string | null>(null);
  // Read off the PAYLOAD, not the chips: it is the response that decides which
  // rows exist, and a chip is only ever a request for one.
  const shownHours = data?.hours ?? hours;
  const shownFilters = data === null ? '' : filtersKey(data.filters);
  useEffect(() => setOpenAddress(null), [shownHours, shownFilters]);

  const toggle = useCallback(
    (address: string) => setOpenAddress((prev) => (prev === address ? null : address)),
    [],
  );

  const counts =
    data === null || !data.enabled
      ? null
      : { launches: data.launches.length, graduations: data.graduations.length };
  /**
   * A listener that has stopped reading blocks, said out loud. It sits outside
   * the ctl panel on purpose: `.ctl-note` is desktop-only, and a stalled feed is
   * exactly the thing a phone must not be told quietly.
   */
  const feedStatus =
    data === null
      ? null
      : feedStatusText(data.enabled, data.lastTickAt, fetchedAt, now, serverAt);

  return (
    <>
      <div className="ctl-panel">
        <div className="ctl-row">
          <span className="ctl-label">SHOWING</span>
          <div className="chips" role="group" aria-label="Discovery filters">
            {filterChips}
          </div>
          <span className="ctl-note">
            {/* A dormant deployment filtered nothing: there is no stream for the
                chips to have narrowed, so it keeps the pre-load sentence rather
                than describing a cut that never happened. */}
            {data === null || !data.enabled
              ? 'each filter is its own switch — the sentence below says which ones the feed applied'
              : filtersSentence(data)}
          </span>
        </div>
        <div className="ctl-row">
          <span className="ctl-label">LAST</span>
          <div className="chips chips-hours" role="group" aria-label="Discovery window">
            {DISCOVERY_DURATIONS_HOURS.map((option) => (
              <button
                key={option}
                type="button"
                className={`chip chip-hours${hours === option ? ' is-active' : ''}`}
                aria-pressed={hours === option}
                onClick={() => onHours(option)}
              >
                {`${option}h`}
              </button>
            ))}
          </div>
          <span className="ctl-note">
            {counts === null
              ? 'pool creations and graduations, read straight off the chain'
              : `${counts.launches} launches · ${counts.graduations} graduated in the last ${shownHours}h`}
          </span>
        </div>
      </div>

      {feedStatus ? (
        <p className="dsc-stall" role="status">
          {feedStatus}
        </p>
      ) : null}

      {error && !data ? (
        <div className="screen">
          <h2 className="screen-title">Could not load discovery</h2>
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
          <DiscoveryBody
            data={data}
            loading={loading}
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

function DiscoveryBody({
  data,
  loading,
  now,
  watch,
  openAddress,
  onToggle,
}: {
  data: DiscoveryResponse | null;
  loading: boolean;
  now: number;
  watch: WatchProps;
  openAddress: string | null;
  onToggle: (address: string) => void;
}) {
  if (!data) {
    return <p className="empty">{loading ? 'Reading the chain…' : 'Nothing here yet.'}</p>;
  }

  // Dormant: no on-chain client on this deployment. One line, and no zones at
  // all — an empty LAUNCHES list would claim the chain was quiet.
  if (!data.enabled) {
    return <p className="empty">{DISCOVERY_DORMANT_LINE}</p>;
  }

  return (
    <>
      {/* Keyed on the controls so a chip change remounts the grid: that is what
          plays the cross-fade, and it is the only motion this surface has. */}
      <div className="zone-grid dsc-grid" key={`${data.hours}-${filtersKey(data.filters)}`}>
        <DiscoveryZone
          headline="LAUNCHES"
          note={`new Uniswap pools · last ${data.hours}h`}
          empty={DISCOVERY_EMPTY_LINES.launch}
          entries={data.launches}
          now={now}
          watch={watch}
          openAddress={openAddress}
          onToggle={onToggle}
        />
        <DiscoveryZone
          headline="GRADUATED"
          note={`PONS graduations · last ${data.hours}h`}
          empty={DISCOVERY_EMPTY_LINES.graduation}
          entries={data.graduations}
          now={now}
          watch={watch}
          openAddress={openAddress}
          onToggle={onToggle}
        />
      </div>
      <p className="footnote dsc-footnote">
        {`${filtersSentence(data)} · launch block share is the supply bought in block one · LP lock read from the pool · nothing here is tracked or called`}
      </p>
    </>
  );
}

function DiscoveryZone({
  headline,
  note,
  empty,
  entries,
  now,
  watch,
  openAddress,
  onToggle,
}: {
  headline: string;
  note: string;
  empty: string;
  entries: DiscoveryEntry[];
  now: number;
  watch: WatchProps;
  openAddress: string | null;
  onToggle: (address: string) => void;
}) {
  return (
    <Zone tone="cyan" headline={headline} count={entries.length} note={note} className="zone-dsc">
      {entries.length === 0 ? (
        <p className="empty">{empty}</p>
      ) : (
        <div className="dsc-rows">
          {entries.map((entry) => (
            <DiscoveryRow
              key={`${entry.kind}:${entry.poolAddress}`}
              entry={entry}
              now={now}
              watch={watch}
              expanded={openAddress === entry.address}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </Zone>
  );
}

function Disc({ entry }: { entry: DiscoveryEntry }) {
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
 * One lead. Same row anatomy as the board and Sleepers — disc, identity, shape,
 * age — with the X and WEB links promoted onto the head line: this is an
 * uncurated surface, and reading the project is the whole job here.
 *
 * The shape slot carries the bundle facts instead of a chart. There is no
 * history behind a coin that launched an hour ago, and the launch block is the
 * one number that says something about how the supply started out.
 */
function DiscoveryRow({
  entry,
  now,
  watch,
  expanded,
  onToggle,
}: {
  entry: DiscoveryEntry;
  now: number;
  watch: WatchProps;
  expanded: boolean;
  onToggle: (address: string) => void;
}) {
  const label = title(entry);
  const control = watchFor(targetFromDiscovery(entry), watch);

  return (
    <div className={`row row-dsc row-desk${expanded ? ' is-open' : ''}`}>
      <div className="row-head">
        <button
          type="button"
          className="row-hit"
          aria-expanded={expanded}
          aria-label={`Trading links for ${label}`}
          // Hover already reveals the strip on a mouse; the tap row below is for
          // pointers that cannot hover, and opening both doubled the links.
          onClick={() => {
            if (hoverCapable()) return;
            onToggle(entry.address);
          }}
        />

        <Disc entry={entry} />

        <div className="row-id">
          <div className="row-name">
            <span className="sym">{label}</span>
            {/* Which venue opened the pool — a fact about the row, not a rating. */}
            <span className="badge badge-dex">{dexLabel(entry.dex)}</span>
            {entry.isStock ? <span className="badge badge-stock">STOCK</span> : null}
            {/*
              The chat already said this one out loud (the per-hour cap means
              most rows did not). Dim on purpose: it is a note about US, not
              about the coin.
            */}
            {entry.alerted ? (
              <span className="badge badge-alerted" title="Posted to the chat">
                ALERTED
              </span>
            ) : null}
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
            {entry.websiteUrl ? (
              <a
                className="pill pill-x"
                href={entry.websiteUrl}
                target="_blank"
                rel="noopener"
                aria-label={`${label} website`}
              >
                WEB
              </a>
            ) : null}
            {entry.watched ? <span className="watch-dot" title="On the group watchlist" /> : null}
          </div>
          <div className="row-sub">{subline(entry, now)}</div>
        </div>

        <span className="dsc-bundle">{bundleText(entry.launchBlockPct, entry.launchBlockWallets)}</span>

        <span className="row-hoverlinks">
          <LinkPills target={entry} watch={control} compact />
        </span>

        <span className="row-age">{fmtAge(entry.at, now)}</span>
      </div>

      {expanded ? (
        <div className="row-pills">
          <LinkPills target={entry} watch={control} />
        </div>
      ) : null}
    </div>
  );
}
