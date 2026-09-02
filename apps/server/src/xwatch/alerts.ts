import { and, desc, eq } from 'drizzle-orm';
import { alerts, discoveryEvents, launchMonitors, type Db } from '@groupie/db';
import { WATCH_CAP_PER_MEMBER, type XWatchSettings } from '@groupie/shared';
import { upsertToken } from '../bot/ingest.js';
import { publish } from '../events.js';
import { addWatch } from '../watchlist.js';
import type { ConfirmedToken } from './confirm.js';
import { launchPingMessage } from './message.js';
import type { MonitorRow } from './monitors.js';

/**
 * What happens when a tracked account posts a contract that confirms
 * (docs/decisions.md round 23).
 *
 * ONE MESSAGE PER MONITOR, EVER. Three independent things enforce that: the
 * monitor only flips out of 'active' once (a guarded UPDATE ... RETURNING), the
 * partial unique index on (group, 'x_launch', handle, address) makes a second
 * alert row impossible, and the runner stops polling a monitor that is no
 * longer active.
 *
 * THE ALERT ROW IS THE AUTHORITY, so it is written FIRST and the monitor's
 * `launch_pinged` is set from what that write actually did. The old order
 * (flip, then insert) could record a ping that the unique index then refused,
 * which is a board saying the chat was told when it was not.
 *
 * NO SYNTHETIC CALL. `calls.message_id` is NOT NULL and caller credit is a
 * social record — a fabricated call would give a hijacked account a permanent
 * place in the group's history. The coin is AUTO-WATCHED under the adder's slot
 * instead, which starts the poller on it immediately; a member pasting the CA
 * afterwards converts it into a real call with nothing lost. That watch belongs
 * to the PING: a held or muted launch is a board row nobody asked to be alerted
 * about, and it must not spend one of the adder's three slots.
 */

export type FireOutcome =
  /** The chat was told. */
  | 'pinged'
  /** Recorded on the board, deliberately silent: the hijack hold. */
  | 'held'
  /** Recorded on the board, silent: this group turned the ping off. */
  | 'muted'
  /** An alert for this (group, handle, address) already exists. */
  | 'duplicate'
  /** The monitor was not active any more — somebody else got there first. */
  | 'inactive';

export interface FireParams {
  monitor: MonitorRow;
  token: ConfirmedToken;
  post: { id: string; url: string | null; createdAt: Date };
  /** The group's whole settings jsonb; the ping toggle is read off it. */
  settings: XWatchSettings;
  nowMs?: number;
}

/**
 * The launch-block facts, if the discovery listener happened to measure them
 * for this coin (docs/decisions.md round 20). A join, never a new chain read:
 * the ping is worth one message, not a bundle scan, and an absent row simply
 * drops the clause.
 */
async function bundleFacts(
  db: Db,
  address: string,
): Promise<{ pct: number | null; wallets: number | null }> {
  const rows = await db
    .select({
      pct: discoveryEvents.launchBlockPct,
      wallets: discoveryEvents.launchBlockWallets,
    })
    .from(discoveryEvents)
    .where(eq(discoveryEvents.tokenAddress, address))
    .orderBy(desc(discoveryEvents.at))
    .limit(1);
  return { pct: rows[0]?.pct ?? null, wallets: rows[0]?.wallets ?? null };
}

export async function fireLaunch(db: Db, params: FireParams): Promise<FireOutcome> {
  const { monitor, token, post } = params;
  const nowMs = params.nowMs ?? Date.now();
  const groupId = monitor.groupId;
  const adder = Number(monitor.addedBy);

  // The token row first: it is what the poller and the board point at, and it
  // exists whether or not the chat is told anything.
  const upserted = await upsertToken(db, token.address);

  const wouldPing = !token.hijack && params.settings.launchPing;
  const holdReason = token.hijack ? ('hijack' as const) : ('muted' as const);

  let message: string | null = null;
  let inserted = false;
  if (wouldPing) {
    const facts = await bundleFacts(db, token.address);
    message = launchPingMessage({
      handle: monitor.xHandle,
      address: token.address,
      symbol: token.symbol,
      mcapUsd: token.mcapUsd,
      liquidityUsd: token.liquidityUsd,
      tokenCreatedAt: token.tokenCreatedAt,
      launchpad: token.launchpad,
      launchBlockPct: facts.pct,
      launchBlockWallets: facts.wallets,
      tweetUrl: post.url,
      nowMs,
    });
    // The alert row IS the record that the chat was told, and the partial unique
    // index on (group, type, handle, address) is what makes a second send
    // impossible — whatever two passes decide.
    const written = await db
      .insert(alerts)
      .values({
        groupId,
        tokenId: upserted.id,
        type: 'x_launch',
        mcapUsd: token.mcapUsd,
        details: {
          handle: monitor.xHandle,
          address: token.address,
          monitorId: monitor.id,
          tweetId: post.id,
          tweetUrl: post.url,
          postedAt: post.createdAt.toISOString(),
          tokenCreatedAt: token.tokenCreatedAt.toISOString(),
          clockSource: token.clockSource,
          hijack: token.hijack,
          message,
        },
      })
      .onConflictDoNothing()
      .returning({ id: alerts.id });
    inserted = written.length > 0;
  }

  // The monitor flips ONCE. Guarded on status = 'active' and reported by
  // RETURNING, so two overlapping passes cannot both decide they are the ones
  // announcing this launch. `launch_pinged` carries what the insert above
  // actually did — a refused insert means somebody already told this chat.
  const flipped = await db
    .update(launchMonitors)
    .set({
      status: 'launched',
      launchedAddress: token.address,
      launchedTokenId: upserted.id,
      // The POST's instant: the contract entered the group's world when the
      // account said it, not when a retry got round to reading the chain.
      launchedAt: post.createdAt,
      launchedTokenCreatedAt: token.tokenCreatedAt,
      launchTweetId: post.id,
      launchTweetUrl: post.url,
      launchPinged: wouldPing && inserted,
      launchedHoldReason: wouldPing ? null : holdReason,
      lastTweetId: post.id,
    })
    .where(and(eq(launchMonitors.id, monitor.id), eq(launchMonitors.status, 'active')))
    .returning({ id: launchMonitors.id });
  // Somebody else decided this monitor between the insert and the flip. The
  // alert row stays as the record of what would have been said; nothing is
  // published, because that monitor has already had its one message.
  if (flipped.length === 0) return 'inactive';

  if (!wouldPing) return token.hijack ? 'held' : 'muted';
  if (!inserted || message === null) return 'duplicate';

  publish({
    type: 'alert_fired',
    groupId,
    tokenId: upserted.id,
    alertType: 'x_launch',
    message,
    // The reply lands on the message that ASKED for this monitor. Null (a
    // monitor added from the board) degrades to a fresh message.
    replyToMessageId: monitor.addedMessageId === null ? null : Number(monitor.addedMessageId),
  });

  // Auto-watch under the ADDER's slot, on the path that pings and only there.
  // A full slot list is not a reason to withhold the news (round 23: "slots
  // full => ping anyway"), so the refusal is logged and the ping stands.
  const watched = await addWatch(db, groupId, upserted.id, adder, WATCH_CAP_PER_MEMBER);
  if (!watched.ok) {
    console.log(
      `x launch: ${monitor.xHandle} — auto-watch skipped, member ${adder} holds ${watched.cap} slots`,
    );
  }
  console.log(`x launch: ${monitor.xHandle} -> ${token.address} (group ${groupId})`);
  return 'pinged';
}
