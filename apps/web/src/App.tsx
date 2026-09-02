import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  BoardCard,
  BoardResponse,
  BoardWindow,
  DiscoveryFilters,
  DiscoveryResponse,
  ProjectEntry,
  ProjectsResponse,
  RangeBoardResponse,
  RangeDurationHours,
  SleeperDurationHours,
  SleepersResponse,
} from '@groupie/shared';
import {
  RANGE_DURATION_HOURS,
  RANGE_PRESETS,
  SLEEPER_DURATIONS_HOURS,
  SLEEPER_DURATION_LABELS,
} from '@groupie/shared';
import {
  ApiError,
  authDev,
  authTelegram,
  binCall,
  createHandoff,
  eventsUrl,
  fetchBoard,
  fetchDiscovery,
  fetchMe,
  fetchRange,
  fetchSleepers,
  fetchTelegramLoginAvailable,
  fetchUpcoming,
  markDead,
  restoreCall,
  setWatch,
  setWatchByAddress,
  telegramLoginUrl,
  trackProject,
  untrackProject,
} from './api';
import { readCachedBoard, writeCachedBoard } from './cache';
import { Board } from './components/Board';
import { DesktopBoard } from './components/DesktopBoard';
import type { RangeSummary, SleepersSummary } from './components/DesktopBoard';
import { Discovery } from './components/Discovery';
import {
  DISCOVERY_FRAME_TAIL,
  DISCOVERY_POLL_MS,
  deriveDiscoverySummary,
  discoveryCountOf,
  filtersAfterFailedReload,
  parseDiscoveryFlag,
  parseDiscoveryHours,
} from './discovery';
import type { DiscoveryHours } from './discovery';
import { Upcoming } from './components/Upcoming';
import {
  UPCOMING_FRAME_TAIL,
  UPCOMING_POLL_MS,
  applyUntracked,
  deriveUpcomingSummary,
  upcomingCountOf,
} from './upcoming';
import { MiniBoard } from './components/MiniBoard';
import { Pulse } from './components/Pulse';
import { DEFAULT_CONTROLS, Ranging, resolveBand, sanitizeRangeControls } from './components/Ranging';
import type { RangeBand, RangeControls } from './components/Ranging';
import type { SectionKey } from './components/SectionTabs';
import { Sleepers } from './components/Sleepers';
import { GhostRows } from './components/Spotlight';
import { WINDOWS, WindowSwitcher } from './components/WindowSwitcher';
import { ViewHeader, Zone } from './components/Zone';
import { applyVerdicts, bandPosition, derivePulse, isStale } from './derive';
import { fmtAge, fmtUsd, shortAddress } from './format';
import { ANNOUNCEMENT_MS, suppressDiffAfter, useAnnouncementQueue, useBoardChange } from './motion';
import type { DeadProps } from './dead';
import { settleVerdicts } from './dead';
import type { WatchProps, WatchTarget } from './watch';
import { watchKey } from './watch';
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
const SLEEPERS_X_ONLY_STORAGE_KEY = 'groupie.sleepers.xOnly';
const SLEEPERS_NO_STOCKS_STORAGE_KEY = 'groupie.sleepers.noStocks';
const SLEEPERS_MIN_HOURS_STORAGE_KEY = 'groupie.sleepers.minHours';
const DISCOVERY_HOURS_STORAGE_KEY = 'groupie.discovery.hours';
const DISCOVERY_X_WEB_STORAGE_KEY = 'groupie.discovery.xWeb';
const DISCOVERY_NO_BUNDLES_STORAGE_KEY = 'groupie.discovery.noBundles';
const DISCOVERY_NO_STOCKS_STORAGE_KEY = 'groupie.discovery.noStocks';
/** 3h — the shortest duration, and the server's own default (round 14). */
const DEFAULT_SLEEPER_HOURS: SleeperDurationHours = 3;
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
/** Round 21: no member verdict is in flight, and none is waiting for a refetch. */
const NO_VERDICTS: ReadonlySet<number> = new Set<number>();
const NO_MARKS: ReadonlyMap<number, string> = new Map<number, string>();
const NO_PENDING: ReadonlySet<string> = new Set<string>();
/** Design 2b: at this width the board stops being tabs and becomes columns. */
const DESKTOP_MIN_PX = 1100;

type BootState =
  | { kind: 'loading' }
  | { kind: 'ready'; slug: string }
  | { kind: 'no-slug' }
  /** No session and no Mini App: the login wall. `loginAvailable` decides whether it is a real one. */
  | { kind: 'telegram-only'; slug: string; loginAvailable: boolean }
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
        // ...and then sanitized as a WHOLE: the short durations only exist on
        // small bands, so band and duration have to be validated together.
        return sanitizeRangeControls({
          presetIndex,
          customLo: typeof stored.customLo === 'string' ? stored.customLo : '',
          customHi: typeof stored.customHi === 'string' ? stored.customHi : '',
          hours: isRangeHours(stored.hours) ? stored.hours : DEFAULT_CONTROLS.hours,
        });
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

/** Twitter-required is the default view (docs/decisions.md round 9). */
function loadSleepersXOnly(): boolean {
  try {
    return window.localStorage.getItem(SLEEPERS_X_ONLY_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

function saveSleepersXOnly(value: boolean): void {
  try {
    window.localStorage.setItem(SLEEPERS_X_ONLY_STORAGE_KEY, value ? '1' : '0');
  } catch {
    // Persisting the preference is best-effort.
  }
}

/**
 * Tokenized stocks are excluded by default (docs/decisions.md round 17): the
 * upper bands are otherwise nothing but Robinhood's equity tokens, which hold a
 * market-cap band because they are securities, not because anyone is quietly
 * accumulating them.
 */
function loadSleepersNoStocks(): boolean {
  try {
    return window.localStorage.getItem(SLEEPERS_NO_STOCKS_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

function saveSleepersNoStocks(value: boolean): void {
  try {
    window.localStorage.setItem(SLEEPERS_NO_STOCKS_STORAGE_KEY, value ? '1' : '0');
  } catch {
    // Persisting the preference is best-effort.
  }
}

/** Re-validated against the tuple: the stored value is user-editable. */
function loadSleepersMinHours(): SleeperDurationHours {
  try {
    const value = Number(window.localStorage.getItem(SLEEPERS_MIN_HOURS_STORAGE_KEY));
    if ((SLEEPER_DURATIONS_HOURS as readonly number[]).includes(value)) {
      return value as SleeperDurationHours;
    }
  } catch {
    // Private mode / disabled storage: fall back to the default.
  }
  return DEFAULT_SLEEPER_HOURS;
}

function saveSleepersMinHours(value: SleeperDurationHours): void {
  try {
    window.localStorage.setItem(SLEEPERS_MIN_HOURS_STORAGE_KEY, String(value));
  } catch {
    // Persisting the preference is best-effort.
  }
}

/**
 * The three discovery filters (docs/decisions.md round 20), all ON by default.
 *
 * Each one is stored, toggled AND requested separately: the endpoint takes three
 * flags (`xweb`, `bundles`, `stocks`), so a chip is exactly one filter and the
 * payload echoes back the set it applied. The view prints that echo, never the
 * chips.
 */
function loadDiscoveryFlag(key: string): boolean {
  try {
    return parseDiscoveryFlag(window.localStorage.getItem(key));
  } catch {
    return true;
  }
}

function saveDiscoveryFlag(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // Persisting the preference is best-effort.
  }
}

/** Re-validated against the tuple: the stored value is user-editable. */
function loadDiscoveryHours(): DiscoveryHours {
  try {
    return parseDiscoveryHours(window.localStorage.getItem(DISCOVERY_HOURS_STORAGE_KEY));
  } catch {
    // Private mode / disabled storage: fall back to the default.
    return parseDiscoveryHours(null);
  }
}

function saveDiscoveryHours(value: DiscoveryHours): void {
  try {
    window.localStorage.setItem(DISCOVERY_HOURS_STORAGE_KEY, String(value));
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
 * Read a one-shot flag the server set on a redirect (`?handoff=expired` for a
 * dead handoff link, `?login=failed` for an OIDC round trip that did not
 * complete) and strip it from the address bar, so a reload does not keep
 * announcing it. Runs at import — exactly once, unlike a StrictMode-doubled
 * render.
 */
function takeQueryFlag(key: string, value: string): boolean {
  if (typeof window === 'undefined') return false;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(window.location.search);
  } catch {
    return false;
  }
  if (params.get(key) !== value) return false;
  try {
    params.delete(key);
    const query = params.toString();
    const { pathname, hash } = window.location;
    window.history.replaceState(null, '', `${pathname}${query ? `?${query}` : ''}${hash}`);
  } catch {
    // A tidy address bar is a nicety; the explanation below is the point.
  }
  return true;
}

const HANDOFF_EXPIRED = takeQueryFlag('handoff', 'expired');
const LOGIN_FAILED = takeQueryFlag('login', 'failed');

/** Feature flag only, and it fails closed: an unreachable server shows the old wall. */
async function loginAvailable(): Promise<boolean> {
  try {
    return (await fetchTelegramLoginAvailable()).available === true;
  } catch {
    return false;
  }
}

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
    // A handoff redemption (or an earlier visit) may already have left a valid
    // session cookie — check for it BEFORE deciding the browser needs a login
    // path, or a freshly handed-off member lands on the login wall.
    let hasSession = false;
    try {
      await fetchMe();
      hasSession = true;
    } catch {
      // No session; fall through to the dev-login attempt.
    }
    if (!hasSession) {
      try {
        await authDev();
      } catch (err) {
        // No dev session endpoint (i.e. prod): this browser has to log in. Ask
        // the server whether it can actually offer a login before we promise one.
        if (err instanceof ApiError && (err.status === 404 || err.status === 401 || err.status === 501)) {
          return { kind: 'telegram-only', slug, loginAvailable: await loginAvailable() };
        }
        return { kind: 'blocked', title: 'Sign-in failed', message: describe(err), retry: true };
      }
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
  /**
   * The member verdict's optimistic half (docs/decisions.md round 21), mirroring
   * the bin machinery: `markedDead` maps a call to the instant it was
   * pronounced (so the card can move to DIED with a death stamp), `restored`
   * holds the ones just put back, and both are cleared by the refetch that
   * makes them real. `verdictPending` is what greys the pill in flight.
   */
  const [markedDead, setMarkedDead] = useState<ReadonlyMap<number, string>>(NO_MARKS);
  const [restored, setRestored] = useState<ReadonlySet<number>>(NO_VERDICTS);
  const [verdictPending, setVerdictPending] = useState<ReadonlySet<number>>(NO_VERDICTS);
  /**
   * Addresses whose watch toggle is in flight (round 16). Keyed by ADDRESS, not
   * by tokenId: a Sleepers lead has no tokenId, and the same coin can be toggled
   * from two surfaces at once — same coin, same key, no clobber.
   */
  const [watchPending, setWatchPending] = useState<ReadonlySet<string>>(NO_PENDING);
  const [actionError, setActionError] = useState<string | null>(null);
  const [handoffPending, setHandoffPending] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [rangeControls, setRangeControls] = useState<RangeControls>(loadRangeControls);
  const [range, setRange] = useState<RangeBoardResponse | null>(null);
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [rangeLoading, setRangeLoading] = useState(false);
  // Sleepers lives in memory only: it is a 3-hourly snapshot of the whole
  // chain, not this group's board, so there is nothing to cache across reloads.
  const [sleepersXOnly, setSleepersXOnly] = useState<boolean>(loadSleepersXOnly);
  const [sleepersNoStocks, setSleepersNoStocks] = useState<boolean>(loadSleepersNoStocks);
  const [sleepersMinHours, setSleepersMinHours] =
    useState<SleeperDurationHours>(loadSleepersMinHours);
  const [sleepers, setSleepers] = useState<SleepersResponse | null>(null);
  const [sleepersError, setSleepersError] = useState<string | null>(null);
  const [sleepersLoading, setSleepersLoading] = useState(false);
  // Discovery is the chain's own feed (rounds 18 and 20): like Sleepers it is a
  // snapshot of something outside this group, so it lives in memory only.
  const [discoveryHours, setDiscoveryHours] = useState<DiscoveryHours>(loadDiscoveryHours);
  const [discoveryXWeb, setDiscoveryXWeb] = useState<boolean>(() =>
    loadDiscoveryFlag(DISCOVERY_X_WEB_STORAGE_KEY),
  );
  const [discoveryNoBundles, setDiscoveryNoBundles] = useState<boolean>(() =>
    loadDiscoveryFlag(DISCOVERY_NO_BUNDLES_STORAGE_KEY),
  );
  const [discoveryNoStocks, setDiscoveryNoStocks] = useState<boolean>(() =>
    loadDiscoveryFlag(DISCOVERY_NO_STOCKS_STORAGE_KEY),
  );
  const [discovery, setDiscovery] = useState<DiscoveryResponse | null>(null);
  /**
   * When the payload on screen landed, on THIS machine's clock. The stall line
   * is judged against it rather than against `now`, so a backgrounded tab or a
   * clock that jumped never turns our own silence into a verdict on the chain
   * listener (see `feedStatusText`).
   */
  const [discoveryFetchedAt, setDiscoveryFetchedAt] = useState<number | null>(null);
  /** The server's own instant for that payload (its Date header), or null. */
  const [discoveryServerAt, setDiscoveryServerAt] = useState<number | null>(null);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  /**
   * UPCOMING (round 23) — the tracked X accounts. Like Discovery it is a poller's
   * snapshot with no live frame behind it, so it lives in memory and carries the
   * two instants its stall verdict is read against.
   */
  const [upcoming, setUpcoming] = useState<ProjectsResponse | null>(null);
  const [upcomingFetchedAt, setUpcomingFetchedAt] = useState<number | null>(null);
  const [upcomingServerAt, setUpcomingServerAt] = useState<number | null>(null);
  const [upcomingError, setUpcomingError] = useState<string | null>(null);
  const [upcomingLoading, setUpcomingLoading] = useState(false);
  const [trackPending, setTrackPending] = useState(false);
  /** Monitors whose DELETE is in flight, and the ones it has optimistically removed. */
  const [untrackPending, setUntrackPending] = useState<ReadonlySet<number>>(NO_VERDICTS);
  const [untracked, setUntracked] = useState<ReadonlySet<number>>(NO_VERDICTS);

  const slug = boot.kind === 'ready' ? boot.slug : null;
  const slugRef = useRef<string | null>(null);
  /**
   * The three verdict overlays, as the board LOAD sees them: a refetch is
   * asynchronous, so it has to settle against the calls that are in flight at
   * the instant its payload lands, not the ones that were when it started.
   */
  const markedDeadRef = useRef(markedDead);
  markedDeadRef.current = markedDead;
  const restoredRef = useRef(restored);
  restoredRef.current = restored;
  const verdictPendingRef = useRef(verdictPending);
  verdictPendingRef.current = verdictPending;
  const windowRef = useRef<BoardWindow>(boardWindow);
  const lastLoadRef = useRef(0);
  const loadSeqRef = useRef(0);
  const debounceRef = useRef<number | null>(null);
  const rangeSeqRef = useRef(0);
  const rangeQueryRef = useRef<RangeQuery | null>(null);
  const sleepersSeqRef = useRef(0);
  const sleepersXOnlyRef = useRef(sleepersXOnly);
  sleepersXOnlyRef.current = sleepersXOnly;
  const sleepersNoStocksRef = useRef(sleepersNoStocks);
  sleepersNoStocksRef.current = sleepersNoStocks;
  const sleepersMinHoursRef = useRef(sleepersMinHours);
  sleepersMinHoursRef.current = sleepersMinHours;
  const discoverySeqRef = useRef(0);
  /** Set by a failed chip reload's snap-back; the load effect consumes it once. */
  const discoverySkipLoadRef = useRef(false);
  const discoveryHoursRef = useRef(discoveryHours);
  discoveryHoursRef.current = discoveryHours;
  /**
   * One chip, one flag, one query parameter (round 20's three filters). The
   * object identity changes on every render, which is exactly why it is a ref:
   * the load effect keys off the three booleans below, never off this.
   */
  const discoveryFilters = useMemo<DiscoveryFilters>(
    () => ({ xWeb: discoveryXWeb, noBundles: discoveryNoBundles, noStocks: discoveryNoStocks }),
    [discoveryXWeb, discoveryNoBundles, discoveryNoStocks],
  );
  const discoveryFiltersRef = useRef(discoveryFilters);
  discoveryFiltersRef.current = discoveryFilters;
  // "Has this view ever loaded?" — a watch toggle only refreshes what is there.
  const rangeRef = useRef<RangeBoardResponse | null>(null);
  rangeRef.current = range;
  const sleepersRef = useRef<SleepersResponse | null>(null);
  sleepersRef.current = sleepers;
  const discoveryRef = useRef<DiscoveryResponse | null>(null);
  discoveryRef.current = discovery;
  const upcomingSeqRef = useRef(0);
  const upcomingRef = useRef<ProjectsResponse | null>(null);
  upcomingRef.current = upcoming;
  /** Read by the load that settles optimistic removals against what is in flight. */
  const untrackPendingRef = useRef(untrackPending);
  untrackPendingRef.current = untrackPending;
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
    if (!currentSlug) return false;
    lastLoadRef.current = Date.now();
    // Latest-wins: a slower earlier response (window switch, or a refetch that
    // began before a bin committed) must not overwrite a newer one.
    const seq = ++loadSeqRef.current;
    if (options.silent) setRevalidating(true);
    else setLoading(true);
    try {
      const data = await fetchBoard(currentSlug, windowRef.current);
      if (seq !== loadSeqRef.current) return false;
      paintedRef.current = true;
      setBoard(data);
      writeCachedBoard(currentSlug, windowRef.current, data);
      setBoardError(null);
      setHidden(NO_HIDDEN);
      // The payload IS the verdict now — including whose name is on it — for
      // every call the server has already answered. One still in flight keeps
      // its overlay: this refetch cannot have seen a request that is still open.
      const settled = settleVerdicts(
        markedDeadRef.current,
        restoredRef.current,
        verdictPendingRef.current,
      );
      setMarkedDead(settled.markedDead);
      setRestored(settled.restored);
      setNow(Date.now());
      // True only when THIS load painted: a verdict's follow-up refetch drops
      // its optimistic overlay on that answer alone, never on a load that was
      // superseded or failed (which would repaint a card the server has killed).
      return true;
    } catch (err) {
      if (seq !== loadSeqRef.current) return false;
      if (err instanceof ApiError && err.status === 403) {
        setBoot({
          kind: 'blocked',
          title: 'No access',
          message: 'You are not a member of this group.',
          retry: false,
        });
        return false;
      }
      if (err instanceof ApiError && err.status === 401) {
        setBoot({
          kind: 'blocked',
          title: 'Session expired',
          message: 'Open the board again from your group’s pinned link.',
          retry: true,
        });
        return false;
      }
      if (err instanceof ApiError && err.status === 404) {
        setBoot({
          kind: 'blocked',
          title: 'Board not found',
          message: 'That link does not match a group overseer is tracking.',
          retry: false,
        });
        return false;
      }
      setBoardError(describe(err));
      return false;
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

  const loadSleepers = useCallback(
    async (
      xOnly: boolean,
      noStocks: boolean,
      minHours: SleeperDurationHours,
      options: { silent?: boolean } = {},
    ) => {
      const currentSlug = slugRef.current;
      if (!currentSlug) return;
      // Latest-wins, exactly like the board and ranging: a slow answer for the
      // filter the user just left must not overwrite the one on screen.
      const seq = ++sleepersSeqRef.current;
      if (!options.silent) setSleepersLoading(true);
      try {
        const data = await fetchSleepers(currentSlug, !xOnly, !noStocks, minHours);
        if (seq !== sleepersSeqRef.current) return;
        setSleepers(data);
        setSleepersError(null);
      } catch (err) {
        if (seq !== sleepersSeqRef.current) return;
        setSleepersError(describe(err));
      } finally {
        if (!options.silent && seq === sleepersSeqRef.current) setSleepersLoading(false);
      }
    },
    [],
  );

  const loadDiscovery = useCallback(
    async (
      hours: DiscoveryHours,
      filters: DiscoveryFilters,
      options: { silent?: boolean } = {},
    ) => {
      const currentSlug = slugRef.current;
      if (!currentSlug) return;
      // Latest-wins, exactly like the board and the other two views.
      const seq = ++discoverySeqRef.current;
      if (!options.silent) setDiscoveryLoading(true);
      try {
        // Both kinds in one request: the view draws both zones, and one payload
        // is what lets the footnote describe a single set of applied filters.
        const { body: data, serverAt } = await fetchDiscovery(currentSlug, {
          kind: 'all',
          hours,
          filters,
        });
        if (seq !== discoverySeqRef.current) return;
        setDiscovery(data);
        // Stamped from the client clock at the instant the response landed: it
        // dates THIS payload, which is what the stall verdict is measured from.
        // The server's own instant rides along so that verdict can read the
        // server's `lastTickAt` against the server's clock, not this device's.
        setDiscoveryFetchedAt(Date.now());
        setDiscoveryServerAt(serverAt);
        setDiscoveryError(null);
      } catch (err) {
        if (seq !== discoverySeqRef.current) return;
        setDiscoveryError(describe(err));
        // A chip is a REQUEST, and a request that failed changed nothing: the
        // payload on screen is still the old one. The flags snap back to the
        // filters that payload applied, so `aria-pressed` cannot claim a cut the
        // rows below it never had. (Mid-flight the optimistic chip stands.)
        // Only the on-screen state snaps back: the STORED preference is what
        // the member chose, and a network blip is not a choice. The snap-back
        // render must not fire a second request either — the load effect skips
        // exactly one run for it.
        const restore = filtersAfterFailedReload(filters, discoveryRef.current);
        if (restore) {
          discoverySkipLoadRef.current = true;
          setDiscoveryXWeb(restore.xWeb);
          setDiscoveryNoBundles(restore.noBundles);
          setDiscoveryNoStocks(restore.noStocks);
        }
      } finally {
        if (!options.silent && seq === discoverySeqRef.current) setDiscoveryLoading(false);
      }
    },
    [],
  );

  const loadUpcoming = useCallback(async (options: { silent?: boolean } = {}) => {
    const currentSlug = slugRef.current;
    if (!currentSlug) return false;
    // Latest-wins, exactly like the board and the other views.
    const seq = ++upcomingSeqRef.current;
    if (!options.silent) setUpcomingLoading(true);
    try {
      const { body: data, serverAt } = await fetchUpcoming(currentSlug);
      if (seq !== upcomingSeqRef.current) return false;
      setUpcoming(data);
      // Stamped from the client clock at the instant the response landed: it
      // dates THIS payload, which is what the stall verdict is measured from.
      // The server's own instant rides along so that verdict can read the
      // server's `lastCheckAt` against the server's clock, not this device's.
      setUpcomingFetchedAt(Date.now());
      setUpcomingServerAt(serverAt);
      setUpcomingError(null);
      // The payload IS the list now: an optimistic removal that this response
      // has already answered stops being an overlay. One still in flight keeps
      // its own, because this read cannot have seen a request that is still open.
      setUntracked((prev) => {
        if (prev.size === 0) return prev;
        const pendingNow = untrackPendingRef.current;
        const next = new Set([...prev].filter((id) => pendingNow.has(id)));
        return next.size === prev.size ? prev : next;
      });
      return true;
    } catch (err) {
      if (seq !== upcomingSeqRef.current) return false;
      setUpcomingError(describe(err));
      return false;
    } finally {
      if (!options.silent && seq === upcomingSeqRef.current) setUpcomingLoading(false);
    }
  }, []);

  /** Fixed for the life of the page: the launch payload only exists in the webview. */
  const inTelegram = useMemo(() => tgInitData() !== null, []);
  const layout = useLayoutMode(inTelegram);
  const desktop = layout === 'desktop';
  const rangeBand = useMemo(() => resolveBand(rangeControls), [rangeControls]);
  const rangingActive = section === 'ranging';
  const sleepersActive = section === 'sleepers';
  const discoveryActive = section === 'discovery';
  const upcomingActive = section === 'upcoming';
  /**
   * A full VIEW is open — one of the four surfaces that replace the board rather
   * than sitting beside it. On desktop that is what decides whether the right
   * rail exists at all, and therefore whether its summary cards are worth
   * polling for.
   */
  const viewOpen = rangingActive || sleepersActive || discoveryActive || upcomingActive;
  const rangeHours = rangeControls.hours;
  const customBand = rangeControls.presetIndex === null;

  // Ranging is analytical, not live: it loads when its tab is open, when a
  // control changes, and on tab focus — never off an SSE event.
  //
  // Round 15 adds the desktop board itself as a reason to load: its rail
  // carries a Ranging summary that could only ever say "open the tab to scan
  // for coilers", because nothing had fetched the data. One analytical query
  // per board load fills it in.
  const rangingNeeded = rangingActive || layout === 'desktop';
  useEffect(() => {
    if (!slug || !rangingNeeded) return;
    rangeQueryRef.current = rangeBand === null ? null : { band: rangeBand, hours: rangeHours };
    if (rangeBand === null) return;
    const query: RangeQuery = { band: rangeBand, hours: rangeHours };
    const id = window.setTimeout(() => void loadRange(query), customBand ? RANGE_DEBOUNCE_MS : 0);
    return () => window.clearTimeout(id);
  }, [slug, rangingNeeded, rangeBand, rangeHours, customBand, loadRange]);

  // Sleepers is a 3-hourly server snapshot, so it never rides the live stream:
  // it loads when its view opens, when a filter changes, and on focus.
  //
  // Design pass 2 adds the desktop board as a reason to load it: the right rail
  // draws the bands as a count strip, which could only ever have said "open the
  // view" while nothing had fetched the scan. One snapshot query per board load
  // fills it in — the same trade round 15 made for the Ranging summary.
  const sleepersNeeded = sleepersActive || layout === 'desktop';
  useEffect(() => {
    if (!slug || !sleepersNeeded) return;
    void loadSleepers(sleepersXOnly, sleepersNoStocks, sleepersMinHours);
  }, [
    slug,
    sleepersNeeded,
    sleepersXOnly,
    sleepersNoStocks,
    sleepersMinHours,
    loadSleepers,
  ]);

  // Discovery is an on-chain feed, not a live board: it loads when its view
  // opens, when a control changes, and on focus — plus once per board load on
  // desktop, which is what fills the rail's summary card.
  //
  // "Needed" means MOUNTED, not "the window is wide": the desktop rail card only
  // exists once the board has painted, and it is replaced entirely while RANGING
  // or SLEEPERS owns the view. Polling for a card nobody is looking at is a
  // request every two minutes that no pixel is waiting for.
  const railMounted = layout === 'desktop' && board !== null && !viewOpen;
  const discoveryNeeded = discoveryActive || railMounted;
  useEffect(() => {
    if (!slug || !discoveryNeeded) return;
    // A failed chip reload snaps the flags back to the payload on screen; that
    // render is a correction, not a request, and issues no fetch.
    if (discoverySkipLoadRef.current) {
      discoverySkipLoadRef.current = false;
      return;
    }
    void loadDiscovery(discoveryHours, discoveryFiltersRef.current);
  }, [slug, discoveryNeeded, discoveryHours, discoveryXWeb, discoveryNoBundles, discoveryNoStocks, loadDiscovery]);

  /**
   * ...and then keeps itself current while the surface is on screen. The server
   * publishes no discovery frame, so a poll is the only thing between an open
   * DISCOVERY view (or the desktop rail card) and a launch that happened five
   * minutes ago. Silent, and never while the document is hidden: a backgrounded
   * tab has nobody reading it, and the focus handler above already refreshes on
   * the way back.
   */
  useEffect(() => {
    if (!slug || !discoveryNeeded) return;
    const id = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void loadDiscovery(discoveryHoursRef.current, discoveryFiltersRef.current, { silent: true });
    }, DISCOVERY_POLL_MS);
    return () => window.clearInterval(id);
  }, [slug, discoveryNeeded, loadDiscovery]);

  /**
   * UPCOMING follows Discovery exactly (round 23): the X watcher polls on the
   * server and publishes no frame, so the open view — or the desktop rail card —
   * is kept current by a two-minute poll of its own, and by the focus handler
   * below. "Needed" means MOUNTED, not "the window is wide".
   */
  const upcomingNeeded = upcomingActive || railMounted;
  useEffect(() => {
    if (!slug || !upcomingNeeded) return;
    void loadUpcoming();
  }, [slug, upcomingNeeded, loadUpcoming]);

  useEffect(() => {
    if (!slug || !upcomingNeeded) return;
    const id = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void loadUpcoming({ silent: true });
    }, UPCOMING_POLL_MS);
    return () => window.clearInterval(id);
  }, [slug, upcomingNeeded, loadUpcoming]);

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
  //
  // Discovery is deliberately absent here: it is the CHAIN's feed, the server
  // publishes no frame for it, and the poll above is what keeps it current.
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
      if (rangingNeeded && query) void loadRange(query, { silent: true });
      if (sleepersNeeded) {
        void loadSleepers(
          sleepersXOnlyRef.current,
          sleepersNoStocksRef.current,
          sleepersMinHoursRef.current,
          { silent: true },
        );
      }
      if (discoveryNeeded) {
        void loadDiscovery(discoveryHoursRef.current, discoveryFiltersRef.current, {
          silent: true,
        });
      }
      if (upcomingNeeded) void loadUpcoming({ silent: true });
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [
    slug,
    loadBoard,
    loadRange,
    loadSleepers,
    loadDiscovery,
    loadUpcoming,
    rangingNeeded,
    sleepersNeeded,
    discoveryNeeded,
    upcomingNeeded,
  ]);

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

  const onSleepersXOnly = useCallback((next: boolean) => {
    setSleepersXOnly(next);
    saveSleepersXOnly(next);
  }, []);

  const onSleepersNoStocks = useCallback((next: boolean) => {
    setSleepersNoStocks(next);
    saveSleepersNoStocks(next);
  }, []);

  const onSleepersMinHours = useCallback((next: SleeperDurationHours) => {
    setSleepersMinHours(next);
    saveSleepersMinHours(next);
  }, []);

  const onDiscoveryHours = useCallback((next: DiscoveryHours) => {
    setDiscoveryHours(next);
    saveDiscoveryHours(next);
  }, []);

  const onDiscoveryXWeb = useCallback((next: boolean) => {
    setDiscoveryXWeb(next);
    saveDiscoveryFlag(DISCOVERY_X_WEB_STORAGE_KEY, next);
  }, []);

  const onDiscoveryNoBundles = useCallback((next: boolean) => {
    setDiscoveryNoBundles(next);
    saveDiscoveryFlag(DISCOVERY_NO_BUNDLES_STORAGE_KEY, next);
  }, []);

  const onDiscoveryNoStocks = useCallback((next: boolean) => {
    setDiscoveryNoStocks(next);
    saveDiscoveryFlag(DISCOVERY_NO_STOCKS_STORAGE_KEY, next);
  }, []);

  const onDiscoveryRetry = useCallback(() => {
    void loadDiscovery(discoveryHoursRef.current, discoveryFiltersRef.current);
  }, [loadDiscovery]);

  const onSleepersRetry = useCallback(() => {
    void loadSleepers(
      sleepersXOnlyRef.current,
      sleepersNoStocksRef.current,
      sleepersMinHoursRef.current,
    );
  }, [loadSleepers]);

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
   * The member verdict (docs/decisions.md round 21).
   *
   * MARK DEAD is group-wide and instant, exactly like binning — but unlike
   * binning it does not ask with a modal: the pill itself asks (one tap arms
   * SURE?, the second fires), because it lives in a hover strip that a dialog
   * would take away. The card moves to DIED optimistically reading "marked dead
   * by you", and the refetch replaces that with the server's own name.
   *
   * A failure puts the card back exactly where it was and says why.
   */
  const runVerdict = useCallback(
    async (card: BoardCard, mode: 'mark' | 'restore') => {
      const currentSlug = slugRef.current;
      if (!currentSlug) return;
      const label = card.symbol ? `$${card.symbol}` : shortAddress(card.address);
      const callId = card.callId;
      const at = new Date().toISOString();

      setVerdictPending((prev) => {
        const next = new Set(prev);
        next.add(callId);
        return next;
      });
      setActionError(null);
      // The two overlays are opposites: pronouncing clears a pending restore of
      // the same call, and restoring clears a pending death.
      if (mode === 'mark') {
        setMarkedDead((prev) => {
          const next = new Map(prev);
          next.set(callId, at);
          return next;
        });
        setRestored((prev) => {
          if (!prev.has(callId)) return prev;
          const next = new Set(prev);
          next.delete(callId);
          return next;
        });
      } else {
        setRestored((prev) => {
          const next = new Set(prev);
          next.add(callId);
          return next;
        });
        setMarkedDead((prev) => {
          if (!prev.has(callId)) return prev;
          const next = new Map(prev);
          next.delete(callId);
          return next;
        });
      }

      // Drops this call's overlay — a rollback after a failure, and a handover
      // after a success, because the payload that just landed says it better
      // than we can. An overlay that outlived its payload would repaint a death
      // a member has since undone from the chat.
      const dropOverlay = () => {
        if (mode === 'mark') {
          setMarkedDead((prev) => {
            if (!prev.has(callId)) return prev;
            const next = new Map(prev);
            next.delete(callId);
            return next;
          });
        } else {
          setRestored((prev) => {
            if (!prev.has(callId)) return prev;
            const next = new Set(prev);
            next.delete(callId);
            return next;
          });
        }
      };

      try {
        if (mode === 'mark') await markDead(currentSlug, callId);
        else await restoreCall(currentSlug, callId);
        // RANGING draws its own payload, and a call this verdict just killed is
        // still in it — so the view a verdict was pronounced FROM has to be
        // re-read alongside the board (round 21 amendment (e)).
        const query = rangeQueryRef.current;
        const [painted] = await Promise.all([
          loadBoard({ silent: true }),
          query && rangeRef.current ? loadRange(query, { silent: true }) : null,
        ]);
        // A load that did not paint (superseded, or failed and swallowed) has
        // not replaced the overlay with the server's answer; the overlay stays
        // up and the next successful load settles it.
        if (painted === true) dropOverlay();
      } catch (err) {
        // The board on screen is what the server still says, and a 409 means
        // someone (or a rule) already answered this.
        dropOverlay();
        setActionError(
          mode === 'mark'
            ? `Could not mark ${label} dead. ${describe(err)}`
            : `Could not restore ${label}. ${describe(err)}`,
        );
      } finally {
        setVerdictPending((prev) => {
          if (!prev.has(callId)) return prev;
          const next = new Set(prev);
          next.delete(callId);
          return next;
        });
      }
    },
    [loadBoard, loadRange],
  );

  const deadProps = useMemo<DeadProps>(
    () => ({
      onMarkDead: (card: BoardCard) => void runVerdict(card, 'mark'),
      onRestore: (card: BoardCard) => void runVerdict(card, 'restore'),
      pending: verdictPending,
    }),
    [runVerdict, verdictPending],
  );

  /**
   * The watch toggle (docs/decisions.md rounds 15 and 16). Watching turns on the
   * group's Telegram alerts for a coin, so this is a group-wide action like
   * binning — and deliberately NOT optimistic: the server owns the per-member
   * cap, so the only honest "watching" state is the one it hands back on the
   * refetch. The pending pill covers the round trip.
   *
   * A coin with a call routes to the card endpoint; a coin without one (a
   * Sleepers lead) goes by address, which upserts the token exactly as
   * `/overseer watch <ca>` does. After it lands, every loaded surface that
   * carries watch state is refreshed — the board, and the two analytical views
   * if they have data — so a pill toggled on one surface is not stale on another.
   */
  const onWatch = useCallback(
    async (target: WatchTarget, next: boolean) => {
      const currentSlug = slugRef.current;
      if (!currentSlug) return;
      const label = target.symbol ? `$${target.symbol}` : shortAddress(target.address);
      const key = watchKey(target.address);
      setWatchPending((prev) => {
        const set = new Set(prev);
        set.add(key);
        return set;
      });
      setActionError(null);
      try {
        if (target.tokenId !== null) await setWatch(currentSlug, target.tokenId, next);
        else await setWatchByAddress(currentSlug, target.address, next);
        // The pill stays pending until EVERY surface that draws this coin has
        // re-read its own payload: a Sleepers row or a Range card reads its
        // watch state from its own response, so clearing on the board alone
        // re-enables a pill that still says WATCH — and a second click is a
        // 409 for a coin the member has just watched.
        const query = rangeQueryRef.current;
        await Promise.all([
          loadBoard({ silent: true }),
          query && rangeRef.current ? loadRange(query, { silent: true }) : null,
          sleepersRef.current
            ? loadSleepers(
                sleepersXOnlyRef.current,
                sleepersNoStocksRef.current,
                sleepersMinHoursRef.current,
                { silent: true },
              )
            : null,
          discoveryRef.current
            ? loadDiscovery(discoveryHoursRef.current, discoveryFiltersRef.current, {
                silent: true,
              })
            : null,
        ]);
      } catch (err) {
        // The cap refusal arrives as a 409 whose message is the friendly
        // sentence the bot sends; describe() surfaces it verbatim.
        setActionError(
          next ? `Could not watch ${label}. ${describe(err)}` : `Could not unwatch ${label}. ${describe(err)}`,
        );
      } finally {
        // Functional clear, and only OUR key: another coin's toggle may have
        // started while this one was in flight.
        setWatchPending((prev) => {
          if (!prev.has(key)) return prev;
          const set = new Set(prev);
          set.delete(key);
          return set;
        });
      }
    },
    [loadBoard, loadRange, loadSleepers, loadDiscovery],
  );

  const watchProps = useMemo<WatchProps>(
    () => ({ onWatch: (target, next) => void onWatch(target, next), pending: watchPending }),
    [onWatch, watchPending],
  );

  /**
   * Track an X account from the web (docs/decisions.md round 23) — the same
   * thing `/overseer track @handle` does, and the same refusals: a cap that is
   * full, a handle already tracked, a handle X does not know. Not optimistic:
   * the server owns both caps and is the only thing that can resolve a handle,
   * so the only honest row is the one it hands back on the refetch.
   *
   * Resolves true only when the monitor was actually created, which is the
   * field's cue to clear itself.
   */
  const onTrack = useCallback(
    async (handle: string, note: string): Promise<boolean> => {
      const currentSlug = slugRef.current;
      if (!currentSlug) return false;
      setTrackPending(true);
      setActionError(null);
      try {
        await trackProject(currentSlug, note ? { handle, note } : { handle });
        await loadUpcoming({ silent: true });
        return true;
      } catch (err) {
        // 409 (capped / already tracked) and 404 (no such account) both arrive
        // with the server's own sentence; describe() surfaces it verbatim.
        setActionError(`Could not track @${handle}. ${describe(err)}`);
        return false;
      } finally {
        setTrackPending(false);
      }
    },
    [loadUpcoming],
  );

  /**
   * ...and remove one, which any member may do. This one IS optimistic — the row
   * disappears the moment the request goes out, because there is no cap to
   * arbitrate and nothing else on screen depends on it. A failure puts it back
   * and says why.
   */
  const onUntrack = useCallback(
    async (entry: ProjectEntry) => {
      const currentSlug = slugRef.current;
      if (!currentSlug) return;
      const id = entry.id;
      setUntrackPending((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      setUntracked((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      setActionError(null);
      try {
        await untrackProject(currentSlug, id);
        // The refetch is what makes it real. A load that PAINTED has replaced
        // the overlay with the server's own list, so the overlay comes down; one
        // that was superseded (or failed) leaves it up until the next read.
        const painted = await loadUpcoming({ silent: true });
        if (painted) {
          setUntracked((prev) => {
            if (!prev.has(id)) return prev;
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        }
      } catch (err) {
        setUntracked((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        setActionError(`Could not untrack @${entry.handle}. ${describe(err)}`);
      } finally {
        setUntrackPending((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [loadUpcoming],
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

  /**
   * The board as the reader's own actions have left it: the server's payload
   * with round 21's optimistic verdicts folded in. Everything that DRAWS reads
   * this; the cache and the fetch layer keep the server's untouched copy, so a
   * pending verdict is never persisted as fact.
   */
  const view = useMemo(
    () => (board === null ? null : applyVerdicts(board, markedDead, restored)),
    [board, markedDead, restored],
  );

  const change = useBoardChange(view);
  // One ceremony line at a time; a second one queues rather than replacing the
  // first. 3G: the coin the PRINTED line names is the row that blooms, so the
  // bloom never appears without the sentence that explains it.
  const announced = useAnnouncementQueue(change.announcements, ANNOUNCEMENT_MS);
  const announcement = announced?.text ?? null;
  const alertedAddress = announced?.address ?? null;
  const pulse = useMemo(
    () => (view ? derivePulse(view, now, hidden) : null),
    [view, now, hidden],
  );
  // The desktop rail's RANGING summary: the top three coilers as band bars
  // (design pass 2, 3A) — the response is sorted by inRangeHours desc.
  const rangeSummary = useMemo<RangeSummary | null>(() => {
    if (!range) return null;
    const span = { lo: range.loUsd, hi: range.hiUsd };
    return {
      count: range.cards.length,
      loUsd: range.loUsd,
      hiUsd: range.hiUsd,
      minHours: range.minHours,
      rows: range.cards.slice(0, 3).map((card) => ({
        callId: card.callId,
        label: card.symbol ? `$${card.symbol}` : shortAddress(card.address),
        hours: card.range.inRangeHours,
        lowPct: (bandPosition(card.range.observedLowUsd, span.lo, span.hi) ?? 0) * 100,
        highPct: (bandPosition(card.range.observedHighUsd, span.lo, span.hi) ?? 0) * 100,
        tickPct: (() => {
          const at = bandPosition(card.mcapUsd, span.lo, span.hi);
          return at === null ? null : at * 100;
        })(),
      })),
    };
  }, [range]);
  // Total entries actually shown, across every band — the SLPRS chip count.
  const sleepersCount = useMemo(
    () => (sleepers ? sleepers.bands.reduce((sum, band) => sum + band.entries.length, 0) : null),
    [sleepers],
  );
  const sleepersSummary = useMemo<SleepersSummary | null>(() => {
    if (!sleepers) return null;
    return {
      total: sleepers.bands.reduce((sum, band) => sum + band.entries.length, 0),
      bands: sleepers.bands.map((band) => ({
        // Round 17 put seven bands in a 330px rail: the legend prints each
        // band's FLOOR without the dollar sign (50K · 100K · … · 5M), which is
        // the only part that distinguishes one segment from the next.
        label: fmtUsd(band.loUsd).replace('$', ''),
        count: band.entries.length,
      })),
      refreshedAt: sleepers.refreshedAt,
      // Both flags read off the payload, never the toggles: this line describes
      // the numbers in the strip, and a toggle flipped mid-flight (or a refetch
      // that failed, leaving the old payload in place) has not changed them yet.
      xOnly: sleepers.xOnly,
      excludeStocks: sleepers.excludeStocks,
      minHoursLabel: SLEEPER_DURATION_LABELS[sleepers.minHours],
    };
  }, [sleepers]);

  /**
   * The DSCVR chip's count and the rail card's numbers. A dormant feed counts
   * nothing — the chip shows an em dash and the card says why, rather than
   * printing a zero nobody can act on.
   */
  const discoveryCount = useMemo(() => discoveryCountOf(discovery), [discovery]);
  const discoverySummary = useMemo(
    () => deriveDiscoverySummary(discovery, discoveryFetchedAt, discoveryServerAt),
    [discovery, discoveryFetchedAt, discoveryServerAt],
  );

  /**
   * UPCOMING as the reader's own actions have left it: the server's payload with
   * the monitors they have just removed taken out. Everything that draws — the
   * view, the chip count, the rail card — reads this, so a row cannot linger in
   * one place after disappearing from another.
   */
  const upcomingView = useMemo<ProjectsResponse | null>(
    () => (upcoming === null ? null : applyUntracked(upcoming, untracked)),
    [upcoming, untracked],
  );
  const upcomingCount = useMemo(() => upcomingCountOf(upcomingView), [upcomingView]);
  const upcomingSummary = useMemo(
    () => deriveUpcomingSummary(upcomingView, upcomingFetchedAt, upcomingServerAt),
    [upcomingView, upcomingFetchedAt, upcomingServerAt],
  );

  // The two analytical views (design pass 2, 3B/3C): controls panel plus
  // results, shared by the desktop full view and the mobile tab body. Only the
  // wayfinding differs — desktop gets the 30px ViewHeader with a breadcrumb,
  // mobile gets the same 46px tone band every other tab has (3F).
  const rangingBody = (
    <Ranging
      controls={rangeControls}
      onControls={onRangeControls}
      band={rangeBand}
      data={range}
      loading={rangeLoading}
      error={rangeError}
      onRetry={onRangeRetry}
      now={now}
      watch={watchProps}
      dead={deadProps}
    />
  );

  // The two Sleepers filters ride together wherever the view is drawn — the
  // desktop view header and the mobile tab band — because either one alone
  // explains only half of what is missing from the bands below.
  const sleepersChips = (
    <>
      <button
        type="button"
        className={`chip chip-x${sleepersXOnly ? ' is-active' : ''}`}
        aria-pressed={sleepersXOnly}
        onClick={() => onSleepersXOnly(!sleepersXOnly)}
      >
        {sleepersXOnly ? 'X only' : 'showing all'}
      </button>
      <button
        type="button"
        className={`chip chip-stocks${sleepersNoStocks ? ' is-active' : ''}`}
        aria-pressed={sleepersNoStocks}
        onClick={() => onSleepersNoStocks(!sleepersNoStocks)}
      >
        {sleepersNoStocks ? 'no stocks' : 'with stocks'}
      </button>
    </>
  );

  // The chips are drawn wherever the layout has room for them: the desktop view
  // header, or — on mobile, where the tone band is 46px and the trust frame owns
  // it — the control panel above the duration chips.
  const sleepersBodyWith = (filterChips: ReactNode) => (
    <Sleepers
      data={sleepers}
      loading={sleepersLoading}
      error={sleepersError}
      onRetry={onSleepersRetry}
      xOnly={sleepersXOnly}
      minHours={sleepersMinHours}
      onMinHours={onSleepersMinHours}
      filterChips={filterChips}
      now={now}
      watch={watchProps}
    />
  );

  /**
   * The discovery filters. Three questions, three chips, three query flags — an
   * X account and a website, the launch-block bundle limit, and tokenized stocks
   * (round 20). One switch each: the chips can no longer disagree with the
   * payload, and the footnote under the zones still reports what the response
   * actually applied rather than what was asked for.
   */
  const discoveryChips = (
    <>
      <button
        type="button"
        className={`chip chip-x${discoveryXWeb ? ' is-active' : ''}`}
        aria-pressed={discoveryXWeb}
        title="Show only coins that have both an X account and a website"
        onClick={() => onDiscoveryXWeb(!discoveryXWeb)}
      >
        {discoveryXWeb ? 'X + web' : 'any socials'}
      </button>
      <button
        type="button"
        className={`chip chip-bundles${discoveryNoBundles ? ' is-active' : ''}`}
        aria-pressed={discoveryNoBundles}
        title="Hide coins whose launch block absorbed a large share of the supply"
        onClick={() => onDiscoveryNoBundles(!discoveryNoBundles)}
      >
        {discoveryNoBundles ? 'no bundles' : 'any launch block'}
      </button>
      <button
        type="button"
        className={`chip chip-stocks${discoveryNoStocks ? ' is-active' : ''}`}
        aria-pressed={discoveryNoStocks}
        title="Hide tokenized stocks, ETFs and leveraged equity products"
        onClick={() => onDiscoveryNoStocks(!discoveryNoStocks)}
      >
        {discoveryNoStocks ? 'no stocks' : 'with stocks'}
      </button>
    </>
  );

  const discoveryBody = (
    <Discovery
      data={discovery}
      loading={discoveryLoading}
      error={discoveryError}
      onRetry={onDiscoveryRetry}
      hours={discoveryHours}
      onHours={onDiscoveryHours}
      filterChips={discoveryChips}
      fetchedAt={discoveryFetchedAt}
      serverAt={discoveryServerAt}
      now={now}
      watch={watchProps}
    />
  );

  const upcomingBody = (
    <Upcoming
      data={upcomingView}
      loading={upcomingLoading}
      error={upcomingError}
      onRetry={() => void loadUpcoming()}
      onTrack={onTrack}
      trackPending={trackPending}
      onUntrack={(entry) => void onUntrack(entry)}
      untrackPending={untrackPending}
      fetchedAt={upcomingFetchedAt}
      serverAt={upcomingServerAt}
      // A launched token gets the same WATCH pill as every other coin in the
      // app (round 16) — and this payload has no watch state, so it comes off
      // the board's own watchlist by address.
      watchlist={view?.watchlist ?? undefined}
      watch={watchProps}
      now={now}
    />
  );

  const rangingPanel = (
    <div className="view">
      <ViewHeader
        title="RANGING"
        sub={
          <>
            {'group calls holding a market-cap band · '}
            <span className="view-hero">time in band is the hero</span>
          </>
        }
        right={
          <span className="view-note">
            analytical — refreshes on control change and focus, not on the live stream
          </span>
        }
        onBack={() => setSection('fresh')}
      />
      {rangingBody}
    </div>
  );

  const sleepersPanel = (
    <div className="view">
      <ViewHeader
        title="SLEEPERS"
        sub={
          <>
            {'chain-wide scan · '}
            <strong className="view-hard">not group calls</strong>
            {sleepers?.refreshedAt ? ` · refreshed ${fmtAge(sleepers.refreshedAt, now)} ago` : ''}
          </>
        }
        right={
          <>
            <span className="view-note">defaults: an X account, no tokenized stocks</span>
            {sleepersChips}
          </>
        }
        onBack={() => setSection('fresh')}
      />
      {sleepersBodyWith(null)}
    </div>
  );

  const discoveryPanel = (
    <div className="view">
      <ViewHeader
        title="DISCOVERY"
        sub={
          <>
            {'chain-wide · '}
            <strong className="view-hard">not group calls</strong>
            {` · ${DISCOVERY_FRAME_TAIL}`}
          </>
        }
        right={<span className="view-note">on-chain events — no market scan, nothing tracked</span>}
        onBack={() => setSection('fresh')}
      />
      {discoveryBody}
    </div>
  );

  const upcomingPanel = (
    <div className="view">
      <ViewHeader
        title="UPCOMING"
        sub={UPCOMING_FRAME_TAIL}
        right={
          <span className="view-note">
            the account&rsquo;s own post — a token that merely names a handle never pings
          </span>
        }
        onBack={() => setSection('fresh')}
      />
      {upcomingBody}
    </div>
  );

  // The keys are load-bearing: the mobile tab bodies all sit in one child slot,
  // so without them React updates a single Zone in place and the tab-in
  // cross-fade never replays.
  const rangingTab = (
    <Zone
      key="ranging"
      tone="cyan"
      headline="RANGING"
      count={range === null ? null : range.cards.length}
      className="zone-tab"
      note={<span className="view-hero">time in band is the hero</span>}
    >
      {rangingBody}
    </Zone>
  );

  const sleepersTab = (
    <Zone
      key="sleepers"
      tone="cyan"
      headline="SLEEPERS"
      count={sleepersCount}
      className="zone-tab"
      /* The band carries the trust frame ALONE: at 375px two chips beside it
         left ~50px for the note, which is not enough to print "not group
         calls". The chips moved into the control panel below; here the frame
         leads, so the scan's age is what an ellipsis eats. */
      note={
        <>
          <strong className="view-hard">not group calls</strong>
          {sleepers?.refreshedAt ? ` · refreshed ${fmtAge(sleepers.refreshedAt, now)} ago` : ''}
        </>
      }
    >
      {sleepersBodyWith(sleepersChips)}
    </Zone>
  );

  const discoveryTab = (
    <Zone
      key="discovery"
      tone="cyan"
      headline="DISCOVERY"
      count={discoveryCount}
      className="zone-tab"
      /* Same rule as the Sleepers band: at 375px the trust frame owns this line
         alone — the chips live in the control panel below. */
      note={
        <>
          <strong className="view-hard">not group calls</strong>
          {` · ${DISCOVERY_FRAME_TAIL}`}
        </>
      }
    >
      {discoveryBody}
    </Zone>
  );

  const upcomingTab = (
    <Zone
      key="upcoming"
      tone="cyan"
      headline="UPCOMING"
      count={upcomingCount}
      className="zone-tab"
      /* Same rule as the Sleepers and Discovery bands: at 375px the trust frame
         owns this line alone — the add field lives in the panel below. */
      note={UPCOMING_FRAME_TAIL}
    >
      {upcomingBody}
    </Zone>
  );

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
    // Both flags are read once at import, so they survive the boot round trip
    // and disappear on the next reload.
    const notices = (
      <>
        {HANDOFF_EXPIRED ? (
          <p className="screen-message" role="status">
            That link expired — tap Full board in Telegram again.
          </p>
        ) : null}
        {LOGIN_FAILED ? (
          <p className="screen-message" role="status">
            Sign-in didn’t complete — try again.
          </p>
        ) : null}
      </>
    );

    // A plain link, not a fetch: the OIDC start leg is a top-level navigation
    // that has to leave our origin and come back.
    if (boot.loginAvailable) {
      return (
        <Screen
          title="Log in to overseer"
          message="Sign in with the Telegram account that is in this group."
        >
          <a className="bridge-btn login-btn" href={telegramLoginUrl(boot.slug)}>
            Log in with Telegram
          </a>
          <p className="screen-note">Or open the board from your group’s pinned link.</p>
          {notices}
        </Screen>
      );
    }

    return (
      <Screen
        title="Log in via Telegram"
        message="This board opens from inside Telegram for now. Tap the pinned board link in your group. Browser login is coming in a later release."
      >
        {notices}
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

  const title = view?.group.title ?? boot.slug;
  const staleBoard =
    view !== null && (view.sections.fresh ?? []).some((card) => isStale(card, now));

  // ---- Telegram half-sheet (design 2a): its own surface, no tabs, one bridge.
  if (layout === 'mini') {
    return (
      <div className="app app-mini">
        <div className="grabber" aria-hidden="true" />
        <header className="head head-mini">
          <span className="head-left">
            <Wordmark />
            <h1 className="group-title" title={title}>
              {title}
            </h1>
          </span>
          <LiveDot state={live} />
        </header>
        {actionError ? (
          <p className="banner banner-error" role="alert">
            {actionError}
          </p>
        ) : null}
        {view && pulse ? (
          <MiniBoard
            board={view}
            now={now}
            hiddenCallIds={hidden}
            pulse={pulse}
            announcement={announcement}
            revalidating={revalidating}
            onFullBoard={() => void onFullBoard()}
            handoffPending={handoffPending}
            watch={watchProps}
            dead={deadProps}
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

  return (
    <div className={`app${desktop ? ' app-desk' : ''}`}>
      <header className={`head${desktop ? ' head-desk' : ''}`}>
        <div className="head-left">
          <Wordmark />
          <span className="head-div" aria-hidden="true" />
          <h1 className="group-title" title={title}>
            {title}
          </h1>
          <LiveDot state={live} />
        </div>
        <div className="head-right">
          {/* 3F puts "data as of" on the mobile header's second line too — it is
              the honesty marker for every number under it, not a stale badge. */}
          {pulse?.asOfMs !== undefined && pulse?.asOfMs !== null ? (
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
          {/* Ranging and Sleepers keep their own clocks (duration chips / the
              3h scan) — the board windows don't apply there, so the chips go
              visibly inert instead of lying about being pressable. */}
          <div
            className={viewOpen ? 'wins-inert' : undefined}
            title={viewOpen ? 'Board time windows don’t apply to this tab' : undefined}
          >
            <WindowSwitcher value={boardWindow} onChange={onWindowChange} />
          </div>
        </div>
      </header>

      {view && pulse ? (
        <Pulse
          data={pulse}
          variant="strip"
          dense={!desktop}
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

        {view ? (
          desktop ? (
            viewOpen ? (
              <div className="desk-view">
                {section === 'sleepers'
                  ? sleepersPanel
                  : section === 'discovery'
                    ? discoveryPanel
                    : section === 'upcoming'
                      ? upcomingPanel
                      : rangingPanel}
              </div>
            ) : (
              <DesktopBoard
                board={view}
                now={now}
                hiddenCallIds={hidden}
                binningId={binningId}
                onBin={onBin}
                watch={watchProps}
                dead={deadProps}
                ceremonies={change.ceremonies}
                moved={change.moved}
                rangeSummary={rangeSummary}
                sleepersSummary={sleepersSummary}
                discoverySummary={discoverySummary}
                upcomingSummary={upcomingSummary}
                onOpenTab={setSection}
                alertedAddress={alertedAddress}
              />
            )
          ) : (
            <Board
              board={view}
              section={section}
              onSection={setSection}
              now={now}
              hiddenCallIds={hidden}
              binningId={binningId}
              onBin={onBin}
              watch={watchProps}
              dead={deadProps}
              ceremonies={change.ceremonies}
              rangingCount={range === null ? null : range.cards.length}
              ranging={rangingTab}
              sleepersCount={sleepersCount}
              sleepers={sleepersTab}
              discoveryCount={discoveryCount}
              discovery={discoveryTab}
              upcomingCount={upcomingCount}
              upcoming={upcomingTab}
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
