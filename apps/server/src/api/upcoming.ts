import { desc, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { discoveryEvents, tokens, type Db } from '@groupie/db';
import {
  XWATCH,
  tradingLinks,
  type ProjectCandidate,
  type ProjectEntry,
  type ProjectStatus,
  type ProjectsResponse,
} from '@groupie/shared';
import { loadSlotHolderNames, parsePathId } from './board.js';
import type { ApiEnv } from './membership.js';
import type { TweetWatcher } from '../xwatch/client.js';
import {
  countSlots,
  lastCheckAt,
  listCandidates,
  listMonitors,
  trackMonitor,
  untrackMonitor,
  type MonitorRow,
} from '../xwatch/monitors.js';

/**
 * UPCOMING — the pre-launch accounts this group is tracking (docs/decisions.md
 * round 23).
 *
 * GET    /api/g/:slug/upcoming        the zone
 * POST   /api/g/:slug/upcoming        { handle, note? } -> 201 | 409 | 404
 * DELETE /api/g/:slug/upcoming/:id    -> 204 (any member, the group's list)
 *
 * `enabled` is whether the WATCHER RUNS IN THIS PROCESS, exactly like
 * /discovery's: a deployment without an X key, or a WEB_ONLY box, says the zone
 * is off rather than showing an empty list that looks like nobody is tracking
 * anything.
 */

/** The whole body is a handle and a short note. */
const TRACK_BODY_MAX_BYTES = 1024;

export interface XWatchApi {
  /** The runner's handle: live in this process? */
  running: boolean;
  /** The provider seam, for the resolve-on-add step. Null = not configured. */
  watcher: TweetWatcher | null;
}

/** The mcap a Tier-B candidate is currently showing, off the discovery stream. */
async function candidateMarket(
  db: Db,
  addresses: string[],
): Promise<Map<string, { mcapUsd: number | null; symbol: string | null }>> {
  const out = new Map<string, { mcapUsd: number | null; symbol: string | null }>();
  if (addresses.length === 0) return out;
  const rows = await db
    .select({
      address: discoveryEvents.tokenAddress,
      symbol: discoveryEvents.symbol,
      mcapUsd: discoveryEvents.mcapUsd,
      at: discoveryEvents.at,
    })
    .from(discoveryEvents)
    .where(inArray(discoveryEvents.tokenAddress, addresses))
    .orderBy(desc(discoveryEvents.at));
  for (const row of rows) {
    // Newest first, so the first row per address wins.
    const key = row.address.toLowerCase();
    if (!out.has(key)) out.set(key, { mcapUsd: row.mcapUsd, symbol: row.symbol });
  }
  return out;
}

export function toProjectEntry(
  row: MonitorRow,
  userId: number,
  names: ReadonlyMap<number, string>,
  launchedSymbol: string | null,
  candidates: ProjectCandidate[],
): ProjectEntry {
  const addedBy = Number(row.addedBy);
  const launchedAddress = row.launchedAddress;
  return {
    id: row.id,
    handle: row.xHandle,
    xUserId: row.xUserId,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    bio: row.bio,
    followers: row.followers,
    followersAtAdd: row.followersAtAdd,
    accountCreatedAt: row.accountCreatedAt?.toISOString() ?? null,
    lastPostAt: row.lastPostAt?.toISOString() ?? null,
    lastPostVia: row.lastPostVia ?? null,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    note: row.note,
    addedBy,
    addedByName: names.get(addedBy) ?? null,
    addedAt: row.addedAt.toISOString(),
    addedByMe: addedBy === userId,
    status: row.status as ProjectStatus,
    launched:
      launchedAddress === null
        ? null
        : {
            address: launchedAddress,
            symbol: launchedSymbol,
            tokenId: row.launchedTokenId,
            // The POST's instant — what the permalink carries, and the thing the
            // group actually saw happen.
            at: (row.launchedAt ?? row.addedAt).toISOString(),
            // ...and the token's own, which is a different clock and the one the
            // hijack hold is judged on.
            tokenCreatedAt: row.launchedTokenCreatedAt?.toISOString() ?? null,
            tweetUrl: row.launchTweetUrl,
            pinged: row.launchPinged,
            heldReason: row.launchedHoldReason,
            links: tradingLinks(launchedAddress),
          },
    candidates,
  };
}

export function createUpcomingRoutes(db: Db, xwatch: XWatchApi): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  app.get('/api/g/:slug/upcoming', async (c) => {
    const group = c.get('group');
    const userId = c.get('userId');
    const body: ProjectsResponse = {
      enabled: xwatch.running,
      lastCheckAt: null,
      capPerGroup: XWATCH.capPerGroup,
      capPerMember: XWATCH.capPerMember,
      slotsUsed: 0,
      slotsUsedByMe: 0,
      projects: [],
    };

    // The LIST is served whether or not the watcher runs here: a group's
    // tracked accounts are its own state, and hiding them on a WEB_ONLY box
    // would look like the list was lost. Only `enabled` says nothing is polling.
    const rows = await listMonitors(db, group.id);
    // Slots are held by the OCCUPYING statuses only: a launched or expired
    // monitor is on the board and costs nobody a slot, so counting rows would
    // tell a member the list is full when it is not.
    const slots = countSlots(rows, userId);
    body.slotsUsed = slots.used;
    body.slotsUsedByMe = slots.usedByMe;
    if (rows.length === 0) {
      body.lastCheckAt = (await lastCheckAt(db, group.id))?.toISOString() ?? null;
      return c.json(body);
    }

    const [names, candidateRows, checkedAt] = await Promise.all([
      loadSlotHolderNames(
        db,
        group.id,
        rows.map((r) => Number(r.addedBy)),
      ),
      listCandidates(
        db,
        rows.map((r) => r.id),
      ),
      lastCheckAt(db, group.id),
    ]);
    body.lastCheckAt = checkedAt?.toISOString() ?? null;

    const launchedTokenIds = rows
      .map((r) => r.launchedTokenId)
      .filter((id): id is number => id !== null);
    const symbols = new Map<number, string | null>();
    if (launchedTokenIds.length > 0) {
      const tokenRows = await db
        .select({ id: tokens.id, symbol: tokens.symbol })
        .from(tokens)
        .where(inArray(tokens.id, launchedTokenIds));
      for (const token of tokenRows) symbols.set(token.id, token.symbol);
    }

    const market = await candidateMarket(
      db,
      [...new Set(candidateRows.map((r) => r.tokenAddress.toLowerCase()))],
    );
    const byMonitor = new Map<number, ProjectCandidate[]>();
    for (const row of candidateRows) {
      const address = row.tokenAddress.toLowerCase();
      const seen = market.get(address);
      const list = byMonitor.get(row.monitorId) ?? [];
      list.push({
        kind: row.kind,
        address,
        symbol: row.symbol ?? seen?.symbol ?? null,
        mcapUsd: seen?.mcapUsd ?? null,
        // A 'posted' row is dated by the POST; a Tier-B claim by the sighting.
        at: (row.postedAt ?? row.seenAt).toISOString(),
        tweetUrl: row.postUrl,
        lastReason: row.lastReason,
        links: tradingLinks(address),
      });
      byMonitor.set(row.monitorId, list);
    }

    body.projects = rows.map((row) =>
      toProjectEntry(
        row,
        userId,
        names,
        row.launchedTokenId === null ? null : (symbols.get(row.launchedTokenId) ?? null),
        byMonitor.get(row.id) ?? [],
      ),
    );
    return c.json(body);
  });

  app.post(
    '/api/g/:slug/upcoming',
    bodyLimit({ maxSize: TRACK_BODY_MAX_BYTES }),
    async (c) => {
      const group = c.get('group');
      const userId = c.get('userId');
      const parsed = (await c.req.json().catch(() => null)) as {
        handle?: unknown;
        note?: unknown;
      } | null;
      if (typeof parsed?.handle !== 'string') {
        return c.json({ error: 'handle must be an X handle' }, 400);
      }
      const printedHandle = parsed.handle.trim().replace(/^@+/, '');
      const outcome = await trackMonitor(db, xwatch.watcher, {
        groupId: group.id,
        userId,
        handle: parsed.handle,
        note: typeof parsed.note === 'string' ? parsed.note : null,
        // The web has no chat message to reply to; the ping is a fresh message.
        messageId: null,
      });
      if (!outcome.ok) {
        switch (outcome.reason) {
          case 'invalid':
            return c.json({ error: 'handle must be an X handle' }, 400);
          case 'not_found':
            return c.json({ error: `X has no account @${printedHandle}` }, 404);
          case 'suspended':
            // A different sentence, because it is a different fact: the account
            // exists and X has taken it down.
            return c.json({ error: `@${printedHandle} is suspended on X` }, 404);
          case 'disabled':
            return c.json({ error: 'the launch monitor is not configured here' }, 503);
          case 'provider':
            // We could not ASK X. Not a 404: that would say the account does
            // not exist, which is a claim this failure cannot support.
            return c.json({ error: 'could not reach X — try again' }, 503);
          case 'duplicate':
            return c.json({ error: 'already tracked', status: outcome.status }, 409);
          case 'cap_group':
            return c.json(
              { error: `this group is tracking ${outcome.cap} accounts already`, cap: outcome.cap },
              409,
            );
          case 'cap_member':
            return c.json(
              { error: `you already track ${outcome.cap} accounts — untrack one first`, cap: outcome.cap },
              409,
            );
        }
      }
      const names = await loadSlotHolderNames(db, group.id, [userId]);
      return c.json(toProjectEntry(outcome.monitor, userId, names, null, []), 201);
    },
  );

  app.delete('/api/g/:slug/upcoming/:id', async (c) => {
    const group = c.get('group');
    // Anything that is not a positive int4 is a 404 rather than a query the
    // column cannot coerce (round 15 review).
    const id = parsePathId(c.req.param('id'));
    if (id === null) return c.json({ error: 'not found' }, 404);
    // Group-scoped, and idempotent: an id this group does not hold answers the
    // same 204 as one it just stopped, so the response is never an existence
    // oracle over another group's monitors.
    await untrackMonitor(db, group.id, { id });
    return c.body(null, 204);
  });

  return app;
}
