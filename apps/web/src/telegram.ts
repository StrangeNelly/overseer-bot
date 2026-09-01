/**
 * Safe accessors for the Telegram WebApp bridge. Every call has to survive
 * running in a plain browser tab, where `window.Telegram` is undefined, and an
 * older Telegram client where a given method may be missing.
 */

function webApp() {
  if (typeof window === 'undefined') return undefined;
  return window.Telegram?.WebApp;
}

/** The signed launch payload, or null when we are not inside Telegram. */
export function tgInitData(): string | null {
  const raw = webApp()?.initData;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/** `?startapp=<slug>` from the pinned t.me link. */
export function tgStartParam(): string | null {
  const raw = webApp()?.initDataUnsafe?.start_param;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/** Tell Telegram the view is painted and ask for the full-height sheet. */
export function tgReady(): void {
  const app = webApp();
  if (!app) return;
  try {
    app.ready?.();
    app.expand?.();
  } catch {
    // An old client without these methods must not break the board.
  }
}

/**
 * Hand a url to the SYSTEM browser. Returns false when the bridge is absent or
 * refuses (plain tab, or a Telegram client too old to know openLink), which is
 * the caller's cue to fall back to window.open.
 */
export function tgOpenLink(url: string): boolean {
  const app = webApp();
  // Called on the object, not through a detached reference: the bridge method
  // is not guaranteed to survive losing its `this`.
  if (typeof app?.openLink !== 'function') return false;
  try {
    app.openLink(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Adopt the client's background colour so the Mini App sheet does not show a
 * seam against Telegram's chrome. Everything else stays on our own palette.
 */
export function applyTelegramTheme(): void {
  const bg = webApp()?.themeParams?.bg_color;
  if (typeof bg !== 'string' || !/^#[0-9a-fA-F]{3,8}$/.test(bg)) return;
  try {
    document.body.style.background = bg;
    document.documentElement.style.setProperty('--bg', bg);
  } catch {
    // Non-fatal: the CSS default stands.
  }
}
