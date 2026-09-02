/**
 * "Has this feed stopped?" — the one rule two background surfaces share.
 *
 * Discovery reads blocks (rounds 18 and 20) and the X launch monitor polls
 * accounts (round 23). Neither rides the board's live stream, both poll, and
 * both must say out loud when the thing behind them has gone quiet — because on
 * both surfaces an empty list would otherwise read as "nothing happened", which
 * is a claim we have not earned.
 *
 * The verdict is made against the PAYLOAD, never against the wall clock:
 * `fetchedAt` is the client instant the response landed, and the gap between the
 * feed's last successful pass and that instant is the only thing that says
 * anything about the feed. A `now` that has run away from `fetchedAt` — a
 * backgrounded tab, a laptop that slept, a clock that jumped — ages the
 * response, not the feed, so an old payload says nothing about a stall at all
 * rather than blaming the server for our own silence.
 *
 * `serverAt` is the server's own instant for the same response (its `Date`
 * header). The stamp being judged is a server timestamp, so the lag is measured
 * against that clock when it is known: a device running ten minutes ahead of the
 * server would otherwise print a permanent stall over a feed running normally.
 * Only the freshness gate uses this device's clock, and both of its operands
 * come from it.
 *
 * A dormant deployment is a different sentence entirely (each surface owns its
 * own), so `enabled` false is silent here.
 */

import { ageMs, fmtAge } from './format';

export interface StallOptions {
  /** False = no provider configured on this deployment: the surface says so itself. */
  enabled: boolean;
  /** The feed's last successful pass, as the server stamped it. */
  at: string | null;
  /** The client instant the payload landed, or null before the first read. */
  fetchedAt: number | null;
  /** Shared clock. */
  now: number;
  /** The server's own instant for the payload (its Date header), or null. */
  serverAt: number | null;
  /** Past this lag the feed is stalled rather than slow. */
  stallMs: number;
  /** Past this age the payload is too old to say anything about the feed NOW. */
  freshMs: number;
  /** What to say before the first successful pass ever completed. */
  waitingLine: string;
  /** The noun in "feed stalled · last <noun> 12m ago" — a read, a check. */
  noun: string;
}

export function stallLine({
  enabled,
  at,
  fetchedAt,
  now,
  serverAt,
  stallMs,
  freshMs,
  waitingLine,
  noun,
}: StallOptions): string | null {
  if (!enabled) return null;
  // An unparseable stamp is the same fact as a missing one: there is no pass we
  // can name. It must not become a stall claim with an em dash for an age.
  const lag = ageMs(at, serverAt ?? fetchedAt ?? now);
  if (lag === null) return waitingLine;
  if (fetchedAt === null || now - fetchedAt >= freshMs) return null;
  if (lag < stallMs) return null;
  // The printed age advances from the server's instant by the time elapsed on
  // this device since the payload landed, so it ticks without inheriting skew.
  const serverNow = serverAt !== null ? serverAt + (now - fetchedAt) : now;
  return `feed stalled · last ${noun} ${fmtAge(at, serverNow)} ago`;
}
