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
  eventsUrl,
  fetchBoard,
  fetchMe,
  fetchRange,
} from './api';
import { Board } from './components/Board';
import { DEFAULT_CONTROLS, Ranging, resolveBand } from './components/Ranging';
import type { RangeBand, RangeControls } from './components/Ranging';
import type { SectionKey } from './components/SectionTabs';
import { WINDOWS, WindowSwitcher } from './components/WindowSwitcher';
import { shortAddress } from './format';
import { tgInitData, tgReady, tgStartParam } from './telegram';

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

type BootState =
  | { kind: 'loading' }
  | { kind: 'ready'; slug: string }
  | { kind: 'no-slug' }
  | { kind: 'telegram-only' }
  | { kind: 'blocked'; title: string; message: string; retry: boolean };

type LiveState = 'idle' | 'open' | 'reconnecting';

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

/** Every field is re-validated: the stored blob is user-editable and can predate a preset change. */
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
          customLoK: typeof stored.customLoK === 'string' ? stored.customLoK : '',
          customHiK: typeof stored.customHiK === 'string' ? stored.customHiK : '',
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

export default function App() {
  const [boot, setBoot] = useState<BootState>({ kind: 'loading' });
  const [boardWindow, setBoardWindow] = useState<BoardWindow>(loadWindow);
  const [section, setSection] = useState<SectionKey>('fresh');
  const [board, setBoard] = useState<BoardResponse | null>(null);
  const [boardError, setBoardError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [live, setLive] = useState<LiveState>('idle');
  const [hidden, setHidden] = useState<ReadonlySet<number>>(NO_HIDDEN);
  const [binningId, setBinningId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
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
    if (!options.silent) setLoading(true);
    try {
      const data = await fetchBoard(currentSlug, windowRef.current);
      if (seq !== loadSeqRef.current) return;
      setBoard(data);
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
          message: 'That link does not match a group Groupie is tracking.',
          retry: false,
        });
        return;
      }
      setBoardError(describe(err));
    } finally {
      if (!options.silent && seq === loadSeqRef.current) setLoading(false);
    }
  }, []);

  // Load on slug/window change, keeping the refs the live handlers read in sync.
  useEffect(() => {
    if (!slug) return;
    slugRef.current = slug;
    windowRef.current = boardWindow;
    void loadBoard();
  }, [slug, boardWindow, loadBoard]);

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

  const retryBoot = useCallback(() => {
    bootPromise = null;
    setBoot({ kind: 'loading' });
    void bootstrapOnce().then(setBoot);
  }, []);

  if (boot.kind === 'loading') {
    return <Screen title="Groupie" message="Opening the board…" />;
  }

  if (boot.kind === 'no-slug') {
    return (
      <Screen
        title="No board selected"
        message="Open this board from your group’s pinned link so Groupie knows which group to show."
      />
    );
  }

  if (boot.kind === 'telegram-only') {
    return (
      <Screen
        title="Log in via Telegram"
        message="This board opens from inside Telegram for now. Tap the pinned board link in your group. Browser login is coming in a later release."
      />
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

  return (
    <div className="app">
      <header className="header">
        <div className="header-top">
          <h1 className="header-title" title={title}>
            {title}
          </h1>
          <LiveDot state={live} />
        </div>
        <WindowSwitcher value={boardWindow} onChange={onWindowChange} />
      </header>

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
          <Board
            board={board}
            section={section}
            onSection={setSection}
            now={now}
            hiddenCallIds={hidden}
            binningId={binningId}
            onBin={onBin}
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
        ) : boardError ? (
          <div className="screen">
            <h2 className="screen-title">Could not load the board</h2>
            <p className="screen-message">{boardError}</p>
            <button type="button" className="retry-btn" onClick={() => void loadBoard()}>
              Try again
            </button>
          </div>
        ) : (
          <p className="empty">{loading ? 'Loading the board…' : 'Nothing here yet.'}</p>
        )}
      </main>
    </div>
  );
}

function LiveDot({ state }: { state: LiveState }) {
  if (state === 'reconnecting') {
    return (
      <span className="live live-off" title="Live connection dropped; retrying">
        <span className="live-dot" />
        reconnecting…
      </span>
    );
  }
  if (state === 'open') {
    return (
      <span className="live live-on" title="Live updates connected">
        <span className="live-dot" />
        live
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
