import { extractLaunchAddresses } from '@groupie/shared';
import type { XPost } from './client.js';

/**
 * Tier A detection (docs/decisions.md round 23) — the ONLY thing that can ping.
 *
 * The chain measurement is what shapes this: in one 8m34s window 101 of 166
 * X-linked PONS launches pointed at someone ELSE's tweet, snipers launching a
 * median 19 seconds after a post that contained no contract address at all. So
 * the trigger is never "a token cites the handle" and never "the account was
 * mentioned" — it is the tracked account AUTHORING a post that carries an
 * address. Everything else is a rejection with a name, because a silent
 * rejection is indistinguishable from a broken watcher.
 *
 * Pure: no database, no chain, no clock. Confirmation (the address is a real
 * token on this chain, young enough to be this launch) is confirm.ts's job, and
 * it runs AFTER this.
 */

/**
 * The retweet prefix X itself writes at the head of a retweet's text. Checked
 * INDEPENDENTLY of the provider's own flag: an adapter that does not carry the
 * flag (or a provider that stops carrying it) must not turn every retweeted
 * contract address into a ping in this group's chat.
 */
const RETWEET_PREFIX = /^RT @[A-Za-z0-9_]{1,15}:/;

/** Does this text carry X's own retweet prefix? (The adapter asks too.) */
export function isRetweetText(text: string): boolean {
  return RETWEET_PREFIX.test(text);
}

/** The account this post is being judged against. */
export interface TrackedAccount {
  monitorId: number;
  groupId: number;
  /** Lowercase, no leading @. */
  handle: string;
  /** Stored at add time. Null for a monitor added before the id was readable. */
  xUserId: string | null;
}

export type DetectReason =
  /** The post is by somebody else entirely. */
  | 'other_author'
  /** A retweet is not an authored post, whatever it carries. */
  | 'retweet'
  /** A reply by this account to SOMEONE ELSE — round 23 counts only self-replies. */
  | 'reply_to_other'
  /** A reply we cannot attribute, because the monitor has no stored user id. */
  | 'reply_unattributable'
  /** Authored, but nothing address-shaped in its own text or attached links. */
  | 'no_address';

export type Detection =
  | { fires: true; addresses: string[] }
  | { fires: false; reason: DetectReason };

/** Is this post authored by the tracked account? Ids win; handles are the fallback. */
export function isAuthoredBy(post: XPost, account: TrackedAccount): boolean {
  if (account.xUserId !== null && post.authorUserId !== null) {
    return post.authorUserId === account.xUserId;
  }
  return post.authorHandle.toLowerCase() === account.handle.toLowerCase();
}

/**
 * What this post means for this monitor.
 *
 * A QUOTE TWEET needs no clause of its own: `post.text` and `post.urls` are the
 * tracked account's own words and own links (the adapter never merges the
 * quoted post's), so a quote of someone else's contract carries no address here
 * and is rejected as `no_address` — which is exactly round 23's rule, "a QT
 * only counts if the address is in the tracked account's OWN text".
 */
export function detectTierA(post: XPost, account: TrackedAccount): Detection {
  if (!isAuthoredBy(post, account)) return { fires: false, reason: 'other_author' };
  if (post.isRetweet || isRetweetText(post.text)) {
    return { fires: false, reason: 'retweet' };
  }

  const replyTo = post.inReplyToUserId ?? null;
  // The provider called it a reply and named nobody: we cannot prove it is a
  // self-reply, so it is silence — the same answer as a monitor with no stored
  // id, and for the same reason.
  if (replyTo === null && post.isReply === true) {
    return { fires: false, reason: 'reply_unattributable' };
  }
  if (replyTo !== null) {
    // A self-reply is the common launch pattern (the CA dropped under the
    // announcement), so it counts — but only when we can PROVE it is a
    // self-reply. Without a stored id there is no proof, and an unprovable
    // reply is silence rather than a guess.
    if (account.xUserId === null) return { fires: false, reason: 'reply_unattributable' };
    if (replyTo !== account.xUserId) return { fires: false, reason: 'reply_to_other' };
  }

  const addresses = extractLaunchAddresses(post.text, post.urls);
  if (addresses.length === 0) return { fires: false, reason: 'no_address' };
  return { fires: true, addresses };
}
