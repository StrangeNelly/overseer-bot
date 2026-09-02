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
  type DiscoverySettings,
} from '@groupie/shared';
import { publish } from '../events.js';
import { clampLaunchMinEth, discoverySettingsOf } from '../discovery/settings.js';
import {
  activeWatchCount,
  addWatch,
  findTokenByAddress,
  isWatched,
  removeWatch,
} from '../watchlist.js';
import {
  alertSettingsOf,
  clampAlertSetting,
  fmtUsd,
  shortAddress,
  tokenLabel,
} from '../poller/alertLogic.js';
import { pollTokenNow } from '../poller/scheduler.js';
import { memberDisplayName, rememberMemberName } from '../api/membership.js';
import { findGroupCall, markCallDead, restoreCall } from '../verdict.js';
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

/**
 * Round 19: buy-opp is measured from the mcap the coin had when the watch was
 * set, so the summary no longer mentions a peak window — that knob is retired
 * from the rule (the settings key survives only for stored blobs).
 */
export function alertsSummary(s: AlertSettings): string {
  return (
    `Alerts: nuke >${s.nukeDropPct}% in ${s.nukeWindowMin}m · ` +
    `buy-opp ≥${s.buyRetracePct}% below the mcap at watch · ` +
    `cooldown ${s.cooldownMin}m per coin. ` +
    `Tune: /overseer set nuke <pct> <minutes> · /overseer set buyopp <pct>`
  );
}

/**
 * The discovery half of `/overseer alerts` (docs/decisions.md rounds 18 and
 * 20). A separate line rather than a longer first one: these are a different
 * family — they are about coins nobody here has called, and they are capped per
 * hour rather than cooled down per coin.
 */
export function discoverySummary(d: DiscoverySettings, enabled: boolean): string {
  // No chain listener in this process: whatever the settings say, nothing will
  // ever be posted, and printing thresholds as if they were live would be a
  // promise the deployment cannot keep.
  if (!enabled) return 'Discovery: off (not configured)';
  const launch =
    d.launchMinEth > 0 ? `launches ≥${d.launchMinEth} ETH` : 'launches muted';
  return (
    `Discovery: ${launch} · graduations ${d.gradsOn ? 'on' : 'off'} · ` +
    `max ${d.alertsPerHour}/h (the rest stay on the board). ` +
    `Tune: /overseer set launch <eth> (0 mutes) · /overseer set grads on|off`
  );
}

/**
 * ...and what a `set` says after writing one. The write still happens when the
 * feed is off — a group configuring its threshold before the key lands is doing
 * something reasonable — but the reply must not imply anything is listening.
 */
export function discoverySetReply(d: DiscoverySettings, enabled: boolean): string {
  if (enabled) return discoverySummary(d, true);
  return `${discoverySummary(d, true)}\n(The discovery feed is off on this deployment.)`;
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

/** Exported for tests: the cap rule has to read the same on all three surfaces. */
export async function handleWatch(
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
  const known = await findTokenByAddress(db, address);
  // A coin the GROUP already watches consumes no slot (addWatch answers
  // ok/alreadyActive), so the cap must not refuse it — round 16 review, and the
  // same rule the board's two watch routes follow.
  const alreadyWatched = known !== undefined && (await isWatched(db, group.id, known.id));
  // Cheap pre-check BEFORE upsertToken: a cap refusal must not leave behind an
  // orphan tokens row — no call, no watch — that the poller would then chase
  // at the fresh tier for a day (round 15 review). The advisory-locked check
  // inside addWatch stays the authoritative gate; a race slipping past this
  // one leaks at most a single row.
  if (!alreadyWatched && (await activeWatchCount(db, group.id, userId)) >= WATCH_CAP_PER_MEMBER) {
    await ctx.reply(capReply());
    return;
  }
  const token = known ?? (await upsertToken(db, address));
  // One implementation for the chat command and the board button, cap included
  // (docs/decisions.md round 15) — see apps/server/src/watchlist.ts.
  const outcome = await addWatch(db, group.id, token.id, userId);
  if (!outcome.ok) {
    await ctx.reply(capReply(outcome.cap));
    return;
  }
  // The board names the slot after its holder; a command is the one moment the
  // chat hands us that name for a member who may never have posted a call.
  await rememberMemberName(
    db,
    group.id,
    userId,
    ctx.from && !ctx.from.is_bot ? displayName(ctx.from) : null,
  );

  const s = alertSettingsOf(group.settings);
  const held = await activeWatchCount(db, group.id, userId);
  // The baseline names itself in the confirmation when we have one (round 19):
  // it is the number every later BUY OPP is measured against. Silent when the
  // coin has never been priced — the alert pass stamps it at the first reading.
  const from = outcome.mcapAtWatch === null ? '' : ` from ${fmtUsd(outcome.mcapAtWatch)}`;
  await ctx.reply(
    `Watching ${tokenLabel(token.symbol, address)}${from} ` +
      `(${held}/${WATCH_CAP_PER_MEMBER} of your slots) — ` +
      `nuke >${s.nukeDropPct}%/${s.nukeWindowMin}m, ` +
      `buy-opp ≥${s.buyRetracePct}% below the mcap at watch. ` +
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

/**
 * `/overseer dead <symbol|CA>` — the member verdict (docs/decisions.md round
 * 21), the chat half of the board's MARK DEAD button. Any member, group-wide,
 * the same standing binning has.
 *
 * One line back, whatever happens: the board is what says this, and the chat is
 * already noisy enough (Rick and Phanes own the summaries). Exported for tests.
 */
export async function handleDead(
  db: Db,
  ctx: Context,
  group: GroupRow,
  args: string[],
  userId: number,
): Promise<void> {
  const query = args.join(' ').trim();
  if (!query) {
    await ctx.reply('Usage: /overseer dead <symbol or contract address>');
    return;
  }
  const call = await findGroupCall(db, group.id, query);
  if (!call) {
    await ctx.reply(`No live call for ${query}.`);
    return;
  }
  const label = tokenLabel(call.symbol, call.address);
  // The command proves membership and carries the sender's name — the same
  // moment `/overseer watch` uses to keep group_members current, and the name
  // the verdict is about to be stamped with.
  const name = ctx.from && !ctx.from.is_bot ? displayName(ctx.from) : null;
  await rememberMemberName(db, group.id, userId, name);
  const markedBy = name ?? (await memberDisplayName(db, group.id, userId));
  const outcome = await markCallDead(db, group.id, call.callId, markedBy);
  if (outcome !== 'marked') {
    await ctx.reply(`No live call for ${label}.`);
    return;
  }
  await ctx.reply(`${label} marked dead${markedBy ? ` by ${markedBy}` : ''}.`);
}

/**
 * `/overseer undead <symbol|CA>` — the reversal, and the ONLY one: a
 * member-marked death is exempt from every automatic revival, so no rule will
 * ever put this call back on its own.
 */
export async function handleUndead(
  db: Db,
  ctx: Context,
  group: GroupRow,
  args: string[],
): Promise<void> {
  const query = args.join(' ').trim();
  if (!query) {
    await ctx.reply('Usage: /overseer undead <symbol or contract address>');
    return;
  }
  const call = await findGroupCall(db, group.id, query);
  if (!call) {
    await ctx.reply(`No call for ${query} here.`);
    return;
  }
  const label = tokenLabel(call.symbol, call.address);
  const outcome = await restoreCall(db, group.id, call.callId);
  if (outcome === 'restored') {
    await ctx.reply(`${label} restored.`);
    return;
  }
  // The verdict is still a member's, the coin is what has gone (amendment d).
  if (outcome === 'token_dead') {
    await ctx.reply(`${label}'s coin has died since — nothing to restore.`);
    return;
  }
  await ctx.reply(`${label} isn't a member-marked death.`);
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
  'Usage: /overseer set nuke <pct 5-95> <minutes 5-60> · /overseer set buyopp <pct 5-95> · ' +
  '/overseer set launch <eth, 0 mutes> · /overseer set grads on|off';

/** A decimal argument — ETH thresholds are not whole numbers. */
function parseDecimal(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** `on`/`off` (and the obvious synonyms), or null when it is neither. */
function parseToggle(raw: string | undefined): boolean | null {
  const word = raw?.toLowerCase();
  if (word === 'on' || word === 'yes' || word === 'true' || word === '1') return true;
  if (word === 'off' || word === 'no' || word === 'false' || word === '0') return false;
  return null;
}

/**
 * Merge a patch into one key of `groups.settings`, in SQL — so a concurrent
 * write to some OTHER settings key survives, and a hand-edited non-object blob
 * cannot break the update. SET expressions see the OLD row, which is what is
 * being merged.
 */
async function mergeSettings(
  db: Db,
  groupId: number,
  key: 'alerts' | 'discovery',
  patch: Record<string, unknown>,
): Promise<unknown> {
  const current = sql`case when jsonb_typeof(${groups.settings}) = 'object' then ${groups.settings} else '{}'::jsonb end`;
  const branch = sql`case when jsonb_typeof(${groups.settings} -> ${key}) = 'object' then ${groups.settings} -> ${key} else '{}'::jsonb end`;
  // The path is a LITERAL, not a parameter: `key` is a two-value union from
  // this module, and keeping it inline leaves the statement's parameter list as
  // "the patch, and nothing else" — which is what makes a merge auditable.
  const path = sql.raw(`'{${key}}'`);
  const updated = await db
    .update(groups)
    .set({
      settings: sql`jsonb_set(${current}, ${path}, ${branch} || ${JSON.stringify(patch)}::jsonb, true)`,
    })
    .where(eq(groups.id, groupId))
    .returning({ settings: groups.settings });
  return updated[0]?.settings;
}

/**
 * Exported for tests: what a `set` writes is what the group lives with.
 * `discoveryEnabled` only shapes the REPLY — a group may configure a feed this
 * deployment cannot run, and the settings survive the day the key arrives.
 */
export async function handleSet(
  db: Db,
  ctx: Context,
  group: GroupRow,
  args: string[],
  discoveryEnabled: boolean,
): Promise<void> {
  const what = args[0]?.toLowerCase();
  const pct = parseWholeNumber(args[1]);
  const span = parseWholeNumber(args[2]);

  // Discovery (docs/decisions.md rounds 18 and 20) lives under its own settings
  // key and answers with its own summary line, so the two families never merge
  // into one wall of knobs.
  if (what === 'launch') {
    const eth = parseDecimal(args[1]);
    if (eth === null || eth < 0) {
      await ctx.reply(SET_USAGE);
      return;
    }
    const settings = await mergeSettings(db, group.id, 'discovery', {
      launchMinEth: clampLaunchMinEth(eth),
    });
    await ctx.reply(discoverySetReply(discoverySettingsOf(settings), discoveryEnabled));
    return;
  }
  if (what === 'grads' || what === 'graduations') {
    const on = parseToggle(args[1]);
    if (on === null) {
      await ctx.reply(SET_USAGE);
      return;
    }
    const settings = await mergeSettings(db, group.id, 'discovery', { gradsOn: on });
    await ctx.reply(discoverySetReply(discoverySettingsOf(settings), discoveryEnabled));
    return;
  }

  let patch: Partial<AlertSettings>;
  if (what === 'nuke' && pct !== null && span !== null) {
    patch = {
      nukeDropPct: clampAlertSetting('nukeDropPct', pct),
      nukeWindowMin: clampAlertSetting('nukeWindowMin', span),
    };
  } else if (what === 'buyopp' && pct !== null) {
    // Round 19: buy-opp takes only a percentage now. A trailing number is the
    // old `<maxHours>` argument — accepted so muscle memory and pinned help
    // still work, and dropped on the floor rather than stored as a knob that
    // no longer does anything.
    patch = { buyRetracePct: clampAlertSetting('buyRetracePct', pct) };
  } else {
    await ctx.reply(SET_USAGE);
    return;
  }

  const settings = await mergeSettings(db, group.id, 'alerts', patch);
  await ctx.reply(alertsSummary(alertSettingsOf(settings)));
}

/**
 * Everything after `/overseer`. Returns true when the command consumed a
 * contract address as an ARGUMENT — that address is a watchlist instruction,
 * not a call, so the message must not fall through to call ingestion.
 *
 * Exported for tests: `discoveryEnabled` has to reach BOTH discovery replies
 * (`alerts` and `set`), and the only way to prove that is to dispatch through
 * here rather than to call the two helpers directly.
 */
export async function handleGroupieCommand(
  db: Db,
  config: Config,
  ctx: Context,
  group: GroupRow,
  rawArgs: string,
  userId: number,
  discoveryEnabled: boolean,
): Promise<boolean> {
  const args = rawArgs.trim().split(/\s+/).filter(Boolean);
  switch (args[0]?.toLowerCase()) {
    case 'watch':
      await handleWatch(db, ctx, group, args.slice(1), userId);
      return true;
    case 'unwatch':
      await handleUnwatch(db, ctx, group, args.slice(1));
      return true;
    // Round 21: both take a <symbol|CA>, and an address argument here is a
    // verdict, not a call — `true` keeps ingestion from re-posting the coin.
    case 'dead':
      await handleDead(db, ctx, group, args.slice(1), userId);
      return true;
    case 'undead':
    case 'restore':
      await handleUndead(db, ctx, group, args.slice(1));
      return true;
    case 'watchlist':
      await handleWatchlist(db, ctx, group, userId);
      return false;
    case 'alerts':
      await ctx.reply(
        `${alertsSummary(alertSettingsOf(group.settings))}\n\n` +
          discoverySummary(discoverySettingsOf(group.settings), discoveryEnabled),
      );
      return false;
    case 'set':
      await handleSet(db, ctx, group, args.slice(1), discoveryEnabled);
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

/**
 * `discoveryEnabled` is whether THIS process runs the chain listener, so
 * `/overseer alerts` can say "off (not configured)" instead of quoting
 * thresholds nothing will ever act on (round 18/20 review).
 */
export function createBot(config: Config, db: Db, discoveryEnabled = false): Bot {
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
        discoveryEnabled,
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
