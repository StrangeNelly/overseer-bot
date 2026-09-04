import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type {
  ProjectCandidate,
  ProjectEntry,
  ProjectsResponse,
  WatchlistEntry,
} from '@groupie/shared';
import { CONFIRM_MS, confirmStep, pressedOutside } from '../confirm';
import type { ConfirmState } from '../confirm';
import { avatarHue, fmtAge, shortAddress } from '../format';
import {
  UPCOMING_DORMANT_LINE,
  UPCOMING_EMPTY_LINE,
  UPCOMING_FOOTNOTE,
  accountAgeText,
  addedText,
  candidateReasonText,
  candidateText,
  canUntrack,
  capsText,
  checkStatus,
  followersText,
  handleUrl,
  hasActiveMonitor,
  isAtGroupCap,
  lastPostText,
  launchWatchTarget,
  launchedText,
  normalizeHandle,
  orderProjects,
  pingBadge,
  postedText,
  statusChipText,
  statusNoteText,
} from '../upcoming';
import { watchFor } from '../watch';
import type { WatchProps } from '../watch';
import { LinkPills } from './LinkPills';

/**
 * UPCOMING (docs/decisions.md round 23) — the pre-launch accounts the group is
 * tracking, and the one thing they are tracked FOR: the account itself posting a
 * contract address that resolves on chain.
 *
 * The trust frame is the whole design here. The chain is full of tokens claiming
 * these handles (measured: ~22 PONS launches/min, and the owner's own example
 * already has a $31K impostor), so a row must never let a claim read as a
 * launch: Tier-B candidates are nested UNDER the account that they name, in the
 * account's own words — "claims @handle · not posted by the account".
 *
 * Cyan carries the analysis, exactly as it does on Sleepers and Discovery; there
 * is no P&L on this surface at all, because nothing here has a call to be a
 * multiple of. Every string is derived in `../upcoming`, which is where the rules
 * are tested; this file is the tree that prints them.
 */

interface UpcomingProps {
  data: ProjectsResponse | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  /**
   * Add a monitor. Resolves true when the server took it — which is the form's
   * cue to clear itself. Every failure (409 capped / already tracked, 404 no
   * such handle) is surfaced by the caller in the board's own error banner, so
   * the field keeps what was typed and the reader can fix it.
   */
  onTrack: (handle: string, note: string) => Promise<boolean>;
  trackPending: boolean;
  /** Remove one, any member — optimistically, until the refetch confirms it. */
  onUntrack: (entry: ProjectEntry) => void;
  untrackPending: ReadonlySet<number>;
  /**
   * The client instant this payload landed, or null before the first successful
   * read. The stall line is judged against it — see `checkStatusText`.
   */
  fetchedAt: number | null;
  /** The server's own instant for this payload (its Date header), or null. */
  serverAt: number | null;
  /**
   * The group's ENTIRE active watchlist (BoardResponse.watchlist). A launched
   * token is a coin like any other, and round 16's rule is that every coin the
   * app shows carries the WATCH pill — but this payload has no watch state of
   * its own, so the state is read off the board's list by address.
   */
  watchlist?: readonly WatchlistEntry[];
  /** The board-wide watch toggle; omitted where there is none (tests, previews). */
  watch?: WatchProps;
  /** Shared clock, ticked once a minute by App. */
  now: number;
}

const NO_WATCHLIST: readonly WatchlistEntry[] = [];

/**
 * HOW WE ARE SEEING THIS ACCOUNT AT ALL (docs/decisions.md round 25).
 *
 * X hides some accounts from its "Latest" index entirely: @legsdotfun's launch
 * post (2026-09-03 21:05Z, 288 replies) never appeared under `from:legsdotfun`
 * in Latest — for any window, or for all time — while `to:legsdotfun` returned
 * every reply to it within seconds. So the watcher recovers those posts from
 * their replies, and sweeps Top every few polls, and `lastPostVia` records
 * which of the three actually carried the newest post we have.
 *
 * The row says so, because the alternative is a reader trusting a monitor whose
 * primary channel is blind. It is a fact about X's index, not a fault of ours
 * and not a warning about the account — so it gets the same dim sub-text every
 * other note on this row gets, and no colour of its own.
 *
 * IT SAYS WHAT WE KNOW, WHICH IS LESS THAN "X HIDES THIS ACCOUNT". The column
 * records which read got there FIRST, and the three reads use different windows
 * (from: 10 minutes, recovery 60, Top 15) over in-process state that a restart
 * empties — so a perfectly indexed account whose post lands in the gap is
 * recovered by a reply and stamped 'replies' with X's index working fine. The
 * strong claim is left to the operator log, which says "may be hiding"; the row
 * reports the road the post travelled and nothing more.
 *
 * IT IS ALSO PAST TENSE, on purpose. Only 'active' monitors are polled, and a
 * recovered launch ends its life as 'launched' — so "watching replies" would be
 * a claim about a poller that has stopped, on the very row this whole path
 * exists to produce. The provenance of the newest post we hold is true for a
 * finished row and a live one alike.
 */
export const UPCOMING_VIA_NOTES = {
  replies: 'newest post reached us through a reply, not through X search',
  top: 'newest post reached us through the Top sweep, not through X search',
} as const;

export function postViaNote(via: ProjectEntry['lastPostVia']): string | null {
  // 'search' is the normal channel and null is "no post seen yet" — neither is
  // news, and a note on every row would make the one that matters invisible.
  return via === 'replies' || via === 'top' ? UPCOMING_VIA_NOTES[via] : null;
}

export function Upcoming({
  data,
  loading,
  error,
  onRetry,
  onTrack,
  trackPending,
  onUntrack,
  untrackPending,
  fetchedAt,
  serverAt,
  watchlist = NO_WATCHLIST,
  watch,
  now,
}: UpcomingProps) {
  /**
   * A watcher that has stopped checking, said out loud. It sits outside the ctl
   * panel on purpose: `.ctl-note` is desktop-only, and a stalled monitor is
   * exactly the thing a phone must not be told quietly — this surface's entire
   * promise is that somebody is watching.
   */
  const feedStatus =
    data === null
      ? null
      : checkStatus({
          enabled: data.enabled,
          lastCheckAt: data.lastCheckAt,
          hasActive: hasActiveMonitor(data),
          hasMonitors: data.projects.length > 0,
          fetchedAt,
          now,
          serverAt,
        });

  return (
    <>
      <TrackPanel data={data} onTrack={onTrack} pending={trackPending} />

      {/* "Nothing left to check" is a note, not an alarm: it gets the dim line,
          never the cyan stall frame, because no watcher is misbehaving. */}
      {feedStatus ? (
        <p className={feedStatus.kind === 'idle' ? 'upc-idle' : 'dsc-stall'} role="status">
          {feedStatus.text}
        </p>
      ) : null}

      {error && !data ? (
        <div className="screen">
          <h2 className="screen-title">Could not load upcoming</h2>
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
          <UpcomingBody
            data={data}
            loading={loading}
            now={now}
            onUntrack={onUntrack}
            untrackPending={untrackPending}
            watchlist={watchlist}
            watch={watch}
          />
        </>
      )}
    </>
  );
}

/**
 * The add field — web parity for `/overseer track @handle [note]` (round 23).
 * The handle is validated here, before a request is spent on it: X's own rule is
 * 1-15 characters of letters, digits and underscores, and a pasted profile URL
 * is what a member actually has on their clipboard.
 */
function TrackPanel({
  data,
  onTrack,
  pending,
}: {
  data: ProjectsResponse | null;
  onTrack: (handle: string, note: string) => Promise<boolean>;
  pending: boolean;
}) {
  const [handle, setHandle] = useState('');
  const [note, setNote] = useState('');
  const [invalid, setInvalid] = useState(false);
  const atCap = isAtGroupCap(data);

  const submit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      if (pending) return;
      const normalized = normalizeHandle(handle);
      if (normalized === null) {
        setInvalid(true);
        return;
      }
      setInvalid(false);
      void onTrack(normalized, note.trim()).then((ok) => {
        // Only a monitor the server actually took clears the field: a refusal
        // (capped, already tracked, no such account) leaves the text in place to
        // be corrected, and the banner above says which it was.
        if (!ok) return;
        setHandle('');
        setNote('');
      });
    },
    [handle, note, onTrack, pending],
  );

  return (
    <div className="ctl-panel">
      <div className="ctl-row">
        <span className="ctl-label">TRACK</span>
        <form className="upc-form" onSubmit={submit}>
          <label className="range-field upc-field">
            <span className="range-field-label">@</span>
            <input
              className="range-input"
              type="text"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder="handle"
              aria-label="X handle to track"
              value={handle}
              onChange={(event) => {
                setHandle(event.target.value);
                setInvalid(false);
              }}
            />
          </label>
          <label className="range-field upc-field upc-field-note">
            <span className="range-field-label">NOTE</span>
            <input
              className="range-input"
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="optional"
              aria-label="Note for this monitor"
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <button
            type="submit"
            className="chip upc-add"
            disabled={pending || atCap}
            title={
              atCap
                ? 'This group has used every monitor slot — untrack one first.'
                : 'Watch this account for a contract address it posts itself'
            }
          >
            {pending ? 'adding…' : 'track'}
          </button>
        </form>
        <span className="ctl-note">
          {data === null
            ? 'the account posting a contract itself is the only thing that pings the chat'
            : capsText(data)}
        </span>
      </div>
      {invalid ? (
        <p className="upc-invalid" role="status">
          that is not an X handle — letters, digits and underscores, up to 15
        </p>
      ) : null}
      {atCap ? (
        <p className="upc-invalid" role="status">
          every monitor slot in this group is taken — untrack one to add another
        </p>
      ) : null}
    </div>
  );
}

function UpcomingBody({
  data,
  loading,
  now,
  onUntrack,
  untrackPending,
  watchlist,
  watch,
}: {
  data: ProjectsResponse | null;
  loading: boolean;
  now: number;
  onUntrack: (entry: ProjectEntry) => void;
  untrackPending: ReadonlySet<number>;
  watchlist: readonly WatchlistEntry[];
  watch: WatchProps | undefined;
}) {
  if (!data) {
    return <p className="empty">{loading ? 'Reading the monitors…' : 'Nothing here yet.'}</p>;
  }

  // Dormant: no X provider key on this deployment. One line — and the rows, if
  // there are any, still draw: a member's monitor is a real record even while
  // nothing is checking it. What must NOT happen is an empty list reading as
  // "the accounts have been quiet".
  const rows = orderProjects(data.projects);

  return (
    <div className="upc-grid">
      {data.enabled ? null : <p className="empty">{UPCOMING_DORMANT_LINE}</p>}
      {rows.length === 0 ? (
        data.enabled ? (
          <p className="empty">{UPCOMING_EMPTY_LINE}</p>
        ) : null
      ) : (
        <div className="upc-rows">
          {rows.map((entry) => (
            <ProjectRow
              key={entry.id}
              entry={entry}
              now={now}
              onUntrack={onUntrack}
              pending={untrackPending.has(entry.id)}
              watchlist={watchlist}
              watch={watch}
            />
          ))}
        </div>
      )}
      <p className="footnote dsc-footnote">{UPCOMING_FOOTNOTE}</p>
    </div>
  );
}

function Disc({ entry }: { entry: ProjectEntry }) {
  const [broken, setBroken] = useState(false);
  const letter = entry.handle.trim().charAt(0).toUpperCase() || '?';

  if (entry.avatarUrl && !broken) {
    return (
      <img
        className="avatar"
        src={entry.avatarUrl}
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
      style={{ background: `hsl(${avatarHue(entry.handle)} 45% 28%)` }}
      aria-hidden="true"
    >
      {letter}
    </span>
  );
}

/**
 * One tracked account. The head is the 48px row every other surface uses —
 * disc, identity, the numbers, the controls — and everything the decision asks
 * this surface to say that a 48px line cannot hold hangs under it: who added it,
 * their note, what fired, and what merely claims the handle.
 */
function ProjectRow({
  entry,
  now,
  onUntrack,
  pending,
  watchlist,
  watch,
}: {
  entry: ProjectEntry;
  now: number;
  onUntrack: (entry: ProjectEntry) => void;
  pending: boolean;
  watchlist: readonly WatchlistEntry[];
  watch: WatchProps | undefined;
}) {
  const launched = entry.launched;
  const held = launched ? pingBadge(launched) : null;
  const statusNote = statusNoteText(entry.status);
  const viaNote = postViaNote(entry.lastPostVia);
  return (
    <div className="row row-upc row-desk">
      <div className="row-head">
        <Disc entry={entry} />

        <div className="row-id">
          <div className="row-name">
            <span className="sym">{`@${entry.handle}`}</span>
            {entry.displayName ? <span className="upc-name">{entry.displayName}</span> : null}
            {/* Dim and neutral by law: LAUNCHED is not a win and SUSPENDED is
                not a verdict — both are facts about the account. */}
            <span className="badge badge-status">{statusChipText(entry.status)}</span>
          </div>
          {/* The bio verbatim, one line. It is the account's own words: we
              neither summarise it nor judge it. */}
          <div className="row-sub" title={entry.bio ?? undefined}>
            {entry.bio ?? 'no bio'}
          </div>
        </div>

        <span className="upc-meta">
          <span className="upc-meta-line">{followersText(entry.followers, entry.followersAtAdd)}</span>
          <span className="upc-meta-line">
            {`${accountAgeText(entry.accountCreatedAt, now)} · ${lastPostText(entry.lastPostAt, now)}`}
          </span>
        </span>

        <span className="upc-actions">
          {/* The account itself — no payload field carries it, and it is the one
              link a reader of this row actually wants. */}
          <a className="pill" href={handleUrl(entry.handle)} target="_blank" rel="noopener">
            X
          </a>
          {/* Every row a member can still act on offers it — EXPIRED and
              LAUNCHED included: those rows are history the group may want off
              its board, and the server takes the request. */}
          {canUntrack(entry.status) ? (
            <UntrackPill entry={entry} pending={pending} onFire={() => onUntrack(entry)} />
          ) : null}
        </span>
      </div>

      {/* RENAMED is the one chip that leaves a reader guessing: the monitor
          still follows the account it was created from, and the @ they typed is
          now somebody else's. */}
      {statusNote ? <p className="upc-status-note">{statusNote}</p> : null}

      {/* Same dim sub-text line, and deliberately the same class: on a phone
          `.upc-status-note` is the one rule that re-indents these notes with the
          rest of the row, and a second class would have to repeat it. */}
      {viaNote ? <p className="upc-status-note">{viaNote}</p> : null}

      <div className="upc-foot">
        <span>{addedText(entry, now)}</span>
        {entry.note ? <span className="upc-note">{entry.note}</span> : null}
      </div>

      {launched ? (
        <div className="upc-launched">
          {/* Dated from the TOKEN's own clock, with the post's beside it: the
              gap between the two is the hijack case, and collapsing them would
              hide exactly the fact this row exists to report. */}
          <span className="upc-launched-line">{launchedText(launched, now)}</span>
          <span className="upc-launched-when">{postedText(launched, now)}</span>
          {/* A ping the chat never heard, and which of the two reasons it was
              (docs/decisions.md round 23). Silent when it actually went out. */}
          {held ? (
            <span className="badge badge-held" title={held.title}>
              {held.text}
            </span>
          ) : null}
          <span className="upc-links">
            {launched.tweetUrl ? (
              <a className="pill" href={launched.tweetUrl} target="_blank" rel="noopener">
                POST
              </a>
            ) : null}
            <LinkPills
              target={{
                address: launched.address,
                symbol: launched.symbol,
                twitterUrl: null,
                websiteUrl: null,
                links: launched.links,
              }}
              // A launched token is a coin like any other (round 16: WATCH on
              // every coin the app shows). A candidate is not — nothing here has
              // confirmed it is a coin at all.
              watch={watchFor(launchWatchTarget(launched, watchlist), watch)}
              compact
            />
          </span>
        </div>
      ) : null}

      {entry.candidates.length > 0 ? (
        <div className="upc-cands">
          {entry.candidates.map((candidate) => (
            <CandidateRow
              key={`${candidate.kind}:${candidate.address}`}
              candidate={candidate}
              handle={entry.handle}
              now={now}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A candidate, in the dimmest voice this surface has. Two different facts share
 * the row shape:
 *
 * - 'posted' — the account's own post, one confirmation short of being a launch.
 *   It carries the POST link so a reader can judge the source themselves, and
 *   the reason the last attempt did not confirm, because "not confirmed yet" and
 *   "nothing is deployed there" are not the same news.
 * - 'claims' — a launch that names this handle on chain and the account never
 *   posted. Evidence about the chain, not news about the account.
 *
 * Neither ever pings the chat, and neither carries a WATCH pill: this surface
 * does not vouch for either one being a coin.
 */
function CandidateRow({
  candidate,
  handle,
  now,
}: {
  candidate: ProjectCandidate;
  handle: string;
  now: number;
}) {
  const reason = candidateReasonText(candidate.lastReason);
  return (
    <div className="upc-cand">
      <span className="upc-cand-sym">
        {candidate.symbol ? `$${candidate.symbol}` : shortAddress(candidate.address)}
      </span>
      <span className="upc-cand-line">{candidateText(candidate, handle, now)}</span>
      {reason ? <span className="upc-cand-why">{`· ${reason}`}</span> : null}
      <span className="upc-links">
        {candidate.tweetUrl ? (
          <a className="pill" href={candidate.tweetUrl} target="_blank" rel="noopener">
            POST
          </a>
        ) : null}
        <LinkPills
          target={{
            address: candidate.address,
            symbol: candidate.symbol,
            twitterUrl: null,
            websiteUrl: null,
            links: candidate.links,
          }}
          compact
        />
      </span>
      {/* A posted candidate already dates itself in its own line; a claim's age
          is the launch's, and belongs where every other row keeps its age. */}
      {candidate.kind === 'claims' ? (
        <span className="row-age">{fmtAge(candidate.at, now)}</span>
      ) : null}
    </div>
  );
}

/**
 * UNTRACK — the same two-tap guard MARK DEAD carries (`../confirm`): removing a
 * monitor is group-wide and instant, and the pill sits in a row a thumb scrolls
 * past. One tap arms it into SURE?, a second fires; four seconds, a tap
 * elsewhere, focus leaving, or the request going into flight all put it back.
 */
function UntrackPill({
  entry,
  pending,
  onFire,
}: {
  entry: ProjectEntry;
  pending: boolean;
  onFire: () => void;
}) {
  const [state, setState] = useState<ConfirmState>('idle');
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (state !== 'armed') return;
    const id = window.setTimeout(() => setState(confirmStep('armed', 'timeout').state), CONFIRM_MS);
    // Capture, so a tap that lands on a control which stops propagation still
    // disarms this one. The press that armed it is already past.
    const onAway = (event: Event) => {
      if (!pressedOutside(ref.current, event.target)) return;
      setState(confirmStep('armed', 'outside').state);
    };
    document.addEventListener('pointerdown', onAway, true);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('pointerdown', onAway, true);
    };
  }, [state]);

  useEffect(() => {
    if (pending) setState((prev) => confirmStep(prev, 'disable').state);
  }, [pending]);

  const armed = state === 'armed';
  return (
    <button
      ref={ref}
      type="button"
      className={`pill pill-dead${armed ? ' is-armed' : ''}`}
      aria-label={
        armed
          ? `Stop tracking @${entry.handle} — press again to confirm`
          : `Stop tracking @${entry.handle}`
      }
      title="Any member can remove a monitor. The account stops being watched for the whole group."
      disabled={pending}
      onBlur={() => setState(confirmStep(state, 'blur').state)}
      onClick={() => {
        const step = confirmStep(state, 'press');
        setState(step.state);
        if (step.fire) onFire();
      }}
    >
      {pending ? '…' : armed ? 'SURE?' : 'UNTRACK'}
    </button>
  );
}
