import { and, eq, gte, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { getContractAddress } from 'viem';
import { deployerWatches, type Db } from '@groupie/db';
import { DEPLOYER_WATCH, DISCOVERY, type DeployerFiredVia } from '@groupie/shared';
import { PONS_V2_FACTORY, TOPICS } from '../chain/addresses.js';
import { summarizeRpcError, type ChainClient, type ChainLog } from '../chain/client.js';
import { addressTopic, dataWord, topicAddress, wordToAddress } from '../chain/decode.js';

/**
 * The DEPLOYER WATCH (docs/decisions.md round 26).
 *
 * The owner's ask: "add a command like `/overseer deployer <address>` and it
 * will do everything it can to notify me in the telegram group as soon as its
 * launched on pons or anywhere else." The motivating case is @clubytech, whose
 * team deployed a registry contract (0xD0A3…37A, by EOA 0x9c5c…074a at that
 * wallet's nonce 163, on 2026-09-05) whose `token()` is still empty while four
 * impostor "Cluby" coins already trade on this chain.
 *
 * FOUR ROADS to the same answer, cheapest first. Each is bounded, each is
 * isolated, and none of them may throw out of the tick:
 *
 * 1. **pons** — the deployer is `TokenLaunched`'s third indexed parameter, and
 *    that log now rides the discovery sweep's existing one-query topic0
 *    OR-list. Verified on chain 2026-09-08: topics[1]=token, topics[2]=curve,
 *    topics[3]=deployer. FREE — no request of its own, and the match is a
 *    string comparison in memory.
 * 2. **pool** — a non-PONS first pool names no deployer anywhere in its logs, so
 *    the SENDER of the transaction that created it is asked for, bounded to
 *    DEPLOYER_WATCH.poolAttributionPerTick reads.
 * 3. **create** — a raw contract deployment. CREATE derives the new address from
 *    (wallet, nonce) alone, so a nonce read plus `eth_getCode` on the predicted
 *    address detects it with no indexer and no vendor (verified: viem's
 *    getContractAddress reproduced the registry address exactly at nonce 163).
 *    The weak one, and THE ONLY ROAD THAT DOES NOT RETIRE THE WATCH: bytecode
 *    at a predicted address proves a contract, not a launch, and the motivating
 *    wallet deploys scaffolding before it launches — so a create is announced
 *    while roads 1, 2 and 4 keep running for the launch itself.
 * 4. **registry** — a watched CONTRACT emitting its own `TokenSet`. The
 *    registry's `setToken` is owner-gated and its owner is a DIFFERENT wallet,
 *    so publication is a separate manual act that LAGS the launch — which is
 *    exactly why road 1 exists and why this one is last.
 *
 * ZERO WATCHES, ZERO CHAIN COST. A board with nothing on watch pays for the
 * watchlist SELECT and stops there — no chain read, no write, no message: the
 * codebase's "absence is the feature flag".
 *
 * Nothing here formats a message or talks to Telegram; the pass returns the
 * hits the chat is owed — the three launch roads' hits that WON their row, plus
 * the creates, which announce without claiming one — and the delivery loop owns
 * the rest.
 */

export type DeployerWatchRow = typeof deployerWatches.$inferSelect;

/**
 * How we found out. See the four roads above.
 *
 * The SHARED type, not a copy of it: `fired_via` is one column, the board reads
 * it as `DeployerFiredVia` and the detection pass writes it as this, and two
 * hand-written unions for one enum are two things to forget to change together.
 */
export type DeployerHitVia = DeployerFiredVia;

/**
 * One watched address seen putting something on chain.
 *
 * `tokenAddress` and `txHash` are NULLABLE, and each null is a real case rather
 * than a failure: a CREATE hit is a contract this wallet deployed, found by
 * prediction, and no transaction hash was read to find it; a registry event
 * whose parameter layout we cannot decode is still a publication worth telling
 * the chat about ("fired, tx 0x…"). Unknown is printed as unknown — never
 * filled in with a plausible-looking address.
 */
export interface DeployerHit {
  watchId: number;
  groupId: number;
  addedBy: number;
  /** The watched address itself, lowercase. */
  watchedAddress: string;
  /** What it launched or deployed, lowercase — null when the event was unreadable. */
  tokenAddress: string | null;
  via: DeployerHitVia;
  /** Where it is written on chain — null for a CREATE hit (see above). */
  txHash: string | null;
}

/**
 * The shape `attributePools` reads off a freshly detected discovery row. A
 * structural type, not the table's: the caller hands over the rows it is about
 * to write, which are not database rows yet.
 */
export interface DeployerLaunchRow {
  kind: 'launch' | 'graduation';
  tokenAddress: string;
  txHash: string;
}

/**
 * The tick's remaining budget for the one road with a per-launch cost. Carried
 * ACROSS the tick's block ranges rather than reset for each of them: the pass
 * runs once per range, so a catch-up tick of forty chunks would otherwise spend
 * forty times DEPLOYER_WATCH.poolAttributionPerTick on a single wake-up.
 */
export interface DeployerTickBudget {
  poolReads: number;
  /**
   * Whether the tick has already said that the budget ran out. The same
   * honesty rule the outage catch-up follows: coverage we did not buy is
   * reported, never covered up — and once per tick rather than once per range,
   * because a 40-chunk catch-up would otherwise print it forty times.
   */
  exhaustionReported?: boolean;
}

export function newDeployerTickBudget(): DeployerTickBudget {
  return { poolReads: DEPLOYER_WATCH.poolAttributionPerTick, exhaustionReported: false };
}

/** What one tick's range gives the pass to work with. */
export interface DeployerWatchContext {
  /** PONS `TokenLaunched` logs from this range's sweep (free — see road 1). */
  launchedLogs: readonly ChainLog[];
  /**
   * Every new pool this range found, BEFORE the discovery board's own floors
   * cut it down. The board drops a launch that is thin, stale, a second pool or
   * a tokenized stock because those do not deserve a DISCOVERY card — none of
   * which is a reason to withhold "the wallet you asked about just launched",
   * so this road reads the raw candidates and the board keeps its own list.
   */
  launchRows: readonly DeployerLaunchRow[];
  fromBlock: number;
  toBlock: number;
  /** Shared across the tick's ranges; omitted means a fresh per-pass budget. */
  budget?: DeployerTickBudget;
}

const lower = (address: string): string => address.toLowerCase();

/**
 * Is there a contract at this address? '' is the SAME ANSWER as '0x' — some
 * nodes answer an empty account with an empty string — and reading it as
 * bytecode would announce a deployment at an address with no code. One
 * predicate, used by the CREATE scan and by `/overseer deployer`'s kind probe,
 * so the two can never disagree about what the node just said.
 */
export function hasCode(code: string): boolean {
  return code !== '' && !/^0x0*$/.test(code);
}

/** When the ceiling warning was last said, so a catch-up tick says it once. */
let ceilingWarnedAtMs = 0;
const CEILING_WARN_INTERVAL_MS = 3_600_000;

/** Active watches, capped — the whole feature's cost ceiling in one query. */
export async function activeWatches(db: Db): Promise<DeployerWatchRow[]> {
  const rows = await db
    .select()
    .from(deployerWatches)
    .where(eq(deployerWatches.status, 'active'))
    // Oldest first, so a board over the cap keeps scanning the watches it has
    // been scanning rather than shuffling which ones are covered every tick.
    .orderBy(deployerWatches.id)
    .limit(DEPLOYER_WATCH.maxWatchesScanned);
  // At the ceiling, the rows past it are the NEWEST — the ones a member just
  // added and is waiting on. The command still says "watching", so the only
  // place that gap can be noticed is here. Hourly, because the pass runs once
  // per block range and a catch-up tick would print it a dozen times.
  if (rows.length >= DEPLOYER_WATCH.maxWatchesScanned) {
    const now = Date.now();
    if (now - ceilingWarnedAtMs > CEILING_WARN_INTERVAL_MS) {
      ceilingWarnedAtMs = now;
      console.warn(
        `deployer watch: at the ${DEPLOYER_WATCH.maxWatchesScanned}-watch scan ceiling — ` +
          'the most recently added watches are NOT being checked',
      );
    }
  }
  return rows;
}

function hitOf(
  watch: DeployerWatchRow,
  tokenAddress: string | null,
  via: DeployerHitVia,
  txHash: string | null,
): DeployerHit {
  return {
    watchId: watch.id,
    groupId: watch.groupId,
    addedBy: Number(watch.addedBy),
    watchedAddress: lower(watch.address),
    tokenAddress,
    via,
    txHash,
  };
}

/**
 * ROAD 1, and the reason this feature is affordable: PONS launches matched
 * against the watchlist IN MEMORY, out of logs the discovery sweep already
 * paid for.
 *
 * `TokenLaunched(address indexed token, address indexed curve, address indexed
 * deployer, …)` — so topics[3] is who launched it and topics[1] is what they
 * launched (verified against live launches, 2026-09-08). A log missing either
 * is skipped: a half-decoded launch is not evidence about anybody.
 *
 * KIND IS NOT CHECKED. A watched contract can be the deployer of a PONS coin
 * just as a wallet can, and refusing to match one because a member typed the
 * address of a factory would be a miss with no upside.
 */
export function matchPonsLaunches(
  watches: readonly DeployerWatchRow[],
  launchedLogs: readonly ChainLog[],
): DeployerHit[] {
  if (watches.length === 0 || launchedLogs.length === 0) return [];
  const byAddress = new Map<string, DeployerWatchRow[]>();
  for (const watch of watches) {
    const key = lower(watch.address);
    const list = byAddress.get(key);
    if (list) list.push(watch);
    else byAddress.set(key, [watch]);
  }

  const out: DeployerHit[] = [];
  for (const log of launchedLogs) {
    const deployer = topicAddress(log.topics, 3);
    const token = topicAddress(log.topics, 1);
    if (deployer === null || token === null) continue;
    for (const watch of byAddress.get(deployer) ?? []) {
      out.push(hitOf(watch, token, 'pons', log.transactionHash));
    }
  }
  return out;
}

/**
 * ROAD 2: who SENT the transaction that opened a new non-PONS pool.
 *
 * A Uniswap pair or a v4 pool names its creator nowhere — `PairCreated` carries
 * the two tokens and `Initialize` the pool key — so the only place the deployer
 * is written down is the transaction itself. One `eth_getTransactionByHash`
 * (17 CU) per new pool, bounded by DEPLOYER_WATCH.poolAttributionPerTick,
 * because a busy range can carry dozens of them and none of this may slow the
 * block loop down.
 *
 * `alreadyMatched` holds the tokens road 1 already matched this pass: a PONS
 * launch is covered for free, and paying to re-ask who sent its transaction
 * would be spending a read on an answer already in hand.
 *
 * A sender that cannot be read — a node that would not answer, or a client with
 * no `getTransactionSender` at all — is UNKNOWN, and unknown is never a match.
 *
 * WALLET WATCHES ONLY. A transaction's `from` is an externally owned account by
 * construction, so a watched CONTRACT can never be the sender even when it is
 * the thing that opened the pool — the EOA that poked it is. Filtering here
 * states that rule where it applies; `/overseer deployer`'s reply states the
 * same thing to the member, and neither may promise what the other cannot do.
 */
export async function attributePools(
  db: Db,
  chain: ChainClient,
  watches: readonly DeployerWatchRow[],
  launchRows: readonly DeployerLaunchRow[],
  alreadyMatched: ReadonlySet<string> = new Set(),
  budget: DeployerTickBudget = newDeployerTickBudget(),
): Promise<DeployerHit[]> {
  void db; // Chain-only road; `db` is here so all four passes read alike.
  if (watches.length === 0 || launchRows.length === 0) return [];
  const readSender = chain.getTransactionSender?.bind(chain);
  if (!readSender) return [];

  const wanted = new Map<string, DeployerWatchRow[]>();
  for (const watch of watches) {
    if (watch.kind !== 'eoa') continue;
    const key = lower(watch.address);
    const list = wanted.get(key);
    if (list) list.push(watch);
    else wanted.set(key, [watch]);
  }
  // Every watch was a contract: nothing here can ever match, so nothing is
  // bought. The refusal has to come before the first read, not after it.
  if (wanted.size === 0) return [];

  const seenTx = new Set<string>();
  const out: DeployerHit[] = [];
  let unattributed = 0;
  for (const row of launchRows) {
    if (budget.poolReads <= 0) {
      // Everything from here on is a pool NOBODY asked the sender of, and this
      // range is never re-read — so the miss is counted and said below rather
      // than dropped in silence.
      unattributed += 1;
      continue;
    }
    // Graduations are a PONS coin's SECOND market; its launch is road 1's, and
    // the transaction that migrated it was sent by the launchpad, not the team.
    if (row.kind !== 'launch') continue;
    if (alreadyMatched.has(lower(row.tokenAddress))) continue;
    const txHash = lower(row.txHash);
    // Two pools opened by one transaction cost one sender lookup, not two.
    if (seenTx.has(txHash)) continue;
    seenTx.add(txHash);
    budget.poolReads -= 1;
    let sender: string | null = null;
    try {
      sender = await readSender(txHash);
    } catch (err) {
      // One unreadable transaction is not worth the tick: unknown, next row.
      console.warn(`deployer watch: sender lookup failed for ${txHash}: ${summarizeRpcError(err)}`);
      continue;
    }
    if (sender === null) continue;
    for (const watch of wanted.get(lower(sender)) ?? []) {
      out.push(hitOf(watch, lower(row.tokenAddress), 'pool', txHash));
    }
  }
  if (unattributed > 0 && !budget.exhaustionReported) {
    budget.exhaustionReported = true;
    console.warn(
      `deployer watch: pool attribution budget ` +
        `(${DEPLOYER_WATCH.poolAttributionPerTick}/tick) spent — ${unattributed} new pool(s) in ` +
        `this range, and any later in this tick, were NOT checked against ` +
        `${wanted.size} watched wallet(s)`,
    );
  }
  return out;
}

/**
 * ROAD 3: raw contract deployments by a watched WALLET, predicted from its
 * nonce.
 *
 * CREATE derives a contract's address from (sender, nonce) and nothing else, so
 * every unused nonce is an address we can compute locally and then ask about
 * with one `eth_getCode`. No indexer, no vendor, no trace API. (Verified
 * 2026-09-08: viem's getContractAddress reproduced the @clubytech registry
 * exactly at nonce 163 of 0x9c5c…074a.)
 *
 * THE HIGH-WATER MARK IS EVERYTHING. `last_nonce` is stamped when the watch is
 * ADDED, and this scan only ever probes above it: without that, adding
 * 0x9c5c…074a would instantly "find" 163 historical contracts and fire on all
 * of them. A null mark is therefore not an invitation to scan from zero — it is
 * stamped to the current nonce and this tick probes nothing.
 *
 * The mark advances ONLY past nonces that were actually ANSWERED. A probe whose
 * `eth_getCode` came back unknown stops the walk with the mark still under it,
 * so the next tick asks again rather than stepping over a deployment nobody
 * managed to read. The rest of a burst is picked up the same way, one
 * DEPLOYER_WATCH.createScanPerTick at a time.
 */
export async function scanCreates(
  db: Db,
  chain: ChainClient,
  watches: readonly DeployerWatchRow[],
): Promise<DeployerHit[]> {
  if (watches.length === 0) return [];
  const readNonce = chain.getTransactionCount?.bind(chain);
  const readCode = chain.getCode?.bind(chain);
  // Without BOTH reads the road cannot run — and it must not stamp a high-water
  // mark it has no way to probe past, or the deployments in between would be
  // skipped for good the moment the client gained the methods.
  if (!readNonce || !readCode) return [];

  const now = Date.now();
  const out: DeployerHit[] = [];
  for (const watch of watches) {
    if (watch.kind !== 'eoa') continue;
    // One nonce read per watch per DEPLOYER_WATCH.nonceCheckSeconds. A catch-up
    // tick reads several block ranges and calls this pass for each of them; the
    // clock is what stops that from re-asking every wallet for a nonce that
    // cannot have moved in the milliseconds since.
    const checkedAt = watch.nonceCheckedAt?.getTime() ?? null;
    if (checkedAt !== null && now - checkedAt < DEPLOYER_WATCH.nonceCheckSeconds * 1000) continue;

    try {
      const nonce = await readNonce(watch.address);
      if (nonce === null) continue;

      if (watch.lastNonce === null) {
        // Take the mark, probe nothing. This is the "added just now" case, and
        // everything below the mark is the wallet's history, not its news.
        await stampNonce(db, watch.id, nonce);
        continue;
      }
      const start = Math.max(0, watch.lastNonce);
      const end = Math.min(nonce, start + DEPLOYER_WATCH.createScanPerTick);
      if (end <= start) {
        // Nothing new; the read still happened, so the clock moves.
        await stampNonce(db, watch.id, start);
        continue;
      }

      let probed = start;
      for (let nextNonce = start; nextNonce < end; nextNonce += 1) {
        const predicted = lower(
          getContractAddress({ from: watch.address as `0x${string}`, nonce: BigInt(nextNonce) }),
        );
        const code = await readCode(predicted);
        // Unknown: stop, and leave the mark BELOW this nonce so it is re-probed.
        if (code === null) break;
        probed = nextNonce + 1;
        // '0x' (or '0x0', or the empty string some nodes answer with) is a
        // definite "nothing was deployed here" — that nonce was an ordinary
        // transaction, and the walk carries on.
        if (!hasCode(code)) continue;
        // Announced, but NOT terminal (see recordHit): the mark below is what
        // stops this same contract being reported twice, and the watch stays
        // live for the launch this deployment may only be scaffolding for.
        out.push(hitOf(watch, predicted, 'create', null));
      }
      await stampNonce(db, watch.id, probed);
    } catch (err) {
      // One watch's failure costs that watch this tick and nothing else.
      console.warn(
        `deployer watch: create scan failed for ${watch.address}: ${summarizeRpcError(err)}`,
      );
    }
  }
  return out;
}

/**
 * The CREATE mark, and the clock behind it. `greatest` because the mark may
 * only ever move FORWARD: two overlapping passes must not rewind it and re-fire
 * on contracts already reported.
 */
async function stampNonce(db: Db, watchId: number, lastNonce: number): Promise<void> {
  await db
    .update(deployerWatches)
    .set({
      lastNonce: sql`greatest(coalesce(${deployerWatches.lastNonce}, 0), ${lastNonce})`,
      nonceCheckedAt: new Date(),
    })
    .where(eq(deployerWatches.id, watchId));
}

/**
 * ROAD 4: a watched CONTRACT publishing its coin — the registry's own
 * `TokenSet` (see TOPICS.tokenSet for the provenance and its one gap).
 *
 * ONE `eth_getLogs` over every contract watch at once, across this range's
 * blocks. The chunking against the provider's 5,000-block ceiling belongs to
 * the client (chain/client.ts learns the cap from a refusal), so there is no
 * second chunker here — this range is the same range the sweep just read.
 *
 * NO CONTRACT WATCHES, NO QUERY. The common case is a board of wallets, and it
 * costs nothing.
 */
export async function scanRegistries(
  db: Db,
  chain: ChainClient,
  watches: readonly DeployerWatchRow[],
  fromBlock: number,
  toBlock: number,
): Promise<DeployerHit[]> {
  void db; // Chain-only road; `db` is here so all four passes read alike.
  const contracts = watches.filter((w) => w.kind === 'contract');
  if (contracts.length === 0) return [];
  if (!Number.isFinite(fromBlock) || !Number.isFinite(toBlock) || toBlock < fromBlock) return [];

  let logs: ChainLog[];
  try {
    logs = await chain.getLogs({
      address: contracts.map((w) => lower(w.address)),
      topics: [[TOPICS.tokenSet]],
      fromBlock,
      toBlock,
    });
  } catch (err) {
    // The range is re-read on the next tick only if the sweep failed too; a
    // registry publication missed here is caught by the row's own next event or
    // by the launch itself on road 1. Worth a line, never worth the tick.
    console.warn(`deployer watch: registry scan failed: ${summarizeRpcError(err)}`);
    return [];
  }

  const byAddress = new Map<string, DeployerWatchRow[]>();
  for (const watch of contracts) {
    const key = lower(watch.address);
    const list = byAddress.get(key);
    if (list) list.push(watch);
    else byAddress.set(key, [watch]);
  }

  const out: DeployerHit[] = [];
  for (const log of logs) {
    if (log.topics[0]?.toLowerCase() !== TOPICS.tokenSet) continue;
    for (const watch of byAddress.get(lower(log.address)) ?? []) {
      out.push(hitOf(watch, publishedToken(log), 'registry', log.transactionHash));
    }
  }
  return out;
}

/**
 * `TokenSet(address,address,uint64)` decoded DEFENSIVELY, because WHICH of its
 * three parameters are `indexed` is unknown — the topic0 is identical either
 * way — and this build refuses to guess a layout it has not observed.
 *
 * So: read the topics after topic0, then the data words, in order, and take the
 * first that is plausibly an address. Null when none is, and null means the
 * caller still reports the event with its transaction hash: a publication we
 * could not decode is still a publication, and inventing a token address out of
 * the wrong word would be worse than saying so.
 */
export function publishedToken(log: ChainLog): string | null {
  const words: Array<string | null> = [
    log.topics[1] ?? null,
    log.topics[2] ?? null,
    log.topics[3] ?? null,
    dataWord(log.data, 0),
    dataWord(log.data, 1),
    dataWord(log.data, 2),
  ];
  for (const word of words) {
    const address = wordToAddress(word);
    if (address === null) continue;
    const body = address.slice(2);
    // Not the zero address, and not a small integer wearing an address's
    // padding: the third parameter is a uint64 timestamp, which decodes as a
    // 20-byte word with twelve leading zero bytes. A real address has not got
    // twelve leading zero bytes.
    if (/^0{24}/.test(body)) continue;
    return address;
  }
  return null;
}

/**
 * Which roads RETIRE a watch. Three of them do: a PONS launch, a first pool and
 * a registry publication are all "the thing you were waiting for happened".
 *
 * A 'create' is not. It proves bytecode exists at an address this wallet
 * deployed — the motivating case is exactly that, a registry deployed three
 * days before any coin — so retiring the watch on it would mean the group is
 * told about the scaffolding and then never told about the launch. It is
 * announced and the watch keeps running.
 */
export function isTerminalRoad(via: DeployerHitVia): boolean {
  return via !== 'create';
}

/**
 * Flip the row to 'fired', and say WHETHER THIS CALL IS THE ONE THAT DID IT.
 *
 * The `status = 'active'` guard is the whole point: two overlapping ticks, or
 * two roads reaching the same launch in one pass, both try to fire, and exactly
 * one UPDATE returns a row. The caller sends its message only for that one, so
 * a member is told once no matter how many ways we found out.
 *
 * `notified_at` is cleared with the same write: the row is now CLAIMED but not
 * yet told, which is the state the recovery sweep looks for. (A re-added watch
 * arrives with it null already — addDeployerWatch clears it with the rest of the
 * last fire — and clearing it here is what makes a SECOND fire on a re-armed row
 * recoverable too.)
 *
 * A 'create' hit never comes here — see `isTerminalRoad`. It is deduped by the
 * CREATE scan's forward-only nonce mark and, if that write ever fails, by the
 * alerts table's partial unique index on (group, type, watched, address, via) —
 * `via` is in that key precisely so a create and the later launch of the same
 * predicted contract are two messages rather than one swallowed one.
 */
export async function recordHit(db: Db, hit: DeployerHit): Promise<boolean> {
  const won = await db
    .update(deployerWatches)
    .set({
      status: 'fired',
      firedAddress: hit.tokenAddress,
      firedVia: hit.via,
      firedTxHash: hit.txHash,
      firedAt: new Date(),
      notifiedAt: null,
    })
    .where(and(eq(deployerWatches.id, hit.watchId), eq(deployerWatches.status, 'active')))
    .returning({ id: deployerWatches.id });
  return won.length > 0;
}

/**
 * The chat has now been DEALT WITH for this fire — told, muted, already told, or
 * nowhere to post. Stamped for every terminal outcome, not only for a message
 * that went out: what this column answers is "does anybody still owe this row a
 * decision", and a muted group's answer is no.
 */
export async function markDeployerNotified(db: Db, watchId: number): Promise<void> {
  await db
    .update(deployerWatches)
    .set({ notifiedAt: new Date() })
    .where(eq(deployerWatches.id, watchId));
}

/**
 * Rows that WON their fire and never got their message out.
 *
 * The flip and the send are separate writes: a hit is claimed inside the block
 * range that found it and the chat is told immediately after, but a throw in
 * between — a 429 on the next range, a cursor write that failed, a redeploy —
 * used to lose the message for good, because the `status='active'` guard means
 * no later pass can re-win the same evidence. These rows are that gap, and they
 * are bounded by DEPLOYER_WATCH.recoveryWindowMinutes: a late ping is still
 * news, a day-old one is not.
 */
export async function undeliveredHits(db: Db, nowMs: number = Date.now()): Promise<DeployerHit[]> {
  const since = new Date(nowMs - DEPLOYER_WATCH.recoveryWindowMinutes * 60_000);
  // ...and NOT the last few seconds. The flip to 'fired' is committed inside the
  // detection pass and `notified_at` is stamped only after the delivery returns,
  // so a row being delivered RIGHT NOW looks exactly like a lost one. The alerts
  // index catches most of that race, but not the one road with a null
  // `details.address` (an undecodable registry event: nulls are distinct in a
  // unique index), where a second delivery would be a second chat message about
  // one fire. The grace window costs a lost message one extra sweep and closes
  // the race for all four roads.
  const settled = new Date(nowMs - DEPLOYER_WATCH.recoveryGraceSeconds * 1000);
  const rows = await db
    .select()
    .from(deployerWatches)
    .where(
      and(
        eq(deployerWatches.status, 'fired'),
        isNull(deployerWatches.notifiedAt),
        isNotNull(deployerWatches.firedVia),
        gte(deployerWatches.firedAt, since),
        lte(deployerWatches.firedAt, settled),
      ),
    )
    .orderBy(deployerWatches.firedAt)
    .limit(DEPLOYER_WATCH.recoveryPerPass);
  const out: DeployerHit[] = [];
  for (const row of rows) {
    // A fired row with no signal recorded is a write we cannot describe, and a
    // message that cannot say WHICH road fired is not one this feature sends.
    if (row.firedVia === null) continue;
    out.push(hitOf(row, row.firedAddress, row.firedVia as DeployerHitVia, row.firedTxHash));
  }
  return out;
}

/**
 * The whole pass, called by the discovery tick once per block range, AFTER the
 * range's own events are handled. Returns the hits that WON their row — the
 * delivery loop's input, and the only hits anything is allowed to announce.
 *
 * Order is by strength of evidence: a PONS launch names its deployer in the log
 * itself, a pool's sender is the transaction's own word, a registry event is a
 * publication that may lag the launch by days, and a CREATE is only "this
 * wallet deployed a contract". The first three CLAIM the row, so the strongest
 * available account of a launch is the one the chat gets; the fourth is
 * announced without claiming anything, so the watch survives it.
 *
 * EVERY PASS IS ISOLATED. One failing road, one failing watch or one failing
 * write costs its own step and nothing else; this function does not throw.
 */
export async function runDeployerWatchPass(
  db: Db,
  chain: ChainClient,
  ctx: DeployerWatchContext,
): Promise<DeployerHit[]> {
  let watches: DeployerWatchRow[];
  try {
    watches = await activeWatches(db);
  } catch (err) {
    console.warn(`deployer watch: could not read the watchlist: ${summarizeRpcError(err)}`);
    return [];
  }
  // Nothing on watch: not one chain read, and not one write. The watchlist
  // SELECT above is the pass's whole cost in that case — the feature is off by
  // being empty, which is how the rest of this codebase does feature flags.
  if (watches.length === 0) return [];

  const hits: DeployerHit[] = [];
  const ponsMatched = new Set<string>();
  try {
    for (const hit of matchPonsLaunches(watches, ctx.launchedLogs)) {
      if (hit.tokenAddress !== null) ponsMatched.add(hit.tokenAddress);
      hits.push(hit);
    }
  } catch (err) {
    console.warn(`deployer watch: pons match failed: ${summarizeRpcError(err)}`);
  }

  try {
    hits.push(
      ...(await attributePools(db, chain, watches, ctx.launchRows, ponsMatched, ctx.budget)),
    );
  } catch (err) {
    console.warn(`deployer watch: pool attribution failed: ${summarizeRpcError(err)}`);
  }

  try {
    hits.push(...(await scanRegistries(db, chain, watches, ctx.fromBlock, ctx.toBlock)));
  } catch (err) {
    console.warn(`deployer watch: registry pass failed: ${summarizeRpcError(err)}`);
  }

  try {
    hits.push(...(await scanCreates(db, chain, watches)));
  } catch (err) {
    console.warn(`deployer watch: create pass failed: ${summarizeRpcError(err)}`);
  }

  const won: DeployerHit[] = [];
  const attempted = new Set<number>();
  const creates: DeployerHit[] = [];
  for (const hit of hits) {
    // The weak road does not claim the row: collected here and decided after
    // the launches, so a wallet that deploys scaffolding is still watched for
    // the coin it deploys next.
    if (!isTerminalRoad(hit.via)) {
      creates.push(hit);
      continue;
    }
    // One attempt per watch per pass: the row can only fire once, and the
    // second UPDATE would be a wasted write for an answer we already have.
    if (attempted.has(hit.watchId)) continue;
    attempted.add(hit.watchId);
    try {
      if (await recordHit(db, hit)) won.push(hit);
    } catch (err) {
      // The write failed, so this watch is STILL ACTIVE — but the evidence is
      // range-bound on three of the four roads and the cursor moves on, so the
      // honest reading is that this hit is lost rather than deferred. Silence
      // either way: never a message we cannot prove we recorded.
      console.warn(`deployer watch: could not record hit ${hit.watchId}: ${summarizeRpcError(err)}`);
    }
  }
  for (const hit of creates) {
    // A watch that just fired on a launch has said its piece for this pass; the
    // launch is the stronger account of the same wallet's minute, and two
    // messages about one wallet in one pass is not the near-silent rule.
    if (attempted.has(hit.watchId)) continue;
    attempted.add(hit.watchId);
    won.push(hit);
  }

  if (won.length > 0) {
    console.log(`deployer watch: ${won.length} watched address(es) launched`);
  }
  return won;
}

/**
 * THE GAP AFTER AN OUTAGE, read once for the watchlist alone.
 *
 * `planRange` refuses to backfill more than DISCOVERY.backfillMaxHours, so a
 * long outage makes the tick STEP OVER blocks nothing will ever read again.
 * That bound is right for the discovery feed (a launch nobody saw for three
 * hours is not news) and wrong for this feature, whose whole promise is one
 * message about one address a member typed in — three of its four roads are
 * range-bound, so the skipped blocks are a silent hole in exactly the coverage
 * `/overseer deployers` reports as "watching".
 *
 * So the cheapest road is run over the gap on its own: ONE `eth_getLogs` on the
 * PONS factory with `TokenLaunched` and the watched addresses as an
 * indexed-topic OR-filter (verified on this RPC 2026-09-08: an array in a topic
 * position narrowed 49 launches to 3). The response is bounded by the
 * watchlist, but the REQUEST count is bounded by how long we were down, so it
 * is capped at DEPLOYER_WATCH.backfillMaxChunks and reads the MOST RECENT part
 * of the gap — the part that is still news. Whatever is left is said out loud
 * rather than covered up: an uncovered range is the one thing a member cannot
 * find out any other way.
 *
 * Roads 2, 3 and 4 are not backfilled. The pool road would need a sender read
 * per pool chain-wide across the whole gap, the registry road one more query
 * per chunk, and the CREATE road is gap-immune already — its mark is a nonce,
 * not a block.
 */
export async function catchUpPonsLaunches(
  db: Db,
  chain: ChainClient,
  fromBlock: number,
  toBlock: number,
): Promise<DeployerHit[]> {
  if (!Number.isFinite(fromBlock) || !Number.isFinite(toBlock) || toBlock < fromBlock) return [];

  let watches: DeployerWatchRow[];
  try {
    watches = await activeWatches(db);
  } catch (err) {
    console.warn(`deployer watch: could not read the watchlist: ${summarizeRpcError(err)}`);
    return [];
  }
  // Nobody is watching, so nobody lost coverage: the gap costs nothing.
  if (watches.length === 0) return [];

  // The provider's cap is LEARNED from a refusal, so it is null exactly when a
  // long gap is most likely: a container that just restarted. Falling back to
  // the gap's own width there made `affordable` the whole gap and the
  // backfillMaxChunks bound a no-op — the single getLogs then chunked itself
  // against the learned cap up to DISCOVERY.maxLogChunksPerQuery (40) instead of
  // this road's 8. The planning default is the honest floor to bound against.
  const chunkBlocks = Math.max(1, chain.maxLogRange?.() ?? DISCOVERY.maxBlocksPerRequest);
  const affordable = chunkBlocks * DEPLOYER_WATCH.backfillMaxChunks;
  const start = Math.max(fromBlock, toBlock - affordable + 1);
  if (start > fromBlock) {
    console.warn(
      `deployer watch: outage gap ${fromBlock}-${toBlock} is wider than the ` +
        `${DEPLOYER_WATCH.backfillMaxChunks}-chunk catch-up — blocks ${fromBlock}-${start - 1} ` +
        `were NOT checked for ${watches.length} watched address(es)`,
    );
  }

  let logs: ChainLog[];
  try {
    logs = await chain.getLogs({
      address: [PONS_V2_FACTORY],
      topics: [
        TOPICS.tokenLaunched,
        null,
        null,
        watches.map((w) => addressTopic(w.address)),
      ],
      fromBlock: start,
      toBlock,
    });
  } catch (err) {
    // The gap is gone either way; a failed catch-up is one log line, never a
    // thrown tick — the cursor has already moved past these blocks.
    console.warn(`deployer watch: outage catch-up failed: ${summarizeRpcError(err)}`);
    return [];
  }

  const won: DeployerHit[] = [];
  const attempted = new Set<number>();
  for (const hit of matchPonsLaunches(watches, logs)) {
    if (attempted.has(hit.watchId)) continue;
    attempted.add(hit.watchId);
    try {
      if (await recordHit(db, hit)) won.push(hit);
    } catch (err) {
      console.warn(
        `deployer watch: could not record catch-up hit ${hit.watchId}: ${summarizeRpcError(err)}`,
      );
    }
  }
  if (won.length > 0) {
    console.log(`deployer watch: ${won.length} launch(es) recovered from the outage gap`);
  }
  return won;
}
