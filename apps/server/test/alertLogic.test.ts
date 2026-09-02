import { describe, expect, it } from 'vitest';
import { ALERT_DEFAULTS, type AlertSettings } from '@groupie/shared';
import {
  alertMessage,
  alertSettingsOf,
  clampAlertSetting,
  evaluateAlerts,
  fmtUsd,
  mergeAlertSettings,
  tokenLabel,
  underCooldown,
  type AlertSnapshot,
} from '../src/poller/alertLogic.js';

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 8, 2, 12, 0, 0);

const SETTINGS: AlertSettings = { ...ALERT_DEFAULTS };

/** Snapshots from `[minutesAgo, mcap]` pairs, oldest first (the loader's order). */
function snaps(...pairs: Array<[number, number]>): AlertSnapshot[] {
  return pairs
    .map(([minutesAgo, mcapUsd]) => ({ atMs: NOW - minutesAgo * MINUTE, mcapUsd }))
    .sort((a, b) => a.atMs - b.atMs);
}

function verdict(
  currentMcapUsd: number | null,
  recentSnapshots: AlertSnapshot[],
  settings: AlertSettings = SETTINGS,
  mcapAtWatch: number | null = null,
  buyOppArmed = true,
) {
  return evaluateAlerts({
    nowMs: NOW,
    currentMcapUsd,
    recentSnapshots,
    settings,
    mcapAtWatch,
    buyOppArmed,
  });
}

/** Just the candidates: most rules are about what fires, not about the flag. */
function evaluate(
  currentMcapUsd: number | null,
  recentSnapshots: AlertSnapshot[],
  settings: AlertSettings = SETTINGS,
  mcapAtWatch: number | null = null,
  buyOppArmed = true,
) {
  return verdict(currentMcapUsd, recentSnapshots, settings, mcapAtWatch, buyOppArmed).candidates;
}

/** The candidate as a nuke, or undefined — the union needs narrowing to read. */
function nuke(result: ReturnType<typeof evaluate>) {
  const first = result[0];
  return first?.type === 'nuke' ? first : undefined;
}

function buyOpp(result: ReturnType<typeof evaluate>) {
  const first = result[0];
  return first?.type === 'buy_opp' ? first : undefined;
}

/** Three readings at 200K inside the 15-minute nuke window. */
const NUKE_WINDOW_AT_200K = snaps([14, 200_000], [10, 200_000], [5, 200_000]);

describe('evaluateAlerts — nuke', () => {
  it('fires at exactly the threshold (40% below the window peak)', () => {
    const result = evaluate(120_000, NUKE_WINDOW_AT_200K);
    expect(result).toHaveLength(1);
    expect(nuke(result)?.dropPct).toBeCloseTo(40, 10);
    expect(nuke(result)?.peakMcapUsd).toBe(200_000);
    // Ties keep the LATEST visit to the peak: the drop started there.
    expect(nuke(result)?.peakAtMs).toBe(NOW - 5 * MINUTE);
  });

  it('does not fire one dollar short of the threshold', () => {
    expect(evaluate(120_001, NUKE_WINDOW_AT_200K)).toEqual([]);
  });

  it('ignores a peak older than the nuke window', () => {
    // 200K three hours ago, flat at 120K ever since: a 40% fall, but not fast.
    // The watch line was crossed long ago and already spent its message, so a
    // disarmed watch makes this pass entirely silent.
    const series = snaps([180, 200_000], [14, 120_000], [10, 120_000], [5, 120_000]);
    expect(evaluate(120_000, series, SETTINGS, 200_000, false)).toEqual([]);
  });

  it('needs three readings in the window — two are a data artefact', () => {
    expect(evaluate(120_000, snaps([14, 200_000], [5, 200_000]))).toEqual([]);
  });

  it('fires on the third reading', () => {
    expect(evaluate(120_000, snaps([14, 200_000], [9, 200_000], [5, 200_000]))).toHaveLength(1);
  });

  it('honours a widened window from group settings', () => {
    const series = snaps([50, 200_000], [40, 200_000], [30, 200_000], [5, 120_000]);
    expect(evaluate(120_000, series)).toEqual([]);
    const wide = evaluate(120_000, series, { ...SETTINGS, nukeWindowMin: 60 });
    expect(wide.map((a) => a.type)).toEqual(['nuke']);
  });
});

/**
 * Round 19: the drawdown is measured from the mcap the coin had WHEN THE WATCH
 * WAS SET, and it is worth one message per fall below that line — tracked by an
 * explicit armed flag, so a polling gap or a nuke-suppressed pass cannot eat the
 * fall, and a stalled series cannot repeat it.
 *
 * Baseline 120K at the default 30% => the line is 84K.
 */
describe('evaluateAlerts — buy opportunity (from the watch, round 19)', () => {
  const WATCHED_AT = 120_000;
  const LINE = 84_000;

  /** A drift down to `to`, with the reading before it at `from`. */
  const drift = (from: number, to: number) =>
    snaps([30, WATCHED_AT], [20, from], [10, from], [5, to]);

  it('fires when the coin is below the line, measured from the watch', () => {
    const result = evaluate(82_000, drift(90_000, 82_000), SETTINGS, WATCHED_AT);
    expect(result).toHaveLength(1);
    expect(buyOpp(result)?.mcapAtWatch).toBe(WATCHED_AT);
    // -31.7% from 120K, NOT from any high the coin printed in between.
    expect(buyOpp(result)?.dropPct).toBeCloseTo(31.67, 2);
  });

  it('disarms itself when it fires, so the fall gets exactly one message', () => {
    const first = verdict(82_000, drift(90_000, 82_000), SETTINGS, WATCHED_AT);
    expect(first.candidates.map((a) => a.type)).toEqual(['buy_opp']);
    expect(first.buyOppArmed).toBe(false);
  });

  it('never fires without a baseline, and leaves the flag untouched', () => {
    for (const baseline of [null, 0, -5, Number.NaN]) {
      const armed = verdict(82_000, drift(90_000, 82_000), SETTINGS, baseline);
      expect(armed.candidates).toEqual([]);
      expect(armed.buyOppArmed).toBe(true);
      const disarmed = verdict(82_000, drift(90_000, 82_000), SETTINGS, baseline, false);
      expect(disarmed.candidates).toEqual([]);
      expect(disarmed.buyOppArmed).toBe(false);
    }
  });

  it('does not re-fire while it sits below the line', () => {
    const result = verdict(80_000, drift(82_000, 80_000), SETTINGS, WATCHED_AT, false);
    expect(result.candidates).toEqual([]);
    expect(result.buyOppArmed).toBe(false);
  });

  /**
   * The stall case (round 19 review): no new snapshot lands for hours, so every
   * pass sees the identical series. Without the flag the same message would be
   * re-posted every time the cooldown released.
   */
  it('does not re-fire off an unchanged series, however many passes run', () => {
    const series = drift(90_000, 82_000);
    const first = verdict(82_000, series, SETTINGS, WATCHED_AT);
    expect(first.candidates).toHaveLength(1);
    for (let pass = 0; pass < 5; pass += 1) {
      const later = verdict(82_000, series, SETTINGS, WATCHED_AT, first.buyOppArmed);
      expect(later.candidates).toEqual([]);
      expect(later.buyOppArmed).toBe(false);
    }
  });

  it('re-arms on a recovery above the line, and fires on the next fall', () => {
    const recovered = snaps([30, 80_000], [20, 95_000], [10, 95_000], [5, 90_000]);
    const back = verdict(90_000, recovered, SETTINGS, WATCHED_AT, false);
    // Above the line there is nothing to say — but the next fall may speak.
    expect(back.candidates).toEqual([]);
    expect(back.buyOppArmed).toBe(true);
    const again = verdict(83_000, recovered, SETTINGS, WATCHED_AT, back.buyOppArmed);
    expect(again.candidates.map((a) => a.type)).toEqual(['buy_opp']);
    expect(again.buyOppArmed).toBe(false);
  });

  it('fires AT the line, and not one dollar above it', () => {
    expect(
      evaluate(LINE, drift(90_000, LINE), SETTINGS, WATCHED_AT).map((a) => a.type),
    ).toEqual(['buy_opp']);
    expect(evaluate(LINE + 1, drift(90_000, LINE + 1), SETTINGS, WATCHED_AT)).toEqual([]);
  });

  /**
   * A gap longer than the series window (a deploy, a GT hold) leaves the fall
   * with no reading above the line to point at. The flag is what remembers it.
   */
  it('fires off a lone reading below the line — a gap does not eat the fall', () => {
    const result = verdict(82_000, snaps([5, 82_000]), SETTINGS, WATCHED_AT);
    expect(result.candidates.map((a) => a.type)).toEqual(['buy_opp']);
    expect(result.buyOppArmed).toBe(false);
  });

  it('fires with no series at all — the baseline is the whole rule', () => {
    expect(evaluate(82_000, [], SETTINGS, WATCHED_AT).map((a) => a.type)).toEqual(['buy_opp']);
  });

  it('ignores a peak the coin printed after the watch', () => {
    // The old rule would have measured -84% from 500K and called it a retrace.
    // Round 19 measures the member's own entry point instead.
    const spike = snaps([30, WATCHED_AT], [20, 500_000], [10, 90_000], [5, 82_000]);
    const result = evaluate(82_000, spike, SETTINGS, WATCHED_AT);
    expect(buyOpp(result)?.dropPct).toBeCloseTo(31.67, 2);
  });

  it('honours a group s own retrace percentage', () => {
    // 50% => the line is 60K, so a fall to 82K is not deep enough.
    const strict: AlertSettings = { ...SETTINGS, buyRetracePct: 50 };
    expect(evaluate(82_000, drift(90_000, 82_000), strict, WATCHED_AT)).toEqual([]);
    expect(
      evaluate(59_000, drift(70_000, 59_000), strict, WATCHED_AT).map((a) => a.type),
    ).toEqual(['buy_opp']);
  });

  it('ignores the retired peak-window settings entirely', () => {
    // They survive as keys for old `set` invocations and stored blobs; the rule
    // must answer the same with any value in them.
    const legacy: AlertSettings = {
      ...SETTINGS,
      buyPeakWindowHours: 1,
      buyMinDeclineHours: 48,
    };
    expect(
      evaluate(82_000, drift(90_000, 82_000), legacy, WATCHED_AT).map((a) => a.type),
    ).toEqual(['buy_opp']);
  });

  it('is suppressed while the nuke condition holds, and STAYS armed', () => {
    // A fall through the line off a cliff is a nuke, not a setup — but the
    // suppression must not spend the fall's message: it fires on the next pass
    // that is not a crash.
    const series = snaps([14, 200_000], [10, 200_000], [5, 200_000]);
    const crashing = verdict(80_000, series, SETTINGS, WATCHED_AT);
    expect(crashing.candidates.map((a) => a.type)).toEqual(['nuke']);
    expect(crashing.buyOppArmed).toBe(true);
    // Once the crash ages out of the nuke window, the setup posts.
    const settled = snaps([120, 200_000], [14, 80_000], [10, 80_000], [5, 80_000]);
    expect(verdict(80_000, settled, SETTINGS, WATCHED_AT).candidates.map((a) => a.type)).toEqual([
      'buy_opp',
    ]);
  });

  it('stays suppressed and armed when thin data blocks the nuke alert itself', () => {
    // A crash in progress is never a buy signal, even when we cannot prove the
    // crash well enough to alert on it.
    const series = snaps([14, 200_000], [5, 200_000]);
    const result = verdict(100_000, series, SETTINGS, WATCHED_AT);
    expect(result.candidates).toEqual([]);
    expect(result.buyOppArmed).toBe(true);
  });
});

describe('evaluateAlerts — insufficient data', () => {
  it('returns nothing without a current market cap, and moves no flag', () => {
    const result = verdict(null, NUKE_WINDOW_AT_200K, SETTINGS, 200_000);
    expect(result.candidates).toEqual([]);
    // An unjudged pass must not disarm the watch, nor re-arm a spent one.
    expect(result.buyOppArmed).toBe(true);
    expect(verdict(null, NUKE_WINDOW_AT_200K, SETTINGS, 200_000, false).buyOppArmed).toBe(false);
  });

  it('treats a zero or negative market cap as a bad reading, not a collapse', () => {
    expect(evaluate(0, NUKE_WINDOW_AT_200K)).toEqual([]);
    expect(evaluate(-5, NUKE_WINDOW_AT_200K)).toEqual([]);
    expect(verdict(0, NUKE_WINDOW_AT_200K, SETTINGS, 200_000).buyOppArmed).toBe(true);
  });

  it('returns nothing with no snapshots at all', () => {
    expect(evaluate(95_000, [])).toEqual([]);
  });

  it('ignores unusable snapshots', () => {
    const junk: AlertSnapshot[] = [
      { atMs: NOW - 14 * MINUTE, mcapUsd: Number.NaN },
      { atMs: NOW - 10 * MINUTE, mcapUsd: 0 },
      { atMs: Number.NaN, mcapUsd: 200_000 },
    ];
    expect(evaluate(120_000, junk)).toEqual([]);
  });

  it('still judges the watch line when the only reading is ancient', () => {
    // The series is the nuke rule's evidence, and an hours-old reading proves
    // no crash; the buy-opp line needs no evidence beyond the baseline.
    const result = verdict(95_000, snaps([30 * 60, 200_000]), SETTINGS, 200_000);
    expect(result.candidates.map((a) => a.type)).toEqual(['buy_opp']);
  });
});

describe('underCooldown', () => {
  it('is false when nothing has fired', () => {
    expect(underCooldown(null, NOW, 60)).toBe(false);
  });

  it('is true inside the window and false after it', () => {
    expect(underCooldown(NOW - 59 * MINUTE, NOW, 60)).toBe(true);
    expect(underCooldown(NOW - 61 * MINUTE, NOW, 60)).toBe(false);
  });

  it('releases at exactly the cooldown', () => {
    expect(underCooldown(NOW - 60 * MINUTE, NOW, 60)).toBe(false);
  });

  it('keeps silent for a future-stamped last fire (clock skew)', () => {
    expect(underCooldown(NOW + 5 * MINUTE, NOW, 60)).toBe(true);
  });
});

describe('settings merge and clamps', () => {
  it('returns the defaults for missing or non-object settings', () => {
    expect(mergeAlertSettings(undefined)).toEqual(ALERT_DEFAULTS);
    expect(mergeAlertSettings(null)).toEqual(ALERT_DEFAULTS);
    expect(mergeAlertSettings('nuke')).toEqual(ALERT_DEFAULTS);
    expect(mergeAlertSettings([50, 10])).toEqual(ALERT_DEFAULTS);
  });

  it('merges a partial override over the defaults', () => {
    const merged = mergeAlertSettings({ nukeDropPct: 55 });
    expect(merged.nukeDropPct).toBe(55);
    expect(merged.nukeWindowMin).toBe(ALERT_DEFAULTS.nukeWindowMin);
    expect(merged.cooldownMin).toBe(ALERT_DEFAULTS.cooldownMin);
  });

  it('clamps out-of-range values instead of trusting them', () => {
    const merged = mergeAlertSettings({
      nukeDropPct: 200,
      nukeWindowMin: 1,
      buyRetracePct: 0,
      buyPeakWindowHours: 999,
      cooldownMin: 0,
    });
    expect(merged.nukeDropPct).toBe(95);
    expect(merged.nukeWindowMin).toBe(5);
    expect(merged.buyRetracePct).toBe(5);
    expect(merged.buyPeakWindowHours).toBe(48);
    expect(merged.cooldownMin).toBe(1);
  });

  it('drops keys of the wrong type without losing the good ones', () => {
    const merged = mergeAlertSettings({ nukeDropPct: '60', nukeWindowMin: 30, junk: true });
    expect(merged.nukeDropPct).toBe(ALERT_DEFAULTS.nukeDropPct);
    expect(merged.nukeWindowMin).toBe(30);
  });

  it('falls back to the default for a non-finite value', () => {
    expect(clampAlertSetting('nukeDropPct', Number.NaN)).toBe(ALERT_DEFAULTS.nukeDropPct);
    expect(mergeAlertSettings({ nukeDropPct: Number.POSITIVE_INFINITY }).nukeDropPct).toBe(
      ALERT_DEFAULTS.nukeDropPct,
    );
  });

  it('reads the alerts key out of a whole group settings blob', () => {
    expect(alertSettingsOf({ alerts: { nukeDropPct: 60 }, other: 'kept' }).nukeDropPct).toBe(60);
    expect(alertSettingsOf({})).toEqual(ALERT_DEFAULTS);
    expect(alertSettingsOf(undefined)).toEqual(ALERT_DEFAULTS);
    expect(alertSettingsOf({ alerts: 'nope' })).toEqual(ALERT_DEFAULTS);
  });
});

describe('alertMessage', () => {
  it('formats a nuke', () => {
    expect(
      alertMessage('nuke', {
        label: 'SYM',
        dropPct: 47.1,
        fromMcapUsd: 210_000,
        currentMcapUsd: 111_000,
        peakAtMs: NOW - 14 * MINUTE,
        nowMs: NOW,
        liquidityUsd: 45_000,
      }),
    ).toBe('🚨 NUKE: SYM -47% in 14m · $210K → $111K · LP $45K');
  });

  it('drops the LP segment when liquidity is unknown', () => {
    expect(
      alertMessage('nuke', {
        label: 'SYM',
        dropPct: 47.1,
        fromMcapUsd: 210_000,
        currentMcapUsd: 111_000,
        peakAtMs: NOW - 14 * MINUTE,
        nowMs: NOW,
        liquidityUsd: null,
      }),
    ).toBe('🚨 NUKE: SYM -47% in 14m · $210K → $111K');
  });

  /**
   * Round 19: the baseline is the watch, so the sentence names both ends of the
   * move and nothing else — no window, no peak, and no advice.
   */
  it('formats a buy opportunity from the watch baseline', () => {
    expect(
      alertMessage('buy_opp', {
        label: 'SYM',
        dropPct: 31.67,
        fromMcapUsd: 120_000,
        currentMcapUsd: 82_000,
        nowMs: NOW,
        liquidityUsd: 45_000,
      }),
    ).toBe('🟢 BUY OPP: SYM -32% since watched ($120K → $82K) · LP $45K');
  });

  it('drops the LP segment from a buy opportunity too', () => {
    expect(
      alertMessage('buy_opp', {
        label: 'SYM',
        dropPct: 31.67,
        fromMcapUsd: 120_000,
        currentMcapUsd: 82_000,
        nowMs: NOW,
        liquidityUsd: null,
      }),
    ).toBe('🟢 BUY OPP: SYM -32% since watched ($120K → $82K)');
  });

  it('never mentions a peak, a window, or what to do about it', () => {
    const message = alertMessage('buy_opp', {
      label: 'SYM',
      dropPct: 40,
      fromMcapUsd: 120_000,
      currentMcapUsd: 72_000,
      nowMs: NOW,
    });
    for (const word of ['high', 'peak', 'buy the', 'dip', 'ago']) {
      expect(message.toLowerCase()).not.toContain(word);
    }
  });

  it('starts with exactly one emoji and carries no markdown', () => {
    const nuke = alertMessage('nuke', {
      label: '*_weird_*',
      dropPct: 50,
      fromMcapUsd: 1_000_000,
      currentMcapUsd: 500_000,
      peakAtMs: NOW - MINUTE,
      nowMs: NOW,
    });
    expect(nuke.startsWith('🚨 ')).toBe(true);
    expect(nuke).toContain('*_weird_*');
    expect(nuke).toContain('$1M → $500K');
    const buy = alertMessage('buy_opp', {
      label: '*_weird_*',
      dropPct: 50,
      fromMcapUsd: 1_000_000,
      currentMcapUsd: 500_000,
      nowMs: NOW,
    });
    expect(buy.startsWith('🟢 ')).toBe(true);
    expect(buy).toContain('*_weird_*');
  });

  it('never claims a sub-minute crash', () => {
    const message = alertMessage('nuke', {
      label: 'SYM',
      dropPct: 40,
      fromMcapUsd: 100_000,
      currentMcapUsd: 60_000,
      peakAtMs: NOW - 10_000,
      nowMs: NOW,
    });
    expect(message).toContain('in 1m');
  });
});

describe('formatting helpers', () => {
  it('formats compact USD like the board does', () => {
    expect(fmtUsd(210_000)).toBe('$210K');
    expect(fmtUsd(1_240_000)).toBe('$1.2M');
    expect(fmtUsd(999_600)).toBe('$1M');
    expect(fmtUsd(820)).toBe('$820');
    expect(fmtUsd(null)).toBe('—');
  });

  it('names a token by symbol, falling back to a short address', () => {
    const address = `0x${'ab'.repeat(20)}`;
    expect(tokenLabel('PONS', address)).toBe('PONS');
    expect(tokenLabel(null, address)).toBe('0xabab…abab');
    expect(tokenLabel('   ', address)).toBe('0xabab…abab');
  });
});
