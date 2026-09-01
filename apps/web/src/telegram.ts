/**
 * Safe accessors for the Telegram WebApp bridge. Every call has to survive
 * running in a plain browser tab, where `window.Telegram` is undefined, and an
 * older Telegram client where a given method may be missing.
 */

/** Page gradient endpoints — handed to Telegram so its chrome matches the sheet. */
const SHEET_TOP = '#0C0616';
const SHEET_BOTTOM = '#080310';

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

/**
 * Tell Telegram the view is painted. Round 8: we deliberately do NOT expand —
 * the half-sheet is a designed surface (Pulse + fresh rows + the browser
 * bridge), and the member drags it up themselves when they want the full board.
 */
export function tgReady(): void {
  const app = webApp();
  if (!app) return;
  try {
    app.ready?.();
  } catch {
    // An old client without these methods must not break the board.
  }
}

/**
 * Grow the sheet on the member's own instruction (the half-sheet's "all tabs"
 * affordance) — never on load, which is the behaviour round 8 retired.
 */
export function tgExpand(): void {
  try {
    webApp()?.expand?.();
  } catch {
    // An old client without expand just keeps the half-sheet.
  }
}

/** True while the member has dragged the sheet to full height. */
export function tgIsExpanded(): boolean {
  return webApp()?.isExpanded === true;
}

/**
 * Subscribe to sheet-height changes so the layout can relax from the half-sheet
 * to the mobile board. Returns an unsubscribe that is safe to call always.
 */
export function tgOnViewportChanged(handler: () => void): () => void {
  const app = webApp();
  if (typeof app?.onEvent !== 'function') return () => {};
  try {
    app.onEvent('viewportChanged', handler);
  } catch {
    return () => {};
  }
  return () => {
    try {
      app.offEvent?.('viewportChanged', handler);
    } catch {
      // Nothing to undo if the bridge already went away.
    }
  };
}

/** One haptic tick. Used only for the browser-bridge tap (design: Motion). */
export function tgHaptic(): void {
  const haptics = webApp()?.HapticFeedback;
  if (typeof haptics?.impactOccurred !== 'function') return;
  try {
    haptics.impactOccurred('medium');
  } catch {
    // Haptics are a nicety; a client that refuses must not break the tap.
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
 * Paint Telegram's own chrome in our colours rather than adopting its theme:
 * the board owns its palette now (Degen Neon), so the seam is closed from our
 * side. Silently ignored by clients that predate the setters.
 */
export function applyTelegramTheme(): void {
  const app = webApp();
  if (!app) return;
  try {
    app.setBackgroundColor?.(SHEET_BOTTOM);
    app.setHeaderColor?.(SHEET_TOP);
  } catch {
    // Non-fatal: the CSS default stands.
  }
}
