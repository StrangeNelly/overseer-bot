import { RANGE_PRESETS, SLEEPERS, requiredVolumeUsd } from '@groupie/shared';

/**
 * Pure selection logic for the Sleepers chain-wide scan (docs/decisions.md
 * round 9). Everything here is a function of the pool listing and the clock —
 * no network, no database — so the rules that decide what the group sees are
 * testable on their own (apps/server/test/sleeperLogic.test.ts).
 *
 * The pipeline, in order:
 *   dedupe to one pool per TOKEN -> floors -> band bucket -> turnover rank.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** One candidate pool, straight off the GeckoTerminal listing. */
export interface PoolCandidate {
  /** Base token address, lowercase. */
  address: string;
  poolAddress: string;
  poolName: string | null;
  mcapUsd: number | null;
  liquidityUsd: number | null;
  vol24Usd: number | null;
  txns24: number | null;
  poolCreatedAt: Date | null;
}

export interface Band {
  loUsd: number;
  hiUsd: number;
}

/** A candidate that cleared every floor, with the derived figures attached. */
export interface QualifiedSleeper extends PoolCandidate {
  mcapUsd: number;
  liquidityUsd: number;
  vol24Usd: number;
  txns24: number;
  poolCreatedAt: Date;
  band: Band;
  /** vol24 / mcap. */
  turnover: number;
}

/** A qualified candidate that made its band's top slice, with its position. */
export interface SleeperPick extends QualifiedSleeper {
  /** 1-based within the band. */
  rank: number;
}

/**
 * The band a market cap belongs to, or null when it sits outside all of them.
 *
 * The RANGE_PRESETS bands share endpoints ($100K is both a high and a low), so
 * bucketing has to pick a side or an entry could land twice: each band is
 * half-open `[lo, hi)`, and only the last one closes at its high so a coin at
 * exactly $1M is still a sleeper rather than falling off the top.
 */
export function bandFor(mcapUsd: number): Band | null {
  if (!Number.isFinite(mcapUsd)) return null;
  for (let i = 0; i < RANGE_PRESETS.length; i++) {
    const preset = RANGE_PRESETS[i];
    if (!preset) continue;
    const last = i === RANGE_PRESETS.length - 1;
    const inBand = mcapUsd >= preset.loUsd && (last ? mcapUsd <= preset.hiUsd : mcapUsd < preset.hiUsd);
    if (inBand) return { loUsd: preset.loUsd, hiUsd: preset.hiUsd };
  }
  return null;
}

/**
 * One entry per TOKEN, keeping its highest-volume pool. A token routinely has
 * several pools in the listing (a curve pool plus its graduated one, or two fee
 * tiers); they would otherwise compete against each other for band slots and
 * the same coin could fill the whole band.
 *
 * A null volume loses to any real number and ties keep the earlier pool, which
 * is the higher-volume one given the listing's own sort.
 */
export function dedupeByToken(candidates: readonly PoolCandidate[]): PoolCandidate[] {
  const best = new Map<string, PoolCandidate>();
  for (const candidate of candidates) {
    const existing = best.get(candidate.address);
    if (!existing) {
      best.set(candidate.address, candidate);
      continue;
    }
    if ((candidate.vol24Usd ?? -1) > (existing.vol24Usd ?? -1)) best.set(candidate.address, candidate);
  }
  return [...best.values()];
}

/**
 * Every floor from round 9, applied to one candidate. Returns the qualified
 * entry (band and turnover already computed) or null.
 *
 * A missing value NEVER passes: an unknown liquidity is not proof of a deep
 * pool, and an unknown age is not proof of a mature one.
 */
export function qualify(candidate: PoolCandidate, nowMs: number): QualifiedSleeper | null {
  const { mcapUsd, liquidityUsd, vol24Usd, txns24, poolCreatedAt } = candidate;
  if (mcapUsd === null || !Number.isFinite(mcapUsd) || mcapUsd <= 0) return null;
  if (liquidityUsd === null || !Number.isFinite(liquidityUsd)) return null;
  if (vol24Usd === null || !Number.isFinite(vol24Usd)) return null;
  if (txns24 === null || !Number.isFinite(txns24)) return null;
  if (poolCreatedAt === null) return null;

  // GeckoTerminal reports a NEGATIVE reserve_in_usd for some pools (seen live
  // 2026-09-02 on a launchpad pool); the floor comparison rejects those too,
  // which is the right answer — a reserve we cannot read is not $10K of depth.
  if (liquidityUsd < SLEEPERS.minLiquidityUsd) return null;
  if (txns24 < SLEEPERS.minTxns24) return null;

  // Age window, inclusive at both ends: exactly 1h old qualifies, and so does
  // exactly 10 days. A pool with a future timestamp is a bad reading, not a
  // brand-new coin, and its negative age fails the minimum.
  const ageMs = nowMs - poolCreatedAt.getTime();
  if (!Number.isFinite(ageMs)) return null;
  if (ageMs < SLEEPERS.minPoolAgeHours * HOUR_MS) return null;
  if (ageMs > SLEEPERS.maxPoolAgeDays * DAY_MS) return null;

  if (vol24Usd < requiredVolumeUsd(mcapUsd)) return null;

  const band = bandFor(mcapUsd);
  if (band === null) return null;

  return {
    ...candidate,
    mcapUsd,
    liquidityUsd,
    vol24Usd,
    txns24,
    poolCreatedAt,
    band,
    turnover: vol24Usd / mcapUsd,
  };
}

/** Band key for grouping — the bands are fixed, so lo alone identifies one. */
function bandKey(band: Band): number {
  return band.loUsd;
}

/**
 * The whole selection, end to end: the picks the scan should persist, sorted
 * by band ascending then rank ascending — the order the API serves them in.
 *
 * `keepPerBand` is deliberately larger than what the API serves: the read-side
 * "X only" filter and the per-group call exclusion both cut entries, and a band
 * with only three kept would run dry the moment either applied.
 */
export function selectSleepers(
  candidates: readonly PoolCandidate[],
  nowMs: number,
  keepPerBand: number = SLEEPERS.keepPerBand,
): SleeperPick[] {
  const byBand = new Map<number, QualifiedSleeper[]>();
  for (const candidate of dedupeByToken(candidates)) {
    const qualified = qualify(candidate, nowMs);
    if (!qualified) continue;
    const key = bandKey(qualified.band);
    const list = byBand.get(key) ?? [];
    list.push(qualified);
    byBand.set(key, list);
  }

  const out: SleeperPick[] = [];
  for (const preset of RANGE_PRESETS) {
    const list = byBand.get(preset.loUsd);
    if (!list) continue;
    list.sort((a, b) => b.turnover - a.turnover);
    list.slice(0, keepPerBand).forEach((entry, index) => out.push({ ...entry, rank: index + 1 }));
  }
  return out;
}
