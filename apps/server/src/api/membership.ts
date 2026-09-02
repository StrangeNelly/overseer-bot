import { and, desc, eq } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import type { Api } from 'grammy';
import { calls, groupMembers, groups, mentions, type Db } from '@groupie/db';
import type { Config } from '../config.js';
import { devAuthEnabled, readSession } from './auth.js';

export type GroupRow = typeof groups.$inferSelect;

/** Set by requireMember for every /api/g/:slug/* handler downstream. */
export interface ApiEnv {
  Variables: {
    group: GroupRow;
    userId: number;
  };
}

/** getChatMember results are cached this long (docs/plan.md). */
const MEMBER_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Statuses that may read a group's board. 'left'/'kicked' fail; 'unknown' is
 * our own marker for a getChatMember that threw.
 */
const ALLOWED_STATUSES = new Set(['creator', 'administrator', 'member', 'restricted']);

async function checkMembership(
  db: Db,
  botApi: Api,
  group: GroupRow,
  userId: number,
): Promise<boolean> {
  const cached = (
    await db
      .select()
      .from(groupMembers)
      .where(and(eq(groupMembers.groupId, group.id), eq(groupMembers.userId, userId)))
  )[0];
  if (cached && Date.now() - cached.checkedAt.getTime() < MEMBER_CACHE_TTL_MS) {
    return ALLOWED_STATUSES.has(cached.status);
  }

  let status = 'unknown';
  let displayName: string | null = null;
  try {
    const member = await botApi.getChatMember(group.chatId, userId);
    status = member.status;
    displayName = telegramDisplayName(member.user);
  } catch (err) {
    // A user Telegram has never seen in this chat throws, as does any transient
    // API failure. Cache the miss for the TTL so a retrying client can't turn a
    // 403 into a getChatMember flood.
    console.warn(`getChatMember failed for chat ${group.chatId} user ${userId}:`, err);
  }

  const checkedAt = new Date();
  await db
    .insert(groupMembers)
    .values({ groupId: group.id, userId, status, checkedAt, displayName })
    .onConflictDoUpdate({
      target: [groupMembers.groupId, groupMembers.userId],
      // A failed check must not erase a name we already hold.
      set: { status, checkedAt, ...(displayName ? { displayName } : {}) },
    });
  return ALLOWED_STATUSES.has(status);
}

/** @username when there is one, else the profile name — the chat's own convention. */
export function telegramDisplayName(user: {
  first_name: string;
  last_name?: string;
  username?: string;
}): string | null {
  if (user.username) return `@${user.username}`;
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return name || null;
}

/**
 * A chat command proves membership and carries the sender's name, so it keeps
 * group_members current without a getChatMember round trip. Never lowers a
 * cached status: only the name moves.
 */
export async function rememberMemberName(
  db: Db,
  groupId: number,
  userId: number,
  displayName: string | null,
): Promise<void> {
  if (!displayName) return;
  await db
    .insert(groupMembers)
    .values({ groupId, userId, status: 'member', checkedAt: new Date(), displayName })
    .onConflictDoUpdate({
      target: [groupMembers.groupId, groupMembers.userId],
      set: { displayName },
    });
}

/**
 * What ONE member goes by in this group — the single-member form of the
 * watchlist's loadSlotHolderNames, and the same two sources in the same order:
 * `group_members.display_name` (written by every membership check and chat
 * command, round 16c), then their most recent mention here as the fallback for
 * members cached before that column existed.
 *
 * Round 21 needs it for the member verdict: "marked dead by @name" is written
 * into the row at the moment of the verdict, so the board never has to re-look
 * up a name that may have changed since.
 *
 * null when neither source knows them — the caller decides what an unnamed
 * member is called, and must not invent one.
 */
export async function memberDisplayName(
  db: Db,
  groupId: number,
  userId: number,
): Promise<string | null> {
  const [member] = await db
    .select({ displayName: groupMembers.displayName })
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)))
    .limit(1);
  if (member?.displayName) return member.displayName;
  const [mentioned] = await db
    .select({ userName: mentions.userName })
    .from(mentions)
    .innerJoin(calls, eq(calls.id, mentions.callId))
    .where(and(eq(calls.groupId, groupId), eq(mentions.userId, userId)))
    .orderBy(desc(mentions.at))
    .limit(1);
  return mentioned?.userName ?? null;
}

/**
 * Gate for /api/g/:slug/*: session -> group -> Telegram membership. 401 without
 * a session, 404 for an unknown/removed group, 403 for a non-member — a 404
 * would otherwise let anyone probe which slugs exist.
 */
export function requireMember(db: Db, botApi: Api, config: Config): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const userId = readSession(c, config);
    if (userId === null) return c.json({ error: 'unauthorized' }, 401);

    const slug = c.req.param('slug');
    if (!slug) return c.json({ error: 'not found' }, 404);
    const group = (await db.select().from(groups).where(eq(groups.slug, slug)))[0];
    if (!group || group.status !== 'active') return c.json({ error: 'not found' }, 404);

    // Dev auth has no Telegram identity behind it, so there is nothing to ask
    // Telegram about; the fake user is a member of every group it can name.
    const bypass = devAuthEnabled(config) && userId === config.devAuthUserId;
    if (!bypass && !(await checkMembership(db, botApi, group, userId))) {
      return c.json({ error: 'forbidden' }, 403);
    }

    c.set('group', group);
    c.set('userId', userId);
    await next();
  };
}
