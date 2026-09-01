import type {
  BoardResponse,
  BoardWindow,
  HandoffResponse,
  MeResponse,
  RangeBoardResponse,
  RangeDurationHours,
  SleepersResponse,
  TelegramLoginAvailability,
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
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

  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(res.status, 'The server sent a malformed response.');
  }
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

export function fetchBoard(
  slug: string,
  boardWindow: BoardWindow,
  signal?: AbortSignal,
): Promise<BoardResponse> {
  return request<BoardResponse>(`${groupPath(slug)}/board?window=${encodeURIComponent(boardWindow)}`, {
    signal,
  });
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
 * default. Snapshot data on a 3-hourly server scan — never on the live stream.
 */
export function fetchSleepers(
  slug: string,
  all: boolean,
  signal?: AbortSignal,
): Promise<SleepersResponse> {
  return request<SleepersResponse>(`${groupPath(slug)}/sleepers?all=${all ? '1' : '0'}`, { signal });
}

export function binCall(slug: string, callId: number): Promise<void> {
  return request<void>(`${groupPath(slug)}/calls/${encodeURIComponent(String(callId))}/bin`, {
    method: 'POST',
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
