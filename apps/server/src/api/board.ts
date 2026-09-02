import { and, desc, eq, gte, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { calls, groupMembers, mentions, snapshots, tokens, watches, type Db } from '@groupie/db';
import {
  BOARD_WINDOWS,
  BOARD_WINDOW_HOURS,
  extractEvmAddresses,
  tradingLinks,
  twitterUrlFrom,
  WATCH_CAP_PER_MEMBER,
  watchCapMessage,
  websiteUrlFrom,
  type BoardCard,
  type BoardResponse,
  type BoardWindow,
  type CallStatus,
  type SparkPoint,
  type WatchlistEntry,
} from '@groupie/shared';
import { upsertToken } from '../bot/ingest.js';
import { publish } from '../events.js';
import { pollTokenNow } from '../poller/scheduler.js';
import {
  activeWatchCount,
  addWatch,
  findGroupToken,
  findTokenByAddress,
  isWatched,
  removeWatch,
} from '../watchlist.js';
import { markCallDead, restoreCall } from '../verdict.js';
import { memberDisplayName, type ApiEnv } from './membership.js';
import { classifySections, parseTzOffsetMin, startOfLocalDayMs } from './boardLogic.js';

/** Contract: sparklines cover the last 24h regardless of the board window. */
const SPARKLINE_HOURS = 24;
const MAX_SPARK_POINTS = 30;

type CallRow = typeof calls.$inferSelect;
type TokenRow = typeof tokens.$inferSelect;

function parseWindow(raw: string | undefined): BoardWindow | null {
  if (raw === undefined || raw === '') return '24h';
  return (BOARD_WINDOWS as readonly string[]).includes(raw) ? (raw as BoardWindow) : null;
}

/** Evenly spaced sample that always keeps the first and last point. */
function downsample(points: SparkPoint[]): SparkPoint[] {
  if (points.length <= MAX_SPARK_POINTS) return points;
  const step = (points.length - 1) / (MAX_SPARK_POINTS - 1);
  const out: SparkPoint[] = [];
  for (let i = 0; i < MAX_SPARK_POINTS; i++) {
    const point = points[Math.round(i * step)];
    if (point) out.push(point);
  }
  return out;
}

/**
 * Death info is call-level first: a call can die on its own liquidity collapse
 * while the token still trades, and a revived token keeps stale token-level
 * history that would misdate a later per-call death. Timestamp, reason and
 * mcap-at-death are taken as one TRIPLE so they always describe the same death
 * — round 15 added the mcap, and a mixed pair would be worse than none. Token
 * values are the fallback for calls that died before per-call stamping existed.
 */
function deathOf(
  call: CallRow,
  token: TokenRow,
): { at: Date | null; reason: string | null; mcapUsd: number | null } {
  if (call.diedAt !== null) {
    return { at: call.diedAt, reason: call.deathReason, mcapUsd: call.mcapAtDeath };
  }
  return { at: token.diedAt, reason: token.deathReason, mcapUsd: token.mcapAtDeath };
}

/** Shared by the board and ranging routes (and the tests) — one card shape. */
export function toCard(
  call: CallRow,
  token: TokenRow,
  sparkline: SparkPoint[],
  watched: boolean,
  watchedByMe = false,
): BoardCard {
  // A zero/negative at-call mcap is a bad reading, not a 0x baseline.
  const base = call.mcapAtCall !== null && call.mcapAtCall > 0 ? call.mcapAtCall : null;
  const death = deathOf(call, token);
  const peak = call.peakMcapSinceCall;
  const retraceFromPeakPct =
    token.mcapUsd !== null && peak !== null && peak > 0
      ? Math.min(100, Math.max(0, (1 - token.mcapUsd / peak) * 100))
      : null;
  return {
    callId: call.id,
    tokenId: token.id,
    address: token.address,
    symbol: token.symbol,
    name: token.name,
    imageUrl: token.imageUrl,
    // tokens.socials is untyped jsonb (DexScreener-shaped when we have it), so
    // the URL is proved rather than assumed (docs/decisions.md round 9).
    twitterUrl: twitterUrlFrom(token.socials),
    // Same defensive read, same blob (docs/decisions.md round 15: a coin with a
    // stored website gets a link everywhere links render).
    websiteUrl: websiteUrlFrom(token.socials),
    phase: token.phase,
    callStatus: call.status,
    mcapUsd: token.mcapUsd,
    liquidityUsd: token.liquidityUsd,
    vol24Usd: token.vol24Usd,
    mcapAtCall: call.mcapAtCall,
    multiple: base !== null && token.mcapUsd !== null ? token.mcapUsd / base : null,
    peakMcapSinceCall: peak,
    peakMultiple: base !== null && peak !== null ? peak / base : null,
    retraceFromPeakPct,
    calledAt: call.calledAt.toISOString(),
    callerName: call.callerName,
    mentionsCount: call.mentionsCount,
    lastMentionAt: call.lastMentionAt.toISOString(),
    revived: token.revivedAt !== null,
    diedAt: death.at?.toISOString() ?? null,
    deathReason: death.reason,
    mcapAtDeath: death.mcapUsd,
    // Round 21. Non-null EXACTLY for a member verdict (the column is only ever
    // written by markCallDead), so the card can tell a verdict from a rule
    // without parsing the reason. Taken from the CALL, like the rest of the
    // death record — never from the token, which is alive.
    deathMarkedBy: call.deathMarkedBy,
    // The trade count behind a flatline death, and a live number the rest of
    // the time. null = the last reading carried none, which prints as unknown.
    txns24: token.txns24,
    dataAsOf: token.lastSnapshotAt?.toISOString() ?? null,
    watched,
    watchedByMe,
    // Raw, not windowed: classifySections owns the 24h badge window, so the
    // two can never disagree about which cards are in the Reviving section.
    revivingAt: token.revivingAt?.toISOString() ?? null,
    links: tradingLinks(token.address),
    sparkline,
  };
}

/**
 * The group's active watchlist — token id -> who added the watch — in one query
 * for a whole board (no per-card lookup). Shared with the ranging route.
 * `.has()` answers "is the group watching", `.get() === userId` answers "is it
 * the reader's slot" (round 15 review: the cap is per member, so the board has
 * to be able to say which pills are yours).
 */
export async function loadWatchedTokenIds(
  db: Db,
  groupId: number,
  tokenIds: number[],
): Promise<Map<number, number>> {
  if (tokenIds.length === 0) return new Map();
  const rows = await db
    .select({ tokenId: watches.tokenId, addedBy: watches.addedBy })
    .from(watches)
    .where(
      and(
        eq(watches.groupId, groupId),
        eq(watches.active, true),
        inArray(watches.tokenId, tokenIds),
      ),
    );
  return new Map(rows.map((r) => [r.tokenId, r.addedBy]));
}

/**
 * One row of the group's active watchlist: the token, who holds the slot, and
 * the group's own non-binned call for it when there is one.
 */
export interface WatchlistRow {
  token: TokenRow;
  addedBy: number;
  addedAt: Date;
  /** watches.mcap_at_watch — the BUY OPP baseline (round 19), null if unmeasured. */
  mcapAtWatch: number | null;
  callId: number | null;
  /** Status of that call — what lets a row say "died" instead of "no call". */
  callStatus: CallStatus | null;
}

/**
 * The group's ENTIRE active watchlist (docs/decisions.md round 16), in one
 * query — not filtered by the board window, and not filtered by rug probation
 * either: this is the only surface where a member can see and free the slots
 * they hold, so a watch that vanishes because its coin went quiet (or went
 * under) is exactly the "stranded slot" round 15's review complained about.
 *
 * The left join is the group's own call for the coin, if any. `calls` is unique
 * on (group, token), so it can never fan a watch out into two rows; watches set
 * from the chat by address and from Sleepers have no call at all and answer
 * null. Binned calls are excluded — a binned card is not on the board, so
 * offering the client an id to join against would be a dangling reference.
 */
export async function loadWatchlistRows(db: Db, groupId: number): Promise<WatchlistRow[]> {
  return db
    .select({
      token: tokens,
      addedBy: watches.addedBy,
      addedAt: watches.addedAt,
      mcapAtWatch: watches.mcapAtWatch,
      callId: calls.id,
      callStatus: calls.status,
    })
    .from(watches)
    .innerJoin(tokens, eq(tokens.id, watches.tokenId))
    .leftJoin(
      calls,
      and(eq(calls.tokenId, watches.tokenId), eq(calls.groupId, groupId), ne(calls.status, 'binned')),
    )
    .where(and(eq(watches.groupId, groupId), eq(watches.active, true)))
    .orderBy(desc(watches.addedAt));
}

/**
 * A watchlist row as the contract shape. `names` is the slot holders' display
 * names (loadSlotHolderNames); a member who has never posted in this group has
 * none, and the row then says "another member's slot" rather than guessing.
 */
export function toWatchlistEntry(
  row: WatchlistRow,
  sparkline: SparkPoint[],
  userId: number,
  names: ReadonlyMap<number, string> = new Map(),
): WatchlistEntry {
  const token = row.token;
  return {
    tokenId: token.id,
    address: token.address,
    symbol: token.symbol,
    imageUrl: token.imageUrl,
    phase: token.phase,
    // The two honesty fields the ON WATCH row explains itself with (round 16
    // review): a watched coin missing from the sections is on probation, died,
    // or simply older than the window — never "no call".
    rugHiddenAt: token.rugHiddenAt?.toISOString() ?? null,
    callStatus: row.callStatus,
    mcapUsd: token.mcapUsd,
    liquidityUsd: token.liquidityUsd,
    dataAsOf: token.lastSnapshotAt?.toISOString() ?? null,
    sparkline,
    // The BUY OPP baseline (round 19): what this coin was worth when the slot
    // was taken, so the row can print the drawdown the alert measures.
    mcapAtWatch: row.mcapAtWatch,
    addedBy: row.addedBy,
    addedByName: names.get(row.addedBy) ?? null,
    addedAt: row.addedAt.toISOString(),
    watchedByMe: row.addedBy === userId,
    callId: row.callId,
    twitterUrl: twitterUrlFrom(token.socials),
    websiteUrl: websiteUrlFrom(token.socials),
    links: tradingLinks(token.address),
  };
}

/**
 * The name each slot holder goes by, keyed by member — never by coin.
 *
 * Two sources, batched for the whole watchlist: group_members.display_name,
 * written by every membership check and chat command (round 16c — it names a
 * member who has never posted a call here, which is exactly who a slot needs
 * to name), then the member's most recent mention in THIS group as the
 * fallback for rows cached before the column existed. `watches.added_by`,
 * `mentions.user_id` and `calls.caller_user_id` are all the same Telegram id.
 * A member absent from both is simply unnamed: the design would rather say
 * "another member's slot" than attribute a slot to the wrong person.
 */
export async function loadSlotHolderNames(
  db: Db,
  groupId: number,
  userIds: number[],
): Promise<Map<number, string>> {
  if (userIds.length === 0) return new Map();
  const [members, mentioned] = await Promise.all([
    db
      .select({ userId: groupMembers.userId, displayName: groupMembers.displayName })
      .from(groupMembers)
      .where(and(eq(groupMembers.groupId, groupId), inArray(groupMembers.userId, userIds))),
    db
      .selectDistinctOn([mentions.userId], { userId: mentions.userId, userName: mentions.userName })
      .from(mentions)
      .innerJoin(calls, eq(calls.id, mentions.callId))
      .where(and(eq(calls.groupId, groupId), inArray(mentions.userId, userIds)))
      .orderBy(mentions.userId, desc(mentions.at)),
  ]);
  const names = new Map<number, string>(mentioned.map((r) => [r.userId, r.userName]));
  for (const m of members) if (m.displayName) names.set(m.userId, m.displayName);
  return names;
}

/** count(*) is a bigint, which postgres-js hands back as a string. */
function countOf(rows: Array<{ n: string | number | null }>): number {
  const n = Number(rows[0]?.n ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Every call this group made since the member's own local midnight, counted in
 * SQL (docs/decisions.md round 15).
 *
 * Every status counts, binned included: "N calls today" is a fact about the
 * chat, not about what the board is currently willing to show. The old
 * payload-derived number was both window-truncated and silently missing
 * anything hidden or binned.
 */
async function loadTodayCallCount(db: Db, groupId: number, dayStartMs: number): Promise<number> {
  const rows = await db
    .select({ n: sql<string | number>`count(*)` })
    .from(calls)
    .where(and(eq(calls.groupId, groupId), gte(calls.calledAt, new Date(dayStartMs))));
  return countOf(rows);
}

/**
 * This group's non-binned calls whose token is on rug probation right now
 * (docs/decisions.md round 15) — the cards the board is deliberately hiding.
 *
 * Counted over tokens, not calls: probation is a token-level state, and one
 * group has at most one call per token anyway. Not windowed — see the field's
 * contract note in packages/shared/src/api.ts.
 */
async function loadHiddenProbationCount(db: Db, groupId: number): Promise<number> {
  const rows = await db
    .select({ n: sql<string | number>`count(distinct ${calls.tokenId})` })
    .from(calls)
    .innerJoin(tokens, eq(tokens.id, calls.tokenId))
    .where(
      and(eq(calls.groupId, groupId), ne(calls.status, 'binned'), isNotNull(tokens.rugHiddenAt)),
    );
  return countOf(rows);
}

/** 24h / 30 points: one bucket per sparkline sample. */
const SPARK_BUCKET_SECONDS = sql.raw(String(Math.round((SPARKLINE_HOURS * 3600) / MAX_SPARK_POINTS)));

// db.execute bypasses Drizzle's column decoders, so postgres-js hands these
// back as strings (timestamptz, double precision) — coerce at the read site.
type SparkRow = {
  token_id: number | string;
  at: Date | string;
  mcap_usd: number | string | null;
} & Record<string, unknown>;

/**
 * Downsample in SQL, not in JS: a fresh token is snapshotted every 45s (~1,900
 * rows/24h) and the board refetches on every price_update, so shipping raw rows
 * for every card dominated egress and endpoint latency.
 *
 * One row per token per bucket (the earliest in each), UNIONed with each
 * token's true latest reading — bucket-firsts alone would drop the freshest
 * point, which is the one a live board is for. Both branches ride
 * snapshots_token_at_idx; downsample() below stays as a cap.
 *
 * Exported for the ranging board, which needs the same sparkline on its cards.
 */
export async function loadSparklines(db: Db, tokenIds: number[]): Promise<Map<number, SparkPoint[]>> {
  const byToken = new Map<number, SparkPoint[]>();
  if (tokenIds.length === 0) return byToken;
  const since = new Date(Date.now() - SPARKLINE_HOURS * 3_600_000);
  const inWindow = and(
    inArray(snapshots.tokenId, tokenIds),
    gte(snapshots.at, since),
    isNotNull(snapshots.mcapUsd),
  );
  const rows = await db.execute<SparkRow>(sql`
    with pts as (
      select distinct on (token_id, bucket) token_id, at, mcap_usd
      from (
        select ${snapshots.tokenId} as token_id,
               ${snapshots.at} as at,
               ${snapshots.mcapUsd} as mcap_usd,
               floor(extract(epoch from ${snapshots.at}) / ${SPARK_BUCKET_SECONDS})::bigint as bucket
        from ${snapshots}
        where ${inWindow}
      ) s
      order by token_id, bucket, at
    ),
    latest as (
      select distinct on (${snapshots.tokenId})
             ${snapshots.tokenId} as token_id,
             ${snapshots.at} as at,
             ${snapshots.mcapUsd} as mcap_usd
      from ${snapshots}
      where ${inWindow}
      order by ${snapshots.tokenId}, ${snapshots.at} desc
    )
    select token_id, at, mcap_usd from pts
    union
    select token_id, at, mcap_usd from latest
    order by at asc
  `);
  for (const row of rows) {
    if (row.mcap_usd === null) continue;
    const mcap = Number(row.mcap_usd);
    const t = new Date(row.at).getTime();
    if (!Number.isFinite(mcap) || !Number.isFinite(t)) continue;
    const tokenId = Number(row.token_id);
    const points = byToken.get(tokenId) ?? [];
    points.push({ t, mcap });
    byToken.set(tokenId, points);
  }
  for (const [tokenId, points] of byToken) byToken.set(tokenId, downsample(points));
  return byToken;
}

export function createBoardRoutes(db: Db): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  app.get('/api/g/:slug/board', async (c) => {
    const group = c.get('group');
    const window = parseWindow(c.req.query('window'));
    if (window === null) {
      return c.json({ error: `window must be one of ${BOARD_WINDOWS.join(', ')}` }, 400);
    }

    const since = new Date(Date.now() - BOARD_WINDOW_HOURS[window] * 3_600_000);
    const [rows, watchRows] = await Promise.all([
      db
        .select({ call: calls, token: tokens })
        .from(calls)
        .innerJoin(tokens, eq(tokens.id, calls.tokenId))
        .where(
          and(
            eq(calls.groupId, group.id),
            ne(calls.status, 'binned'),
            gte(calls.lastMentionAt, since),
            // Rug probation hides the card from EVERY section, died included
            // (docs/decisions.md round 6). Filtered here rather than in
            // classifySections so no section can ever leak a hidden token.
            isNull(tokens.rugHiddenAt),
          ),
        ),
      loadWatchlistRows(db, group.id),
    ]);

    const cardTokenIds = [...new Set(rows.map((r) => r.token.id))];
    // One sparkline query for cards AND watchlist rows: a watched coin with no
    // call is not on the board, so its points would otherwise need a second
    // round trip per entry.
    const sparkTokenIds = [...new Set([...cardTokenIds, ...watchRows.map((w) => w.token.id)])];
    // The group's active watches, straight off the rows we already have — the
    // watchlist is every active row, so it answers "is the group watching this
    // card" and "is the slot mine" without a second query.
    const watchedIds = new Map(watchRows.map((w) => [w.token.id, w.addedBy]));
    // The client's own midnight: the server has no idea what day it is where
    // the member is, and a UTC day would report the wrong number for most of
    // the group's evening. An absent/junk offset falls back to UTC.
    const dayStartMs = startOfLocalDayMs(Date.now(), parseTzOffsetMin(c.req.query('tz')));
    const slotHolderIds = [...new Set(watchRows.map((w) => w.addedBy))];
    const [sparklines, todayCallCount, hiddenProbationCount, slotHolderNames] = await Promise.all([
      loadSparklines(db, sparkTokenIds),
      loadTodayCallCount(db, group.id, dayStartMs),
      loadHiddenProbationCount(db, group.id),
      loadSlotHolderNames(db, group.id, slotHolderIds),
    ]);
    const userId = c.get('userId');
    const cards = rows.map((r) =>
      toCard(
        r.call,
        r.token,
        sparklines.get(r.token.id) ?? [],
        watchedIds.has(r.token.id),
        watchedIds.get(r.token.id) === userId,
      ),
    );

    const body: BoardResponse = {
      group: { slug: group.slug, title: group.title },
      window,
      generatedAt: new Date().toISOString(),
      todayCallCount,
      hiddenProbationCount,
      sections: classifySections(cards),
      watchlist: watchRows.map((w) =>
        toWatchlistEntry(w, sparklines.get(w.token.id) ?? [], userId, slotHolderNames),
      ),
    };
    return c.json(body);
  });

  // Any member may bin, and the effect is group-wide (docs/decisions.md).
  app.post('/api/g/:slug/calls/:callId/bin', async (c) => {
    const group = c.get('group');
    const callId = parsePathId(c.req.param('callId'));
    if (callId === null) return c.json({ error: 'not found' }, 404);

    // Conditional update: the status check and the write are one statement, so
    // two members binning at once can't race into a double-bin.
    const binned = await db
      .update(calls)
      .set({ status: 'binned', binnedBy: c.get('userId'), binnedAt: new Date() })
      .where(and(eq(calls.id, callId), eq(calls.groupId, group.id), eq(calls.status, 'died')))
      .returning({ id: calls.id, tokenId: calls.tokenId });
    if (binned[0]) {
      // Group-wide effect: tell every other open board to refetch instead of
      // leaving the binned card on screen until some unrelated poll event.
      publish({ type: 'call_binned', tokenId: binned[0].tokenId, callId, groupId: group.id });
      return c.body(null, 204);
    }

    const existing = (
      await db
        .select({ status: calls.status })
        .from(calls)
        .where(and(eq(calls.id, callId), eq(calls.groupId, group.id)))
    )[0];
    if (!existing) return c.json({ error: 'not found' }, 404);
    return c.json({ error: `only died calls can be binned (status: ${existing.status})` }, 409);
  });

  /**
   * MARK DEAD (docs/decisions.md round 21) — the member verdict. Any member,
   * group-wide, exactly the standing binning has: the rules cannot see a coin
   * that was dumped without its pool draining ($VLR at 0.4x on $19K of intact
   * liquidity), so the group is allowed to say so.
   *
   * Only a LIVE call can be marked: a call that a rule already killed keeps the
   * rule's record, and one that is binned is off the board entirely.
   */
  app.post('/api/g/:slug/calls/:callId/dead', async (c) => {
    const group = c.get('group');
    const callId = parsePathId(c.req.param('callId'));
    if (callId === null) return c.json({ error: 'not found' }, 404);

    // The name is stamped into the row at the moment of the verdict (see
    // markCallDead) — the session's member, never the request body's.
    const markedBy = await memberDisplayName(db, group.id, c.get('userId'));
    const outcome = await markCallDead(db, group.id, callId, markedBy);
    if (outcome === 'marked') return c.body(null, 204);
    if (outcome === 'not_found') return c.json({ error: 'not found' }, 404);
    return c.json({ error: 'only live calls can be marked dead' }, 409);
  });

  /**
   * RESTORE — the only way back from a member verdict, and a member action too
   * (round 21: a marked death is exempt from every automatic revival, so
   * nothing else will ever undo it). A rule death is not restorable here: it
   * has its own comeback path, and reversing it by hand would erase a record
   * the poller is still using.
   */
  app.delete('/api/g/:slug/calls/:callId/dead', async (c) => {
    const group = c.get('group');
    const callId = parsePathId(c.req.param('callId'));
    if (callId === null) return c.json({ error: 'not found' }, 404);

    const outcome = await restoreCall(db, group.id, callId);
    if (outcome === 'restored') return c.body(null, 204);
    if (outcome === 'not_found') return c.json({ error: 'not found' }, 404);
    // Round 21 amendment (d): the verdict still stands, but a rule has killed
    // the coin since — there is nothing live to put the call back onto.
    if (outcome === 'token_dead') {
      return c.json({ error: 'the coin is dead — nothing to restore it to' }, 409);
    }
    return c.json({ error: 'only a member-marked death can be restored' }, 409);
  });

  /**
   * The watch button (docs/decisions.md round 15). "Watching" means exactly
   * what `/overseer watch` means — the group's nuke/buy-opp alerts for that
   * coin, posted into the chat — so both paths go through watchlist.ts and
   * share the cap. The member is the session's, never the request body's.
   */
  app.post('/api/g/:slug/tokens/:tokenId/watch', async (c) => {
    const group = c.get('group');
    const tokenId = parsePathId(c.req.param('tokenId'));
    if (tokenId === null) return c.json({ error: 'not found' }, 404);
    // Group-scoped, like the bin route: the button only renders on this
    // group's cards, and a global lookup would make the 404/204 split an
    // existence oracle over other groups' token ids (round 15 review).
    if (!(await findGroupToken(db, group.id, tokenId))) return c.json({ error: 'not found' }, 404);

    const outcome = await addWatch(db, group.id, tokenId, c.get('userId'));
    // 409, not 403: nothing is forbidden, the member's three slots are full.
    // The message is the one the bot sends, so the two surfaces read alike.
    if (!outcome.ok) return c.json({ error: watchCapMessage(outcome.cap), cap: outcome.cap }, 409);

    // Same immediate poll as the address route and the bot: a card's coin can
    // be minutes behind its tier, and the round-19 baseline is only stamped
    // from a contemporaneous reading — this is the one that lands it.
    pollTokenNow(db, tokenId).catch((err) =>
      console.error(`immediate poll failed for watched token ${tokenId}:`, err),
    );
    return c.body(null, 204);
  });

  /**
   * Any member may stop a watch, whoever added it — the same group-wide rule
   * binning has (docs/decisions.md round 2). Idempotent: unwatching a coin
   * nobody is watching is a 204, not an error.
   */
  app.delete('/api/g/:slug/tokens/:tokenId/watch', async (c) => {
    const group = c.get('group');
    const tokenId = parsePathId(c.req.param('tokenId'));
    if (tokenId === null) return c.json({ error: 'not found' }, 404);
    await removeWatch(db, group.id, tokenId);
    return c.body(null, 204);
  });

  /**
   * Watch by ADDRESS (docs/decisions.md round 16) — the web's version of
   * `/overseer watch <ca>`, and the only path for a coin the group has never
   * called (a Sleepers row). Same cap, same credit, same immediate poll; the
   * member is the session's, never the body's.
   */
  app.post('/api/g/:slug/watch', bodyLimit({ maxSize: WATCH_BODY_MAX_BYTES }), async (c) => {
    const group = c.get('group');
    const body = (await c.req.json().catch(() => null)) as { address?: unknown } | null;
    const address = parseAddress(body?.address);
    if (address === null) return c.json({ error: ADDRESS_ERROR }, 400);

    const userId = c.get('userId');
    const known = await findTokenByAddress(db, address);
    // A coin the GROUP already watches consumes no slot — addWatch answers
    // ok/alreadyActive for exactly this state, and the card route 204s — so the
    // cap must not refuse it here either (round 16 review). It also cannot
    // orphan anything: the tokens row is already there.
    if (known && (await isWatched(db, group.id, known.id))) return c.body(null, 204);
    // Cheap pre-check BEFORE upsertToken, exactly like the bot's: a cap refusal
    // must not leave behind an orphan tokens row — no call, no watch — that the
    // poller would then chase at the fresh tier for a day (round 15 review).
    // addWatch's advisory-locked check stays the authoritative gate.
    if ((await activeWatchCount(db, group.id, userId)) >= WATCH_CAP_PER_MEMBER) {
      return c.json({ error: watchCapMessage(WATCH_CAP_PER_MEMBER), cap: WATCH_CAP_PER_MEMBER }, 409);
    }
    const token = known ?? (await upsertToken(db, address));
    const outcome = await addWatch(db, group.id, token.id, userId);
    if (!outcome.ok) return c.json({ error: watchCapMessage(outcome.cap), cap: outcome.cap }, 409);

    // A coin nobody called has never been polled: resolve it now so the alert
    // engine (and the ON WATCH row) has a symbol and a price to work from.
    pollTokenNow(db, token.id).catch((err) =>
      console.error(`immediate poll failed for watched ${address}:`, err),
    );
    return c.body(null, 204);
  });

  /**
   * Unwatch by address. Always 204: unwatching is idempotent, and a coin this
   * group never watched must answer exactly like one that is not in `tokens` at
   * all — the lookup is chain-wide (like the bot's unwatch), so anything else
   * would turn the response into an existence oracle over every group's coins.
   * A malformed address answers the same way, without touching the database.
   */
  app.delete('/api/g/:slug/watch/:address', async (c) => {
    const group = c.get('group');
    const address = parseAddress(c.req.param('address'));
    if (address !== null) {
      const token = await findTokenByAddress(db, address);
      // Group-scoped inside removeWatch: another group's watch is untouchable.
      if (token) await removeWatch(db, group.id, token.id);
    }
    return c.body(null, 204);
  });

  return app;
}

const ADDRESS_ERROR = 'address must be a contract address (0x + 40 hex)';

/**
 * The whole expected body is one address — about 60 bytes. Anything past a
 * kilobyte is refused (413) before Node buffers it, so a member's session
 * cannot be used to make the process hold an arbitrary amount of memory.
 */
const WATCH_BODY_MAX_BYTES = 1024;

/**
 * The address a watch action names, normalised the way ingest normalises the
 * ones it reads out of chat: EIP-55 checked when mixed case, stored lowercase
 * (packages/shared/src/extract.ts). Unlike the chat command this refuses an
 * address buried in other text — a JSON field is not a sentence, and accepting
 * junk around it would let two different bodies mean the same watch.
 */
export function parseAddress(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  const address = extractEvmAddresses(trimmed)[0];
  return address !== undefined && address === trimmed.toLowerCase() ? address : null;
}

/** The columns these ids compare against are int4. */
const PG_INT4_MAX = 2_147_483_647;

/**
 * Path ids are strings; anything that is not a positive int4 is a 404. The
 * upper bound matters: a bigger number would reach Postgres, fail int4
 * coercion, and turn into a 500 instead of the honest not-found (round 15
 * review).
 */
export function parsePathId(raw: string | undefined): number | null {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 && value <= PG_INT4_MAX ? value : null;
}
