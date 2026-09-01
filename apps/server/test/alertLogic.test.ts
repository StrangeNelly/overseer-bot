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
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 8, 2, 12, 0, 0);

const SETTINGS: AlertSettings = { ...ALERT_DEFAULTS };

/** Snapshots from `[minutesAgo, mcap]` pairs, oldest first (the loader's order). */
function snaps(...pairs: Array<[number, number]>): AlertSnapshot[] {
  return pairs
    .map(([minutesAgo, mcapUsd]) => ({ atMs: NOW - minutesAgo * MINUTE, mcapUsd }))
    .sort((a, b) => a.atMs - b.atMs);
}

function evaluate(
  currentMcapUsd: number | null,
  recentSnapshots: AlertSnapshot[],
  settings: AlertSettings = SETTINGS,
) {
  return evaluateAlerts({ nowMs: NOW, currentMcapUsd, recentSnapshots, settings });
}

/** Three readings at 200K inside the 15-minute nuke window. */
const NUKE_WINDOW_AT_200K = snaps([14, 200_000], [10, 200_000], [5, 200_000]);

describe('evaluateAlerts — nuke', () => {
  it('fires at exactly the threshold (40% below the window peak)', () => {
    const result = evaluate(120_000, NUKE_WINDOW_AT_200K);
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe('nuke');
    expect(result[0]?.dropPct).toBeCloseTo(40, 10);
    expect(result[0]?.peakMcapUsd).toBe(200_000);
    // Ties keep the LATEST visit to the peak: the drop started there.
    expect(result[0]?.peakAtMs).toBe(NOW - 5 * MINUTE);
  });

  it('does not fire one dollar short of the threshold', () => {
    expect(evaluate(120_001, NUKE_WINDOW_AT_200K)).toEqual([]);
  });

  it('ignores a peak older than the nuke window', () => {
    // 200K three hours ago, flat at 120K ever since: a 40% fall, but not fast.
    const series = snaps([180, 200_000], [14, 120_000], [10, 120_000], [5, 120_000]);
    const result = evaluate(120_000, series);
    expect(result.map((a) => a.type)).toEqual(['buy_opp']);
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

describe('evaluateAlerts — buy opportunity', () => {
  /** 24h high of 144K six hours ago, drifting down since. */
  const SLOW_BLEED = snaps(
    [23 * 60, 120_000],
    [6 * 60, 144_000],
    [3 * 60, 120_000],
    [60, 100_000],
    [10, 96_000],
    [5, 95_000],
  );

  it('fires on a 30%+ retrace from a peak that is hours old', () => {
    const result = evaluate(95_000, SLOW_BLEED);
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe('buy_opp');
    expect(result[0]?.peakMcapUsd).toBe(144_000);
    expect(result[0]?.peakAtMs).toBe(NOW - 6 * HOUR);
    expect(result[0]?.dropPct).toBeCloseTo(34.03, 2);
  });

  it('does not fire on a shallower retrace', () => {
    expect(evaluate(110_000, SLOW_BLEED)).toEqual([]);
  });

  it('does not fire while the peak is younger than the minimum decline', () => {
    // Same 34% retrace, but the peak is 20 minutes old: too fast to be a setup,
    // and too shallow (in its own window) to be a nuke.
    const series = snaps([20, 144_000], [15, 140_000], [10, 120_000], [5, 100_000]);
    expect(evaluate(95_000, series)).toEqual([]);
  });

  it('is suppressed while the nuke condition holds', () => {
    // Qualifies on both counts: 55% off a 5h-old peak AND 50% off the last 15m.
    const series = snaps(
      [5 * 60, 220_000],
      [14, 200_000],
      [10, 200_000],
      [5, 200_000],
    );
    const result = evaluate(100_000, series);
    expect(result.map((a) => a.type)).toEqual(['nuke']);
  });

  it('stays suppressed when thin data blocks the nuke alert itself', () => {
    // A crash in progress is never a buy signal, even when we cannot prove the
    // crash well enough to alert on it.
    const series = snaps([5 * 60, 220_000], [14, 200_000], [5, 200_000]);
    expect(evaluate(100_000, series)).toEqual([]);
  });

  it('reports the LATEST visit to a repeated peak as the decline start', () => {
    const series = snaps([20 * 60, 144_000], [6 * 60, 144_000], [60, 100_000]);
    expect(evaluate(95_000, series)[0]?.peakAtMs).toBe(NOW - 6 * HOUR);
  });
});

describe('evaluateAlerts — insufficient data', () => {
  it('returns nothing without a current market cap', () => {
    expect(evaluate(null, NUKE_WINDOW_AT_200K)).toEqual([]);
  });

  it('treats a zero or negative market cap as a bad reading, not a collapse', () => {
    expect(evaluate(0, NUKE_WINDOW_AT_200K)).toEqual([]);
    expect(evaluate(-5, NUKE_WINDOW_AT_200K)).toEqual([]);
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

  it('ignores snapshots older than the peak window', () => {
    expect(evaluate(95_000, snaps([30 * 60, 200_000]))).toEqual([]);
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
        peakMcapUsd: 210_000,
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
        peakMcapUsd: 210_000,
        currentMcapUsd: 111_000,
        peakAtMs: NOW - 14 * MINUTE,
        nowMs: NOW,
        liquidityUsd: null,
      }),
    ).toBe('🚨 NUKE: SYM -47% in 14m · $210K → $111K');
  });

  it('formats a buy opportunity', () => {
    expect(
      alertMessage('buy_opp', {
        label: 'SYM',
        dropPct: 34.03,
        peakMcapUsd: 144_000,
        currentMcapUsd: 95_000,
        peakAtMs: NOW - 6 * HOUR,
        nowMs: NOW,
        peakWindowHours: 24,
      }),
    ).toBe('🟢 BUY OPP: SYM -34% from 24h high $144K (peaked 6h ago) · now $95K');
  });

  it('starts with exactly one emoji and carries no markdown', () => {
    const nuke = alertMessage('nuke', {
      label: '*_weird_*',
      dropPct: 50,
      peakMcapUsd: 1_000_000,
      currentMcapUsd: 500_000,
      peakAtMs: NOW - MINUTE,
      nowMs: NOW,
    });
    expect(nuke.startsWith('🚨 ')).toBe(true);
    expect(nuke).toContain('*_weird_*');
    expect(nuke).toContain('$1M → $500K');
  });

  it('never claims a sub-minute crash', () => {
    const message = alertMessage('nuke', {
      label: 'SYM',
      dropPct: 40,
      peakMcapUsd: 100_000,
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
