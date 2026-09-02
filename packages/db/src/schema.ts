import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Groups use a surrogate PK: Telegram reassigns chat ids on basic-group ->
 * supergroup migration, so the external id must be a mutable column, not the
 * key everything references. Telegram ids are negative for supergroups; they
 * fit in JS numbers (|id| < 2^53) but need BIGINT in Postgres.
 */
export const groups = pgTable('groups', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  chatId: bigint('chat_id', { mode: 'number' }).notNull().unique(),
  title: text('title'),
  slug: text('slug').notNull().unique(),
  status: text('status', { enum: ['active', 'removed'] }).notNull().default('active'),
  settings: jsonb('settings').notNull().default({}),
  addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
});

export const tokens = pgTable(
  'tokens',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    chainId: integer('chain_id').notNull(),
    address: text('address').notNull(), // stored lowercase
    symbol: text('symbol'),
    name: text('name'),
    imageUrl: text('image_url'),
    socials: jsonb('socials'),
    launchpad: text('launchpad'),
    phase: text('phase', { enum: ['unresolved', 'curve', 'graduated', 'dead'] })
      .notNull()
      .default('unresolved'),
    poolAddress: text('pool_address'),
    tokenCreatedAt: timestamp('token_created_at', { withTimezone: true }),
    graduatedAt: timestamp('graduated_at', { withTimezone: true }),
    diedAt: timestamp('died_at', { withTimezone: true }),
    deathReason: text('death_reason'),
    // The freshest cached mcap when the death was stamped (docs/decisions.md
    // round 15). Written from the token's OWN column inside the death UPDATE:
    // for poll-path deaths that is the reading the verdict was reached on; a
    // rug-expiry death runs on the sweep's own clock, so there it can trail
    // died_at by up to the probation poll interval (~30 min). Null for deaths
    // stamped before this column existed.
    mcapAtDeath: doublePrecision('mcap_at_death'),
    // Set when a dead token comes back; died_at/death_reason are kept as the
    // last-death record, so the board can show "revived" plus that history.
    revivedAt: timestamp('revived_at', { withTimezone: true }),
    // Rug probation (docs/decisions.md round 6). Set when the token has been
    // under the rug floor for an hour: the calls vanish from every board
    // section, but nothing is dead or binned yet. Cleared by a revival, by a
    // repost, or by the expiry that turns probation into the permanent rug.
    rugHiddenAt: timestamp('rug_hidden_at', { withTimezone: true }),
    // Set when probation ended in a comeback. Drives the Reviving section and
    // its badge for 24h; deliberately NOT cleared when it goes stale (a later
    // hide clears it) — the board filters by the window instead.
    revivingAt: timestamp('reviving_at', { withTimezone: true }),
    // Latest polled market state, cached on the token (M2 poller fills these).
    priceUsd: doublePrecision('price_usd'),
    mcapUsd: doublePrecision('mcap_usd'),
    liquidityUsd: doublePrecision('liquidity_usd'),
    vol24Usd: doublePrecision('vol24_usd'),
    // Trades in the last 24h as of the last poll that could measure them
    // (docs/decisions.md round 21). DexScreener's txns.h24 buys+sells, or
    // GeckoTerminal's transactions.h24 for the pool-batched tiers. NULL means
    // the reading carried no trade count — never zero trades, and the flatline
    // rule treats it as no evidence.
    txns24: integer('txns24'),
    // Round 21's flatline clock: when the "far off peak, no volume, no trades"
    // condition FIRST held continuously. Set on the reading that starts the
    // run, cleared by any reading that breaks it (a null reading breaks it —
    // unknown is not evidence), and six hours of it is the death.
    flatSince: timestamp('flat_since', { withTimezone: true }),
    // ...and the COVERAGE behind that clock (round 21 amendment a): how many
    // polls have actually held the condition inside the current run, and when
    // the last of them was. An outage is not six quiet hours, so elapsed time
    // alone may not kill: the death also needs the readings and an unbroken
    // run (a reading whose predecessor is older than the gap ceiling starts a
    // new run). Both are reset by the same reading that clears flat_since.
    flatReadings: integer('flat_readings').notNull().default(0),
    flatLastAt: timestamp('flat_last_at', { withTimezone: true }),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
    // As-of marker for the cached market fields above: set ONLY when they are
    // written. last_polled_at advances on data-less polls, so it says nothing
    // about staleness.
    lastSnapshotAt: timestamp('last_snapshot_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('tokens_chain_address_uq').on(t.chainId, t.address)],
);

export const calls = pgTable(
  'calls',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    groupId: integer('group_id')
      .notNull()
      .references(() => groups.id),
    tokenId: integer('token_id')
      .notNull()
      .references(() => tokens.id),
    callerUserId: bigint('caller_user_id', { mode: 'number' }).notNull(),
    callerName: text('caller_name').notNull(),
    messageId: bigint('message_id', { mode: 'number' }).notNull(),
    calledAt: timestamp('called_at', { withTimezone: true }).notNull(),
    // Call-relative market data: Groupie's moat (M2 fills/updates these).
    mcapAtCall: doublePrecision('mcap_at_call'),
    liquidityAtCall: doublePrecision('liquidity_at_call'),
    peakMcapSinceCall: doublePrecision('peak_mcap_since_call'),
    peakAt: timestamp('peak_at', { withTimezone: true }),
    mentionsCount: integer('mentions_count').notNull().default(1),
    lastMentionAt: timestamp('last_mention_at', { withTimezone: true }).notNull(),
    status: text('status', { enum: ['active', 'died', 'binned'] }).notNull().default('active'),
    // Per-call death record. A call can die on its own liquidity collapse while
    // the token still trades, so the token's died_at/death_reason cannot
    // represent this — and a revived token's retained history would misdate a
    // later per-call death. Stamped at every flip to 'died'; kept on revival as
    // the last-death record, exactly like tokens.died_at/death_reason.
    diedAt: timestamp('died_at', { withTimezone: true }),
    deathReason: text('death_reason'),
    // Mcap at THIS call's death, stamped with died_at/death_reason so the three
    // always describe the same death (docs/decisions.md round 15). The died
    // rail printed the last polled mcap and labelled it "at death"; this is the
    // real number, and null means the rail must not make the claim at all.
    mcapAtDeath: doublePrecision('mcap_at_death'),
    // Round 21's member verdict: the display name of whoever marked this call
    // dead, as the bot would print it. Non-null EXACTLY when death_reason is
    // 'member' — every rule death leaves it null, which is what lets the board
    // tell a verdict from a rule without parsing the reason string. A member
    // we cannot name is still stamped (UNNAMED_MEMBER), never left null.
    deathMarkedBy: text('death_marked_by'),
    // Null on a binned call = the SYSTEM binned it (rug auto-removal,
    // docs/decisions.md round 5); a member's bin always records their user id.
    binnedBy: bigint('binned_by', { mode: 'number' }),
    binnedAt: timestamp('binned_at', { withTimezone: true }),
    // Set when a died/binned token is re-mentioned; M2 poller consumes it.
    reviveRequested: boolean('revive_requested').notNull().default(false),
  },
  (t) => [
    uniqueIndex('calls_group_token_uq').on(t.groupId, t.tokenId),
    index('calls_group_activity_idx').on(t.groupId, t.lastMentionAt),
  ],
);

export const mentions = pgTable(
  'mentions',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    callId: integer('call_id')
      .notNull()
      .references(() => calls.id),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    userName: text('user_name').notNull(),
    messageId: bigint('message_id', { mode: 'number' }).notNull(),
    at: timestamp('at', { withTimezone: true }).notNull(),
  },
  // Unique so Telegram's at-least-once update redelivery cannot double-record
  // a sighting; call_id leads, so it also serves per-call lookups.
  (t) => [uniqueIndex('mentions_call_message_uq').on(t.callId, t.messageId)],
);

export const snapshots = pgTable(
  'snapshots',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    tokenId: integer('token_id')
      .notNull()
      .references(() => tokens.id),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    priceUsd: doublePrecision('price_usd'),
    mcapUsd: doublePrecision('mcap_usd'),
    liquidityUsd: doublePrecision('liquidity_usd'),
    vol24Usd: doublePrecision('vol24_usd'),
  },
  (t) => [index('snapshots_token_at_idx').on(t.tokenId, t.at)],
);

/** Disposable cache of getChatMember results. */
export const groupMembers = pgTable(
  'group_members',
  {
    groupId: integer('group_id')
      .notNull()
      .references(() => groups.id),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    status: text('status').notNull(),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
    // The member's Telegram display name as of the last membership check or
    // chat command (round 16c): the only name source for a member who has never
    // posted a call here, which is exactly who a watchlist slot needs to name.
    displayName: text('display_name'),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.userId] })],
);

/**
 * Per-group alert watchlist (docs/decisions.md round 4). A watch is the group's
 * opt-in to bot messages about a coin, so it is group-scoped and survives
 * un-watching as an inactive row (history of who added what).
 */
export const watches = pgTable(
  'watches',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    groupId: integer('group_id')
      .notNull()
      .references(() => groups.id),
    tokenId: integer('token_id')
      .notNull()
      .references(() => tokens.id),
    addedBy: bigint('added_by', { mode: 'number' }).notNull(),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
    active: boolean('active').notNull().default(true),
    /**
     * Market cap when this watch was ACTIVATED (docs/decisions.md round 19) —
     * the BUY OPP baseline. Null while unknown: the token's cached mcap at the
     * moment of the watch, else the first snapshot at/after added_at (the alert
     * pass backfills it), else nothing was ever measured and buy-opp stays off.
     * Re-activating a stopped watch re-stamps it with credit and clock.
     */
    mcapAtWatch: doublePrecision('mcap_at_watch'),
    /**
     * Whether a BUY OPP may still fire for the CURRENT fall below the line
     * (docs/decisions.md round 19). True while the coin is above the line (or
     * has never crossed it), false from the moment one fires until the coin
     * recovers above the line. Explicit state, not inferred from the last two
     * readings: a polling gap or a nuke-suppressed pass must not consume the
     * crossing, and a stalled series must not re-fire it.
     */
    buyOppArmed: boolean('buy_opp_armed').notNull().default(true),
  },
  (t) => [
    uniqueIndex('watches_group_token_uq').on(t.groupId, t.tokenId),
    // The per-member cap (docs/decisions.md round 15) counts a member's active
    // rows in a group on every watch attempt — from the bot AND the web button.
    index('watches_group_member_idx').on(t.groupId, t.addedBy),
  ],
);

export const alerts = pgTable(
  'alerts',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    groupId: integer('group_id')
      .notNull()
      .references(() => groups.id),
    // NULLABLE since migration 0013: a discovery alert (docs/decisions.md
    // rounds 18 and 20) is about a coin the group has never called, so there is
    // no tokens row to point at. `details.address` carries the coin instead.
    // Every watchlist alert still has one.
    tokenId: integer('token_id').references(() => tokens.id),
    // 'launch'/'graduation' joined the family in round 18/20. The column is
    // plain text in Postgres (this enum is a TypeScript claim, not a CHECK), so
    // widening it needs no migration — but the delivery path does branch on the
    // null token id above, which does.
    type: text('type', { enum: ['nuke', 'buy_opp', 'launch', 'graduation'] }).notNull(),
    firedAt: timestamp('fired_at', { withTimezone: true }).notNull().defaultNow(),
    /** Market cap at fire time; details carries the peak/drop that triggered it. */
    mcapUsd: doublePrecision('mcap_usd'),
    details: jsonb('details'),
  },
  (t) => [
    // Every fired row is also the cooldown record: the poller asks "did this
    // (group, token, type) fire recently?" on every tick a condition holds.
    index('alerts_cooldown_idx').on(t.groupId, t.tokenId, t.type, t.firedAt),
    // A discovery alert has no token id, so the cooldown index cannot make it
    // unique — the coin is named by `details.pool`. This partial unique index
    // makes a double send impossible at the SCHEMA level: whatever two
    // overlapping delivery passes decide, only one row per (group, kind, pool)
    // can ever exist, and the insert's ON CONFLICT DO NOTHING turns the loser
    // into "already delivered" rather than an error.
    uniqueIndex('alerts_discovery_pool_uq')
      .on(t.groupId, t.type, sql`(${t.details} ->> 'pool')`)
      .where(sql`${t.type} in ('launch', 'graduation')`),
  ],
);

/**
 * One-time browser handoff (docs/decisions.md round 7). The Mini App is already
 * authenticated via initData; it mints one of these so the system browser can
 * redeem it for the ordinary session cookie and land on the same board.
 *
 * Only the sha256 of the token is stored — the raw secret exists in the link
 * and nowhere else, so a leaked database row cannot be replayed as a login.
 * Rows are short-lived (60s TTL) and cleaned up opportunistically on mint.
 */
export const handoffTokens = pgTable(
  'handoff_tokens',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    /** sha256 hex of the raw token. Unique: it is the lookup key on redeem. */
    tokenHash: text('token_hash').notNull().unique(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    /** Board to land on, copied from the gated group at mint time. */
    slug: text('slug').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Set by the atomic claim; a non-null value is what makes redemption one-shot. */
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // Serves both housekeeping sweeps and the per-user live-token cap.
  (t) => [index('handoff_tokens_user_created_idx').on(t.userId, t.createdAt)],
);

/**
 * Sleepers: the latest chain-wide scan (docs/decisions.md round 9).
 *
 * A snapshot stream, not a tracking table. Each scan inserts its own rows and
 * then deletes every older scan_at — history is not needed, and these tokens
 * are deliberately NOT in `tokens` (nothing here is tracked or polled; a coin
 * only becomes tracked when someone posts it in chat).
 *
 * The scan's own floors guarantee the market columns, so they are NOT NULL:
 * an entry only exists because its mcap landed in a band, its volume cleared
 * the tapering requirement, its pool held liquidity and its age was known.
 */
export const sleeperEntries = pgTable(
  'sleeper_entries',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    scanAt: timestamp('scan_at', { withTimezone: true }).notNull(),
    /**
     * The SLEEPER_BANDS band this entry was bucketed into. Stored as plain
     * numbers, not an enum or a foreign key, so adding a band (round 14 added
     * $1M–$3M) is a constant change and never a migration.
     */
    bandLoUsd: doublePrecision('band_lo_usd').notNull(),
    bandHiUsd: doublePrecision('band_hi_usd').notNull(),
    /** 1-based, by turnover desc within the band. */
    rank: integer('rank').notNull(),
    address: text('address').notNull(), // stored lowercase
    symbol: text('symbol'),
    name: text('name'),
    imageUrl: text('image_url'),
    twitterUrl: text('twitter_url'),
    websiteUrl: text('website_url'),
    poolAddress: text('pool_address').notNull(),
    mcapUsd: doublePrecision('mcap_usd').notNull(),
    vol24Usd: doublePrecision('vol24_usd').notNull(),
    liquidityUsd: doublePrecision('liquidity_usd').notNull(),
    txns24: integer('txns24').notNull(),
    /** vol24 / mcap — the ranking figure, stored so reads never recompute it. */
    turnover: doublePrecision('turnover').notNull(),
    /**
     * Continuous hours inside the band at scan time, off GeckoTerminal candles
     * (docs/decisions.md round 14) — the duration filter reads this. Defaults
     * to 0 so rows written before the column existed (and any scan whose candle
     * reads failed) simply claim no residency rather than a fictional one.
     */
    inBandHours: doublePrecision('in_band_hours').notNull().default(0),
    /**
     * When in_band_hours was last measured off CANDLES (docs/decisions.md round
     * 16b). A scan that finds the address still in the same band carries the
     * figure forward plus the elapsed time and copies this stamp unchanged, so
     * it dates the last real measurement rather than the last scan.
     *
     * NULL means "never measured, or measured before this column existed" —
     * which forces a full OHLCV measurement, the safe answer.
     */
    residencyMeasuredAt: timestamp('residency_measured_at', { withTimezone: true }),
    /**
     * A tokenized stock, ETF or leveraged equity product, decided at scan time
     * by isTokenizedStock (docs/decisions.md round 17). Stored rather than
     * recomputed on read so the toggle answers off the same reading the keep
     * cut used. Defaults to false: a row written before this column existed
     * carries no name evidence either way, and the rule's own answer for an
     * unknown name is false.
     */
    isStock: boolean('is_stock').notNull().default(false),
    poolCreatedAt: timestamp('pool_created_at', { withTimezone: true }),
  },
  // The read is always "the latest scan, band ascending, rank ascending".
  (t) => [index('sleeper_entries_scan_idx').on(t.scanAt, t.bandLoUsd, t.rank)],
);

/**
 * First/last time an address appeared in a scan. Feeds the persistence marker
 * ("on list 9h") — round 9 chose persistence over forced rotation: a coin that
 * still qualifies is still interesting. Pruned by last_listed_at.
 */
export const sleeperSeen = pgTable(
  'sleeper_seen',
  {
    address: text('address').primaryKey(), // stored lowercase
    firstListedAt: timestamp('first_listed_at', { withTimezone: true }).notNull().defaultNow(),
    lastListedAt: timestamp('last_listed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sleeper_seen_last_listed_idx').on(t.lastListedAt)],
);

/**
 * Discovery: what the CHAIN surfaced on its own (docs/decisions.md rounds 18 and
 * 20) — a direct Uniswap launch, or a PONS graduation.
 *
 * Group-agnostic like `sleeper_entries`: one chain listener serves every group,
 * and everything group-specific (the watch pills, the chat threshold) happens at
 * read time. Unlike Sleepers this IS a ledger rather than a snapshot — an event
 * happened at an instant and that instant does not get replaced by the next
 * scan — so rows accumulate and are pruned by age instead of swapped out.
 *
 * Nothing here is tracked or polled the way a call is: a discovery coin becomes
 * a tracked token only when a member posts it in the chat, exactly like a
 * sleeper. The one enrichment pass fills the market columns once, shortly after
 * the event.
 */
export const discoveryEvents = pgTable(
  'discovery_events',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    kind: text('kind', { enum: ['launch', 'graduation'] }).notNull(),
    tokenAddress: text('token_address').notNull(), // stored lowercase
    /**
     * The pool the event created (launch) or migrated into (graduation). A
     * Uniswap v2 pair address, or a v4 32-byte POOL ID — v4 pools are not
     * contracts, and GeckoTerminal reports the id in its own `address` field,
     * so the two surfaces agree on this string.
     *
     * UNIQUE, and that uniqueness is the dedupe: the listener replays block
     * ranges after a restart and must never post the same launch twice.
     */
    poolAddress: text('pool_address').notNull().unique(),
    /** GeckoTerminal/DexScreener dex id, e.g. 'uniswap-v4-robinhood'. */
    dex: text('dex').notNull(),
    /** The instant of the on-chain event, from the block timestamp. */
    at: timestamp('at', { withTimezone: true }).notNull(),
    blockNumber: bigint('block_number', { mode: 'number' }).notNull(),
    txHash: text('tx_hash').notNull(),
    /**
     * Reserve at the event: the DEPOSIT that opened the pool — a v2 pair's own
     * `Mint`, or a v4 creating transaction's quote Transfer minus the same-tx
     * Swap (its `value` when the quote is native ETH). NULL is unknown, never
     * zero: the read failed, or no deposit landed inside the launch window
     * (see apps/server/src/chain/reserve.ts). Such a candidate is never stored
     * as a launch, so a NULL here belongs to a graduation row; an unknown
     * reserve can never clear a chat threshold.
     */
    initialLiquidityEth: doublePrecision('initial_liquidity_eth'),
    initialLiquidityUsd: doublePrecision('initial_liquidity_usd'),
    /**
     * WHICH asset the deposit above was actually made in. An ETH-quoted pool's
     * ETH figure is the measurement and its dollars are derived; a USDG pool is
     * the other way round, and the row must say so or "3.1 ETH" would be
     * printed about a pool nobody put ETH into. Null for a graduation (no
     * deposit is measured) and for rows written before the column existed.
     */
    quoteSymbol: text('quote_symbol', { enum: ['ETH', 'USDG'] }),
    symbol: text('symbol'),
    name: text('name'),
    imageUrl: text('image_url'),
    twitterUrl: text('twitter_url'),
    websiteUrl: text('website_url'),
    /** Latest enrichment (DexScreener); null until the first read succeeds. */
    mcapUsd: doublePrecision('mcap_usd'),
    liquidityUsd: doublePrecision('liquidity_usd'),
    /**
     * GeckoTerminal's locked_liquidity_percentage, 0-100. Null when unknown —
     * which is NOT the same as 0% locked, and the row must say so: Uniswap LP is
     * unlocked unless the team locks it, so "unknown" and "0" would otherwise
     * read alike and one of them is a claim we cannot make.
     */
    lpLockedPct: doublePrecision('lp_locked_pct'),
    /**
     * Bundle facts (docs/decisions.md round 20): the share of total supply
     * bought in the launch block window, 0-100, and the distinct wallets that
     * took it. Null when the logs or the supply could not be read.
     */
    launchBlockPct: doublePrecision('launch_block_pct'),
    launchBlockWallets: integer('launch_block_wallets'),
    /** isTokenizedStock, decided at enrichment when the name arrives. */
    isStock: boolean('is_stock').notNull().default(false),
    /**
     * When the FIRST enrichment succeeded; null = never enriched. Stamped by
     * the DexScreener read alone: folding the GeckoTerminal lock read into the
     * same stamp meant one GT 429 could leave a fully enriched row looking
     * unenriched forever.
     */
    enrichedAt: timestamp('enriched_at', { withTimezone: true }),
    /**
     * When the market figures above were last read — what the board prints as
     * "read 3h ago". Moves on every re-enrichment; `enriched_at` never does.
     */
    dataAsOf: timestamp('data_as_of', { withTimezone: true }),
    /**
     * When the re-enrichment pass last TRIED this row, whether or not
     * DexScreener had a pair for it. `data_as_of` only moves on a real read, so
     * ordering the batch by it alone put the rows nobody can enrich at the front
     * of every pass forever; this stamp is what rotates a no-pair row to the
     * back and lets the rest of the window get read.
     */
    refreshAttemptedAt: timestamp('refresh_attempted_at', { withTimezone: true }),
    /**
     * Every LP-lock attempt, figure or not. Lock reads are ordered by it
     * (falling back to enriched_at), which is what keeps a pool GeckoTerminal
     * cannot answer from heading the queue on every pass until lockGiveUpHours.
     */
    lockAttemptedAt: timestamp('lock_attempted_at', { withTimezone: true }),
    /**
     * Stamped ONLY when GeckoTerminal returned a lock FIGURE. A pool it has not
     * indexed, or one it knows without a figure, stays null so a later pass
     * asks again (rotated by lock_attempted_at) until DISCOVERY.lockGiveUpHours.
     */
    lockCheckedAt: timestamp('lock_checked_at', { withTimezone: true }),
    /**
     * Set when a chat alert went out for this event ANYWHERE. Kept as an
     * operator-facing record only — it is not served and never decides
     * delivery, because "alerted" is a per-GROUP fact and lives in
     * discovery_alert_decisions.
     */
    alertedAt: timestamp('alerted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The zones read "this kind, newest first, inside a window".
    index('discovery_events_kind_at_idx').on(t.kind, t.at),
    // The enrichment pass reads "not enriched yet, oldest first".
    index('discovery_events_enriched_idx').on(t.enrichedAt, t.at),
    // ...and the re-enrichment pass filters on how stale the FIGURES are
    // (data_as_of) before ordering by when the row was last TRIED.
    index('discovery_events_data_as_of_idx').on(t.dataAsOf),
    // "Have we already seen this TOKEN?" — the second-pool / second-fee-tier
    // test, asked once per candidate.
    index('discovery_events_token_idx').on(t.tokenAddress),
  ],
);

/**
 * How far the chain listener has read. One row per chain (`id` = the network
 * slug), so a restart resumes instead of replaying history — bounded by
 * DISCOVERY.backfillMaxHours, which the reader applies rather than the writer:
 * the stored number is always the honest "last block we processed".
 */
export const chainCursor = pgTable('chain_cursor', {
  id: text('id').primaryKey(),
  lastBlock: bigint('last_block', { mode: 'number' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * What the delivery pass DECIDED about one (event, group) pair — including the
 * times it decided not to send.
 *
 * Before this table the pass re-considered every enriched row on every tick and
 * used a global `alerted_at` stamp to stop: an event that failed one group's
 * filter was re-evaluated forever, and an event that passed for one group
 * marked itself delivered for all of them. A decision row per group ends both.
 * It is also the honest source for `DiscoveryEntry.alerted`, which is a
 * per-group fact and was being served from a global column.
 */
export const discoveryAlertDecisions = pgTable(
  'discovery_alert_decisions',
  {
    eventId: integer('event_id')
      .notNull()
      .references(() => discoveryEvents.id, { onDelete: 'cascade' }),
    groupId: integer('group_id')
      .notNull()
      .references(() => groups.id),
    /**
     * 'sent' — a chat message went out. 'capped' — the group was over its
     * hourly ceiling. 'filtered' — the group's own settings or the shared
     * filters said no. 'stale' — the event aged past maxAlertAgeMinutes before
     * anything could be decided about it.
     */
    outcome: text('outcome', { enum: ['sent', 'capped', 'filtered', 'stale'] }).notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.groupId] }),
    // "Which of these events has this group been told about?" — the route's
    // per-group `alerted`, asked once per page.
    index('discovery_decisions_group_idx').on(t.groupId, t.outcome),
  ],
);

export const launchMonitors = pgTable(
  'launch_monitors',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    groupId: integer('group_id')
      .notNull()
      .references(() => groups.id),
    xHandle: text('x_handle').notNull(), // stored lowercase, no leading @
    addedBy: bigint('added_by', { mode: 'number' }).notNull(),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
    status: text('status', { enum: ['active', 'launched', 'expired', 'removed'] })
      .notNull()
      .default('active'),
  },
  // X handles are case-insensitive; enforce that at the DB level too.
  (t) => [uniqueIndex('launch_monitors_group_handle_uq').on(t.groupId, sql`lower(${t.xHandle})`)],
);
