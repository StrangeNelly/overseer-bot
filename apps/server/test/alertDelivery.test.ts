import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Api } from 'grammy';
import { groups, type Db } from '@groupie/db';
import { startAlertDelivery } from '../src/bot/alertDelivery.js';
import { bold, code, esc, link, stripHtml } from '../src/bot/telegramHtml.js';
import { publish } from '../src/events.js';

/**
 * The delivery seam (round 27): which alerts are parsed as HTML, and what
 * happens when Telegram refuses one.
 *
 * The stakes are the reason this file exists. The alert ROW is written before
 * the send and is the record that the chat was told, so nothing ever retries a
 * delivery — a formatted message Telegram rejects would be a launch the owner
 * asked to hear about and never did.
 */

interface Sent {
  chatId: number;
  text: string;
  options: Record<string, unknown>;
}

/** Minimal grammY Api double: records sends, optionally rejecting the first. */
function makeApi(rejectFirst = false): { api: Api; sent: Sent[] } {
  const sent: Sent[] = [];
  let rejected = false;
  const api = {
    sendMessage: async (chatId: number, text: string, options: Record<string, unknown>) => {
      if (rejectFirst && !rejected) {
        rejected = true;
        // The shape Telegram actually answers with on bad markup.
        throw new Error('Bad Request: can\'t parse entities');
      }
      sent.push({ chatId, text, options });
      return { message_id: 1 };
    },
  } as unknown as Api;
  return { api, sent };
}

/** A db double that answers the one SELECT delivery makes: the group row. */
function makeDb(status = 'active'): Db {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () =>
          Promise.resolve(table === groups ? [{ chatId: 4242, status }] : []),
      }),
    }),
  } as unknown as Db;
}

/** Delivery is queued on a promise chain, so a send is not synchronous. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const stops: Array<() => void> = [];
afterEach(() => {
  while (stops.length > 0) stops.pop()?.();
  vi.restoreAllMocks();
});

function start(api: Api, db: Db = makeDb()): void {
  stops.push(startAlertDelivery(db, api));
}

describe('alert delivery — parse mode', () => {
  it('sends a plain alert with NO parse_mode, so an unescaped symbol cannot break it', async () => {
    const { api, sent } = makeApi();
    start(api);
    publish({
      type: 'alert_fired',
      groupId: 1,
      tokenId: 7,
      alertType: 'nuke',
      message: 'A&B nuked -80%',
    });
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toBe('A&B nuked -80%');
    expect(sent[0]?.options).not.toHaveProperty('parse_mode');
  });

  it('sends an HTML alert with parse_mode HTML', async () => {
    const { api, sent } = makeApi();
    start(api);
    publish({
      type: 'alert_fired',
      groupId: 1,
      tokenId: 7,
      alertType: 'x_launch',
      message: '<b>@who</b> posted a contract address.',
      parseMode: 'HTML',
    });
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.options.parse_mode).toBe('HTML');
  });
});

describe('alert delivery — the HTML rejection fallback', () => {
  it('re-sends the same words as plain text when Telegram refuses the markup', async () => {
    // Nothing retries a delivery, so a rejected formatted send must not be the
    // end of the message: the launch matters more than the styling.
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { api, sent } = makeApi(true);
    start(api);
    publish({
      type: 'alert_fired',
      groupId: 1,
      tokenId: 7,
      alertType: 'x_launch',
      message: '<b>@who</b> posted <code>0xabc</code>\n<a href="https://x.test/1">post</a>',
      parseMode: 'HTML',
    });
    await settle();
    expect(sent).toHaveLength(1);
    // The retry carries the words, without the markup and without parse_mode.
    expect(sent[0]?.text).toBe('@who posted 0xabc\npost');
    expect(sent[0]?.options).not.toHaveProperty('parse_mode');
    expect(error).toHaveBeenCalled();
  });

  it('does not retry a PLAIN send — only the markup is ever the suspect', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { api, sent } = makeApi(true);
    start(api);
    publish({
      type: 'alert_fired',
      groupId: 1,
      tokenId: 7,
      alertType: 'nuke',
      message: 'plain',
    });
    await settle();
    expect(sent).toHaveLength(0);
    expect(error).toHaveBeenCalled();
  });

  it('says nothing at all to a group that is no longer active', async () => {
    const { api, sent } = makeApi();
    start(api, makeDb('removed'));
    publish({
      type: 'alert_fired',
      groupId: 1,
      tokenId: 7,
      alertType: 'x_launch',
      message: '<b>x</b>',
      parseMode: 'HTML',
    });
    await settle();
    expect(sent).toHaveLength(0);
  });
});

describe('telegramHtml', () => {
  it('escapes the three characters Telegram parses, and only those', () => {
    expect(esc('A & B <tag> "q" \'s\'')).toBe('A &amp; B &lt;tag&gt; "q" \'s\'');
  });

  it('lets a hostile symbol through as text rather than as formatting', () => {
    // Anyone can deploy a coin called `<b>`.
    expect(bold('<b>PUMP</b>')).toBe('<b>&lt;b&gt;PUMP&lt;/b&gt;</b>');
    expect(code('a&b')).toBe('<code>a&amp;b</code>');
  });

  it('builds an anchor, and degrades to the bare label rather than a broken one', () => {
    expect(link('DEXS', 'https://dexscreener.com/robinhood/0xabc')).toBe(
      '<a href="https://dexscreener.com/robinhood/0xabc">DEXS</a>',
    );
    // A URL we cannot form must not emit a malformed anchor that fails the send.
    expect(link('post', null)).toBe('post');
    expect(link('post', '   ')).toBe('post');
    expect(link('post', 'not a url')).toBe('post');
    // ...and a non-http scheme is never given an href.
    expect(link('x', 'javascript:alert(1)')).toBe('x');
  });

  it('strips markup back to the words, entities included', () => {
    expect(stripHtml('<b>a</b> · <code>0x1</code>')).toBe('a · 0x1');
    expect(stripHtml('<a href="https://x.test/1">post</a>')).toBe('post');
    // `&amp;` is unescaped LAST, or `&amp;lt;` would round-trip into a `<`.
    expect(stripHtml('&amp;lt;')).toBe('&lt;');
    expect(stripHtml('a &amp; b &lt;c&gt;')).toBe('a & b <c>');
  });
});
