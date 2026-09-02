import { useState } from 'react';
import type { WatchlistEntry } from '@groupie/shared';
import type { WatchRow } from '../derive';
import { slotLabel } from '../derive';
import { avatarHue, fmtAge, fmtSignedPct, fmtUsd, shortAddress } from '../format';

/**
 * "watched at $120K · −32% since" — the BUY OPP baseline (round 19): the alert
 * measures its drawdown from here, so the row says where "here" is. Null until
 * the first reading after the watch, and for payloads that predate the field.
 */
function baselineNote(entry: WatchlistEntry): string | null {
  const base = entry.mcapAtWatch;
  if (base == null || !(base > 0)) return null;
  const now = entry.mcapUsd;
  const since = now !== null && now > 0 ? ` · ${fmtSignedPct(((now - base) / base) * 100)} since` : '';
  return `watched at ${fmtUsd(base)}${since}`;
}
import { hoverCapable, useAlertBloom } from '../motion';
import type { DeadProps } from '../dead';
import { deadForCard } from '../dead';
import type { WatchProps } from '../watch';
import { targetFromWatchEntry, watchForCard, watchFor } from '../watch';
import { LinkPills } from './LinkPills';
import { MoveChip } from './Zone';
import { Sparkline } from './Sparkline';
import { TokenCard } from './TokenCard';

/**
 * ON WATCH (docs/decisions.md round 16).
 *
 * The zone renders from the group's whole watchlist, not from `card.watched`:
 * a watch set in the chat by address, or from a Sleepers row, has no call on
 * this board at all. Before round 16 those slots were invisible here and could
 * only be freed with a bot command — the "stranded slots" finding.
 *
 * A watch WITH a call borrows the board row it already has (sparkline, multiple,
 * call story); a watch WITHOUT one gets a compact row built from the entry's own
 * fields, and the same links + WATCH reveal as everything else in the app.
 */

interface WatchRowsProps {
  rows: WatchRow[];
  now: number;
  watch: WatchProps;
  /**
   * The member verdict (round 21). Only the rows that HAVE a card can carry it:
   * a chat or Sleepers watch is not one of the group's calls, so there is no
   * call to pronounce dead.
   */
  dead?: DeadProps;
  /** Desktop hovers to reveal pills; mobile taps a row open, one at a time. */
  mode: 'desk' | 'mobile';
  openKey?: string | null;
  onToggle?: (key: string) => void;
  /** 3G: the address a watch-move announcement just named. */
  alertedAddress?: string | null;
}

export function WatchRows({
  rows,
  now,
  watch,
  dead,
  mode,
  openKey,
  onToggle,
  alertedAddress,
}: WatchRowsProps) {
  const desk = mode === 'desk';
  // 3G: the row the announcement just named surfaces to rank 1 — the FLIP that
  // follows is what makes the board's alert legible without a badge.
  const key = alertedAddress?.toLowerCase() ?? null;
  const ordered =
    key === null
      ? rows
      : [
          ...rows.filter((row) => row.entry.address.toLowerCase() === key),
          ...rows.filter((row) => row.entry.address.toLowerCase() !== key),
        ];
  return (
    <div className={desk ? 'feed feed-flat' : 'rows'}>
      {ordered.map((row) => {
        const alerted =
          alertedAddress !== null &&
          alertedAddress !== undefined &&
          alertedAddress.toLowerCase() === row.entry.address.toLowerCase();
        if (row.card) {
          // The peak note ("peak $30M · 2.3x") rides the card's own subline, so
          // it is NOT joined into slotNote here: TokenCard prints it once, in
          // cyan, ahead of LP — appending it to the baseline string as well
          // would say the same thing twice on one row.
          return (
            <TokenCard
              key={`c${row.entry.tokenId}`}
              card={row.card}
              section="watch"
              now={now}
              size={desk ? 'desk' : 'row'}
              links={desk ? 'hover' : 'tap'}
              expanded={!desk && openKey === row.entry.address}
              onToggle={onToggle ? () => onToggle(row.entry.address) : undefined}
              slotNote={[slotLabel(row.entry), baselineNote(row.entry)].filter(Boolean).join(' · ')}
              watch={watchForCard(row.card, watch)}
              dead={deadForCard(row.card, dead)}
              alerted={alerted}
            />
          );
        }
        return (
          <CalllessRow
            key={`e${row.entry.tokenId}`}
            entry={row.entry}
            hasCall={row.hasCall}
            move1h={row.move1h}
            now={now}
            watch={watch}
            desk={desk}
            expanded={!desk && openKey === row.entry.address}
            onToggle={onToggle}
            alerted={alerted}
          />
        );
      })}
    </div>
  );
}

/**
 * A watch with no CARD on this board. The gap is explained from what the entry
 * itself carries, because the four reasons are four different sentences: the
 * call is outside the window, the coin is hidden on rug probation, it died, or
 * there is genuinely no call (a chat or Sleepers watch). Only the last one may
 * say "no call".
 *
 * There is no multiple either way — there is no card here to be a multiple of,
 * and inventing one would be the dishonest thing.
 */
function CalllessRow({
  entry,
  hasCall,
  move1h,
  now,
  watch,
  desk,
  expanded,
  onToggle,
  alerted,
}: {
  entry: WatchlistEntry;
  hasCall: boolean;
  move1h: number | null;
  now: number;
  watch: WatchProps;
  desk: boolean;
  expanded: boolean;
  onToggle?: (key: string) => void;
  alerted: boolean;
}) {
  const title = entry.symbol ? `$${entry.symbol}` : shortAddress(entry.address);
  const seed = entry.symbol ?? entry.address;
  const control = watchFor(targetFromWatchEntry(entry), watch);
  const pills = <LinkPills target={entry} watch={control} compact={desk} />;
  const blooming = useAlertBloom(alerted);
  // Touch at desktop width has no hover, so the strip needs a tap (and the
  // button is what makes it keyboard-reachable at any width).
  const [tapped, setTapped] = useState(false);

  const died = entry.callStatus === 'died' || entry.phase === 'dead';
  const state = died
    ? { text: 'DIED', title: 'This call died — the group’s alerts resume by themselves if it revives' }
    : entry.rugHiddenAt !== null
      ? {
          text: 'on rug probation',
          title: 'Hidden from the board while it sits under the rug floor — it comes back on its own if it recovers',
        }
      : hasCall
        ? {
            text: 'called · outside this window',
            title: 'This group called it; the call sits outside the board window you are looking at',
          }
        : {
            text: 'no call',
            title: 'Watched from the chat or from Sleepers — this group has no open call for it',
          };

  const sub = [slotLabel(entry), fmtUsd(entry.mcapUsd)];
  const baseline = baselineNote(entry);
  if (baseline) sub.splice(1, 0, baseline);
  if (died) sub.push('alerts resume if it revives');
  else if (entry.liquidityUsd !== null) sub.push(`LP ${fmtUsd(entry.liquidityUsd)}`);

  const className = [
    'row',
    desk ? 'row-desk' : 'row-row',
    'edge-none',
    died ? 'is-died' : '',
    expanded ? 'is-open' : '',
    desk && tapped ? 'is-tapped' : '',
    blooming ? 'is-alerted' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={className} data-flip={entry.address}>
      <div className="row-head">
        {desk ? (
          <button
            type="button"
            className="row-hit"
            aria-expanded={tapped}
            aria-label={`Trading links for ${title}`}
            onClick={() => {
              if (hoverCapable()) return;
              setTapped((prev) => !prev);
            }}
          />
        ) : onToggle ? (
          <button
            type="button"
            className="row-hit"
            aria-expanded={expanded}
            aria-label={`Trading links for ${title}`}
            onClick={() => onToggle(entry.address)}
          />
        ) : null}

        {entry.imageUrl ? (
          <img className="avatar" src={entry.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
        ) : (
          <span
            className="avatar avatar-fallback"
            style={{ background: `hsl(${avatarHue(seed)} 45% 28%)` }}
            aria-hidden="true"
          >
            {(entry.symbol ?? '?').trim().charAt(0).toUpperCase() || '?'}
          </span>
        )}

        <div className="row-id">
          <div className="row-name">
            <span className="sym">{title}</span>
            <span className="watch-dot" title="On the group watchlist" />
          </div>
          <div className="row-sub">
            {sub.map((part, index) => (
              <span key={index} className="sub-part">
                {index > 0 ? <span className="sub-sep">·</span> : null}
                {part}
              </span>
            ))}
          </div>
        </div>

        <MoveChip pct={move1h} />

        <span className="row-spark">
          <Sparkline points={entry.sparkline} mcapAtCall={null} />
        </span>

        {desk ? <span className="row-hoverlinks">{pills}</span> : null}

        <div className="row-num">
          <span className={`watch-nocall${died ? ' watch-died' : ''}`} title={state.title}>
            {state.text}
          </span>
          <span className="mcaps">{`watched ${fmtAge(entry.addedAt, now)} ago`}</span>
        </div>

        <span className="row-age">{fmtAge(entry.dataAsOf, now)}</span>
      </div>

      {!desk && expanded ? <div className="row-pills">{pills}</div> : null}
    </div>
  );
}
