import { and, asc, desc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { launchCandidates, launchMonitors, type Db } from '@groupie/db';
import { XWATCH } from '@groupie/shared';
import { normalizeHandle, type HandleResolution, type TweetWatcher, type XProfile } from './client.js';

/**
 * The tracked-account list (docs/decisions.md round 23): who is on it, who may
 * add one, and what happens to a monitor whose account goes away.
 *
 * The caps are the watchlist's pattern (docs/decisions.md round 15) at a group
 * scope: twelve handles per group — one provider rule's worth, plus room — and
 * three per member, counted under a transaction advisory lock so the chat and
 * the board cannot race past them together.
 *
 * A monitor NEVER REPOINTS. `x_user_id` is read once, when the handle is added,
 * and a refresh that finds a different id behind the same handle marks the row
 * 'renamed' instead of following it: X handles are transferable, and silently
 * watching whoever bought the name is worse than saying the monitor is broken.
 *
 * 'renamed' IS THE DEFAULT BROKEN STATE, and 'suspended' is only ever said when
 * the provider says it. A handle that stops resolving means the @ no longer
 * answers for the account this group added — a rename, a deletion and a
 * suspension all look identical from a handle lookup, and only one of those is
 * an accusation.
 */

/** Statuses that hold a slot: still tracked, still the member's to remove. */
export const OCCUPYING_STATUSES = ['active', 'renamed', 'suspended'] as const;
/** ...and the ones the runner actually polls. */
export const POLLED_STATUSES = ['active'] as const;
/**
 * Statuses that block a second `track` of the same handle. 'launched' is here
 * and NOT in the caps above: the monitor is finished (one message per monitor,
 * ever) so it consumes no slot, but it is still on the board — re-adding the
 * handle would duplicate the row rather than start anything.
 */
const BLOCKING_STATUSES = [...OCCUPYING_STATUSES, 'launched'] as const;

export type MonitorRow = typeof launchMonitors.$inferSelect;

/**
 * Same advisory-lock discipline as watchlist.ts and discovery/alerts.ts, on a
 * namespace nobody else uses: one GROUP's monitor adds are serialized, so two
 * clients cannot both read eleven against a cap of twelve.
 */
const LOCK_NAMESPACE = sql.raw(String(0x0efd));

export type TrackOutcome =
  | { ok: true; monitor: MonitorRow; heldByMember: number; reactivated: boolean }
  /** The handle is not a handle (X allows 1-15 of [A-Za-z0-9_]). */
  | { ok: false; reason: 'invalid' }
  /** No provider key in this deployment: nothing can be tracked here. */
  | { ok: false; reason: 'disabled' }
  /** X has no such account (or it is suspended) — the 404-shaped answers. */
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'suspended' }
  /** We could not ASK. Never a verdict about the account. */
  | { ok: false; reason: 'provider'; detail: string }
  | { ok: false; reason: 'duplicate'; status: string }
  | { ok: false; reason: 'cap_group'; cap: number }
  | { ok: false; reason: 'cap_member'; cap: number };

function profileFields(profile: XProfile): Partial<MonitorRow> {
  return {
    xUserId: profile.userId,
    displayName: profile.displayName,
    avatarUrl: profile.avatarUrl,
    bio: profile.bio,
    followers: profile.followers,
    accountCreatedAt: profile.accountCreatedAt,
  };
}

export interface TrackParams {
  groupId: number;
  userId: number;
  /** As typed — with or without the @, any case. */
  handle: string;
  note?: string | null;
  /** The chat message that added it; null from the web (then the ping is fresh). */
  messageId?: number | null;
}

/**
 * Track an account. Resolves it on X FIRST — a handle nobody can find is a
 * typo, and storing it would put a permanent dead row on the board — then takes
 * the lock and enforces the caps.
 */
export async function trackMonitor(
  db: Db,
  watcher: TweetWatcher | null,
  params: TrackParams,
): Promise<TrackOutcome> {
  const handle = normalizeHandle(params.handle);
  if (handle === null) return { ok: false, reason: 'invalid' };
  if (watcher === null) return { ok: false, reason: 'disabled' };

  let resolution: HandleResolution;
  try {
    resolution = await watcher.resolveHandle(handle);
  } catch (err) {
    return {
      ok: false,
      reason: 'provider',
      detail: err instanceof Error ? err.name : 'unavailable',
    };
  }
  if (resolution.status === 'not_found') return { ok: false, reason: 'not_found' };
  if (resolution.status === 'suspended') return { ok: false, reason: 'suspended' };
  if (resolution.status === 'error') {
    return { ok: false, reason: 'provider', detail: resolution.detail };
  }
  const profile = resolution.profile;
  const note = params.note?.trim() ? params.note.trim().slice(0, 280) : null;
  // One clock for both, so `expires_at` is exactly added_at + 60 days.
  const addedAt = new Date();
  const expiresAt = new Date(addedAt.getTime() + XWATCH.expireDays * 86_400_000);

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${LOCK_NAMESPACE}, hashtext(${`xwatch:${params.groupId}`}))`,
    );

    const existing = (
      await tx
        .select()
        .from(launchMonitors)
        .where(
          and(
            eq(launchMonitors.groupId, params.groupId),
            sql`lower(${launchMonitors.xHandle}) = ${handle}`,
          ),
        )
        .limit(1)
    )[0];
    if (existing && (BLOCKING_STATUSES as readonly string[]).includes(existing.status)) {
      return { ok: false, reason: 'duplicate', status: existing.status } as const;
    }

    const held = await tx
      .select({ addedBy: launchMonitors.addedBy })
      .from(launchMonitors)
      .where(
        and(
          eq(launchMonitors.groupId, params.groupId),
          inArray(launchMonitors.status, [...OCCUPYING_STATUSES]),
        ),
      );
    if (held.length >= XWATCH.capPerGroup) {
      return { ok: false, reason: 'cap_group', cap: XWATCH.capPerGroup } as const;
    }
    const mine = held.filter((r) => Number(r.addedBy) === params.userId).length;
    if (mine >= XWATCH.capPerMember) {
      return { ok: false, reason: 'cap_member', cap: XWATCH.capPerMember } as const;
    }

    const values = {
      groupId: params.groupId,
      xHandle: handle,
      addedBy: params.userId,
      addedAt,
      status: 'active' as const,
      note,
      addedMessageId: params.messageId ?? null,
      followersAtAdd: profile.followers,
      expiresAt,
      // THE RESOLVE ABOVE WAS A REFRESH. Leaving this null would put a
      // just-read profile at the FRONT of the rotation (nulls first), so a
      // group adding twelve handles would spend twelve provider calls
      // re-reading what it had read seconds earlier.
      profileRefreshedAt: addedAt,
      ...profileFields(profile),
    };

    if (existing) {
      // A removed or expired row is re-used rather than duplicated: the unique
      // index is on (group, lower(handle)), and a fresh track is a fresh
      // monitor — new adder, new clock, and NO launch history carried over.
      const updated = await tx
        .update(launchMonitors)
        .set({
          ...values,
          lastCheckedAt: null,
          lastPostAt: null,
          lastTweetId: null,
          // POST HISTORY, NOT PROFILE. `last_post_via` describes how the post
          // this row holds reached us, and the three columns above just said it
          // holds none — leaving a stale 'replies' would make a monitor that has
          // seen nothing print a fact about X's index it has no evidence for.
          lastPostVia: null,
          providerRuleId: null,
          launchedAddress: null,
          launchedTokenId: null,
          launchedAt: null,
          launchTweetId: null,
          launchTweetUrl: null,
          launchPinged: false,
          launchedHoldReason: null,
          launchedTokenCreatedAt: null,
          // `profileRefreshedAt` is NOT cleared here: `values` above stamps it
          // with this track's own resolve, which is a refresh like any other.
        })
        .where(eq(launchMonitors.id, existing.id))
        .returning();
      const monitor = updated[0];
      if (!monitor) return { ok: false, reason: 'duplicate', status: existing.status } as const;
      return { ok: true, monitor, heldByMember: mine + 1, reactivated: true } as const;
    }

    const inserted = await tx.insert(launchMonitors).values(values).returning();
    const monitor = inserted[0];
    // Lost a race for the same handle despite the lock (another process, no
    // lock): the unique index held, and "already tracked" is the honest answer.
    if (!monitor) return { ok: false, reason: 'duplicate', status: 'active' } as const;
    return { ok: true, monitor, heldByMember: mine + 1, reactivated: false } as const;
  });
}

/**
 * Stop tracking. Any member may, whoever added it — the same group-wide rule
 * binning and un-watching follow. Idempotent; answers whether it stopped one.
 *
 * An 'expired' row is removable too: a FINISHED monitor is still on the board,
 * and "you cannot take that off your own board" would be the only answer this
 * command has no reason to give.
 */
export async function untrackMonitor(
  db: Db,
  groupId: number,
  target: { id?: number; handle?: string },
): Promise<MonitorRow | undefined> {
  const handle = target.handle === undefined ? null : normalizeHandle(target.handle);
  if (target.id === undefined && handle === null) return undefined;
  const stopped = await db
    .update(launchMonitors)
    .set({ status: 'removed' })
    .where(
      and(
        eq(launchMonitors.groupId, groupId),
        target.id === undefined
          ? sql`lower(${launchMonitors.xHandle}) = ${handle}`
          : eq(launchMonitors.id, target.id),
        // Idempotent AND honest: a row already removed reports nothing stopped.
        inArray(launchMonitors.status, [...BLOCKING_STATUSES, 'expired']),
      ),
    )
    .returning();
  return stopped[0];
}

/** Does this monitor still hold one of the group's twelve slots? */
export function holdsSlot(status: string): boolean {
  return (OCCUPYING_STATUSES as readonly string[]).includes(status);
}

/**
 * Slots held on this board, and how many of them are one member's — omit the
 * member and `usedByMe` is zero, which is what a group-wide count wants.
 */
export function countSlots(
  rows: readonly Pick<MonitorRow, 'status' | 'addedBy'>[],
  userId?: number,
): { used: number; usedByMe: number } {
  let used = 0;
  let usedByMe = 0;
  for (const row of rows) {
    if (!holdsSlot(row.status)) continue;
    used += 1;
    if (userId !== undefined && Number(row.addedBy) === userId) usedByMe += 1;
  }
  return { used, usedByMe };
}

/** One group's monitors, newest activity first (the board's order). */
export async function listMonitors(db: Db, groupId: number): Promise<MonitorRow[]> {
  return db
    .select()
    .from(launchMonitors)
    .where(
      and(
        eq(launchMonitors.groupId, groupId),
        inArray(launchMonitors.status, [...BLOCKING_STATUSES, 'expired']),
      ),
    )
    .orderBy(
      desc(sql`coalesce(${launchMonitors.launchedAt}, ${launchMonitors.lastPostAt}, ${launchMonitors.addedAt})`),
      desc(launchMonitors.id),
    );
}

/**
 * Candidates for a set of monitors, newest first — a 'posted' row is dated by
 * the POST that carried it, a Tier-B claim by when the scan saw the launch.
 *
 * CAPPED PER MONITOR, not overall. A tracked handle attracts impostors (the
 * research found six handles with two or three claimants inside nine minutes),
 * so an unbounded list would let one popular account's sixty days of claims
 * arrive on every board poll — and a plain global LIMIT would let that same
 * account crowd the other eleven monitors off the board. The correlated count
 * keeps the newest `XWATCH.candidatesPerMonitor` of EACH, in one round trip.
 */
export async function listCandidates(
  db: Db,
  monitorIds: number[],
): Promise<Array<typeof launchCandidates.$inferSelect>> {
  if (monitorIds.length === 0) return [];
  const dated = sql`coalesce(${launchCandidates.postedAt}, ${launchCandidates.seenAt})`;
  return db
    .select()
    .from(launchCandidates)
    .where(
      and(
        inArray(launchCandidates.monitorId, monitorIds),
        sql`(select count(*) from ${launchCandidates} newer
             where newer.monitor_id = ${launchCandidates.monitorId}
               and coalesce(newer.posted_at, newer.seen_at) > ${dated}) < ${XWATCH.candidatesPerMonitor}`,
      ),
    )
    .orderBy(desc(dated));
}

/** Every monitor the runner polls, across every group. */
export async function polledMonitors(db: Db): Promise<MonitorRow[]> {
  return db
    .select()
    .from(launchMonitors)
    .where(inArray(launchMonitors.status, [...POLLED_STATUSES]))
    .orderBy(asc(launchMonitors.id));
}

/**
 * The oldest-refreshed monitors first (nulls first), so a rotation covers the
 * whole watchlist instead of re-reading whichever rows the id order puts first.
 */
export async function profileRefreshQueue(
  db: Db,
  limit: number = XWATCH.profilesPerPass,
): Promise<MonitorRow[]> {
  return db
    .select()
    .from(launchMonitors)
    .where(inArray(launchMonitors.status, [...POLLED_STATUSES]))
    .orderBy(sql`${launchMonitors.profileRefreshedAt} asc nulls first`, asc(launchMonitors.id))
    .limit(limit);
}

/** Stamp a profile-refresh ATTEMPT, whatever it learned (or failed to). */
export async function stampProfileRefreshed(db: Db, id: number, at: Date): Promise<void> {
  await db
    .update(launchMonitors)
    .set({ profileRefreshedAt: at })
    .where(eq(launchMonitors.id, id));
}

/**
 * The watcher's last successful check — the stall clock.
 *
 * Scoped to the monitors still being POLLED: a group whose every monitor has
 * launched or expired has nothing being checked, and a timestamp frozen at
 * whenever the last live one was read would be printed as "checked 3d ago"
 * about a watcher that is working perfectly.
 */
export async function lastCheckAt(db: Db, groupId?: number): Promise<Date | null> {
  const rows = await db
    .select({ at: sql<string | Date | null>`max(${launchMonitors.lastCheckedAt})` })
    .from(launchMonitors)
    .where(
      and(
        inArray(launchMonitors.status, [...POLLED_STATUSES]),
        isNotNull(launchMonitors.lastCheckedAt),
        groupId === undefined ? undefined : eq(launchMonitors.groupId, groupId),
      ),
    );
  const raw = rows[0]?.at ?? null;
  if (raw === null) return null;
  // max() comes back as a string from postgres-js; a Date survives untouched.
  const at = raw instanceof Date ? raw : new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** Stamp a successful provider check on the monitors that poll answered for. */
export async function markChecked(db: Db, monitorIds: number[], at: Date): Promise<void> {
  if (monitorIds.length === 0) return;
  await db
    .update(launchMonitors)
    .set({ lastCheckedAt: at })
    .where(inArray(launchMonitors.id, monitorIds));
}

/** Record which rule shard a monitor is polled in (only when it changed). */
export async function setRuleIds(db: Db, byMonitor: Map<number, string>): Promise<void> {
  for (const [id, ruleId] of byMonitor) {
    await db
      .update(launchMonitors)
      .set({ providerRuleId: ruleId })
      .where(
        and(
          eq(launchMonitors.id, id),
          or(
            sql`${launchMonitors.providerRuleId} is null`,
            sql`${launchMonitors.providerRuleId} <> ${ruleId}`,
          ),
        ),
      );
  }
}

/**
 * The account posted. Recorded even when the post carries no address — it is
 * what keeps the 60-day expiry clock honest, and what the board prints as
 * "quiet 14h".
 *
 * `expires_at` is moved with it, and is the SINGLE source the sweep reads: one
 * column that always says when this monitor runs out, rather than an expiry
 * rule recomputed from two other columns wherever somebody needs it.
 *
 * `greatest` so an out-of-order page can never move either clock backwards.
 *
 * `via` is WHICH READ FOUND IT (round 25): the from: search, reply recovery, or
 * the Top sweep. It is diagnosis, not decoration — an account whose posts only
 * ever arrive via replies/top is an account X is hiding from the Latest index,
 * which is the failure this round exists to survive and the one thing a stored
 * column can tell an operator about it.
 */
export async function recordPost(
  db: Db,
  monitorId: number,
  post: { at: Date; id: string; via: 'search' | 'replies' | 'top' },
): Promise<void> {
  // No bare Date inside a raw sql template (the driver does not encode it):
  // ISO string plus an explicit cast, the repo's rule everywhere.
  const at = post.at.toISOString();
  const expires = new Date(post.at.getTime() + XWATCH.expireDays * 86_400_000).toISOString();
  // COMPARED AGAINST THE OLD ROW, in the same statement and for the same reason
  // `greatest` guards the clocks below: reply recovery can hand us a post OLDER
  // than the one already recorded (parents are fetched over a sixty-minute
  // window, oldest-first, minutes after the from: poll saw a newer post), and
  // letting that stamp 'replies' over the newer post's 'search' would report an
  // account as hidden on the strength of a read that arrived late, not first.
  //
  // STRICTLY NEWER, or a DIFFERENT post in the same second. The equal case is
  // the same post arriving twice by a slower road — the seen set is in-process
  // only, so after a restart the from: read's ten-minute window no longer serves
  // a post the sixty-minute recovery window still reaches, and X's createdAt is
  // second-precision, so `at` is byte-identical on the second write.
  // Re-recording it must keep the source that found it FIRST; the id clause is
  // what still lets a genuinely second post inside that one second through.
  //
  // (In postgres every SET expression reads the PRE-UPDATE row, so all three
  // column references below see the post this row held before this statement.)
  const isNewerPost = sql`${launchMonitors.lastPostAt} is null
      or ${launchMonitors.lastPostAt} < ${at}::timestamptz
      or (${launchMonitors.lastPostAt} = ${at}::timestamptz
          and coalesce(${launchMonitors.lastTweetId}, '') <> ${post.id})`;
  await db
    .update(launchMonitors)
    .set({
      lastPostAt: sql`greatest(coalesce(${launchMonitors.lastPostAt}, ${at}::timestamptz), ${at}::timestamptz)`,
      expiresAt: sql`greatest(coalesce(${launchMonitors.expiresAt}, ${expires}::timestamptz), ${expires}::timestamptz)`,
      // THE SAME GUARD AS `last_post_via`, and it must be the same one: the id
      // is what the tie-break above reads to tell a second post inside one
      // second from the same post re-read. Written unconditionally, an older
      // post recorded after a newer one (recovery's oldest-first pass) would
      // leave the id pointing at the OLD post while `last_post_at` still held
      // the newer one — and the next re-read of that newer post would then look
      // like "same second, different id" and restamp the source anyway, which
      // is the whole defect this guard exists to close. Guarded, the three
      // columns always describe ONE post: its clock, its id, its road here.
      // (The one deliberate exception is alerts.ts's launch flip, which stamps
      // the LAUNCHING post's id on its own — that write is the launch record,
      // not this post clock.)
      lastTweetId: sql`case when ${isNewerPost} then ${post.id} else ${launchMonitors.lastTweetId} end`,
      // WHICH READ FOUND IT — the from: search, reply recovery, or the Top
      // sweep — and only ever for the newest post this row holds.
      lastPostVia: sql`case when ${isNewerPost} then ${post.via} else ${launchMonitors.lastPostVia} end`,
    })
    .where(eq(launchMonitors.id, monitorId));
}

/** Two handles, compared the way they are stored: lowercase, no leading @. */
function sameHandle(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const norm = (h: string): string => h.trim().replace(/^@+/, '').toLowerCase();
  return norm(a) !== '' && norm(a) === norm(b);
}

/**
 * Apply a profile refresh — or the fact that there was no profile to refresh.
 *
 * THE LABELS ARE EVIDENCE-SHAPED. 'ok' with a DIFFERENT user id is a rename:
 * the row keeps its stored id and is marked 'renamed'. A handle that no longer
 * resolves is ALSO 'renamed' — the @ stopped answering for the account this
 * group added, which is all a handle lookup can tell us. Only the provider
 * saying SUSPENDED marks a row 'suspended', because that word is an accusation
 * and a 404 does not support it. An 'error' writes NOTHING: a provider outage
 * is not evidence about anybody's account.
 *
 * `byId` is the second opinion, when the adapter offers one: the stored numeric
 * id survives a rename, so an id that answers under a DIFFERENT handle proves
 * the account renamed itself, and an id the provider calls suspended is the
 * only source that word may come from.
 *
 * AN ID THAT ANSWERS UNDER THE SAME HANDLE IS A CONTRADICTION, not a rename:
 * the handle lookup said "@x is gone" and the id lookup said "@x is right
 * here". One of the two calls is wrong, and a contradiction is not evidence —
 * nothing is written, and the next rotation asks again.
 */
export async function applyProfileRefresh(
  db: Db,
  monitor: Pick<MonitorRow, 'id' | 'xUserId' | 'status' | 'xHandle'>,
  resolution: HandleResolution,
  byId?: HandleResolution,
): Promise<'updated' | 'renamed' | 'suspended' | 'ignored'> {
  if (resolution.status === 'error') return 'ignored';
  if (resolution.status === 'not_found' || resolution.status === 'suspended') {
    // A handle the provider calls suspended needs no second opinion. A handle
    // that is merely GONE gets one: an id lookup that errored is the absence of
    // an answer and writes nothing, an id that still answers under this very
    // handle contradicts the lookup that sent us here and also writes nothing,
    // an id the provider calls suspended is the only source that word may come
    // from, and anything else — including no id opinion at all — is a rename.
    let next: 'renamed' | 'suspended' = 'renamed';
    if (resolution.status === 'suspended') {
      next = 'suspended';
    } else if (byId !== undefined) {
      if (byId.status === 'error') return 'ignored';
      if (byId.status === 'suspended') next = 'suspended';
      else if (byId.status === 'ok' && sameHandle(byId.profile.handle, monitor.xHandle)) {
        return 'ignored';
      }
    }
    await db
      .update(launchMonitors)
      .set({ status: next })
      .where(and(eq(launchMonitors.id, monitor.id), eq(launchMonitors.status, 'active')));
    return next;
  }
  const profile = resolution.profile;
  if (monitor.xUserId !== null && profile.userId !== monitor.xUserId) {
    // NEVER repoint: the handle changed hands, and the account this group asked
    // about is not the account behind it any more.
    await db
      .update(launchMonitors)
      .set({ status: 'renamed' })
      .where(and(eq(launchMonitors.id, monitor.id), eq(launchMonitors.status, 'active')));
    return 'renamed';
  }
  await db
    .update(launchMonitors)
    .set({
      ...profileFields(profile),
      // A monitor added before the id could be read adopts THIS id once, which
      // is not a repoint: it had nothing to point at.
      xUserId: monitor.xUserId ?? profile.userId,
    })
    .where(eq(launchMonitors.id, monitor.id));
  return 'updated';
}

/**
 * Expire monitors that have run out — `expires_at` is the single source, set to
 * added_at + 60d when the handle is tracked and pushed forward by every post.
 *
 * It sweeps 'renamed' and 'suspended' as well as 'active': a broken monitor
 * holds one of the group's twelve slots and nothing will ever move its clock
 * again, so leaving it out of the sweep would mean a renamed account costs a
 * slot forever. (The fallback clause dates a row written before `expires_at`
 * existed; a row that carries one never reads the other two columns.)
 */
export async function expireMonitors(db: Db, nowMs: number = Date.now()): Promise<number> {
  const now = new Date(nowMs).toISOString();
  const fallbackCutoff = new Date(nowMs - XWATCH.expireDays * 86_400_000).toISOString();
  const expired = await db
    .update(launchMonitors)
    .set({ status: 'expired' })
    .where(
      and(
        inArray(launchMonitors.status, [...OCCUPYING_STATUSES]),
        or(
          sql`${launchMonitors.expiresAt} < ${now}::timestamptz`,
          sql`${launchMonitors.expiresAt} is null and coalesce(${launchMonitors.lastPostAt}, ${launchMonitors.addedAt}) < ${fallbackCutoff}::timestamptz`,
        ),
      ),
    )
    .returning({ id: launchMonitors.id });
  return expired.length;
}
