import { SLEEPER_BANDS, SLEEPERS, isTokenizedStock, requiredVolumeUsd } from '@groupie/shared';

/**
 * Pure selection logic for the Sleepers chain-wide scan (docs/decisions.md
 * rounds 9 and 14). Everything here is a function of the pool listing, the
 * candles and the clock — no network, no database — so the rules that decide
 * what the group sees are testable on their own
 * (apps/server/test/sleeperLogic.test.ts).
 *
 * The pipeline, in order:
 *   dedupe to one pool per TOKEN -> floors -> band bucket -> turnover rank
 *   -> (round 14, in sleeperScan) time-in-band per kept entry.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const HOUR_SEC = 3_600;
const DAY_SEC = 24 * HOUR_SEC;

/** One candidate pool, straight off the GeckoTerminal listing. */
export interface PoolCandidate {
  /** Base token address, lowercase. */
  address: string;
  poolAddress: string;
  poolName: string | null;
  mcapUsd: number | null;
  /** Base token price in USD; only the supply inference reads it. */
  priceUsd: number | null;
  liquidityUsd: number | null;
  vol24Usd: number | null;
  txns24: number | null;
  /** Trades in the last hour; null when the listing carried no h1 block. */
  txns1h: number | null;
  poolCreatedAt: Date | null;
  /**
   * The BASE TOKEN's name, e.g. "Invesco QQQ • Robinhood Token" — what the
   * tokenized-stock rule reads (docs/decisions.md round 17). The pool listing
   * carries only the pool's name ("QQQ / WETH 1%"), which is built from
   * symbols, so the scan attaches this from its DexScreener enrichment before
   * selecting. Undefined and null both mean "not known", which
   * isTokenizedStock answers with false.
   */
  tokenName?: string | null;
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
  /**
   * A tokenized stock, ETF or leveraged equity product (round 17). Kept and
   * stored like any other entry — the read side decides whether to show it —
   * but it competes for band slots only against other stocks.
   */
  isStock: boolean;
}

/** A qualified candidate that made its band's top slice, with its position. */
export interface SleeperPick extends QualifiedSleeper {
  /** 1-based within the band. */
  rank: number;
}

/**
 * The band a market cap belongs to, or null when it sits outside all of them.
 *
 * The SLEEPER_BANDS share endpoints ($1M is both a high and a low), so
 * bucketing has to pick a side or an entry could land twice: each band is
 * half-open `[lo, hi)`, and only the last one closes at its high so a coin at
 * exactly the ladder's top (the last band's hiUsd) is still a sleeper rather
 * than falling off it.
 */
export function bandFor(mcapUsd: number): Band | null {
  if (!Number.isFinite(mcapUsd)) return null;
  for (let i = 0; i < SLEEPER_BANDS.length; i++) {
    const preset = SLEEPER_BANDS[i];
    if (!preset) continue;
    const last = i === SLEEPER_BANDS.length - 1;
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

  // ...and the same floor relative to size (round 14, the FORESKIN case): an
  // unlocked pool that was pulled mid-cycle still shows $10K+ of crumbs against
  // a market cap nobody has repriced yet. Below 2% there is no market here,
  // whatever the absolute number says. Inclusive: exactly 2% is a pass.
  if (liquidityUsd < mcapUsd * SLEEPERS.liqToMcapMinRatio) return null;

  if (txns24 < SLEEPERS.minTxns24) return null;

  // Age window, inclusive at both ends: exactly 1h old qualifies. The scan's
  // ceiling is inBandMaxDays, not maxPoolAgeDays — a coin with a month in band
  // is by definition older than 10 days, so the long-duration chips (round 14)
  // need older pools admitted here. Round 9's 10-day ceiling still holds for
  // every short-duration view; the API enforces it at serve time. A pool with
  // a future timestamp is a bad reading, not a brand-new coin, and its
  // negative age fails the minimum.
  const ageMs = nowMs - poolCreatedAt.getTime();
  if (!Number.isFinite(ageMs)) return null;
  if (ageMs < SLEEPERS.minPoolAgeHours * HOUR_MS) return null;
  if (ageMs > SLEEPERS.inBandMaxDays * DAY_MS) return null;

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
    isStock: isTokenizedStock(candidate.tokenName ?? null, candidate.address),
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
 *
 * Round 17: that cut is applied to stocks and non-stocks SEPARATELY, so each
 * kind gets its own `keepPerBand`. Tokenized equities sit in the upper bands by
 * the dozen and would otherwise take every slot — the toggle could then only
 * hide them, never reveal the coins underneath. Ranking is still over the whole
 * band, so `rank` stays a single ascending order whichever kinds are served.
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
  for (const preset of SLEEPER_BANDS) {
    const list = byBand.get(preset.loUsd);
    if (!list) continue;
    list.sort((a, b) => b.turnover - a.turnover);
    let coins = 0;
    let stocks = 0;
    const kept: QualifiedSleeper[] = [];
    for (const entry of list) {
      const taken = entry.isStock ? stocks : coins;
      if (taken >= keepPerBand) continue;
      if (entry.isStock) stocks++;
      else coins++;
      kept.push(entry);
    }
    kept.forEach((entry, index) => out.push({ ...entry, rank: index + 1 }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Time in band (docs/decisions.md round 14)
// ---------------------------------------------------------------------------

/** One candle, as GeckoTerminal reports it: `tsSec` is the candle's START. */
export interface Candle {
  tsSec: number;
  close: number;
}

export interface ResidencyInput {
  band: Band;
  /** Market cap at scan time, from the listing row. */
  entryMcapUsd: number;
  /** Base token price at scan time, from the SAME listing row. */
  entryPriceUsd: number | null;
  /** Hourly candles, newest first. */
  hourly: readonly Candle[];
  /**
   * Daily candles, newest first. Only consulted when every hourly candle was
   * in band — otherwise the streak already ended inside the hourly window.
   */
  daily?: readonly Candle[];
  nowMs: number;
}

export interface BandResidency {
  /** Continuous hours in band ending now, capped at SLEEPERS.inBandMaxDays. */
  hours: number;
  /**
   * True when the walk consumed the WHOLE hourly window without leaving the
   * band — the caller's signal that fetching daily candles could extend it.
   */
  hourlyExhausted: boolean;
}

/**
 * Circulating supply, inferred from one (mcap, price) pair.
 *
 * The whole measurement rests on this: a token's market cap is
 * `price x supply`, and supply does not move on the timescales we look at, so
 * mcap and price are PROPORTIONAL. That lets a pool's candle closes — which are
 * prices — be read as market caps through a single ratio taken from the listing
 * row we already trust for today's mcap.
 *
 * What the inference cannot see: a real supply change (a burn, a mint, an
 * unlock) inside the window would tilt older candles' implied mcaps. On this
 * chain's fair-launch tokens supply is fixed at launch, which is why the
 * approximation is safe here and would not be on, say, a rebasing token.
 *
 * Returns null when the pair cannot produce a usable supply.
 */
export function inferSupply(entryMcapUsd: number, entryPriceUsd: number | null): number | null {
  if (!Number.isFinite(entryMcapUsd) || entryMcapUsd <= 0) return null;
  if (entryPriceUsd === null || !Number.isFinite(entryPriceUsd) || entryPriceUsd <= 0) return null;
  const supply = entryMcapUsd / entryPriceUsd;
  return Number.isFinite(supply) && supply > 0 ? supply : null;
}

/** Inclusive on both edges: a band's own boundary is part of the band. */
function closeInBand(close: number, supply: number, band: Band): boolean {
  const mcap = close * supply;
  return Number.isFinite(mcap) && mcap >= band.loUsd && mcap <= band.hiUsd;
}

/** Newest first, defensively — never trust the upstream sort. */
function newestFirst(candles: readonly Candle[]): Candle[] {
  return [...candles]
    .filter((c) => Number.isFinite(c.tsSec) && Number.isFinite(c.close))
    .sort((a, b) => b.tsSec - a.tsSec);
}

/**
 * How long the coin has sat in `band`, continuously, up to right now.
 *
 * Walks BACK from the newest candle: each close is converted to a market cap
 * through the inferred supply, and the first one outside [lo, hi] ends the
 * streak. Residency is then measured from the START of the oldest unbroken
 * candle to now — a span, not a candle count, because GeckoTerminal omits
 * periods with no trades and a quiet hour is residency too (nothing traded, so
 * nothing left the band).
 *
 * Three ways to get 0, all deliberate:
 *   - no candles at all;
 *   - the newest candle is older than SLEEPERS.inBandMaxCandleAgeHours — a
 *     residency claim is about NOW, and stale candles cannot support one;
 *   - the newest candle is already out of band (the coin has left).
 */
export function computeResidency(input: ResidencyInput): BandResidency {
  const none: BandResidency = { hours: 0, hourlyExhausted: false };
  const hourly = newestFirst(input.hourly);
  const newest = hourly[0];
  if (!newest) return none;

  const nowSec = Math.floor(input.nowMs / 1000);
  const ageSec = nowSec - newest.tsSec;
  // Future-stamped candles are a bad reading, not fresh data. One hour of slack
  // absorbs the in-progress candle and clock skew.
  if (ageSec < -HOUR_SEC) return none;
  if (ageSec > SLEEPERS.inBandMaxCandleAgeHours * HOUR_SEC) return none;

  // Falling back to the newest close keeps the measurement possible when the
  // listing had no price: the ratio is then anchored on that candle, which
  // makes the newest implied mcap exactly the listing's mcap — the same anchor,
  // reached the other way round.
  const supply = inferSupply(input.entryMcapUsd, input.entryPriceUsd ?? newest.close);
  if (supply === null) return none;

  let streakStartSec: number | null = null;
  let hourlyExhausted = true;
  for (const candle of hourly) {
    if (!closeInBand(candle.close, supply, input.band)) {
      hourlyExhausted = false;
      break;
    }
    streakStartSec = candle.tsSec;
  }
  if (streakStartSec === null) return none;

  // The hourly window (100 candles ≈ 4 days) ran out while still in band, so
  // the streak is at least that long and the daily candles say how much longer.
  // Only candles STARTING before the hourly streak are consulted; the ones
  // overlapping it are the same hours, at a coarser resolution.
  if (hourlyExhausted) {
    for (const candle of newestFirst(input.daily ?? [])) {
      if (candle.tsSec >= streakStartSec) continue;
      if (!closeInBand(candle.close, supply, input.band)) break;
      streakStartSec = candle.tsSec;
    }
  }

  const capSec = SLEEPERS.inBandMaxDays * DAY_SEC;
  const spanSec = Math.min(Math.max(0, nowSec - streakStartSec), capSec);
  return { hours: spanSec / HOUR_SEC, hourlyExhausted };
}

// ---------------------------------------------------------------------------
// Short holds (docs/decisions.md round 17)
// ---------------------------------------------------------------------------

export interface ShortResidencyInput {
  band: Band;
  /** Market cap at scan time, from the listing row. */
  entryMcapUsd: number;
  /** Base token price at scan time, from the SAME listing row. */
  entryPriceUsd: number | null;
  /** 15-minute candles, newest first. */
  minutes: readonly Candle[];
  nowMs: number;
}

const SHORT_CANDLE_SEC = SLEEPERS.shortCandleMinutes * 60;
const SHORT_CANDLE_HOURS = SLEEPERS.shortCandleMinutes / 60;

/**
 * Residency for the 30m and 1h chips: consecutive in-band 15-minute closes
 * ending at the newest candle, counted as `count x 0.25` hours — so 30m is two
 * closes and 1h is four.
 *
 * Deliberately a COUNT, not the span computeResidency measures. At the hourly
 * timescale a gap in the series is a quiet hour that still counts as residency;
 * at fifteen minutes a gap is just as likely to be a pool nobody has traded in
 * since the reading that put it in the band, and crediting it would let a
 * silent coin claim exactly the sub-hour figure this chip exists to certify.
 * Counting closes only credits quarter-hours we can actually see in band.
 *
 * The two answers are different claims, and the caller acts on each one
 * differently (see measureResidency):
 *   - null is NO READING — nothing to say. No candles, none of them readable,
 *     a future-stamped newest candle (a bad clock is not evidence), or a
 *     (mcap, price) pair that cannot produce a supply.
 *   - 0 is a READING that establishes nothing: the newest candle's START is
 *     more than SLEEPERS.shortMaxCandleAgeMinutes old (its data ends up to one
 *     candle later still, which is the honest resolution of this timeframe),
 *     or the newest close is already out of band.
 *
 * The figure is capped one candle BELOW SLEEPERS.shortHoldMaxHours: this call
 * is only ever made after the hourly walk declined to establish that many
 * hours, and the newest 15-minute bucket is in progress, so a full count is
 * ~14 minutes short of the window it would otherwise claim.
 */
export function computeShortResidency(input: ShortResidencyInput): number | null {
  const minutes = newestFirst(input.minutes);
  const newest = minutes[0];
  if (!newest) return null;

  const nowSec = Math.floor(input.nowMs / 1000);
  const ageSec = nowSec - newest.tsSec;
  // One candle of slack for the in-progress bucket and clock skew; beyond that
  // a future stamp is a bad reading, not fresh data.
  if (ageSec < -SHORT_CANDLE_SEC) return null;
  if (ageSec > SLEEPERS.shortMaxCandleAgeMinutes * 60) return 0;

  const supply = inferSupply(input.entryMcapUsd, input.entryPriceUsd ?? newest.close);
  if (supply === null) return null;

  let count = 0;
  for (const candle of minutes) {
    if (!closeInBand(candle.close, supply, input.band)) break;
    count++;
  }
  return Math.min(count * SHORT_CANDLE_HOURS, SLEEPERS.shortHoldMaxHours - SHORT_CANDLE_HOURS);
}

// ---------------------------------------------------------------------------
// Carrying residency between scans (docs/decisions.md round 16b)
// ---------------------------------------------------------------------------

/** What the previous scan recorded for one address. */
export interface PrevResidency {
  band: Band;
  /** Hours in band as of that scan. */
  inBandHours: number;
  /** When that scan ran. */
  scanAtMs: number;
  /** When the figure was last measured off candles; null = never / unknown. */
  measuredAtMs: number | null;
}

/** Residency cap, in hours — the same ceiling computeResidency applies. */
const MAX_RESIDENCY_HOURS = SLEEPERS.inBandMaxDays * 24;

/**
 * Does this pick need the full OHLCV walk-back, or can the previous scan's
 * figure simply be carried forward?
 *
 * Carrying is only ever legitimate for an address that is STILL IN THE SAME
 * BAND with a residency the last scan actually measured: the coin has not left
 * as far as this scan can see, so the streak it was on has grown by the time
 * between the two scans. Everything else re-measures:
 *
 *   - no previous entry (new to the list) — there is nothing to extend;
 *   - a different band — the old streak ended, whatever else is true;
 *   - a previous figure of 0 — the last measurement failed or found the coin
 *     out of band, and 0 + elapsed would invent residency out of nothing;
 *   - zero trades in the last hour — the listing's own figures are trailing 24h
 *     ones, so a coin that has stopped trading stays on it and would keep
 *     accruing band time it is not earning. This is the candle-freshness rule
 *     computeResidency applies (inBandMaxCandleAgeHours), reached without a
 *     call. An UNKNOWN h1 count carries: absence of the block is not absence of
 *     trades;
 *   - a figure last measured over `residencyReverifyHours` ago, so a carried
 *     value can never drift indefinitely (see the constant for the bound);
 *   - a nonsense clock (stamps in the future) — never carry off bad arithmetic.
 */
export function needsFullMeasurement(
  prev: PrevResidency | undefined,
  pick: { band: Band; txns1h?: number | null },
  nowMs: number,
): boolean {
  if (!prev) return true;
  if (pick.txns1h === 0) return true;
  if (prev.band.loUsd !== pick.band.loUsd || prev.band.hiUsd !== pick.band.hiUsd) return true;
  if (!Number.isFinite(prev.inBandHours) || prev.inBandHours <= 0) return true;
  if (prev.measuredAtMs === null || !Number.isFinite(prev.measuredAtMs)) return true;
  if (!Number.isFinite(prev.scanAtMs) || prev.scanAtMs > nowMs) return true;
  const measuredAgeMs = nowMs - prev.measuredAtMs;
  if (measuredAgeMs < 0) return true;
  return measuredAgeMs >= SLEEPERS.residencyReverifyHours * HOUR_MS;
}

/**
 * The carried figure: last scan's hours plus the time since it ran, capped
 * exactly where a measured value would be.
 */
export function carriedResidencyHours(prev: PrevResidency, nowMs: number): number {
  const elapsedHours = Math.max(0, (nowMs - prev.scanAtMs) / HOUR_MS);
  return Math.min(prev.inBandHours + elapsedHours, MAX_RESIDENCY_HOURS);
}
