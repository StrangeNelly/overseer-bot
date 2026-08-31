import { randomBytes } from 'node:crypto';
import { Bot, type Context } from 'grammy';
import type { Message } from 'grammy/types';
import { eq } from 'drizzle-orm';
import { calls, groupMembers, groups, launchMonitors, type Db } from '@groupie/db';
import { publish } from '../events.js';
import { pollTokenNow } from '../poller/scheduler.js';
import type { Config } from '../config.js';
import { ingestMessage } from './ingest.js';

function isGroupChat(ctx: Context): boolean {
  const type = ctx.chat?.type;
  return type === 'group' || type === 'supergroup';
}

function displayName(user: { first_name: string; last_name?: string; username?: string }): string {
  if (user.username) return `@${user.username}`;
  return [user.first_name, user.last_name].filter(Boolean).join(' ');
}

/**
 * Resolve who to credit for a message. Anonymous group admins arrive as
 * @GroupAnonymousBot and post-as-channel users as @Channel_Bot (both
 * is_bot=true) with the real sender in sender_chat — those are humans behind
 * an API facade and are often the primary callers, so credit the sender_chat.
 * Linked-channel auto-forwards also carry a channel sender_chat and are
 * ingested deliberately (call channels feed their groups). Genuine third-party
 * bots (Rick, Phanes, ...) stay ignored.
 */
function resolveSender(
  msg: Message,
  chatId: number,
): { userId: number; userName: string } | undefined {
  const senderChat = msg.sender_chat;
  if (senderChat && (senderChat.id === chatId || senderChat.type === 'channel')) {
    return {
      userId: senderChat.id,
      userName: msg.author_signature ?? senderChat.title ?? 'Anonymous admin',
    };
  }
  if (!msg.from || msg.from.is_bot) return undefined;
  return { userId: msg.from.id, userName: displayName(msg.from) };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

/**
 * Find or create the group row. `activate` controls whether an existing
 * 'removed' row is resurrected — only lifecycle events (my_chat_member,
 * /groupie) may do that; plain messages must not revive a removed group.
 */
async function ensureGroup(
  db: Db,
  chatId: number,
  title: string | undefined,
  opts: { activate: boolean },
) {
  const existing = await db.select().from(groups).where(eq(groups.chatId, chatId));
  const row = existing[0];
  if (row) {
    const setStatus = opts.activate && row.status !== 'active';
    const setTitle = title !== undefined && title !== row.title;
    if (!setStatus && !setTitle) return row;
    const updated = await db
      .update(groups)
      .set({
        ...(setStatus ? { status: 'active' as const } : {}),
        ...(setTitle ? { title } : {}),
      })
      .where(eq(groups.id, row.id))
      .returning();
    return updated[0]!;
  }

  // New group: retry on the (astronomically rare) random slug collision.
  for (let attempt = 0; attempt < 3; attempt++) {
    const slug = randomBytes(4).toString('hex');
    try {
      const inserted = await db
        .insert(groups)
        .values({ chatId, title: title ?? null, slug })
        .onConflictDoNothing({ target: groups.chatId })
        .returning();
      if (inserted[0]) return inserted[0];
      // Lost a race with a concurrent insert for the same chat.
      const raced = await db.select().from(groups).where(eq(groups.chatId, chatId));
      if (raced[0]) return raced[0];
      throw new Error(`group insert raced but row missing for chat ${chatId}`);
    } catch (err) {
      if (isUniqueViolation(err) && attempt < 2) continue;
      throw err;
    }
  }
  throw new Error(`could not create group row for chat ${chatId}`);
}

/**
 * Basic group upgraded to supergroup: Telegram assigns a new chat id. Re-key
 * our row so the slug, calls, and history survive. If an update from the new
 * chat id was processed first, a stub row exists — merge it away.
 */
async function migrateGroup(db: Db, oldChatId: number, newChatId: number) {
  await db.transaction(async (tx) => {
    const oldRow = (await tx.select().from(groups).where(eq(groups.chatId, oldChatId)))[0];
    if (!oldRow) return;
    const stub = (await tx.select().from(groups).where(eq(groups.chatId, newChatId)))[0];
    if (stub && stub.id !== oldRow.id) {
      // Member rows are a disposable cache; calls repoint (a duplicate
      // (group, token) call in the minutes-old stub aborts the tx and is
      // surfaced by bot.catch — acceptably rare).
      await tx.delete(groupMembers).where(eq(groupMembers.groupId, stub.id));
      await tx.update(calls).set({ groupId: oldRow.id }).where(eq(calls.groupId, stub.id));
      await tx
        .update(launchMonitors)
        .set({ groupId: oldRow.id })
        .where(eq(launchMonitors.groupId, stub.id));
      await tx.delete(groups).where(eq(groups.id, stub.id));
    }
    await tx.update(groups).set({ chatId: newChatId }).where(eq(groups.id, oldRow.id));
  });
  console.log(`group chat migrated ${oldChatId} -> ${newChatId}`);
}

export function createBot(config: Config, db: Db): Bot {
  const bot = new Bot(config.botToken);

  // Being added to / removed from a group is the entire onboarding flow.
  bot.on('my_chat_member', async (ctx) => {
    if (!isGroupChat(ctx)) return;
    const status = ctx.myChatMember.new_chat_member.status;
    const oldStatus = ctx.myChatMember.old_chat_member.status;
    // member -> administrator promotion is not a join; skip the duplicate work.
    if (
      (status === 'member' || status === 'administrator') &&
      (oldStatus === 'member' || oldStatus === 'administrator')
    ) {
      return;
    }
    if (status === 'member' || status === 'administrator') {
      const group = await ensureGroup(db, ctx.chat.id, ctx.chat.title, { activate: true });
      console.log(`joined group ${ctx.chat.id} (${ctx.chat.title}) -> slug ${group.slug}`);
    } else if (status === 'left' || status === 'kicked') {
      await db.update(groups).set({ status: 'removed' }).where(eq(groups.chatId, ctx.chat.id));
      console.log(`removed from group ${ctx.chat.id}`);
    }
  });

  // The bot's one allowed reply: the board link. Falls through to the message
  // handler so a CA pasted in the same message is still ingested.
  bot.command('groupie', async (ctx, next) => {
    if (isGroupChat(ctx) && ctx.from) {
      const group = await ensureGroup(db, ctx.chat.id, ctx.chat.title, { activate: true });
      // The t.me deep link opens the board inside Telegram; the plain URL is
      // the fallback until the Mini App is registered in BotFather.
      const boardUrl = config.miniAppUrl
        ? `${config.miniAppUrl}?startapp=${group.slug}`
        : `${config.webAppUrl}/g/${group.slug}`;
      await ctx.reply(`Groupie board: ${boardUrl}`, {
        link_preview_options: { is_disabled: true },
      });
    }
    await next();
  });

  // Everything else: silent ingestion.
  bot.on('message', async (ctx) => {
    if (!isGroupChat(ctx)) return;
    const msg = ctx.message;

    // Group -> supergroup migration service message.
    if (msg.migrate_to_chat_id) {
      await migrateGroup(db, ctx.chat.id, msg.migrate_to_chat_id);
      return;
    }

    const sender = resolveSender(msg, ctx.chat.id);
    if (!sender) return;

    const group = await ensureGroup(db, ctx.chat.id, ctx.chat.title, { activate: false });
    if (group.status !== 'active') return;

    const entityUrls = [...(msg.entities ?? []), ...(msg.caption_entities ?? [])]
      .map((e) => (e.type === 'text_link' ? e.url : undefined))
      .filter((u): u is string => Boolean(u));

    const result = await ingestMessage(db, {
      groupId: group.id,
      messageId: msg.message_id,
      userId: sender.userId,
      userName: sender.userName,
      at: new Date(msg.date * 1000),
      texts: [msg.text, msg.caption, ...entityUrls],
    });

    if (result.newCalls.length > 0 || result.reposts.length > 0) {
      console.log(
        `chat ${ctx.chat.id}: ${result.newCalls.length} new call(s) ${result.newCalls.join(', ')}` +
          (result.reposts.length ? `; repost(s) ${result.reposts.join(', ')}` : ''),
      );
    }

    // New calls need mcap-at-call captured NOW (launch coins move in seconds);
    // reposts of died or binned calls asked for a revive re-poll. Fire and forget.
    for (const entry of result.entries) {
      if (entry.isNew) publish({ type: 'new_call', tokenId: entry.tokenId, address: entry.address });
      if (entry.isNew || entry.wasDied || entry.wasBinned) {
        pollTokenNow(db, entry.tokenId).catch((err) =>
          console.error(`immediate poll failed for ${entry.address}:`, err),
        );
      }
    }
  });

  bot.catch((err) => {
    console.error('bot error:', err.error);
  });

  return bot;
}
