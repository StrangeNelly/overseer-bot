/**
 * Everything the redesign reads off the board payload. Strictly derived — the
 * board API is unchanged by this pass, so nothing here invents a number the
 * server did not send.
 */

import type { BoardCard, BoardResponse, SparkPoint, WatchlistEntry } from '@groupie/shared';
import {
  MEMBER_DEATH_REASON,
  UNNAMED_MEMBER,
  isFlatlineDeath,
  isMemberDeath as isMemberDeathReason,
} from '@groupie/shared';
import { ageMs, fmtMultiple, fmtUsd } from './format';

/** Market numbers older than this get a visible "as of" hint. */
export const STALE_AFTER_MS = 5 * 60 * 1000;
/** The comeback badge runs for 24h (docs/decisions.md round 6), same as the section. */
export const REVIVING_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Runner threshold: the multiple that earns a (static) glow. */
export const RUNNER_MULTIPLE = 3;

export type StatusEdge = 'up' | 'down' | 'cyan' | 'died' | 'unresolved';

export function isDied(card: BoardCard): boolean {
  return card.callStatus === 'died';
}

/**
 * The server never clears a stale reviving_at (a later hide does), so the 24h
 * window lives on the read side — here and in the server's classifySections.
 */
export function isReviving(card: BoardCard, now: number): boolean {
  const age = ageMs(card.revivingAt, now);
  return age !== null && age < REVIVING_WINDOW_MS;
}

/**
 * No market data yet: the row prints a dim dash, never a hero number.
 *
 * True of a dead card as well — a wrong-chain or never-graduated death has no
 * numbers either — so every caller must let DEATH win first (statusEdge below,
 * TokenCard's own flag). "Dead" and "still loading" are not both sayable.
 */
export function isUnresolved(card: BoardCard): boolean {
  return card.phase === 'unresolved' || (card.mcapUsd === null && card.multiple === null);
}

export function isStale(card: BoardCard, now: number): boolean {
  const age = ageMs(card.dataAsOf, now);
  return age !== null && age > STALE_AFTER_MS;
}

/** The 2px left edge. Priority: died > unresolved > reviving > live P&L. */
export function statusEdge(card: BoardCard, now: number): StatusEdge {
  if (isDied(card)) return 'died';
  if (isUnresolved(card)) return 'unresolved';
  if (isReviving(card, now)) return 'cyan';
  if (card.multiple === null) return 'unresolved';
  return card.multiple >= 1 ? 'up' : 'down';
}

/**
 * "+38% since revival": how far the mcap has come since the comeback, read off
 * the sparkline the payload already carries. null when the trace does not
 * reach back to the revival instant — better silent than made up.
 */
export function revivalDelta(card: BoardCard): number | null {
  const atRevival = mcapAtRevival(card);
  if (atRevival === null) return null;
  if (typeof card.mcapUsd !== 'number' || !Number.isFinite(card.mcapUsd)) return null;
  return ((card.mcapUsd - atRevival) / atRevival) * 100;
}

/**
 * The market cap the comeback started from, read off the sample nearest the
 * revival instant. Approximate by construction — it is our own 5-minute trace,
 * not a stored figure — which is why the card only prints it when the trace
 * really covers the moment.
 *
 * The trace is downsampled to <=30 points over 24h, so "the first point after
 * the revival" can easily BE the current reading, which would report a
 * meaningless 0% delta. Nothing is claimed when that is the case.
 */
export function mcapAtRevival(card: BoardCard): number | null {
  const revivedAt = card.revivingAt === null ? null : Date.parse(card.revivingAt);
  if (revivedAt === null || Number.isNaN(revivedAt)) return null;

  const usable = card.sparkline.filter(
    (point) => typeof point.mcap === 'number' && Number.isFinite(point.mcap) && point.mcap > 0,
  );
  if (usable.length < 2) return null;

  let nearest = 0;
  for (let i = 1; i < usable.length; i++) {
    if (Math.abs(usable[i]!.t - revivedAt) < Math.abs(usable[nearest]!.t - revivedAt)) nearest = i;
  }
  if (nearest === usable.length - 1) return null;
  return usable[nearest]!.mcap;
}

export interface PulseData {
  /**
   * Calls made since the reader's local midnight — the server's SQL count over
   * the whole group (docs/decisions.md round 15), not a tally of the cards in
   * this window. A 6h window used to make a 20-call day read as 4.
   */
  calls: number;
  best: { label: string; multiple: number } | null;
  died: number;
  reviving: number;
  bestReviving: { label: string; pct: number } | null;
  /** Age of the payload itself, in ms. */
  asOfMs: number | null;
  /** Design pass 2: the day drawn as a ratio (the day-outcome strip). */
  outcome: OutcomeCounts;
}

/**
 * The day-outcome strip (design pass 2, "Derived data"). Four segments whose
 * widths are proportional to the counts, all four counted over the SAME
 * population the strip is labelled with — the calls made since local midnight:
 * runners are today's alive cards at >= 3x, reviving and died are today's, and
 * "active" is whatever is left of the group's day (the server's todayCallCount
 * minus the three named outcomes, floored at 0).
 */
export interface OutcomeCounts {
  runners: number;
  active: number;
  reviving: number;
  died: number;
}

function label(card: BoardCard): string {
  return card.symbol ?? 'unnamed';
}

function startOfDay(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Every distinct call on the board, minus anything optimistically binned. */
export function allCards(board: BoardResponse, hidden: ReadonlySet<number>): BoardCard[] {
  const seen = new Set<number>();
  const out: BoardCard[] = [];
  for (const cards of Object.values(board.sections)) {
    for (const card of cards) {
      if (hidden.has(card.callId) || seen.has(card.callId)) continue;
      seen.add(card.callId);
      out.push(card);
    }
  }
  return out;
}

/**
 * The Pulse band: today's story in one line.
 *
 * The call count comes from the server (board.todayCallCount) because it is a
 * claim about the GROUP's day, which the window truncates and probation hides
 * from. Everything else is a claim about what is on screen — best runner, died,
 * reviving — and stays derived from the payload, where it is honest by
 * construction.
 */
export function derivePulse(
  board: BoardResponse,
  now: number,
  hidden: ReadonlySet<number>,
): PulseData {
  const cards = allCards(board, hidden);
  const dayStart = startOfDay(now);

  const today = cards.filter((card) => {
    const called = Date.parse(card.calledAt);
    return !Number.isNaN(called) && called >= dayStart;
  });

  const pool = today.length > 0 ? today : cards;
  let best: { label: string; multiple: number } | null = null;
  for (const card of pool) {
    if (isDied(card)) continue;
    const multiple = card.multiple;
    if (typeof multiple !== 'number' || !Number.isFinite(multiple)) continue;
    if (!best || multiple > best.multiple) best = { label: label(card), multiple };
  }

  const reviving = (board.sections.reviving ?? []).filter((card) => !hidden.has(card.callId));
  let bestReviving: { label: string; pct: number } | null = null;
  for (const card of reviving) {
    const pct = revivalDelta(card);
    if (pct === null) continue;
    if (!bestReviving || pct > bestReviving.pct) bestReviving = { label: label(card), pct };
  }

  const generated = Date.parse(board.generatedAt);
  const died = (board.sections.died ?? []).filter((card) => !hidden.has(card.callId)).length;

  // The strip is labelled TODAY'S N, so every segment counts the same day: a
  // 30d window's 40 deaths are not part of a two-call day, and drawing them
  // there made "active" floor at 0 and the bar dwarf its own label.
  const todayIds = new Set(today.map((card) => card.callId));
  const outcomeRunners = today.filter(
    (card) =>
      !isDied(card) &&
      typeof card.multiple === 'number' &&
      Number.isFinite(card.multiple) &&
      card.multiple >= RUNNER_MULTIPLE,
  ).length;
  const outcomeReviving = reviving.filter((card) => todayIds.has(card.callId)).length;
  const outcomeDied = today.filter((card) => isDied(card)).length;
  const active = Math.max(
    0,
    board.todayCallCount - (outcomeRunners + outcomeReviving + outcomeDied),
  );

  return {
    // The server counts the day; the payload only ever knew this window's slice
    // of it (cache.ts drops any blob that predates the field).
    calls: board.todayCallCount,
    best,
    died,
    reviving: reviving.length,
    bestReviving,
    asOfMs: Number.isNaN(generated) ? null : Math.max(0, now - generated),
    outcome: { runners: outcomeRunners, active, reviving: outcomeReviving, died: outcomeDied },
  };
}

// ---------------------------------------------------------------- pass 2 derivations

const HOUR_MS = 60 * 60 * 1000;

function usablePoints(points: SparkPoint[]): SparkPoint[] {
  return points.filter(
    (p) => typeof p.mcap === 'number' && Number.isFinite(p.mcap) && p.mcap > 0,
  );
}

/**
 * The 1h move chip (design pass 2): the nearest sample at least 60 minutes
 * before the last sample, against the last sample. null — and therefore no chip
 * at all — when the trace does not reach back an hour, which is the honest
 * answer for a coin called twenty minutes ago.
 */
export function moveOneHour(points: SparkPoint[]): number | null {
  const usable = usablePoints(points);
  if (usable.length < 2) return null;
  const last = usable[usable.length - 1]!;
  for (let i = usable.length - 2; i >= 0; i--) {
    const point = usable[i]!;
    if (last.t - point.t >= HOUR_MS) {
      return ((last.mcap - point.mcap) / point.mcap) * 100;
    }
  }
  return null;
}

/** LP as a whole percentage of market cap — printed, never judged. */
export function lpRatioPct(value: {
  liquidityUsd: number | null;
  mcapUsd: number | null;
}): number | null {
  const { liquidityUsd, mcapUsd } = value;
  if (liquidityUsd === null || mcapUsd === null || !(mcapUsd > 0)) return null;
  return (liquidityUsd / mcapUsd) * 100;
}

/**
 * Where "now" sits on the call -> peak dollar scale, 0..1. null when there is no
 * span to place it on (no peak above the call price), which is exactly when the
 * gauge has nothing to say.
 */
export function gaugePosition(card: BoardCard): number | null {
  const { mcapUsd, mcapAtCall, peakMcapSinceCall } = card;
  if (mcapUsd === null || mcapAtCall === null || peakMcapSinceCall === null) return null;
  const span = peakMcapSinceCall - mcapAtCall;
  if (!(span > 0)) return null;
  return Math.min(1, Math.max(0, (mcapUsd - mcapAtCall) / span));
}

/** Below this, the run never happened: the multiple already tells the story. */
const PEAK_NOTE_MIN_MULTIPLE = 1.2;
/** At or under this drawdown the coin is still AT its peak — nothing to add. */
const PEAK_NOTE_MIN_RETRACE_PCT = 10;

/** The peak note taken apart, so a narrow column can print less of it. */
export interface PeakNoteParts {
  /** "peak $30M · 2.3x" — the fact itself, never abbreviated. */
  head: string;
  /**
   * " · back under call" when the coin has since fallen under where it was
   * called, else null. The clause itself and not a flag, so the wording exists
   * once in the app: a row that renders the tail separately and a tooltip that
   * renders the whole sentence cannot end up phrasing it differently.
   */
  tail: string | null;
}

/** The round trip, as the row and `peakNote` both print it. */
const PEAK_NOTE_TAIL = ' · back under call';

/**
 * "peak $30M · 2.3x" — the fact every mark-to-market number leaves out.
 *
 * The board's headline is where a call sits NOW, so a coin printing 0.8x
 * ($13M → $11M) reads identically whether it drifted sideways or touched $30M
 * first and round-tripped. Those are opposite facts about opposite people
 * (docs owner feedback), so the peak gets said on every call surface.
 *
 * It is a fact, never a verdict: no "missed", no "you should have". null
 * whenever the peak adds nothing — no peak recorded, the coin never really left
 * the call behind (< 1.2x), or it is sitting at/near that peak right now
 * (< 10% off), where the live multiple IS the peak multiple.
 *
 * `· back under call` is the round trip, stated as a position rather than a
 * judgement. It comes back as its own clause because it is the one part a
 * cramped row can afford to drop: the multiple printed two columns over already
 * says the coin is under 1x, so a reader loses a phrasing, not a fact. The head
 * never is — nothing else on the row carries the peak. Returning the clause
 * itself rather than a boolean keeps the wording in one place, and `peakNote`
 * is nothing but the concatenation, so the full sentence and the split one
 * cannot drift apart in gating OR in words.
 */
export function peakNoteParts(card: BoardCard): PeakNoteParts | null {
  const { peakMcapSinceCall, peakMultiple, retraceFromPeakPct, multiple } = card;
  if (peakMcapSinceCall === null || !Number.isFinite(peakMcapSinceCall)) return null;
  if (peakMultiple === null || !Number.isFinite(peakMultiple)) return null;
  if (peakMultiple < PEAK_NOTE_MIN_MULTIPLE) return null;
  if (
    retraceFromPeakPct !== null &&
    Number.isFinite(retraceFromPeakPct) &&
    retraceFromPeakPct < PEAK_NOTE_MIN_RETRACE_PCT
  ) {
    return null;
  }
  const roundTripped = multiple !== null && Number.isFinite(multiple) && multiple < 1;
  return {
    head: `peak ${fmtUsd(peakMcapSinceCall)} · ${fmtMultiple(peakMultiple)}`,
    tail: roundTripped ? PEAK_NOTE_TAIL : null,
  };
}

/** The whole sentence — the tooltip, and every surface with room for it. */
export function peakNote(card: BoardCard): string | null {
  const parts = peakNoteParts(card);
  if (parts === null) return null;
  return `${parts.head}${parts.tail ?? ''}`;
}

/** Position inside a band as 0..1 — the Sleepers/Ranging tick. */
export function bandPosition(value: number | null, loUsd: number, hiUsd: number): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const span = hiUsd - loUsd;
  if (!(span > 0)) return null;
  return Math.min(1, Math.max(0, (value - loUsd) / span));
}

/** One ON WATCH row: the group's watch, plus the board card behind it if any. */
export interface WatchRow {
  entry: WatchlistEntry;
  /** The matching board card, when this watch is also one of the group's calls. */
  card: BoardCard | null;
  /**
   * The group HAS a non-binned call for this coin — which is not the same as
   * having a card here: the sections are windowed and probation-filtered, the
   * watchlist is neither. Only a false here earns the words "no call".
   */
  hasCall: boolean;
  /** Read off whichever trace we have — the card's, else the entry's. */
  move1h: number | null;
}

export interface InPlay {
  runners: BoardCard[];
  retraced: BoardCard[];
  reviving: BoardCard[];
  watch: WatchRow[];
}

type VisibleSections = Record<keyof BoardResponse['sections'], BoardCard[]>;

/** Nulls always sort last, whichever direction the comparator runs. */
function byDesc<T>(read: (value: T) => number | null) {
  return (a: T, b: T): number => {
    const left = read(a);
    const right = read(b);
    if (left === null && right === null) return 0;
    if (left === null) return 1;
    if (right === null) return -1;
    return right - left;
  };
}

/**
 * The three IN PLAY rank rules, on their own so the mobile tabs can apply the
 * same order to their own (unfiltered) lists — one zone, one ordering, whichever
 * surface is drawing it.
 *
 * "Moving now first": a runner that is up 4x but flat for six hours is not the
 * one a returning member wants at the top.
 */
export function rankRunners(cards: BoardCard[]): BoardCard[] {
  return [...cards].sort(byDesc((card: BoardCard) => moveOneHour(card.sparkline)));
}

/** "Liquidity intact first" — the ratio is printed, never judged. */
export function rankRetraced(cards: BoardCard[]): BoardCard[] {
  return [...cards].sort(byDesc(lpRatioPct));
}

/** "Strongest comeback first." */
export function rankReviving(cards: BoardCard[]): BoardCard[] {
  return [...cards].sort(byDesc(revivalDelta));
}

/**
 * The IN PLAY column (design pass 2, behaviour change 2). Ranked by the data,
 * not by when a coin was called — and a coin appears in exactly ONE of the
 * three P&L zones, with priority REVIVING > RUNNERS > RETRACED.
 *
 * ON WATCH is NOT part of that de-duplication (round 16 review): the zone is
 * the slot inventory, the one place a member can see and free every slot they
 * hold, so hiding a watched runner from it would make "your slots 3 / 3" sit
 * over an empty list. The watch dot still marks the coin wherever else it sits.
 *
 * It renders from the group's whole watchlist, not from card.watched: a watch
 * set in the chat, or from a Sleepers row, has no call on this board at all and
 * would otherwise be invisible — and un-freeable.
 */
export function deriveInPlay(board: BoardResponse, visible: VisibleSections): InPlay {
  const reviving = rankReviving(visible.reviving);
  const taken = new Set<number>(reviving.map((card) => card.callId));

  const runners = rankRunners(visible.runners.filter((card) => !taken.has(card.callId)));
  for (const card of runners) taken.add(card.callId);

  const retraced = rankRetraced(visible.retraced.filter((card) => !taken.has(card.callId)));
  for (const card of retraced) taken.add(card.callId);

  return { runners, retraced, reviving, watch: deriveWatchRows(board, visible) };
}

/**
 * The ON WATCH rows: the group's ENTIRE active watchlist, joined to the board
 * cards where this window happens to carry one. A watch whose call is outside
 * the window, on rug probation, or dead keeps its `hasCall` and says so — only
 * a watch with no call at all is a chat or Sleepers watch.
 */
export function deriveWatchRows(board: BoardResponse, visible: VisibleSections): WatchRow[] {
  // Every card still on the board, so a watch with a call can borrow its
  // sparkline, multiple and call story.
  const byCallId = new Map<number, BoardCard>();
  for (const cards of Object.values(visible)) {
    for (const card of cards) if (!byCallId.has(card.callId)) byCallId.set(card.callId, card);
  }

  const rows: WatchRow[] = [];
  for (const entry of board.watchlist ?? []) {
    const hasCall = entry.callId !== null;
    const card = entry.callId === null ? null : (byCallId.get(entry.callId) ?? null);
    rows.push({ entry, card, hasCall, move1h: moveOneHour(card ? card.sparkline : entry.sparkline) });
  }
  // "Biggest 1h move first" — magnitude, so a nuke ranks with a runner.
  rows.sort(byDesc((row: WatchRow) => (row.move1h === null ? null : Math.abs(row.move1h))));
  return rows;
}

/** `your slots n / 3` — how many of the reader's own cap slots are spent. */
export function mySlots(board: BoardResponse): number {
  return (board.watchlist ?? []).filter((entry) => entry.watchedByMe).length;
}

/**
 * How the ON WATCH subline names the slot holder. Every row in the zone is
 * watched by definition, so "watched" said nothing: the question the cap makes
 * a member ask is WHOSE slot this is.
 */
export function slotLabel(entry: WatchlistEntry): string {
  if (entry.watchedByMe) return 'your slot';
  return entry.addedByName ? `${entry.addedByName}’s slot` : 'another member’s slot';
}

// ---------------------------------------------------------------- round 21: verdicts

function finite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * A death a member pronounced (round 21) — the only one RESTORE may reverse.
 * The reason string itself is shared's to define; this is the CARD-level
 * question, which also asks whether the call is dead at all.
 */
export function isMemberDeath(card: BoardCard): boolean {
  return isDied(card) && isMemberDeathReason(card.deathReason);
}

/**
 * What a death SAYS beyond its badge (docs/decisions.md round 21).
 *
 * The two reasons round 21 introduced both carry evidence the badge cannot
 * hold: WHO pronounced it, or the volume and trade count the rule read. Every
 * clause is a number or a name — never a verdict — and a clause we do not have
 * is dropped rather than printed as zero: an unknown 24h volume is not $0.
 *
 * null for every other reason, which keeps the existing wording untouched.
 */
export function deathNote(card: BoardCard): string | null {
  if (isMemberDeathReason(card.deathReason)) {
    const by = typeof card.deathMarkedBy === 'string' ? card.deathMarkedBy.trim() : '';
    // A member-marked death whose name did not survive the join still says what
    // kind of death it was: the badge alone reads as machinery.
    return `marked dead by ${by.length > 0 ? by : UNNAMED_MEMBER}`;
  }
  if (isFlatlineDeath(card.deathReason)) {
    const parts = ['flatlined'];
    if (finite(card.vol24Usd)) parts.push(`vol ${fmtUsd(card.vol24Usd)} / 24h`);
    if (finite(card.txns24)) {
      const trades = Math.max(0, Math.round(card.txns24));
      parts.push(`${trades} ${trades === 1 ? 'trade' : 'trades'}`);
    }
    return parts.join(' · ');
  }
  return null;
}

/**
 * The optimistic half of a member verdict: the board as it will read once the
 * server answers, drawn from what the reader just did.
 *
 * `markedDead` maps a callId to the instant the member pressed; `restored`
 * holds the member-dead calls they have just put back. Both sets are cleared by
 * the refetch, so this overlay only ever covers the round trip — exactly the
 * bin machinery's contract, with a move instead of a hide.
 *
 * The optimistic card names the reader ("marked dead by you") because that is
 * the one thing we honestly know before the payload lands; the server's own
 * display name replaces it on the refetch.
 */
export function applyVerdicts(
  board: BoardResponse,
  markedDead: ReadonlyMap<number, string>,
  restored: ReadonlySet<number>,
): BoardResponse {
  if (markedDead.size === 0 && restored.size === 0) return board;

  const moved: BoardCard[] = [];
  const taken = new Set<number>();
  const strip = (cards: BoardCard[]): BoardCard[] =>
    cards.filter((card) => {
      const at = markedDead.get(card.callId);
      if (at === undefined) return true;
      if (!taken.has(card.callId)) {
        taken.add(card.callId);
        moved.push(asMemberDead(card, at));
      }
      return false;
    });

  const sections = board.sections;
  const fresh = strip(sections.fresh ?? []);
  const runners = strip(sections.runners ?? []);
  const retraced = strip(sections.retraced ?? []);
  const reviving = strip(sections.reviving ?? []);
  // A restore leaves DIED and does not reappear anywhere until the payload says
  // where it belongs — inventing a section for it would be a guess.
  const serverDied = (sections.died ?? []).filter((card) => !restored.has(card.callId));
  // The server's own version of a death always wins over ours: once the refetch
  // has it, the optimistic copy would only differ by naming the wrong person.
  const already = new Set(serverDied.map((card) => card.callId));
  const died = [...moved.filter((card) => !already.has(card.callId)), ...serverDied];

  return { ...board, sections: { fresh, runners, retraced, died, reviving } };
}

function asMemberDead(card: BoardCard, diedAt: string): BoardCard {
  return {
    ...card,
    callStatus: 'died',
    diedAt,
    deathReason: MEMBER_DEATH_REASON,
    deathMarkedBy: 'you',
    // Mark-to-market at the instant of the verdict, which is what the server
    // stamps too. Null stays null: no reading, no claim.
    mcapAtDeath: card.mcapUsd,
    // A dead call is not also a comeback.
    revivingAt: null,
  };
}
