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
    tokenId: integer('token_id')
      .notNull()
      .references(() => tokens.id),
    type: text('type', { enum: ['nuke', 'buy_opp'] }).notNull(),
    firedAt: timestamp('fired_at', { withTimezone: true }).notNull().defaultNow(),
    /** Market cap at fire time; details carries the peak/drop that triggered it. */
    mcapUsd: doublePrecision('mcap_usd'),
    details: jsonb('details'),
  },
  // Every fired row is also the cooldown record: the poller asks "did this
  // (group, token, type) fire recently?" on every tick a condition holds.
  (t) => [index('alerts_cooldown_idx').on(t.groupId, t.tokenId, t.type, t.firedAt)],
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
