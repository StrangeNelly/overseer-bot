import { and, eq } from 'drizzle-orm';
import type { Api } from 'grammy';
import { calls, groups, type Db } from '@groupie/db';
import { subscribe } from '../events.js';

/**
 * The one place the bot speaks unprompted (docs/decisions.md round 4): watchlist
 * alerts, already de-duplicated and cooled down by the poller, delivered into
 * the group that asked for them.
 *
 * Sends are chained rather than fired in parallel — alerts are low volume, and
 * sequential sends keep them in the order they fired without a queue. A failed
 * send is logged and dropped: the alert row is already the record of truth, and
 * nothing here may reject into the poller or crash the process.
 */
export function startAlertDelivery(db: Db, api: Api): () => void {
  let queue: Promise<void> = Promise.resolve();
  return subscribe((event) => {
    if (event.type !== 'alert_fired') return;
    queue = queue
      .then(async () => {
        const group = (
          await db
            .select({ chatId: groups.chatId, status: groups.status })
            .from(groups)
            .where(eq(groups.id, event.groupId))
        )[0];
        // Removed from the chat since the alert fired: nowhere to post.
        if (!group || group.status !== 'active') return;
        // Thread the alert onto the original call message when there is one —
        // context travels with the alert. Deleted/migrated originals degrade to
        // a plain send; watched-but-never-called tokens have no call row.
        const call = (
          await db
            .select({ messageId: calls.messageId })
            .from(calls)
            .where(and(eq(calls.groupId, event.groupId), eq(calls.tokenId, event.tokenId)))
        )[0];
        await api.sendMessage(group.chatId, event.message, {
          link_preview_options: { is_disabled: true },
          ...(call
            ? {
                reply_parameters: {
                  message_id: call.messageId,
                  allow_sending_without_reply: true,
                },
              }
            : {}),
        });
      })
      .catch((err) => {
        console.error(`alert delivery failed for group ${event.groupId}:`, err);
      });
  });
}
