/**
 * Minimal typings for the Telegram WebApp bridge injected by
 * https://telegram.org/js/telegram-web-app.js. Only the surface this app
 * touches is declared — no @types package, on purpose.
 */
export {};

interface TelegramThemeParams {
  bg_color?: string;
  secondary_bg_color?: string;
  text_color?: string;
  hint_color?: string;
  link_color?: string;
  button_color?: string;
  button_text_color?: string;
}

interface TelegramInitDataUnsafe {
  start_param?: string;
}

interface TelegramHapticFeedback {
  impactOccurred?: (style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft') => void;
  notificationOccurred?: (type: 'error' | 'success' | 'warning') => void;
  selectionChanged?: () => void;
}

interface TelegramWebApp {
  /** Signed launch payload; empty string outside Telegram. */
  initData?: string;
  initDataUnsafe?: TelegramInitDataUnsafe;
  themeParams?: TelegramThemeParams;
  /** False in the default half-sheet, true once dragged to full height. */
  isExpanded?: boolean;
  viewportHeight?: number;
  ready?: () => void;
  expand?: () => void;
  onEvent?: (event: string, handler: () => void) => void;
  offEvent?: (event: string, handler: () => void) => void;
  setBackgroundColor?: (color: string) => void;
  setHeaderColor?: (color: string) => void;
  HapticFeedback?: TelegramHapticFeedback;
  /** Opens a url in the SYSTEM browser, outside the Mini App webview. */
  openLink?: (url: string, options?: { try_instant_view?: boolean }) => void;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}
