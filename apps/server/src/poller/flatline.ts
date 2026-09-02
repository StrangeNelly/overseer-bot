import { DEATH } from '@groupie/shared';

/**
 * Round 21's flatline rule, as a pure function (docs/decisions.md round 21).
 *
 * The gap it closes: every death rule before it watched LIQUIDITY, and $VLR
 * proved a coin can be finished with its pool intact — 0.4x, $106K -> $46K on
 * $19K of liquidity, held up by residual holders too small to bother selling.
 * What that coin has lost is not its pool, it is its TAPE: nothing trades.
 *
 * So the condition is three readings at once — far off the peak, no volume, no
 * trades — and the death is not the condition, it is the condition holding for
 * `DEATH.flatlineHours` without a break. scheduler.ts owns the clock
 * (`tokens.flat_since`); this file only ever judges one reading.
 */

/** The evidence one poll produced, exactly as the market source handed it over. */
export interface FlatlineInput {
  /** This poll's market cap. */
  mcapUsd: number | null;
  /** The highest peak-since-call across the token's ACTIVE calls. */
  peakMcapSinceCall: number | null;
  /** 24h volume from this poll's reading. */
  vol24Usd: number | null;
  /** 24h trade count from this poll's reading. */
  txns24: number | null;
}

/**
 * - `holds`  — every clause is satisfied by this reading; the clock runs.
 * - `fails`  — a clause is measurably NOT satisfied; the clock resets.
 * - `unknown` — a clause could not be measured at all; the clock resets too.
 *
 * `unknown` and `fails` do the same thing to the clock on purpose, and are
 * still separated: "nothing traded" and "we were not told what traded" are
 * different facts, and the day this rule is tuned that difference is the first
 * thing anyone will want out of the logs. UNKNOWN DATA IS NEVER A VERDICT.
 */
export type FlatlineVerdict = 'holds' | 'fails' | 'unknown';

/**
 * How far below its peak-since-call this reading sits, 0-100 — or null when
 * either side is missing or the peak is not a usable baseline.
 *
 * Clamped like the board's own retrace figure: a reading ABOVE the peak (the
 * peak update and this judgement are two statements) is 0% off it, never a
 * negative retrace.
 */
export function retracePctFromPeak(
  mcapUsd: number | null,
  peakMcapSinceCall: number | null,
): number | null {
  if (mcapUsd === null || !Number.isFinite(mcapUsd) || mcapUsd < 0) return null;
  if (peakMcapSinceCall === null || !Number.isFinite(peakMcapSinceCall)) return null;
  if (peakMcapSinceCall <= 0) return null;
  return Math.min(100, Math.max(0, (1 - mcapUsd / peakMcapSinceCall) * 100));
}

/** A number the rule may be applied to at all. */
function measured(value: number | null): value is number {
  return value !== null && Number.isFinite(value);
}

/**
 * One reading's verdict. Every clause has to be measurable before any of them
 * can fail: a poll that could not read volume tells us nothing about whether
 * the coin is flat, however far off the peak it is.
 */
export function flatlineVerdict(input: FlatlineInput): FlatlineVerdict {
  const retracePct = retracePctFromPeak(input.mcapUsd, input.peakMcapSinceCall);
  // No peak means no call has ever tracked this coin (or none is active any
  // more): there is no "since the call" to be 85% below, so the rule does not
  // apply rather than applying vacuously.
  if (retracePct === null) return 'unknown';
  if (!measured(input.vol24Usd) || input.vol24Usd < 0) return 'unknown';
  // A tier whose reading carries no trade count cannot flatline anything.
  if (!measured(input.txns24) || input.txns24 < 0) return 'unknown';

  if (retracePct < DEATH.flatlineRetracePct) return 'fails';
  if (input.vol24Usd >= DEATH.flatlineVolumeUsd) return 'fails';
  if (input.txns24 > DEATH.flatlineTxns24) return 'fails';
  return 'holds';
}

/**
 * Has a running flatline clock reached the death? The clock is only ever
 * started by a `holds` reading, so this is simply "how long has it held".
 *
 * An undatable stamp answers false: a clock we cannot read is not six hours
 * old, and the next `holds` reading re-stamps it.
 */
export function flatlineElapsed(flatSince: Date | null, nowMs: number): boolean {
  const since = flatSince?.getTime();
  if (since === undefined || !Number.isFinite(since)) return false;
  return nowMs - since >= DEATH.flatlineHours * 3_600_000;
}

/**
 * The state of one token's flatline run, as the poll that just extended it left
 * it: `flat_since`/`flat_readings` are this poll's own RETURNING (so a
 * concurrent poller cannot make either drift), and `previousReadingAt` is
 * `flat_last_at` as it stood BEFORE this poll stamped it — the run's previous
 * holding reading, which is the only thing that can show a hole in the run.
 */
export interface FlatlineClock {
  flatSince: Date | null;
  /** Holding readings inside the current run, this one included. */
  readings: number | null;
  previousReadingAt: Date | null;
}

/**
 * The whole death test (docs/decisions.md round 21 + amendment a): six unbroken
 * hours, at least `DEATH.flatlineMinReadings` polls that actually held the
 * condition, and no hole wider than `DEATH.flatlineMaxGapMinutes` before this
 * reading.
 *
 * The coverage half exists because elapsed time is not evidence of silence when
 * nothing was watching: a process that was down for six hours would otherwise
 * come back and kill every coin that was quiet when it stopped.
 */
export function flatlineDeathDue(clock: FlatlineClock, nowMs: number): boolean {
  if (!flatlineElapsed(clock.flatSince, nowMs)) return false;
  const readings = clock.readings;
  if (readings === null || !Number.isFinite(readings)) return false;
  if (readings < DEATH.flatlineMinReadings) return false;
  const previous = clock.previousReadingAt?.getTime();
  // A run with no previous reading is this reading, and one reading is not six
  // hours of anything.
  if (previous === undefined || !Number.isFinite(previous)) return false;
  return nowMs - previous <= DEATH.flatlineMaxGapMinutes * 60_000;
}

/**
 * Round 21's extra revival bar for a FLATLINE corpse: mcap alone would revive
 * it on the poll right after it died, because the mcap is exactly what the rule
 * left standing. Volume has to come back too, and unknown volume is not a
 * comeback.
 *
 * The mcap half stays where it has always been (death.ts's isRevived, round
 * 13's single bar); this is the additional clause that hangs off it.
 */
export function flatlineVolumeRecovered(vol24Usd: number | null): boolean {
  return measured(vol24Usd) && vol24Usd >= DEATH.flatlineRevivalVolumeUsd;
}
