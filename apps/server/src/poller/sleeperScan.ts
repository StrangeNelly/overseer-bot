import { lt, sql } from 'drizzle-orm';
import { sleeperEntries, sleeperSeen, type Db } from '@groupie/db';
import { SLEEPERS, twitterUrlFrom, websiteUrlFrom } from '@groupie/shared';
import * as ds from '../market/dexscreener.js';
import * as gt from '../market/geckoterminal.js';
import {
  carriedResidencyHours,
  computeResidency,
  computeShortResidency,
  dedupeByToken,
  needsFullMeasurement,
  qualify,
  selectSleepers,
  type PoolCandidate,
  type PrevResidency,
  type SleeperPick,
} from './sleeperLogic.js';

/**
 * The Sleepers chain-wide scan (docs/decisions.md round 9).
 *
 * Every three hours: sweep ALL of Robinhood Chain by 24h volume, keep the coins
 * that are quietly trading hard for their size, enrich them with DexScreener
 * metadata, and replace the previous scan's rows.
 *
 * Deliberately NOT tracking: nothing here writes to `tokens`, nothing is
 * polled afterwards, and no chat message is ever sent. A sleeper becomes a
 * tracked token the moment a member posts it in the group.
 */

/** DexScreener's batch cap. */
const DS_BATCH = 30;

/**
 * Spacing between GeckoTerminal requests. The budgeter's window is 25/min with
 * no intra-window pacing, and firing ten pages back to back reliably drew a 429
 * in testing (verified live 2026-09-02) — this is a three-hourly job with
 * nothing waiting on it, so it can afford to be polite.
 */
const PAGE_GAP_MS = 1_500;

/**
 * Spacing for the round-14 OHLCV residency calls, deliberately slower than the
 * listing pages: up to ~60 of these run back to back, and at 1.5s they would
 * eat the whole 25/min budget for minutes at a stretch — queueing the fresh-
 * tier polls (and with them nuke-alert detection) behind a discovery job. At
 * 4s the scan holds itself to ~15/min, leaving the live board real headroom;
 * the scan finishing a few minutes later costs nothing at a 3h cadence.
 */
const OHLCV_GAP_MS = 4_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One page, with a single retry. A 429 parks the shared budgeter for 30
 * seconds, so the retry's own acquireSlot() waits that cooldown out before it
 * asks again — which is exactly the pause the retry needs.
 */
async function fetchPage(page: number): Promise<gt.GtPoolListing[]> {
  try {
    return await gt.getTopPools(page, 'scan');
  } catch (err) {
    console.warn(`sleeper scan: page ${page} failed, retrying once:`, err);
    return gt.getTopPools(page, 'scan');
  }
}

export interface SleeperScanResult {
  /** Pool rows read off GeckoTerminal, before the per-token dedupe. */
  scanned: number;
  /** Rows written for this scan. */
  kept: number;
  /** Pages actually fetched (fewer than maxPages if the listing ran out). */
  pages: number;
}

/** Every reachable page of the volume-sorted listing, stopping on an empty one. */
async function collect(): Promise<{ candidates: PoolCandidate[]; pages: number }> {
  const candidates: PoolCandidate[] = [];
  let pages = 0;
  for (let page = 1; page <= SLEEPERS.maxPages; page++) {
    if (page > 1) await sleep(PAGE_GAP_MS);
    const listings = await fetchPage(page);
    pages = page;
    // The listing ran out (or the free tier's page cap answered with nothing):
    // there is no deeper page to ask for.
    if (listings.length === 0) break;
    for (const pool of listings) {
      candidates.push({
        address: pool.baseTokenAddress,
        poolAddress: pool.poolAddress,
        poolName: pool.poolName,
        mcapUsd: pool.mcapUsd,
        priceUsd: pool.priceUsd,
        liquidityUsd: pool.liquidityUsd,
        vol24Usd: pool.vol24Usd,
        txns24: pool.txns24,
        txns1h: pool.txns1h,
        poolCreatedAt: pool.poolCreatedAt,
      });
    }
  }
  return { candidates, pages };
}

/**
 * The pool's own name is "SABLE / WETH 1%" — the base token's symbol is the
 * part before the separator. Only a fallback: DexScreener's symbol wins when it
 * knows the token.
 */
function symbolFromPoolName(poolName: string | null): string | null {
  if (!poolName) return null;
  const first = poolName.split('/')[0]?.trim();
  return first && first.length > 0 && first.length <= 24 ? first : null;
}

interface EnrichedPick extends SleeperPick {
  symbol: string | null;
  name: string | null;
  imageUrl: string | null;
  twitterUrl: string | null;
  websiteUrl: string | null;
}

/**
 * DexScreener batches over the given addresses: image, socials, and a proper
 * symbol/name. A token DexScreener does not index (curve-phase coins are
 * routinely absent) is simply missing from the map — an absence there says
 * nothing about the coin.
 *
 * Run BEFORE selection since round 17, because the token NAME is what decides
 * whether an entry is a tokenized stock and the stock/coin split has to happen
 * inside the keep cut. GeckoTerminal's pool listing carries only the pool's own
 * name ("QQQ / WETH 1%"), built from symbols, so it cannot answer that.
 */
async function fetchPairs(addresses: readonly string[]): Promise<Map<string, ds.DsPair>> {
  const pairs = new Map<string, ds.DsPair>();
  let unnamed = 0;
  for (let i = 0; i < addresses.length; i += DS_BATCH) {
    const batch = addresses.slice(i, i + DS_BATCH);
    try {
      for (const [address, pair] of await fetchPairsBatch(batch)) pairs.set(address, pair);
    } catch (err) {
      unnamed += batch.length;
      console.warn('sleeper scan: dexscreener enrichment failed for a batch:', err);
    }
  }
  // Not just missing metadata since round 17: an address with no name is an
  // address the tokenized-stock rule has to answer "coin" for, so a failed
  // batch quietly puts equities back in the coins' keep slots. Say so.
  if (unnamed > 0) {
    console.warn(
      `sleeper scan: ${unnamed}/${addresses.length} qualified addresses left unnamed — ` +
        'any tokenized stocks among them are kept and served as coins this scan',
    );
  }
  return pairs;
}

/**
 * One DexScreener batch, with a single retry — the same discipline every
 * GeckoTerminal call here already has. No pacing sleep: DexScreener's limit is
 * 300/min and one scan asks for a handful of batches.
 */
async function fetchPairsBatch(batch: string[]): Promise<Map<string, ds.DsPair>> {
  try {
    return await ds.getBestPairs(batch);
  } catch (err) {
    console.warn('sleeper scan: dexscreener batch failed, retrying once:', err);
    return ds.getBestPairs(batch);
  }
}

/** The kept picks, with the metadata already fetched attached. */
function enrich(picks: SleeperPick[], pairs: Map<string, ds.DsPair>): EnrichedPick[] {
  return picks.map((pick) => {
    const pair = pairs.get(pick.address);
    return {
      ...pick,
      symbol: pair?.symbol ?? symbolFromPoolName(pick.poolName),
      name: pair?.name ?? null,
      imageUrl: pair?.imageUrl ?? null,
      twitterUrl: twitterUrlFrom(pair?.socials),
      websiteUrl: websiteUrlFrom(pair?.socials),
    };
  });
}

interface ScoredPick extends EnrichedPick {
  /** Continuous hours in band, measured off candles (round 14). */
  inBandHours: number;
  /**
   * When inBandHours was last measured off candles — this scan for a full
   * measurement, the previous stamp for a carried one, null when the read
   * failed.
   */
  residencyMeasuredAt: Date | null;
}

/** One OHLCV call, with a single retry — same discipline as a listing page. */
async function fetchOhlcv(
  poolAddress: string,
  timeframe: 'hour' | 'day',
  limit: number,
): Promise<gt.GtCandle[]> {
  await sleep(OHLCV_GAP_MS);
  try {
    return await gt.getOhlcv(poolAddress, timeframe, limit, 'scan');
  } catch (err) {
    console.warn(`sleeper scan: ${timeframe} ohlcv for ${poolAddress} failed, retrying once:`, err);
    await sleep(OHLCV_GAP_MS);
    return gt.getOhlcv(poolAddress, timeframe, limit, 'scan');
  }
}

/** The 15-minute read behind the 30m/1h chips, paced like every other call. */
async function fetchShortOhlcv(poolAddress: string): Promise<gt.GtCandle[]> {
  await sleep(OHLCV_GAP_MS);
  try {
    return await gt.getOhlcvMinutes(
      poolAddress,
      SLEEPERS.shortCandleMinutes,
      SLEEPERS.shortCandleLimit,
      'scan',
    );
  } catch (err) {
    console.warn(`sleeper scan: 15m ohlcv for ${poolAddress} failed, retrying once:`, err);
    await sleep(OHLCV_GAP_MS);
    return gt.getOhlcvMinutes(
      poolAddress,
      SLEEPERS.shortCandleMinutes,
      SLEEPERS.shortCandleLimit,
      'scan',
    );
  }
}

/** The newest candle's START, or null when the series carried no readable one. */
function newestTsSec(candles: readonly gt.GtCandle[]): number | null {
  let newest: number | null = null;
  for (const candle of candles) {
    if (!Number.isFinite(candle.tsSec)) continue;
    if (newest === null || candle.tsSec > newest) newest = candle.tsSec;
  }
  return newest;
}

/**
 * Is the 15-minute read worth making at all, or is its answer already known?
 *
 * computeShortResidency reports 0 whenever the newest 15-minute candle's START
 * is more than SLEEPERS.shortMaxCandleAgeMinutes old, and two signals we hold
 * BEFORE spending the call prove that is the answer:
 *
 *   - the listing says zero trades in the last hour, so the newest 15-minute
 *     bucket cannot have started inside it. An UNKNOWN count (null) still
 *     reads: absence of the h1 block is not absence of trades;
 *   - the newest HOURLY candle started more than
 *     (shortMaxCandleAgeMinutes + 60) minutes ago, so no trade can have landed
 *     inside the freshness window either — the hour that would contain it has
 *     no candle. An unknown hourly age (no readable candles) still reads.
 *
 * Skipping is not a shortcut around the rule: the caller records the 0 the read
 * would have returned, so a sub-3h figure never rides on the hourly span alone.
 */
function shortReadCanSeeAnything(
  txns1h: number | null | undefined,
  newestHourlyTsSec: number | null,
  nowMs: number,
): boolean {
  if (txns1h === 0) return false;
  if (newestHourlyTsSec === null) return true;
  const ageMin = (nowMs / 1000 - newestHourlyTsSec) / 60;
  return ageMin <= SLEEPERS.shortMaxCandleAgeMinutes + 60;
}

/**
 * The previous scan's residency, per address (docs/decisions.md round 16b).
 *
 * Safe to read at measure time: persist() inserts THIS scan's rows and only
 * then deletes the older ones, so until it runs the newest scan_at in the table
 * is still the previous scan's. One row per address per scan (selectSleepers
 * dedupes by token), so a plain map is enough.
 */
async function loadPreviousResidency(db: Db): Promise<Map<string, PrevResidency>> {
  const rows = await db
    .select({
      address: sleeperEntries.address,
      bandLoUsd: sleeperEntries.bandLoUsd,
      bandHiUsd: sleeperEntries.bandHiUsd,
      inBandHours: sleeperEntries.inBandHours,
      scanAt: sleeperEntries.scanAt,
      residencyMeasuredAt: sleeperEntries.residencyMeasuredAt,
    })
    .from(sleeperEntries)
    .where(sql`${sleeperEntries.scanAt} = (select max(${sleeperEntries.scanAt}) from ${sleeperEntries})`);

  const out = new Map<string, PrevResidency>();
  for (const row of rows) {
    out.set(row.address, {
      band: { loUsd: row.bandLoUsd, hiUsd: row.bandHiUsd },
      inBandHours: row.inBandHours,
      scanAtMs: row.scanAt.getTime(),
      measuredAtMs: row.residencyMeasuredAt?.getTime() ?? null,
    });
  }
  return out;
}

/**
 * Time in band for every kept entry (docs/decisions.md rounds 14 and 16b).
 *
 * The cheap path first: an address the previous scan already
 * measured IN THE SAME BAND simply extends its figure by the time since that
 * scan, no candles fetched. Only new entries, band changes, failed previous
 * reads and figures older than SLEEPERS.residencyReverifyHours pay for OHLCV.
 * needsFullMeasurement owns that decision and carries the error bound.
 *
 * The full walk: hourly candles first (100 of them reach ~4 days back, which
 * covers every duration up to 3d on its own), and only a window that was
 * in-band all the way through is worth a second, daily call.
 *
 * A pool whose candles cannot be read reports 0 rather than a guess. That means
 * it is filtered out of every duration view for one cycle, which is the honest
 * failure: we do not know how long it has been sitting there.
 *
 * The short read (round 17): a full measurement that comes back under
 * SLEEPERS.shortHoldMaxHours pays for ONE more call, 15-minute candles, so the
 * 30m and 1h chips have something to filter on. Below that threshold the minute
 * evidence is the AUTHORITATIVE one — it REPLACES the hourly figure rather than
 * competing with it — because the chips it serves are defined in terms of
 * fifteen-minute closes, and hourly candles cannot resolve half an hour either
 * way: a coin that left the band 45 minutes ago still has an in-band hourly
 * close. A null reading (no candles, nothing readable) leaves the hourly figure
 * standing; a 0 reading is evidence and replaces it.
 *
 * Bounded by construction — at most one extra call per NEW short entry per scan
 * (two if the first attempt errors and the retry runs), never for a carried
 * one, never for an entry the hourly walk already established at
 * shortHoldMaxHours or more, never after a failed hourly read (whose failure is
 * almost always the budgeter telling us to stop asking), and never when the
 * listing or the hourly candles already prove the answer would be 0 — see
 * shortReadCanSeeAnything.
 *
 * The short read has its OWN try/catch: the hourly walk that preceded it is a
 * real measurement, and throwing it (and its stamp) away over a 429 on the
 * follow-up call would force a full re-measurement next scan — the exact spend
 * the budgeter is asking us to avoid.
 */
async function measureResidency(
  picks: EnrichedPick[],
  prev: Map<string, PrevResidency>,
  nowMs: number,
): Promise<ScoredPick[]> {
  const out: ScoredPick[] = [];
  let failures = 0;
  let carried = 0;
  for (const pick of picks) {
    const previous = prev.get(pick.address);
    if (previous && !needsFullMeasurement(previous, pick, nowMs)) {
      carried++;
      out.push({
        ...pick,
        inBandHours: carriedResidencyHours(previous, nowMs),
        // The stamp travels with the figure: what is dated here is the last
        // real measurement, which is what the 24h re-verification reads.
        // Non-null because needsFullMeasurement rejects an unstamped previous.
        residencyMeasuredAt: new Date(previous.measuredAtMs!),
      });
      continue;
    }
    const shared = {
      band: pick.band,
      entryMcapUsd: pick.mcapUsd,
      entryPriceUsd: pick.priceUsd,
      nowMs,
    };
    let inBandHours = 0;
    let measured = false;
    let newestHourlyTsSec: number | null = null;
    try {
      const hourly = await fetchOhlcv(pick.poolAddress, 'hour', SLEEPERS.inBandHourlyLimit);
      newestHourlyTsSec = newestTsSec(hourly);
      const fromHourly = computeResidency({ ...shared, hourly });
      // hourlyExhausted is only ever true off a live, in-band streak, so this
      // is the one case where a second call can find more history.
      if (fromHourly.hourlyExhausted) {
        const daily = await fetchOhlcv(pick.poolAddress, 'day', SLEEPERS.inBandDailyLimit);
        inBandHours = computeResidency({ ...shared, hourly, daily }).hours;
      } else {
        inBandHours = fromHourly.hours;
      }
      measured = true;
    } catch (err) {
      failures++;
      console.warn(`sleeper scan: no residency for ${pick.address}:`, err);
    }
    if (measured && inBandHours < SLEEPERS.shortHoldMaxHours) {
      if (shortReadCanSeeAnything(pick.txns1h, newestHourlyTsSec, nowMs)) {
        try {
          const minutes = await fetchShortOhlcv(pick.poolAddress);
          const fromMinutes = computeShortResidency({ ...shared, minutes });
          // A number is a reading and it wins outright, 0 included. Null is no
          // reading at all, and the hourly figure stands.
          if (fromMinutes !== null) inBandHours = fromMinutes;
        } catch (err) {
          console.warn(`sleeper scan: 15m read failed, hourly figure kept for ${pick.address}:`, err);
        }
      } else {
        // The listing already proved the read would answer 0: nothing traded
        // inside the freshness window. Below the threshold the minute evidence
        // is the only evidence, so the hourly span is not kept in its place.
        inBandHours = 0;
      }
    }
    // A failed read is left UNSTAMPED so the next scan measures it properly
    // rather than carrying a 0 forward for a day.
    out.push({ ...pick, inBandHours, residencyMeasuredAt: measured ? new Date(nowMs) : null });
  }
  if (failures > 0) console.warn(`sleeper scan: ${failures}/${picks.length} residency reads failed`);
  if (carried > 0) console.log(`sleeper scan: ${carried}/${picks.length} residencies carried forward`);
  return out;
}

/**
 * Replace-style write. The insert lands first and the delete is scoped to
 * strictly older scans, so a reader between the two statements sees the old
 * scan or the new one — never nothing. Only the latest scan is kept; round 9
 * asked for a snapshot stream, not a history.
 */
async function persist(db: Db, scanAt: Date, picks: ScoredPick[]): Promise<void> {
  if (picks.length > 0) {
    await db.insert(sleeperEntries).values(
      picks.map((pick) => ({
        scanAt,
        bandLoUsd: pick.band.loUsd,
        bandHiUsd: pick.band.hiUsd,
        rank: pick.rank,
        address: pick.address,
        symbol: pick.symbol,
        name: pick.name,
        imageUrl: pick.imageUrl,
        twitterUrl: pick.twitterUrl,
        websiteUrl: pick.websiteUrl,
        poolAddress: pick.poolAddress,
        mcapUsd: pick.mcapUsd,
        vol24Usd: pick.vol24Usd,
        liquidityUsd: pick.liquidityUsd,
        txns24: Math.round(pick.txns24),
        turnover: pick.turnover,
        inBandHours: pick.inBandHours,
        residencyMeasuredAt: pick.residencyMeasuredAt,
        isStock: pick.isStock,
        poolCreatedAt: pick.poolCreatedAt,
      })),
    );
  }
  // A scan that qualified nothing still clears the board: leaving three-hour-old
  // entries up under a "refreshed just now" line would be a lie.
  await db.delete(sleeperEntries).where(lt(sleeperEntries.scanAt, scanAt));
}

/**
 * The persistence ledger behind "on list 9h". first_listed_at is written once
 * and never moved; last_listed_at advances on every scan the address appears
 * in, and is what the prune reads.
 */
async function recordSeen(db: Db, scanAt: Date, addresses: string[]): Promise<void> {
  if (addresses.length > 0) {
    await db
      .insert(sleeperSeen)
      .values(addresses.map((address) => ({ address, firstListedAt: scanAt, lastListedAt: scanAt })))
      .onConflictDoUpdate({
        target: sleeperSeen.address,
        set: { lastListedAt: scanAt },
      });
  }
  const cutoff = new Date(scanAt.getTime() - SLEEPERS.seenRetentionDays * 86_400_000);
  await db.delete(sleeperSeen).where(lt(sleeperSeen.lastListedAt, cutoff));
}

/**
 * One full scan. Throwing is fine — the scheduler isolates this the same way it
 * isolates the rug sweep and the prune, and a failed scan simply leaves the
 * previous one on screen until the next attempt.
 */
export async function runSleeperScan(db: Db): Promise<SleeperScanResult> {
  const scanAt = new Date();
  // Read BEFORE persist() writes this scan — see loadPreviousResidency.
  const previous = await loadPreviousResidency(db);
  const { candidates, pages } = await collect();
  // Names first (round 17): the tokenized-stock rule reads the base token's
  // name, and the keep cut needs the answer before it picks its twelve. Only
  // candidates that already clear every floor are looked up — the ones that
  // fail cannot be kept whatever they are called. qualify() is pure and cheap,
  // so running it here and again inside selectSleepers costs nothing.
  const deduped = dedupeByToken(candidates);
  const nowMs = scanAt.getTime();
  const pairs = await fetchPairs(
    deduped.filter((c) => qualify(c, nowMs) !== null).map((c) => c.address),
  );
  const named = deduped.map((c) => ({ ...c, tokenName: pairs.get(c.address)?.name ?? null }));
  const picks = selectSleepers(named, nowMs);
  const enriched = enrich(picks, pairs);
  // Measured against the scan's own clock, so every entry in a scan answers the
  // duration filter as of the same instant.
  const scored = await measureResidency(enriched, previous, nowMs);

  await persist(db, scanAt, scored);
  await recordSeen(db, scanAt, [...new Set(scored.map((e) => e.address))]);

  console.log(
    `sleeper scan: ${candidates.length} pools over ${pages} page(s) -> ${scored.length} kept ` +
      `(${scored.filter((e) => e.twitterUrl !== null).length} with X, ` +
      `${scored.filter((e) => e.isStock).length} tokenized stocks, ` +
      `${scored.filter((e) => e.inBandHours >= 24).length} in band 24h+)`,
  );
  return { scanned: candidates.length, kept: scored.length, pages };
}
