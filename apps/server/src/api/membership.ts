import { and, eq } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import type { Api } from 'grammy';
import { groupMembers, groups, type Db } from '@groupie/db';
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
  try {
    status = (await botApi.getChatMember(group.chatId, userId)).status;
  } catch (err) {
    // A user Telegram has never seen in this chat throws, as does any transient
    // API failure. Cache the miss for the TTL so a retrying client can't turn a
    // 403 into a getChatMember flood.
    console.warn(`getChatMember failed for chat ${group.chatId} user ${userId}:`, err);
  }

  const checkedAt = new Date();
  await db
    .insert(groupMembers)
    .values({ groupId: group.id, userId, status, checkedAt })
    .onConflictDoUpdate({
      target: [groupMembers.groupId, groupMembers.userId],
      set: { status, checkedAt },
    });
  return ALLOWED_STATUSES.has(status);
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
