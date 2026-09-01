import { lt } from 'drizzle-orm';
import { sleeperEntries, sleeperSeen, type Db } from '@groupie/db';
import { SLEEPERS, twitterUrlFrom, websiteUrlFrom } from '@groupie/shared';
import * as ds from '../market/dexscreener.js';
import * as gt from '../market/geckoterminal.js';
import { selectSleepers, type PoolCandidate, type SleeperPick } from './sleeperLogic.js';

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
 * Spacing between listing pages. The GeckoTerminal budgeter's window is 25/min
 * with no intra-window pacing, and firing ten pages back to back reliably drew
 * a 429 in testing (verified live 2026-09-02) — this is a three-hourly job with
 * nothing waiting on it, so it can afford to be polite.
 */
const PAGE_GAP_MS = 1_500;

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
    return await gt.getTopPools(page);
  } catch (err) {
    console.warn(`sleeper scan: page ${page} failed, retrying once:`, err);
    return gt.getTopPools(page);
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
        liquidityUsd: pool.liquidityUsd,
        vol24Usd: pool.vol24Usd,
        txns24: pool.txns24,
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

/**
 * Replace-style write. The insert lands first and the delete is scoped to
 * strictly older scans, so a reader between the two statements sees the old
 * scan or the new one — never nothing. Only the latest scan is kept; round 9
 * asked for a snapshot stream, not a history.
 */
async function persist(db: Db, scanAt: Date, picks: EnrichedPick[]): Promise<void> {
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
  const { candidates, pages } = await collect();
  const picks = selectSleepers(candidates, scanAt.getTime());
  const enriched = await enrich(picks);

  await persist(db, scanAt, enriched);
  await recordSeen(db, scanAt, [...new Set(enriched.map((e) => e.address))]);

  console.log(
    `sleeper scan: ${candidates.length} pools over ${pages} page(s) -> ${enriched.length} kept ` +
      `(${enriched.filter((e) => e.twitterUrl !== null).length} with X)`,
  );
  return { scanned: candidates.length, kept: enriched.length, pages };
}
