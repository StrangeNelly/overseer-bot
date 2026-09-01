import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  BoardCard,
  BoardResponse,
  BoardWindow,
  RangeBoardResponse,
  RangeDurationHours,
} from '@groupie/shared';
import { RANGE_DURATION_HOURS, RANGE_PRESETS } from '@groupie/shared';
import {
  ApiError,
  authDev,
  authTelegram,
  binCall,
  createHandoff,
  eventsUrl,
  fetchBoard,
  fetchMe,
  fetchRange,
} from './api';
import { readCachedBoard, writeCachedBoard } from './cache';
import { Board } from './components/Board';
import { DesktopBoard } from './components/DesktopBoard';
import type { RangeSummary } from './components/DesktopBoard';
import { MiniBoard } from './components/MiniBoard';
import { Pulse } from './components/Pulse';
import { DEFAULT_CONTROLS, Ranging, resolveBand } from './components/Ranging';
import type { RangeBand, RangeControls } from './components/Ranging';
import type { SectionKey } from './components/SectionTabs';
import { GhostRows } from './components/Spotlight';
import { WINDOWS, WindowSwitcher } from './components/WindowSwitcher';
import { derivePulse, isStale } from './derive';
import { fmtAge, fmtUsd, shortAddress } from './format';
import { ANNOUNCEMENT_MS, suppressDiffAfter, useBoardChange, useTransient } from './motion';
import {
  tgExpand,
  tgHaptic,
  tgInitData,
  tgIsExpanded,
  tgOnViewportChanged,
  tgOpenLink,
  tgReady,
  tgStartParam,
} from './telegram';

const WINDOW_STORAGE_KEY = 'groupie.window';
const RANGE_STORAGE_KEY = 'groupie.range';
const DEFAULT_WINDOW: BoardWindow = '24h';
/** Typing a custom band fires on every keystroke; wait for the pause. */
const RANGE_DEBOUNCE_MS = 400;
/**
 * Collapse bursts of live events into one refetch. Sized for peak volume
 * (50-100 calls/day, docs/decisions.md round 5): every event in the group hits
 * every open board, so a wider window is what keeps client and DB load sane at
 * that card count.
 */
const REFETCH_DEBOUNCE_MS = 6000;
/** Don't refetch twice when a tab switch fires both focus and visibilitychange. */
const FOCUS_REFETCH_MIN_GAP_MS = 3000;
const AGE_TICK_MS = 60_000;
/** Every server event name that should pull a fresh board. */
const LIVE_EVENT_NAMES = ['update', 'price_update', 'new_call', 're_call', 'token_died'];
/** Telegram start params and our slugs share this alphabet. */
const SLUG_RE = /^[A-Za-z0-9_-]{1,64}$/;
const NO_HIDDEN: ReadonlySet<number> = new Set<number>();
/** Design 2b: at this width the board stops being tabs and becomes columns. */
const DESKTOP_MIN_PX = 1100;

type BootState =
  | { kind: 'loading' }
  | { kind: 'ready'; slug: string }
  | { kind: 'no-slug' }
  | { kind: 'telegram-only' }
  | { kind: 'blocked'; title: string; message: string; retry: boolean };

type LiveState = 'idle' | 'open' | 'reconnecting';

/** Half-sheet, single column, or the full terminal. */
type LayoutMode = 'mini' | 'mobile' | 'desktop';

/** What the ranging endpoint was last asked for — the unit a refetch repeats. */
interface RangeQuery {
  band: RangeBand;
  hours: RangeDurationHours;
}

function describe(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return 'Something went wrong.';
}

function isBoardWindow(value: unknown): value is BoardWindow {
  return typeof value === 'string' && (WINDOWS as readonly string[]).includes(value);
}

function loadWindow(): BoardWindow {
  try {
    const raw = window.localStorage.getItem(WINDOW_STORAGE_KEY);
    if (isBoardWindow(raw)) return raw;
  } catch {
    // Private mode / disabled storage: fall back to the default.
  }
  return DEFAULT_WINDOW;
}

function saveWindow(value: BoardWindow): void {
  try {
    window.localStorage.setItem(WINDOW_STORAGE_KEY, value);
  } catch {
    // Persisting the preference is best-effort.
  }
}

function isRangeHours(value: unknown): value is RangeDurationHours {
  return typeof value === 'number' && (RANGE_DURATION_HOURS as readonly number[]).includes(value);
}

/**
 * Every field is re-validated: the stored blob is user-editable and can predate
 * a preset change. The custom fields were renamed in round 8 (they hold dollars
 * with a suffix now, not bare thousands), so an old blob simply starts empty
 * rather than silently meaning something 1000x smaller.
 */
function loadRangeControls(): RangeControls {
  try {
    const raw = window.localStorage.getItem(RANGE_STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        const stored = parsed as Record<string, unknown>;
        const index = stored.presetIndex;
        const presetIndex =
          typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < RANGE_PRESETS.length
            ? index
            : index === null
              ? null
              : DEFAULT_CONTROLS.presetIndex;
        return {
          presetIndex,
          customLo: typeof stored.customLo === 'string' ? stored.customLo : '',
          customHi: typeof stored.customHi === 'string' ? stored.customHi : '',
          hours: isRangeHours(stored.hours) ? stored.hours : DEFAULT_CONTROLS.hours,
        };
      }
    }
  } catch {
    // Private mode, disabled storage, or a corrupt blob: fall back to the default.
  }
  return DEFAULT_CONTROLS;
}

function saveRangeControls(value: RangeControls): void {
  try {
    window.localStorage.setItem(RANGE_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Persisting the preference is best-effort.
  }
}

/** `/g/<slug>` wins; otherwise the Telegram start param, which we then put in the URL. */
function resolveSlug(): string | null {
  const match = /^\/g\/([^/?#]+)/.exec(window.location.pathname);
  if (match?.[1]) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(match[1]);
    } catch {
      decoded = match[1];
    }
    if (SLUG_RE.test(decoded)) return decoded;
  }

  const startParam = tgStartParam();
  if (startParam && SLUG_RE.test(startParam)) {
    try {
      window.history.replaceState(null, '', `/g/${encodeURIComponent(startParam)}`);
    } catch {
      // A rewritten URL is a nicety, not a requirement.
    }
    return startParam;
  }

  return null;
}

/**
 * Read `?handoff=expired` (set by the server when a browser handoff link is
 * dead) and strip it from the address bar, so a reload does not keep announcing
 * it. Runs at import — exactly once, unlike a StrictMode-doubled render.
 */
function takeHandoffExpired(): boolean {
  if (typeof window === 'undefined') return false;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(window.location.search);
  } catch {
    return false;
  }
  if (params.get('handoff') !== 'expired') return false;
  try {
    params.delete('handoff');
    const query = params.toString();
    const { pathname, hash } = window.location;
    window.history.replaceState(null, '', `${pathname}${query ? `?${query}` : ''}${hash}`);
  } catch {
    // A tidy address bar is a nicety; the explanation below is the point.
  }
  return true;
}

const HANDOFF_EXPIRED = takeHandoffExpired();

async function bootstrap(): Promise<BootState> {
  const slug = resolveSlug();
  if (!slug) return { kind: 'no-slug' };

  const initData = tgInitData();
  if (initData) {
    tgReady();
    try {
      await authTelegram(initData);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        return {
          kind: 'blocked',
          title: 'Sign-in failed',
          message: 'Telegram could not verify this session. Close the board and open it again from your group link.',
          retry: true,
        };
      }
      return { kind: 'blocked', title: 'Sign-in failed', message: describe(err), retry: true };
    }
  } else {
    try {
      await authDev();
    } catch (err) {
      // No dev session endpoint in prod — browser login lands in a later milestone.
      if (err instanceof ApiError && (err.status === 404 || err.status === 401 || err.status === 501)) {
        return { kind: 'telegram-only' };
      }
      return { kind: 'blocked', title: 'Sign-in failed', message: describe(err), retry: true };
    }
  }

  try {
    await fetchMe();
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) {
      return {
        kind: 'blocked',
        title: 'No access',
        message: 'You are not a member of this group.',
        retry: false,
      };
    }
    if (err instanceof ApiError && err.status === 401) {
      return {
        kind: 'blocked',
        title: 'Session expired',
        message: 'Open the board again from your group’s pinned link.',
        retry: true,
      };
    }
    return { kind: 'blocked', title: 'Could not sign in', message: describe(err), retry: true };
  }

  return { kind: 'ready', slug };
}

/** Shared across StrictMode's double mount so auth runs exactly once. */
let bootPromise: Promise<BootState> | null = null;
function bootstrapOnce(): Promise<BootState> {
  bootPromise ??= bootstrap();
  return bootPromise;
}

/**
 * Which of the three surfaces to draw. Inside Telegram the half-sheet owns the
 * screen until the member drags it up (round 8: we never expand it for them);
 * outside, it is a plain width question.
 */
function useLayoutMode(inTelegram: boolean): LayoutMode {
  const [expanded, setExpanded] = useState(() => !inTelegram || tgIsExpanded());
  const [wide, setWide] = useState(
    () => typeof window !== 'undefined' && window.innerWidth >= DESKTOP_MIN_PX,
  );

  useEffect(() => {
    if (!inTelegram) return;
    const sync = () => setExpanded(tgIsExpanded());
    sync();
    return tgOnViewportChanged(sync);
  }, [inTelegram]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    let mq: MediaQueryList;
    try {
      mq = window.matchMedia(`(min-width: ${DESKTOP_MIN_PX}px)`);
    } catch {
      return;
    }
    const sync = () => setWide(mq.matches);
    sync();
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', sync);
      return () => mq.removeEventListener('change', sync);
    }
    mq.addListener?.(sync);
    return () => mq.removeListener?.(sync);
  }, []);

  if (inTelegram && !expanded) return 'mini';
  return wide ? 'desktop' : 'mobile';
}

export default function App() {
  const [boot, setBoot] = useState<BootState>({ kind: 'loading' });
  const [boardWindow, setBoardWindow] = useState<BoardWindow>(loadWindow);
  const [section, setSection] = useState<SectionKey>('fresh');
  const [board, setBoard] = useState<BoardResponse | null>(null);
  const [boardError, setBoardError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [revalidating, setRevalidating] = useState(false);
  const [live, setLive] = useState<LiveState>('idle');
  const [hidden, setHidden] = useState<ReadonlySet<number>>(NO_HIDDEN);
  const [binningId, setBinningId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [handoffPending, setHandoffPending] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [rangeControls, setRangeControls] = useState<RangeControls>(loadRangeControls);
  const [range, setRange] = useState<RangeBoardResponse | null>(null);
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [rangeLoading, setRangeLoading] = useState(false);

  const slug = boot.kind === 'ready' ? boot.slug : null;
  const slugRef = useRef<string | null>(null);
  const windowRef = useRef<BoardWindow>(boardWindow);
  const lastLoadRef = useRef(0);
  const loadSeqRef = useRef(0);
  const debounceRef = useRef<number | null>(null);
  const rangeSeqRef = useRef(0);
  const rangeQueryRef = useRef<RangeQuery | null>(null);
  /** True once the server has answered: the cache never outranks a real payload. */
  const paintedRef = useRef(false);

  // Bootstrap: slug -> auth -> /api/me.
  useEffect(() => {
    let alive = true;
    void bootstrapOnce().then((next) => {
      if (alive) setBoot(next);
    });
    return () => {
      alive = false;
    };
  }, []);

  const loadBoard = useCallback(async (options: { silent?: boolean } = {}) => {
    const currentSlug = slugRef.current;
    if (!currentSlug) return;
    lastLoadRef.current = Date.now();
    // Latest-wins: a slower earlier response (window switch, or a refetch that
    // began before a bin committed) must not overwrite a newer one.
    const seq = ++loadSeqRef.current;
    if (options.silent) setRevalidating(true);
    else setLoading(true);
    try {
      const data = await fetchBoard(currentSlug, windowRef.current);
      if (seq !== loadSeqRef.current) return;
      paintedRef.current = true;
      setBoard(data);
      writeCachedBoard(currentSlug, windowRef.current, data);
      setBoardError(null);
      setHidden(NO_HIDDEN);
      setNow(Date.now());
    } catch (err) {
      if (seq !== loadSeqRef.current) return;
      if (err instanceof ApiError && err.status === 403) {
        setBoot({
          kind: 'blocked',
          title: 'No access',
          message: 'You are not a member of this group.',
          retry: false,
        });
        return;
      }
      if (err instanceof ApiError && err.status === 401) {
        setBoot({
          kind: 'blocked',
          title: 'Session expired',
          message: 'Open the board again from your group’s pinned link.',
          retry: true,
        });
        return;
      }
      if (err instanceof ApiError && err.status === 404) {
        setBoot({
          kind: 'blocked',
          title: 'Board not found',
          message: 'That link does not match a group overseer is tracking.',
          retry: false,
        });
        return;
      }
      setBoardError(describe(err));
    } finally {
      if (seq === loadSeqRef.current) {
        if (options.silent) setRevalidating(false);
        else setLoading(false);
      }
    }
  }, []);

  // Load on slug/window change, keeping the refs the live handlers read in sync.
  useEffect(() => {
    if (!slug) return;
    slugRef.current = slug;
    windowRef.current = boardWindow;
    void loadBoard();
  }, [slug, boardWindow, loadBoard]);

  /**
   * Instant paint from the last board we saw (design: Performance). Strictly a
   * pre-first-response courtesy: once the server has spoken in this session the
   * cache is never consulted again, so it cannot resurrect a binned card or
   * overwrite fresher numbers. Its successor is not diffed either — a stale
   * cache must not fire a storm of "new call" blooms.
   */
  useEffect(() => {
    if (!slug || paintedRef.current) return;
    const cached = readCachedBoard(slug, boardWindow);
    if (!cached) return;
    suppressDiffAfter(cached);
    setBoard((prev) => (prev === null && !paintedRef.current ? cached : prev));
  }, [slug, boardWindow]);

  const loadRange = useCallback(async (query: RangeQuery, options: { silent?: boolean } = {}) => {
    const currentSlug = slugRef.current;
    if (!currentSlug) return;
    // Latest-wins, exactly like the board: a slow answer for an abandoned band
    // must not overwrite the one the user is looking at.
    const seq = ++rangeSeqRef.current;
    if (!options.silent) setRangeLoading(true);
    try {
      const data = await fetchRange(currentSlug, query.band.loUsd, query.band.hiUsd, query.hours);
      if (seq !== rangeSeqRef.current) return;
      setRange(data);
      setRangeError(null);
    } catch (err) {
      if (seq !== rangeSeqRef.current) return;
      setRangeError(describe(err));
    } finally {
      if (!options.silent && seq === rangeSeqRef.current) setRangeLoading(false);
    }
  }, []);

  /** Fixed for the life of the page: the launch payload only exists in the webview. */
  const inTelegram = useMemo(() => tgInitData() !== null, []);
  const layout = useLayoutMode(inTelegram);
  const rangeBand = useMemo(() => resolveBand(rangeControls), [rangeControls]);
  const rangingActive = section === 'ranging';
  const rangeHours = rangeControls.hours;
  const customBand = rangeControls.presetIndex === null;

  // Ranging is analytical, not live: it loads when its tab is open, when a
  // control changes, and on tab focus — never off an SSE event.
  useEffect(() => {
    if (!slug || !rangingActive) return;
    rangeQueryRef.current = rangeBand === null ? null : { band: rangeBand, hours: rangeHours };
    if (rangeBand === null) return;
    const query: RangeQuery = { band: rangeBand, hours: rangeHours };
    const id = window.setTimeout(() => void loadRange(query), customBand ? RANGE_DEBOUNCE_MS : 0);
    return () => window.clearTimeout(id);
  }, [slug, rangingActive, rangeBand, rangeHours, customBand, loadRange]);

  const scheduleRefetch = useCallback(() => {
    if (debounceRef.current !== null) return;
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
      void loadBoard({ silent: true });
    }, REFETCH_DEBOUNCE_MS);
  }, [loadBoard]);

  useEffect(
    () => () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    },
    [],
  );

  // Live stream. EventSource reconnects on its own; we only mirror its state.
  useEffect(() => {
    if (!slug) return;
    const source = new EventSource(eventsUrl(slug));
    const onEvent = () => scheduleRefetch();

    source.onopen = () => setLive('open');
    source.onerror = () => setLive('reconnecting');
    source.onmessage = onEvent;
    for (const name of LIVE_EVENT_NAMES) source.addEventListener(name, onEvent);

    return () => {
      for (const name of LIVE_EVENT_NAMES) source.removeEventListener(name, onEvent);
      source.close();
      setLive('idle');
    };
  }, [slug, scheduleRefetch]);

  // Coming back to the tab should show current numbers.
  useEffect(() => {
    if (!slug) return;
    const onFocus = () => {
      if (document.visibilityState === 'hidden') return;
      if (Date.now() - lastLoadRef.current < FOCUS_REFETCH_MIN_GAP_MS) return;
      void loadBoard({ silent: true });
      const query = rangeQueryRef.current;
      if (rangingActive && query) void loadRange(query, { silent: true });
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [slug, loadBoard, loadRange, rangingActive]);

  // Keeps every "3h" on the board honest without a refetch.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), AGE_TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  const onWindowChange = useCallback((next: BoardWindow) => {
    setBoardWindow(next);
    saveWindow(next);
  }, []);

  const onRangeControls = useCallback((next: RangeControls) => {
    setRangeControls(next);
    saveRangeControls(next);
  }, []);

  const onRangeRetry = useCallback(() => {
    const query = rangeQueryRef.current;
    if (query) void loadRange(query);
  }, [loadRange]);

  const onBin = useCallback(
    async (card: BoardCard) => {
      const currentSlug = slugRef.current;
      if (!currentSlug) return;
      const label = card.symbol ? `$${card.symbol}` : shortAddress(card.address);
      const ok = window.confirm(`Bin ${label}? It disappears from the board for the whole group.`);
      if (!ok) return;

      setBinningId(card.callId);
      setActionError(null);
      try {
        await binCall(currentSlug, card.callId);
        setHidden((prev) => {
          const next = new Set(prev);
          next.add(card.callId);
          return next;
        });
        void loadBoard({ silent: true });
      } catch (err) {
        setActionError(`Could not bin ${label}. ${describe(err)}`);
      } finally {
        setBinningId(null);
      }
    },
    [loadBoard],
  );

  /**
   * Hand this board to the system browser, already signed in: the server mints
   * a one-time link off our Mini App session and Telegram opens it outside the
   * webview (docs/decisions.md round 7).
   */
  const onFullBoard = useCallback(async () => {
    const currentSlug = slugRef.current;
    if (!currentSlug) return;
    // Design: the bridge tap is the one haptic on this surface.
    tgHaptic();
    setHandoffPending(true);
    setActionError(null);
    try {
      const { url } = await createHandoff(currentSlug);
      // No Telegram bridge (or an old client that lacks openLink): a new tab is
      // the next best thing.
      if (!tgOpenLink(url)) window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setActionError(`Could not open the full board. ${describe(err)}`);
    } finally {
      setHandoffPending(false);
    }
  }, []);

  const retryBoot = useCallback(() => {
    bootPromise = null;
    setBoot({ kind: 'loading' });
    void bootstrapOnce().then(setBoot);
  }, []);

  const change = useBoardChange(board);
  const announcement = useTransient(change.announcement, ANNOUNCEMENT_MS);
  const pulse = useMemo(
    () => (board ? derivePulse(board, now, hidden) : null),
    [board, now, hidden],
  );
  const rangeSummary = useMemo<RangeSummary | null>(() => {
    if (!range) return null;
    // The response is sorted by inRangeHours desc, so the first card is the longest.
    const longest = range.cards[0];
    return {
      count: range.cards.length,
      loUsd: range.loUsd,
      hiUsd: range.hiUsd,
      minHours: range.minHours,
      longest: longest
        ? {
            label: longest.symbol ? `$${longest.symbol}` : shortAddress(longest.address),
            hours: longest.range.inRangeHours,
          }
        : null,
    };
  }, [range]);

  if (boot.kind === 'loading') {
    return <Screen title="overseer" message="Opening the board…" />;
  }

  if (boot.kind === 'no-slug') {
    return (
      <Screen
        title="No board selected"
        message="Open this board from your group’s pinned link so overseer knows which group to show."
      />
    );
  }

  if (boot.kind === 'telegram-only') {
    return (
      <Screen
        title="Log in via Telegram"
        message="This board opens from inside Telegram for now. Tap the pinned board link in your group. Browser login is coming in a later release."
      >
        {HANDOFF_EXPIRED ? (
          <p className="screen-message" role="status">
            That link expired — tap Full board in Telegram again.
          </p>
        ) : null}
      </Screen>
    );
  }

  if (boot.kind === 'blocked') {
    return (
      <Screen title={boot.title} message={boot.message}>
        {boot.retry ? (
          <button type="button" className="retry-btn" onClick={retryBoot}>
            Try again
          </button>
        ) : null}
      </Screen>
    );
  }

  const title = board?.group.title ?? boot.slug;
  const staleBoard =
    board !== null && (board.sections.fresh ?? []).some((card) => isStale(card, now));

  // ---- Telegram half-sheet (design 2a): its own surface, no tabs, one bridge.
  if (layout === 'mini') {
    return (
      <div className="app app-mini">
        <div className="grabber" aria-hidden="true" />
        <header className="head head-mini">
          <Wordmark />
          <LiveDot state={live} />
        </header>
        {actionError ? (
          <p className="banner banner-error" role="alert">
            {actionError}
          </p>
        ) : null}
        {board && pulse ? (
          <MiniBoard
            board={board}
            now={now}
            hiddenCallIds={hidden}
            pulse={pulse}
            announcement={announcement}
            revalidating={revalidating}
            onFullBoard={() => void onFullBoard()}
            handoffPending={handoffPending}
            onExpand={tgExpand}
          />
        ) : (
          <div className="mini-rows">
            <GhostRows count={5} />
          </div>
        )}
      </div>
    );
  }

  const desktop = layout === 'desktop';

  return (
    <div className={`app${desktop ? ' app-desk' : ''}`}>
      <header className={`head${desktop ? ' head-desk' : ''}`}>
        <div className="head-left">
          <Wordmark />
          <h1 className="group-title" title={title}>
            {title}
          </h1>
          <LiveDot state={live} />
        </div>
        <div className="head-right">
          {pulse?.asOfMs !== undefined && pulse?.asOfMs !== null && (desktop || staleBoard) ? (
            <span className={`asof${staleBoard ? ' is-stale' : ''}`}>
              {`data as of ${fmtAge(new Date(Date.now() - pulse.asOfMs).toISOString())} ago`}
            </span>
          ) : null}
          {inTelegram ? (
            // Expanded-in-Telegram still needs the browser bridge: the
            // half-sheet's big button only exists in the 'mini' layout.
            <button
              type="button"
              className="bridge-btn bridge-btn-compact"
              onClick={() => void onFullBoard()}
              disabled={handoffPending}
            >
              {handoffPending ? 'opening…' : 'full ↗'}
            </button>
          ) : null}
          <WindowSwitcher value={boardWindow} onChange={onWindowChange} />
        </div>
      </header>

      {board && pulse ? (
        <Pulse
          data={pulse}
          variant="strip"
          announcement={announcement}
          revalidating={revalidating}
          rangingNote={
            desktop && rangeSummary
              ? `${rangeSummary.count} coiling in ${fmtUsd(rangeSummary.loUsd)}–${fmtUsd(rangeSummary.hiUsd)}`
              : null
          }
        />
      ) : null}

      <main className="main">
        {actionError ? (
          <p className="banner banner-error" role="alert">
            {actionError}
          </p>
        ) : null}

        {boardError && board ? (
          <p className="banner banner-warn" role="status">
            Could not refresh: {boardError}{' '}
            <button type="button" className="banner-btn" onClick={() => void loadBoard()}>
              Retry
            </button>
          </p>
        ) : null}

        {board ? (
          desktop ? (
            section === 'ranging' ? (
              <div className="desk-ranging">
                <button type="button" className="link-btn back-btn" onClick={() => setSection('fresh')}>
                  ◂ board
                </button>
                <Ranging
                  controls={rangeControls}
                  onControls={onRangeControls}
                  band={rangeBand}
                  data={range}
                  loading={rangeLoading}
                  error={rangeError}
                  onRetry={onRangeRetry}
                  now={now}
                />
              </div>
            ) : (
              <DesktopBoard
                board={board}
                now={now}
                hiddenCallIds={hidden}
                binningId={binningId}
                onBin={onBin}
                ceremonies={change.ceremonies}
                moved={change.moved}
                rangeSummary={rangeSummary}
                onOpenRanging={setSection}
              />
            )
          ) : (
            <Board
              board={board}
              section={section}
              onSection={setSection}
              now={now}
              hiddenCallIds={hidden}
              binningId={binningId}
              onBin={onBin}
              ceremonies={change.ceremonies}
              rangingCount={range === null ? null : range.cards.length}
              ranging={
                <Ranging
                  controls={rangeControls}
                  onControls={onRangeControls}
                  band={rangeBand}
                  data={range}
                  loading={rangeLoading}
                  error={rangeError}
                  onRetry={onRangeRetry}
                  now={now}
                />
              }
            />
          )
        ) : boardError ? (
          <div className="screen">
            <h2 className="screen-title">Could not load the board</h2>
            <p className="screen-message">{boardError}</p>
            <button type="button" className="retry-btn" onClick={() => void loadBoard()}>
              Try again
            </button>
          </div>
        ) : loading ? (
          <GhostRows />
        ) : (
          <p className="empty">Nothing here yet.</p>
        )}
      </main>
    </div>
  );
}

/** Lowercase, magenta, glowing — with the cyan peak dot for a period. */
function Wordmark() {
  return (
    <span className="wordmark">
      overseer<span className="wordmark-dot">.</span>
    </span>
  );
}

function LiveDot({ state }: { state: LiveState }) {
  if (state === 'reconnecting') {
    return (
      <span className="live live-off" title="Live connection dropped; retrying">
        <span className="live-dot" />
        RECONNECTING
      </span>
    );
  }
  if (state === 'open') {
    return (
      <span className="live live-on" title="Live updates connected">
        <span className="live-dot" />
        LIVE
      </span>
    );
  }
  return null;
}

function Screen({
  title,
  message,
  children,
}: {
  title: string;
  message: string;
  children?: ReactNode;
}) {
  return (
    <div className="app">
      <div className="screen">
        <h1 className="screen-title">{title}</h1>
        <p className="screen-message">{message}</p>
        {children}
      </div>
    </div>
  );
}
