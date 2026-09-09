/**
 * Telegram HTML formatting for chat messages (round 27).
 *
 * WHY HTML AND NOT MARKDOWN. Round 23 shipped the launch ping as plain text
 * with the reasoning "a symbol carrying `*` or `_` must not break the send" —
 * true of Markdown, where those characters are syntax wherever they appear. In
 * HTML mode only three characters are special (`&`, `<`, `>`), they are escaped
 * unconditionally by `esc` below, and a symbol full of asterisks is just text.
 * So the constraint that forced plain text does not apply here, and the thing
 * plain text could not do — make a WORD tappable instead of printing a 90
 * character URL — is what these helpers exist for.
 *
 * EVERY interpolated value must go through `esc`, including values that look
 * safe today: a token symbol and name are attacker-controlled (anyone can
 * deploy a coin called `<b>`), and an unescaped one would either break the
 * send with a 400 or let a coin inject formatting into our message.
 */

/**
 * Undo the formatting: tags removed, entities turned back into characters.
 *
 * The delivery path's LAST RESORT (bot/alertDelivery.ts). If Telegram ever
 * refuses a formatted message — a parser change, a length limit, a shape none
 * of the escaping anticipated — the alert row already says the chat was told,
 * so nothing will retry it and the launch the owner asked to hear about would
 * vanish. Sending the same words unformatted is worse-looking and infinitely
 * better than silence.
 */
export function stripHtml(value: string): string {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    // `&amp;` LAST, or `&amp;lt;` would round-trip into a `<`.
    .replace(/&amp;/g, '&');
}

/** The three characters Telegram's HTML parser treats as syntax. */
export function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** `<b>…</b>` with the content escaped. */
export function bold(value: string): string {
  return `<b>${esc(value)}</b>`;
}

/**
 * `<code>…</code>` — monospace, and TAP-TO-COPY in every Telegram client.
 *
 * This is why the full contract address is printed rather than the shortened
 * one: a member reading the ping wants to paste that address into a trading
 * app, and `0x80ba…9136` cannot be pasted anywhere.
 */
export function code(value: string): string {
  return `<code>${esc(value)}</code>`;
}

/**
 * `<a href="url">label</a>`, or the bare escaped label when the URL is not a
 * usable http(s) one — a link we cannot form must not silently vanish, and it
 * must never emit a malformed anchor that fails the whole send.
 */
export function link(label: string, url: string | null | undefined): string {
  if (typeof url !== 'string' || url.trim() === '') return esc(label);
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return esc(label);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return esc(label);
  // The href is quoted, so `"` matters here as well as the three above.
  const href = esc(parsed.toString()).replace(/"/g, '&quot;');
  return `<a href="${href}">${esc(label)}</a>`;
}
