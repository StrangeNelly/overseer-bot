import { lt, sql } from 'drizzle-orm';
import { sleeperEntries, sleeperSeen, type Db } from '@groupie/db';
import { SLEEPERS, twitterUrlFrom, websiteUrlFrom } from '@groupie/shared';
import * as ds from '../market/dexscreener.js';
import * as gt from '../market/geckoterminal.js';
import {
  carriedResidencyHours,
  computeResidency,
  needsFullMeasurement,
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
 * One DexScreener batch over the kept entries: image, socials, and a proper
 * symbol/name. A token DexScreener does not index (curve-phase coins are
 * routinely absent) keeps the GeckoTerminal name data and null socials — an
 * absence there says nothing about the coin.
 */
async function enrich(picks: SleeperPick[]): Promise<EnrichedPick[]> {
  const pairs = new Map<string, ds.DsPair>();
  for (let i = 0; i < picks.length; i += DS_BATCH) {
    const batch = picks.slice(i, i + DS_BATCH).map((p) => p.address);
    try {
      for (const [address, pair] of await ds.getBestPairs(batch)) pairs.set(address, pair);
    } catch (err) {
      // Metadata is a nicety; the scan's numbers all come from GeckoTerminal.
      console.warn('sleeper scan: dexscreener enrichment failed for a batch:', err);
    }
  }

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
    let inBandHours = 0;
    let measured = false;
    try {
      const shared = {
        band: pick.band,
        entryMcapUsd: pick.mcapUsd,
        entryPriceUsd: pick.priceUsd,
        nowMs,
      };
      const hourly = await fetchOhlcv(pick.poolAddress, 'hour', SLEEPERS.inBandHourlyLimit);
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
  const picks = selectSleepers(candidates, scanAt.getTime());
  const enriched = await enrich(picks);
  // Measured against the scan's own clock, so every entry in a scan answers the
  // duration filter as of the same instant.
  const scored = await measureResidency(enriched, previous, scanAt.getTime());

  await persist(db, scanAt, scored);
  await recordSeen(db, scanAt, [...new Set(scored.map((e) => e.address))]);

  console.log(
    `sleeper scan: ${candidates.length} pools over ${pages} page(s) -> ${scored.length} kept ` +
      `(${scored.filter((e) => e.twitterUrl !== null).length} with X, ` +
      `${scored.filter((e) => e.inBandHours >= 24).length} in band 24h+)`,
  );
  return { scanned: candidates.length, kept: scored.length, pages };
}
