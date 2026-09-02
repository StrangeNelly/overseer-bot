import { describe, expect, it } from 'vitest';
import type { calls, tokens } from '@groupie/db';
import { tradingLinks, type BoardCard } from '@groupie/shared';
import { toCard } from '../src/api/board.js';
import { classifySections, parseTzOffsetMin, startOfLocalDayMs } from '../src/api/boardLogic.js';

const HOUR = 3_600_000;

interface CardSpec {
  callId: number;
  callStatus?: BoardCard['callStatus'];
  mcapAtCall?: number | null;
  mcapUsd?: number | null;
  peak?: number | null;
  liquidityUsd?: number | null;
  lastMentionAt?: string;
  diedAt?: string | null;
  revivingAt?: string | null;
}

/** Mirrors board.ts's derivation so section rules are tested on real inputs. */
function card(spec: CardSpec): BoardCard {
  const mcapAtCall = spec.mcapAtCall === undefined ? 100_000 : spec.mcapAtCall;
  const mcapUsd = spec.mcapUsd === undefined ? 100_000 : spec.mcapUsd;
  const peak = spec.peak === undefined ? mcapUsd : spec.peak;
  const base = mcapAtCall !== null && mcapAtCall > 0 ? mcapAtCall : null;
  const address = `0x${String(spec.callId).padStart(40, '0')}`;
  return {
    callId: spec.callId,
    tokenId: spec.callId,
    address,
    symbol: `T${spec.callId}`,
    name: null,
    imageUrl: null,
    twitterUrl: null,
    websiteUrl: null,
    phase: 'graduated',
    callStatus: spec.callStatus ?? 'active',
    mcapUsd,
    liquidityUsd: spec.liquidityUsd === undefined ? 50_000 : spec.liquidityUsd,
    vol24Usd: 10_000,
    mcapAtCall,
    multiple: base !== null && mcapUsd !== null ? mcapUsd / base : null,
    peakMcapSinceCall: peak,
    peakMultiple: base !== null && peak !== null ? peak / base : null,
    retraceFromPeakPct:
      mcapUsd !== null && peak !== null && peak > 0
        ? Math.min(100, Math.max(0, (1 - mcapUsd / peak) * 100))
        : null,
    calledAt: new Date(Date.now() - 6 * HOUR).toISOString(),
    callerName: '@caller',
    mentionsCount: 1,
    lastMentionAt: spec.lastMentionAt ?? new Date(Date.now() - HOUR).toISOString(),
    revived: false,
    diedAt: spec.diedAt ?? null,
    deathReason: null,
    mcapAtDeath: null,
    deathMarkedBy: null,
    txns24: null,
    dataAsOf: new Date().toISOString(),
    watched: false,
    watchedByMe: false,
    revivingAt: spec.revivingAt ?? null,
    links: tradingLinks(address),
    sparkline: [],
  };
}

const ids = (cards: BoardCard[]) => cards.map((c) => c.callId);

describe('classifySections', () => {
  it('an active 5x sitting near its peak is fresh + a runner', () => {
    const sections = classifySections([card({ callId: 1, mcapUsd: 500_000, peak: 520_000 })]);
    expect(ids(sections.fresh)).toEqual([1]);
    expect(ids(sections.runners)).toEqual([1]);
    expect(sections.retraced).toEqual([]);
    expect(sections.died).toEqual([]);
  });

  it('peaked 10x then -70% is fresh + retraced, NOT a runner', () => {
    const sections = classifySections([card({ callId: 2, mcapUsd: 300_000, peak: 1_000_000 })]);
    expect(ids(sections.fresh)).toEqual([2]);
    expect(ids(sections.retraced)).toEqual([2]);
    // Still 3x on the call, but a card in a retrace is never also a runner.
    expect(sections.runners).toEqual([]);
    expect(sections.retraced[0]?.retraceFromPeakPct).toBeCloseTo(70);
  });

  it('a peak that never reached 3x is not a retrace however far it fell', () => {
    const sections = classifySections([card({ callId: 3, mcapUsd: 20_000, peak: 250_000 })]);
    expect(ids(sections.fresh)).toEqual([3]);
    expect(sections.retraced).toEqual([]);
    expect(sections.runners).toEqual([]);
  });

  it('a card exactly 40% off a 3x peak is retraced (boundary)', () => {
    const sections = classifySections([card({ callId: 4, mcapUsd: 180_000, peak: 300_000 })]);
    expect(ids(sections.retraced)).toEqual([4]);
  });

  it('died cards appear only in died', () => {
    const sections = classifySections([
      card({ callId: 5, callStatus: 'died', mcapUsd: 500_000, peak: 1_000_000 }),
    ]);
    expect(ids(sections.died)).toEqual([5]);
    expect(sections.fresh).toEqual([]);
    expect(sections.runners).toEqual([]);
    expect(sections.retraced).toEqual([]);
  });

  it('2.9x is NOT a runner; 3.0x is', () => {
    const sections = classifySections([
      card({ callId: 6, mcapUsd: 290_000 }),
      card({ callId: 7, mcapUsd: 300_000 }),
    ]);
    expect(ids(sections.runners)).toEqual([7]);
    expect(ids(sections.fresh).sort()).toEqual([6, 7]);
  });

  it('a null mcapAtCall is never a runner or a retrace, but is still fresh', () => {
    const sections = classifySections([
      card({ callId: 8, mcapAtCall: null, mcapUsd: 900_000, peak: 2_000_000 }),
      card({ callId: 9, mcapAtCall: 0, mcapUsd: 900_000, peak: 2_000_000 }),
    ]);
    expect(ids(sections.fresh).sort()).toEqual([8, 9]);
    expect(sections.runners).toEqual([]);
    expect(sections.retraced).toEqual([]);
  });

  it('a null current mcap is fresh only', () => {
    const sections = classifySections([card({ callId: 10, mcapUsd: null, peak: 1_000_000 })]);
    expect(ids(sections.fresh)).toEqual([10]);
    expect(sections.runners).toEqual([]);
    expect(sections.retraced).toEqual([]);
  });

  it('sorts fresh by lastMentionAt desc', () => {
    const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * HOUR).toISOString();
    const sections = classifySections([
      card({ callId: 11, lastMentionAt: at(5) }),
      card({ callId: 12, lastMentionAt: at(1) }),
      card({ callId: 13, lastMentionAt: at(3) }),
    ]);
    expect(ids(sections.fresh)).toEqual([12, 13, 11]);
  });

  it('sorts runners by multiple desc and retraced by retrace pct desc', () => {
    const sections = classifySections([
      card({ callId: 14, mcapUsd: 400_000 }), // 4x
      card({ callId: 15, mcapUsd: 900_000 }), // 9x
      card({ callId: 16, mcapUsd: 300_000, peak: 1_000_000 }), // -70%
      card({ callId: 17, mcapUsd: 500_000, peak: 1_000_000 }), // -50%
    ]);
    expect(ids(sections.runners)).toEqual([15, 14]);
    expect(ids(sections.retraced)).toEqual([16, 17]);
  });

  it('sorts died by diedAt desc with nulls last', () => {
    const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * HOUR).toISOString();
    const sections = classifySections([
      card({ callId: 18, callStatus: 'died', diedAt: at(10) }),
      card({ callId: 19, callStatus: 'died', diedAt: null }),
      card({ callId: 20, callStatus: 'died', diedAt: at(2) }),
    ]);
    expect(ids(sections.died)).toEqual([20, 18, 19]);
  });

  it('does not mutate or reorder the input array', () => {
    const cards = [
      card({ callId: 21, lastMentionAt: new Date(Date.now() - 9 * HOUR).toISOString() }),
      card({ callId: 22, lastMentionAt: new Date(Date.now() - HOUR).toISOString() }),
    ];
    classifySections(cards);
    expect(ids(cards)).toEqual([21, 22]);
  });

  it('binned calls reach no section', () => {
    expect(classifySections([card({ callId: 23, callStatus: 'binned' })])).toEqual({
      fresh: [],
      runners: [],
      retraced: [],
      reviving: [],
      died: [],
    });
  });
});

/**
 * The retraced liveness clauses (docs/decisions.md round 10): "pulled back but
 * NOT dying" has to mean something. Past 85% off peak is a collapse — rug
 * probation's job — and a dust pool is not a market anyone can sell into.
 */
describe('classifySections — retraced honesty', () => {
  it('does not bill the HDFI collapse as a retrace', () => {
    // The live case: 3.4x peak, then -99% to $8,249 on $8.5k of liquidity. The
    // board showed "Retraced 0.03x"; it is a rug, and the sweep hides it.
    const sections = classifySections([
      card({ callId: 50, mcapAtCall: 256_000, peak: 872_124, mcapUsd: 8_249, liquidityUsd: 8_500 }),
    ]);
    expect(sections.retraced).toEqual([]);
    // Not exiled either — it stays visible until probation takes it.
    expect(ids(sections.fresh)).toEqual([50]);
  });

  it('a 60%-off-peak card with real liquidity IS retraced', () => {
    const sections = classifySections([
      card({ callId: 51, peak: 1_000_000, mcapUsd: 400_000, liquidityUsd: 50_000 }),
    ]);
    expect(ids(sections.retraced)).toEqual([51]);
  });

  it('an 84%-off card on a dust pool is not a retrace', () => {
    const sections = classifySections([
      card({ callId: 52, peak: 1_000_000, mcapUsd: 160_000, liquidityUsd: 500 }),
    ]);
    expect(sections.retraced).toEqual([]);
    expect(ids(sections.fresh)).toEqual([52]);
    // The same card on a real pool is exactly what the section is for.
    const live = classifySections([
      card({ callId: 53, peak: 1_000_000, mcapUsd: 160_000, liquidityUsd: 50_000 }),
    ]);
    expect(ids(live.retraced)).toEqual([53]);
  });

  it('unknown liquidity is never proof of a live market', () => {
    const sections = classifySections([
      card({ callId: 54, peak: 1_000_000, mcapUsd: 400_000, liquidityUsd: null }),
    ]);
    expect(sections.retraced).toEqual([]);
    expect(ids(sections.fresh)).toEqual([54]);
  });

  it('85% off peak is still a retrace; 86% is a collapse', () => {
    const sections = classifySections([
      card({ callId: 55, peak: 1_000_000, mcapUsd: 150_000 }),
      card({ callId: 56, peak: 1_000_000, mcapUsd: 140_000 }),
    ]);
    expect(ids(sections.retraced)).toEqual([55]);
    expect(ids(sections.fresh).sort()).toEqual([55, 56]);
  });

  it('exactly the dust line is enough liquidity', () => {
    const sections = classifySections([
      card({ callId: 57, peak: 1_000_000, mcapUsd: 400_000, liquidityUsd: 1_000 }),
      card({ callId: 58, peak: 1_000_000, mcapUsd: 400_000, liquidityUsd: 999 }),
    ]);
    expect(ids(sections.retraced)).toEqual([57]);
  });

  it('a card that stops being retraced can go back to being a runner', () => {
    // 30x peak, now ~87% off it but still 4x on the call: past the retrace
    // ceiling, so nothing holds it out of runners any more.
    const sections = classifySections([
      card({ callId: 59, mcapAtCall: 100_000, peak: 3_000_000, mcapUsd: 400_000 }),
    ]);
    expect(sections.retraced).toEqual([]);
    expect(ids(sections.runners)).toEqual([59]);
  });
});

/**
 * The Reviving spotlight (docs/decisions.md round 6). Note what is NOT tested
 * here: hidden tokens (rug_hidden_at set) never reach classifySections at all —
 * board.ts and range.ts filter them out in SQL, so probation holds for every
 * section including died.
 */
describe('classifySections — reviving', () => {
  const NOW = Date.UTC(2026, 8, 2, 12, 0, 0);
  const ago = (hours: number) => new Date(NOW - hours * HOUR).toISOString();

  it('spotlights a card that came back from probation', () => {
    const sections = classifySections([card({ callId: 40, revivingAt: ago(2) })], NOW);
    expect(ids(sections.reviving)).toEqual([40]);
  });

  it('is a spotlight, not an exile: the card classifies normally as well', () => {
    // A 5x that also just survived probation belongs in fresh AND runners AND
    // reviving — the same dual membership fresh/runners already has.
    const sections = classifySections(
      [card({ callId: 41, mcapUsd: 500_000, peak: 520_000, revivingAt: ago(1) })],
      NOW,
    );
    expect(ids(sections.reviving)).toEqual([41]);
    expect(ids(sections.fresh)).toEqual([41]);
    expect(ids(sections.runners)).toEqual([41]);
  });

  it('drops out of the section after 24h, without the stamp being cleared', () => {
    const stale = card({ callId: 42, revivingAt: ago(24.5) });
    const sections = classifySections([stale], NOW);
    expect(sections.reviving).toEqual([]);
    // Still fresh, and the stamp is still on the card: the window is applied on
    // read, never by wiping the column.
    expect(ids(sections.fresh)).toEqual([42]);
    expect(stale.revivingAt).not.toBeNull();
  });

  it('holds the spotlight right up to the 24h boundary', () => {
    expect(ids(classifySections([card({ callId: 43, revivingAt: ago(23.9) })], NOW).reviving)).toEqual([43]);
    expect(classifySections([card({ callId: 44, revivingAt: ago(24) })], NOW).reviving).toEqual([]);
  });

  it('sorts by revivingAt desc', () => {
    const sections = classifySections(
      [
        card({ callId: 45, revivingAt: ago(9) }),
        card({ callId: 46, revivingAt: ago(1) }),
        card({ callId: 47, revivingAt: ago(5) }),
      ],
      NOW,
    );
    expect(ids(sections.reviving)).toEqual([46, 47, 45]);
  });

  it('a card with no revival stamp is never in it', () => {
    expect(classifySections([card({ callId: 48 })], NOW).reviving).toEqual([]);
  });

  it('a coin that came back and then died is answered by died, not reviving', () => {
    const sections = classifySections(
      [card({ callId: 49, callStatus: 'died', diedAt: ago(1), revivingAt: ago(3) })],
      NOW,
    );
    expect(ids(sections.died)).toEqual([49]);
    expect(sections.reviving).toEqual([]);
  });
});

type CallRow = typeof calls.$inferSelect;
type TokenRow = typeof tokens.$inferSelect;

function callRow(overrides: Partial<CallRow> = {}): CallRow {
  return {
    id: 1,
    groupId: 1,
    tokenId: 1,
    callerUserId: 4242,
    callerName: '@caller',
    messageId: 7,
    calledAt: new Date(Date.now() - 6 * HOUR),
    mcapAtCall: 100_000,
    liquidityAtCall: 50_000,
    peakMcapSinceCall: 300_000,
    peakAt: new Date(Date.now() - 3 * HOUR),
    mentionsCount: 1,
    lastMentionAt: new Date(Date.now() - HOUR),
    status: 'active',
    diedAt: null,
    deathReason: null,
    mcapAtDeath: null,
    binnedBy: null,
    binnedAt: null,
    reviveRequested: false,
    ...overrides,
  };
}

function tokenRow(overrides: Partial<TokenRow> = {}): TokenRow {
  return {
    id: 1,
    chainId: 1,
    address: '0x0000000000000000000000000000000000000001',
    symbol: 'TKN',
    name: 'Token',
    imageUrl: null,
    socials: null,
    launchpad: null,
    phase: 'graduated',
    poolAddress: null,
    tokenCreatedAt: null,
    graduatedAt: null,
    diedAt: null,
    deathReason: null,
    mcapAtDeath: null,
    revivedAt: null,
    rugHiddenAt: null,
    revivingAt: null,
    priceUsd: 0.01,
    mcapUsd: 200_000,
    liquidityUsd: 40_000,
    vol24Usd: 10_000,
    firstSeenAt: new Date(Date.now() - 7 * HOUR),
    lastPolledAt: new Date(),
    lastSnapshotAt: new Date(),
    ...overrides,
  };
}

/** The '>95% liquidity drop from call' rug: the call dies, the token trades on. */
describe('toCard death info', () => {
  const callDeath = new Date(Date.now() - 2 * HOUR);

  it('reports the call-level death of a call whose token is still alive', () => {
    const result = toCard(
      callRow({ status: 'died', diedAt: callDeath, deathReason: 'call_liquidity_collapse' }),
      tokenRow(),
      [],
      false,
    );
    expect(result.diedAt).toBe(callDeath.toISOString());
    expect(result.deathReason).toBe('call_liquidity_collapse');
  });

  it("prefers the call's death over a revived token's stale last-death record", () => {
    const result = toCard(
      callRow({ status: 'died', diedAt: callDeath, deathReason: 'call_liquidity_collapse' }),
      tokenRow({
        diedAt: new Date(Date.now() - 40 * HOUR),
        deathReason: 'liquidity_floor',
        revivedAt: new Date(Date.now() - 30 * HOUR),
      }),
      [],
      false,
    );
    expect(result.diedAt).toBe(callDeath.toISOString());
    expect(result.deathReason).toBe('call_liquidity_collapse');
    expect(result.revived).toBe(true);
  });

  it('takes date and reason from the SAME death, never a mix', () => {
    const result = toCard(
      callRow({ status: 'died', diedAt: callDeath }), // stamped, reason unknown
      tokenRow({ diedAt: new Date(Date.now() - 40 * HOUR), deathReason: 'curve_floor' }),
      [],
      false,
    );
    expect(result.diedAt).toBe(callDeath.toISOString());
    expect(result.deathReason).toBeNull();
  });

  it('falls back to the token for a call with no death stamp (pre-M3 rows)', () => {
    const result = toCard(
      callRow({ status: 'died' }),
      tokenRow({ phase: 'dead', diedAt: callDeath, deathReason: 'liquidity_floor' }),
      [],
      false,
    );
    expect(result.diedAt).toBe(callDeath.toISOString());
    expect(result.deathReason).toBe('liquidity_floor');
  });

  it('leaves a living call on a living token with no death info', () => {
    const result = toCard(callRow(), tokenRow(), [], false);
    expect(result.diedAt).toBeNull();
    expect(result.deathReason).toBeNull();
  });

  it('carries the token\'s revival stamp onto the card, unwindowed', () => {
    // Raw on purpose: classifySections owns the 24h window, so a stale stamp
    // must still reach it rather than being silently dropped here.
    const revivingAt = new Date(Date.now() - 40 * HOUR);
    expect(toCard(callRow(), tokenRow({ revivingAt }), [], false).revivingAt).toBe(
      revivingAt.toISOString(),
    );
    expect(toCard(callRow(), tokenRow(), [], false).revivingAt).toBeNull();
  });

  it('sorts a fresh per-call rug above an older token death', () => {
    const sections = classifySections([
      toCard(
        callRow({
          id: 31,
          status: 'died',
          diedAt: new Date(Date.now() - 5 * HOUR),
          deathReason: 'liquidity_floor',
        }),
        tokenRow({ id: 2, phase: 'dead', diedAt: new Date(Date.now() - 5 * HOUR) }),
        [],
        false,
      ),
      toCard(
        callRow({ id: 30, status: 'died', diedAt: callDeath, deathReason: 'call_liquidity_collapse' }),
        tokenRow(),
        [],
        false,
      ),
    ]);
    expect(ids(sections.died)).toEqual([30, 31]);
  });
});

/**
 * Mcap-at-death (docs/decisions.md round 15). The rail printed the LAST POLLED
 * mcap and captioned it "at death"; for a corpse that keeps being polled those
 * are different numbers, and the caption was the lie.
 */
describe('toCard mcap-at-death', () => {
  const callDeath = new Date(Date.now() - 2 * HOUR);

  it('takes the mcap from the same row as the date and reason', () => {
    const result = toCard(
      callRow({
        status: 'died',
        diedAt: callDeath,
        deathReason: 'call_liquidity_collapse',
        mcapAtDeath: 12_400,
      }),
      // The token has traded on since, so its cached mcap is a different number.
      tokenRow({ mcapUsd: 61_000 }),
      [],
      false,
    );
    expect(result.mcapAtDeath).toBe(12_400);
    expect(result.mcapUsd).toBe(61_000);
  });

  it('never mixes a call death with the token s mcap-at-death', () => {
    const result = toCard(
      callRow({ status: 'died', diedAt: callDeath, mcapAtDeath: null }),
      tokenRow({ diedAt: new Date(Date.now() - 40 * HOUR), mcapAtDeath: 900 }),
      [],
      false,
    );
    // The call's death is the one being reported, so its (absent) mcap is the
    // honest answer — the card says "last seen" rather than borrowing $900.
    expect(result.diedAt).toBe(callDeath.toISOString());
    expect(result.mcapAtDeath).toBeNull();
  });

  it('falls back to the token record when the call has no death stamp', () => {
    const result = toCard(
      callRow({ status: 'died' }),
      tokenRow({ phase: 'dead', diedAt: callDeath, deathReason: 'liquidity_floor', mcapAtDeath: 7_100 }),
      [],
      false,
    );
    expect(result.mcapAtDeath).toBe(7_100);
  });

  it('is null for a living card, and for a death recorded before the column', () => {
    expect(toCard(callRow(), tokenRow(), [], false).mcapAtDeath).toBeNull();
    expect(
      toCard(callRow({ status: 'died', diedAt: callDeath }), tokenRow(), [], false).mcapAtDeath,
    ).toBeNull();
  });
});

/** Round 15: a website link wherever links render, proved off the same blob as X. */
describe('toCard websiteUrl', () => {
  it('reads a website out of the socials blob', () => {
    const card = toCard(
      callRow(),
      tokenRow({ socials: { website: 'https://example.com', twitter: 'https://x.com/example' } }),
      [],
      false,
    );
    expect(card.websiteUrl).toBe('https://example.com');
    expect(card.twitterUrl).toBe('https://x.com/example');
  });

  it('is null when there is none, and never trusts a non-http scheme', () => {
    expect(toCard(callRow(), tokenRow(), [], false).websiteUrl).toBeNull();
    expect(
      toCard(callRow(), tokenRow({ socials: { website: 'javascript:alert(1)' } }), [], false)
        .websiteUrl,
    ).toBeNull();
  });
});

/**
 * The client's own midnight (docs/decisions.md round 15). The board's
 * todayCallCount is a claim about the reader's day, and the server runs in UTC
 * — so the offset arrives on the query string and is validated here.
 */
describe('parseTzOffsetMin', () => {
  it('takes minutes east of UTC, both signs', () => {
    expect(parseTzOffsetMin('600')).toBe(600); // AEST
    expect(parseTzOffsetMin('-300')).toBe(-300); // EST
    expect(parseTzOffsetMin('0')).toBe(0);
  });

  it('accepts the real extremes and rejects what is beyond them', () => {
    expect(parseTzOffsetMin('840')).toBe(840);
    expect(parseTzOffsetMin('-840')).toBe(-840);
    expect(parseTzOffsetMin('841')).toBe(0);
    expect(parseTzOffsetMin('-1440')).toBe(0);
  });

  it('falls back to UTC rather than failing the whole board', () => {
    for (const raw of [undefined, '', 'abc', '1.5', 'NaN', 'Infinity']) {
      expect(parseTzOffsetMin(raw)).toBe(0);
    }
  });
});

describe('startOfLocalDayMs', () => {
  const at = (iso: string) => Date.parse(iso);

  it('is UTC midnight at offset 0', () => {
    expect(startOfLocalDayMs(at('2026-09-02T13:45:00Z'), 0)).toBe(at('2026-09-02T00:00:00Z'));
  });

  it('rolls the day over for a reader ahead of UTC', () => {
    // 23:00Z is already the 3rd in Sydney (+10), so their day started at 14:00Z.
    expect(startOfLocalDayMs(at('2026-09-02T23:00:00Z'), 600)).toBe(at('2026-09-02T14:00:00Z'));
  });

  it('holds the day back for a reader behind UTC', () => {
    // 02:00Z is still the 1st in New York (-5): their day started at 04:00Z.
    expect(startOfLocalDayMs(at('2026-09-02T02:00:00Z'), -300)).toBe(at('2026-09-01T05:00:00Z'));
  });

  it('never returns a start in the future', () => {
    for (const offset of [-840, -300, 0, 330, 600, 840]) {
      for (const iso of ['2026-09-02T00:00:00Z', '2026-09-02T12:00:00Z', '2026-09-02T23:59:59Z']) {
        const now = at(iso);
        const start = startOfLocalDayMs(now, offset);
        expect(start).toBeLessThanOrEqual(now);
        expect(now - start).toBeLessThan(86_400_000);
      }
    }
  });

  it('handles a half-hour offset (India, +5:30)', () => {
    expect(startOfLocalDayMs(at('2026-09-02T10:00:00Z'), 330)).toBe(at('2026-09-01T18:30:00Z'));
  });
});
