import type {
  BoardResponse,
  BoardWindow,
  DiscoveryFilters,
  DiscoveryKind,
  DiscoveryResponse,
  HandoffResponse,
  MeResponse,
  RangeBoardResponse,
  RangeDurationHours,
  SleeperDurationHours,
  SleepersResponse,
  TelegramLoginAvailability,
  WatchByAddressRequest,
} from '@groupie/shared';

/** Any non-2xx response, or a request that never reached the server (status 0). */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (text) {
      try {
        const body: unknown = JSON.parse(text);
        if (body && typeof body === 'object') {
          const record = body as Record<string, unknown>;
          for (const key of ['error', 'message'] as const) {
            const value = record[key];
            if (typeof value === 'string' && value.length > 0) return value;
          }
        }
      } catch {
        // Not JSON — fall through to the status line.
      }
    }
  } catch {
    // Body already consumed or unreadable.
  }
  return res.statusText || `Request failed (${res.status})`;
}

/**
 * A response together with the server's own instant for it (the HTTP `Date`
 * header, whole-second resolution), so a client can compare a server timestamp
 * in the body against the server's clock instead of its own. Null when the
 * header is missing or unparseable.
 */
export interface Timed<T> {
  body: T;
  serverAt: number | null;
}

async function requestTimed<T>(path: string, init?: RequestInit): Promise<Timed<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: 'same-origin',
      ...init,
      headers: { Accept: 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError(0, 'Could not reach the server.');
  }

  if (!res.ok) throw new ApiError(res.status, await errorMessage(res));

  const dateHeader = res.headers.get('date');
  const parsed = dateHeader ? Date.parse(dateHeader) : NaN;
  const serverAt = Number.isFinite(parsed) ? parsed : null;

  const text = await res.text();
  if (!text) return { body: undefined as T, serverAt };
  try {
    return { body: JSON.parse(text) as T, serverAt };
  } catch {
    throw new ApiError(res.status, 'The server sent a malformed response.');
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return (await requestTimed<T>(path, init)).body;
}

function groupPath(slug: string): string {
  return `/api/g/${encodeURIComponent(slug)}`;
}

/** Exchange a Mini App launch payload for a session cookie. */
export function authTelegram(initData: string): Promise<void> {
  return request<void>('/api/auth/telegram', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initData }),
  });
}

/** Dev-only shortcut session. 404 in prod — that is the signal to show the login screen. */
export function authDev(): Promise<void> {
  return request<void>('/api/auth/dev');
}

/**
 * Is browser "Log in with Telegram" configured on this deployment? Purely a
 * feature flag for the login wall — the real gate is the OIDC round trip.
 */
export function fetchTelegramLoginAvailable(): Promise<TelegramLoginAvailability> {
  return request<TelegramLoginAvailability>('/api/auth/telegram/available');
}

/** Where the "Log in with Telegram" button sends the browser (a full navigation). */
export function telegramLoginUrl(slug: string): string {
  return `/auth/telegram/start?slug=${encodeURIComponent(slug)}`;
}

export function fetchMe(): Promise<MeResponse> {
  return request<MeResponse>('/api/me');
}

/**
 * Minutes EAST of UTC — the negation of getTimezoneOffset(), which is what the
 * board's todayCallCount needs to know where the reader's midnight is. A
 * browser that throws here simply gets a UTC day.
 */
function tzOffsetMin(): number {
  try {
    const offset = -new Date().getTimezoneOffset();
    return Number.isInteger(offset) ? offset : 0;
  } catch {
    return 0;
  }
}

export function fetchBoard(
  slug: string,
  boardWindow: BoardWindow,
  signal?: AbortSignal,
): Promise<BoardResponse> {
  const params = new URLSearchParams({ window: boardWindow, tz: String(tzOffsetMin()) });
  return request<BoardResponse>(`${groupPath(slug)}/board?${params.toString()}`, { signal });
}

/** Ranging board: tokens whose mcap has held `loUsd`..`hiUsd` for `hours`+. */
export function fetchRange(
  slug: string,
  loUsd: number,
  hiUsd: number,
  hours: RangeDurationHours,
  signal?: AbortSignal,
): Promise<RangeBoardResponse> {
  // The server wants whole USD; rounding here keeps a stray decimal out of a 400.
  const params = new URLSearchParams({
    lo: String(Math.round(loUsd)),
    hi: String(Math.round(hiUsd)),
    hours: String(hours),
  });
  return request<RangeBoardResponse>(`${groupPath(slug)}/range?${params.toString()}`, { signal });
}

/**
 * Sleepers: the chain-wide discovery stream. `all` drops the twitter-required
 * default; `stocks` drops the no-tokenized-stocks default (round 17);
 * `minHours` is the time-in-band filter (round 14). Snapshot data on a 3-hourly
 * server scan — never on the live stream.
 *
 * Both flags are sent explicitly rather than omitted at their default, so the
 * URL always says what the payload answers.
 */
export function fetchSleepers(
  slug: string,
  all: boolean,
  stocks: boolean,
  minHours: SleeperDurationHours,
  signal?: AbortSignal,
): Promise<SleepersResponse> {
  const params = new URLSearchParams({
    all: all ? '1' : '0',
    stocks: stocks ? '1' : '0',
    minHours: String(minHours),
  });
  return request<SleepersResponse>(`${groupPath(slug)}/sleepers?${params.toString()}`, { signal });
}

/**
 * Discovery: what the CHAIN surfaced on its own (docs/decisions.md rounds 18 and
 * 20) — direct Uniswap launches and PONS graduations, neither of them a group
 * call.
 *
 * Three independent filters, three query flags (`xweb`, `bundles`, `stocks`,
 * all default 1): one switch per chip, so a chip that is lit can never mean a
 * filter the payload dropped. Every parameter is sent explicitly rather than
 * omitted at its default, so the URL always says what the payload answers — and
 * the payload echoes `hours` and `filters` back, which is what the view prints.
 */
export function fetchDiscovery(
  slug: string,
  query: { kind: DiscoveryKind | 'all'; hours: number; filters: DiscoveryFilters },
  signal?: AbortSignal,
): Promise<Timed<DiscoveryResponse>> {
  const params = new URLSearchParams({
    kind: query.kind,
    hours: String(query.hours),
    xweb: query.filters.xWeb ? '1' : '0',
    bundles: query.filters.noBundles ? '1' : '0',
    stocks: query.filters.noStocks ? '1' : '0',
  });
  // Timed: `lastTickAt` in the body is a server timestamp, and the stall verdict
  // must read it against the server's clock, never this device's.
  return requestTimed<DiscoveryResponse>(`${groupPath(slug)}/discovery?${params.toString()}`, {
    signal,
  });
}

export function binCall(slug: string, callId: number): Promise<void> {
  return request<void>(`${groupPath(slug)}/calls/${encodeURIComponent(String(callId))}/bin`, {
    method: 'POST',
  });
}

/**
 * The member verdict (docs/decisions.md round 21): mark a LIVE call dead by
 * hand. Any member, group-wide — the same standing as binning — and the same
 * thing `/overseer dead <symbol|CA>` does. 204, or 409 when the call is not
 * live any more (a rule got there first, or another member did).
 */
export function markDead(slug: string, callId: number): Promise<void> {
  return request<void>(`${groupPath(slug)}/calls/${encodeURIComponent(String(callId))}/dead`, {
    method: 'POST',
  });
}

/**
 * ...and its only reversal (`/overseer undead`): the call goes back to active,
 * no re-alert, no probation. 409 for a rule-driven death — a member can undo a
 * member's verdict, never the machinery's.
 */
export function restoreCall(slug: string, callId: number): Promise<void> {
  return request<void>(`${groupPath(slug)}/calls/${encodeURIComponent(String(callId))}/dead`, {
    method: 'DELETE',
  });
}

/**
 * Turn the group's Telegram alerts on/off for one coin (docs/decisions.md round
 * 15) — the same watchlist `/overseer watch` writes to, and the same per-member
 * cap. A 409 carries the friendly over-cap sentence in `error`.
 */
export function setWatch(slug: string, tokenId: number, watched: boolean): Promise<void> {
  return request<void>(`${groupPath(slug)}/tokens/${encodeURIComponent(String(tokenId))}/watch`, {
    method: watched ? 'POST' : 'DELETE',
  });
}

/**
 * Watch by ADDRESS (docs/decisions.md round 16) — the same thing
 * `/overseer watch <ca>` does, and the only path for a coin with no call on
 * this board (a Sleepers row, or a watch someone set from the chat). 409 carries
 * the same friendly over-cap sentence as the card path.
 */
export function setWatchByAddress(
  slug: string,
  address: string,
  watched: boolean,
): Promise<void> {
  if (watched) {
    const body: WatchByAddressRequest = { address };
    return request<void>(`${groupPath(slug)}/watch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  return request<void>(`${groupPath(slug)}/watch/${encodeURIComponent(address)}`, {
    method: 'DELETE',
  });
}

/**
 * Mint a one-time link that opens this board in the system browser, already
 * signed in. The url is a 60-second credential — hand it straight to the
 * browser, never render or log it.
 */
export function createHandoff(slug: string): Promise<HandoffResponse> {
  return request<HandoffResponse>(`${groupPath(slug)}/handoff`, { method: 'POST' });
}

/** Multiplexed live stream for one group. */
export function eventsUrl(slug: string): string {
  return `${groupPath(slug)}/events`;
}
