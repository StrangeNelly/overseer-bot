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

interface TelegramWebApp {
  /** Signed launch payload; empty string outside Telegram. */
  initData?: string;
  initDataUnsafe?: TelegramInitDataUnsafe;
  themeParams?: TelegramThemeParams;
  ready?: () => void;
  expand?: () => void;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}
