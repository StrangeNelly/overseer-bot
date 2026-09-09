import { and, eq } from 'drizzle-orm';
import type { Api } from 'grammy';
import { calls, groups, type Db } from '@groupie/db';
import { subscribe } from '../events.js';
import { stripHtml } from './telegramHtml.js';

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
        // a plain send; watched-but-never-called tokens have no call row, and a
        // discovery alert (rounds 18/20) has no token at all, so it is always a
        // fresh message.
        // An alert that names its OWN reply target keeps it (round 23: the
        // launch ping answers the message that added the monitor, and there is
        // no call row to find it from). Everything else threads onto the call.
        const named = event.replyToMessageId ?? null;
        const call =
          named !== null || event.tokenId === null
            ? undefined
            : (
                await db
                  .select({ messageId: calls.messageId })
                  .from(calls)
                  .where(and(eq(calls.groupId, event.groupId), eq(calls.tokenId, event.tokenId)))
              )[0];
        const replyTo = named ?? call?.messageId ?? null;
        const options = {
          link_preview_options: { is_disabled: true },
          ...(replyTo !== null
            ? {
                reply_parameters: {
                  message_id: replyTo,
                  allow_sending_without_reply: true,
                },
              }
            : {}),
        };
        // Only a builder that escaped its own interpolations asks for HTML
        // (round 27); everything else is still sent as plain text.
        if (event.parseMode !== 'HTML') {
          await api.sendMessage(group.chatId, event.message, options);
          return;
        }
        try {
          await api.sendMessage(group.chatId, event.message, {
            ...options,
            parse_mode: 'HTML',
          });
        } catch (err) {
          // THE ALERT ROW ALREADY SAYS THE CHAT WAS TOLD, so nothing retries
          // this and a rejected formatted send would lose the message outright.
          // The words matter more than the styling: strip the markup and send
          // it as the plain text this used to be. Only the retry's own failure
          // reaches the outer catch.
          console.error(
            `alert delivery: HTML send rejected for group ${event.groupId}, retrying as plain text:`,
            err,
          );
          await api.sendMessage(group.chatId, stripHtml(event.message), options);
        }
      })
      .catch((err) => {
        console.error(`alert delivery failed for group ${event.groupId}:`, err);
      });
  });
}
