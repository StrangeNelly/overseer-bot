/**
 * Copy-to-clipboard that survives the Telegram webview, where the async
 * Clipboard API is frequently withheld. Shared by every surface with a
 * COPY CA pill.
 */

/** The pre-Clipboard-API path: a hidden textarea plus execCommand. */
function legacyCopy(text: string): boolean {
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

/** Resolves true when the text made it to the clipboard by either route. */
export async function copyText(text: string): Promise<boolean> {
  const clipboard = navigator.clipboard;
  if (clipboard && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Blocked or unavailable in this webview: fall through.
    }
  }
  return legacyCopy(text);
}
