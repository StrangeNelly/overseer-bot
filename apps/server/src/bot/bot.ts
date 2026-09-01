import { randomBytes } from 'node:crypto';
import { Bot, type Context } from 'grammy';
import type { Message } from 'grammy/types';
import { and, eq, sql } from 'drizzle-orm';
import {
  alerts,
  calls,
  groupMembers,
  groups,
  launchMonitors,
  tokens,
  watches,
  type Db,
} from '@groupie/db';
import {
  extractEvmAddresses,
  ROBINHOOD_CHAIN_ID,
  WATCH_CAP_PER_MEMBER,
  watchCapMessage,
  type AlertSettings,
} from '@groupie/shared';
import { publish } from '../events.js';
import { activeWatchCount, addWatch, removeWatch } from '../watchlist.js';
import {
  alertSettingsOf,
  clampAlertSetting,
  fmtUsd,
  shortAddress,
  tokenLabel,
} from '../poller/alertLogic.js';
import { pollTokenNow } from '../poller/scheduler.js';
import type { Config } from '../config.js';
import { ingestMessage, upsertToken } from './ingest.js';

type GroupRow = typeof groups.$inferSelect;

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
 * /overseer) may do that; plain messages must not revive a removed group.
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
      // Watches and alerts reference the stub too; leaving them would make the
      // delete below fail on the foreign key.
      await tx.update(watches).set({ groupId: oldRow.id }).where(eq(watches.groupId, stub.id));
      await tx.update(alerts).set({ groupId: oldRow.id }).where(eq(alerts.groupId, stub.id));
      await tx.delete(groups).where(eq(groups.id, stub.id));
    }
    await tx.update(groups).set({ chatId: newChatId }).where(eq(groups.id, oldRow.id));
  });
  console.log(`group chat migrated ${oldChatId} -> ${newChatId}`);
}

/* -------------------------------------------------- /overseer subcommands */

/** Telegram caps a message at 4096 chars; a long watchlist is truncated. */
const WATCHLIST_MAX_LINES = 50;

/** Whole numbers only: these are chat commands, not a precision instrument. */
function parseWholeNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.round(value) : null;
}

function alertsSummary(s: AlertSettings): string {
  return (
    `Alerts: nuke >${s.nukeDropPct}% in ${s.nukeWindowMin}m · ` +
    `buy-opp ≥${s.buyRetracePct}% retrace from a ${s.buyPeakWindowHours}h high ` +
    `at least ${s.buyMinDeclineHours}h old · cooldown ${s.cooldownMin}m per coin. ` +
    `Tune: /overseer set nuke <pct> <minutes> · /overseer set buyopp <pct> <maxHours>`
  );
}

/** The address a watch/unwatch is about, or null when the argument is junk. */
function commandAddress(args: string[]): string | null {
  return extractEvmAddresses(args.join(' '))[0] ?? null;
}

/** The over-cap reply, with the chat-side way out appended. */
function capReply(cap: number = WATCH_CAP_PER_MEMBER): string {
  return (
    `${watchCapMessage(cap)} /overseer watchlist to see them, ` +
    `/overseer unwatch <ca> to free a slot.`
  );
}

async function handleWatch(
  db: Db,
  ctx: Context,
  group: GroupRow,
  args: string[],
  userId: number,
): Promise<void> {
  const address = commandAddress(args);
  if (!address) {
    await ctx.reply('Usage: /overseer watch <contract address>');
    return;
  }
  // Cheap pre-check BEFORE upsertToken: a cap refusal must not leave behind an
  // orphan tokens row — no call, no watch — that the poller would then chase
  // at the fresh tier for a day (round 15 review). The advisory-locked check
  // inside addWatch stays the authoritative gate; a race slipping past this
  // one leaks at most a single row.
  if ((await activeWatchCount(db, group.id, userId)) >= WATCH_CAP_PER_MEMBER) {
    await ctx.reply(capReply());
    return;
  }
  const token = await upsertToken(db, address);
  // One implementation for the chat command and the board button, cap included
  // (docs/decisions.md round 15) — see apps/server/src/watchlist.ts.
  const outcome = await addWatch(db, group.id, token.id, userId);
  if (!outcome.ok) {
    await ctx.reply(capReply(outcome.cap));
    return;
  }

  const s = alertSettingsOf(group.settings);
  const held = await activeWatchCount(db, group.id, userId);
  await ctx.reply(
    `Watching ${tokenLabel(token.symbol, address)} (${held}/${WATCH_CAP_PER_MEMBER} of your slots) — ` +
      `nuke >${s.nukeDropPct}%/${s.nukeWindowMin}m, ` +
      `buy-opp ≥${s.buyRetracePct}% retrace over ${s.buyMinDeclineHours}-${s.buyPeakWindowHours}h. ` +
      `/overseer alerts to tune.`,
  );

  // A coin nobody called has never been polled: resolve it now so the alert
  // engine has a symbol and a price series to work from.
  pollTokenNow(db, token.id).catch((err) =>
    console.error(`immediate poll failed for watched ${address}:`, err),
  );
}

async function handleUnwatch(
  db: Db,
  ctx: Context,
  group: GroupRow,
  args: string[],
): Promise<void> {
  const address = commandAddress(args);
  if (!address) {
    await ctx.reply('Usage: /overseer unwatch <contract address>');
    return;
  }
  const token = (
    await db
      .select({ id: tokens.id, symbol: tokens.symbol })
      .from(tokens)
      .where(and(eq(tokens.chainId, ROBINHOOD_CHAIN_ID), eq(tokens.address, address)))
  )[0];
  if (!token) {
    await ctx.reply(`${shortAddress(address)} wasn't watched.`);
    return;
  }
  // Any member may unwatch, whoever added it (the "any member can bin" rule).
  const stopped = await removeWatch(db, group.id, token.id);
  const label = tokenLabel(token.symbol, address);
  await ctx.reply(stopped ? `Stopped watching ${label}.` : `${label} wasn't watched.`);
}

async function handleWatchlist(
  db: Db,
  ctx: Context,
  group: GroupRow,
  userId: number,
): Promise<void> {
  const rows = await db
    .select({
      symbol: tokens.symbol,
      address: tokens.address,
      mcapUsd: tokens.mcapUsd,
      addedBy: watches.addedBy,
    })
    .from(watches)
    .innerJoin(tokens, eq(tokens.id, watches.tokenId))
    .where(and(eq(watches.groupId, group.id), eq(watches.active, true)))
    .orderBy(watches.addedAt);
  // The cap is per member, so the list has to say which rows are the reader's
  // (docs/decisions.md round 15) — otherwise "you have 3" is unactionable.
  const mine = rows.filter((r) => r.addedBy === userId).length;
  if (rows.length === 0) {
    await ctx.reply('Watchlist is empty. /overseer watch <ca> to follow a coin.');
    return;
  }
  const lines = rows
    .slice(0, WATCHLIST_MAX_LINES)
    .map(
      (r) =>
        `${tokenLabel(r.symbol, r.address)} ${fmtUsd(r.mcapUsd)}${r.addedBy === userId ? ' (yours)' : ''}`,
    );
  if (rows.length > WATCHLIST_MAX_LINES) {
    lines.push(`+${rows.length - WATCHLIST_MAX_LINES} more`);
  }
  await ctx.reply(
    `Watching ${rows.length} (${mine}/${WATCH_CAP_PER_MEMBER} of your slots):\n${lines.join('\n')}`,
  );
}

const SET_USAGE =
  'Usage: /overseer set nuke <pct 5-95> <minutes 5-60> · /overseer set buyopp <pct 5-95> <maxHours 1-48>';

async function handleSet(db: Db, ctx: Context, group: GroupRow, args: string[]): Promise<void> {
  const what = args[0]?.toLowerCase();
  const pct = parseWholeNumber(args[1]);
  const span = parseWholeNumber(args[2]);
  let patch: Partial<AlertSettings>;
  if (what === 'nuke' && pct !== null && span !== null) {
    patch = {
      nukeDropPct: clampAlertSetting('nukeDropPct', pct),
      nukeWindowMin: clampAlertSetting('nukeWindowMin', span),
    };
  } else if (what === 'buyopp' && pct !== null && span !== null) {
    patch = {
      buyRetracePct: clampAlertSetting('buyRetracePct', pct),
      buyPeakWindowHours: clampAlertSetting('buyPeakWindowHours', span),
    };
  } else {
    await ctx.reply(SET_USAGE);
    return;
  }

  // Merge into settings.alerts in SQL so a concurrent write to some OTHER
  // settings key survives, and so a hand-edited non-object blob can't break the
  // update. SET expressions see the OLD row, which is what is being merged.
  const current = sql`case when jsonb_typeof(${groups.settings}) = 'object' then ${groups.settings} else '{}'::jsonb end`;
  const currentAlerts = sql`case when jsonb_typeof(${groups.settings} -> 'alerts') = 'object' then ${groups.settings} -> 'alerts' else '{}'::jsonb end`;
  const updated = await db
    .update(groups)
    .set({
      settings: sql`jsonb_set(${current}, '{alerts}', ${currentAlerts} || ${JSON.stringify(patch)}::jsonb, true)`,
    })
    .where(eq(groups.id, group.id))
    .returning({ settings: groups.settings });

  await ctx.reply(alertsSummary(alertSettingsOf(updated[0]?.settings)));
}

/**
 * Everything after `/overseer`. Returns true when the command consumed a
 * contract address as an ARGUMENT — that address is a watchlist instruction,
 * not a call, so the message must not fall through to call ingestion.
 */
async function handleGroupieCommand(
  db: Db,
  config: Config,
  ctx: Context,
  group: GroupRow,
  rawArgs: string,
  userId: number,
): Promise<boolean> {
  const args = rawArgs.trim().split(/\s+/).filter(Boolean);
  switch (args[0]?.toLowerCase()) {
    case 'watch':
      await handleWatch(db, ctx, group, args.slice(1), userId);
      return true;
    case 'unwatch':
      await handleUnwatch(db, ctx, group, args.slice(1));
      return true;
    case 'watchlist':
      await handleWatchlist(db, ctx, group, userId);
      return false;
    case 'alerts':
      await ctx.reply(alertsSummary(alertSettingsOf(group.settings)));
      return false;
    case 'set':
      await handleSet(db, ctx, group, args.slice(1));
      return false;
    default: {
      // The t.me deep link opens the board inside Telegram; the plain URL is
      // the fallback until the Mini App is registered in BotFather.
      const boardUrl = config.miniAppUrl
        ? `${config.miniAppUrl}?startapp=${group.slug}`
        : `${config.webAppUrl}/g/${group.slug}`;
      await ctx.reply(`Overseer board: ${boardUrl}`, {
        link_preview_options: { is_disabled: true },
      });
      return false;
    }
  }
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

  // Member-initiated interaction: the board link, or a watchlist subcommand.
  // Falls through to the message handler so a CA pasted in the same message is
  // still ingested — unless a subcommand already consumed that address.
  // /overseer is the command (post-rebrand); /groupie stays as a quiet alias
  // so pinned messages and muscle memory keep working.
  bot.command(['overseer', 'groupie'], async (ctx, next) => {
    let consumedAddress = false;
    if (isGroupChat(ctx) && ctx.from) {
      const group = await ensureGroup(db, ctx.chat.id, ctx.chat.title, { activate: true });
      consumedAddress = await handleGroupieCommand(
        db,
        config,
        ctx,
        group,
        ctx.match,
        ctx.from.id,
      );
    }
    if (!consumedAddress) await next();
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
    // reposts of died, binned or probation-hidden calls asked for a revive
    // re-poll. An inert re-mention asked for nothing (docs/decisions.md round 6
    // item 5a) — the coin is a corpse and someone pointed at it. Fire and forget.
    for (const entry of result.entries) {
      if (entry.isNew) publish({ type: 'new_call', tokenId: entry.tokenId, address: entry.address });
      if (!entry.inert && (entry.isNew || entry.wasDied || entry.wasBinned || entry.wasHidden)) {
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
