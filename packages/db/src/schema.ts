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
    // Set when a dead token comes back; died_at/death_reason are kept as the
    // last-death record, so the board can show "revived" plus that history.
    revivedAt: timestamp('revived_at', { withTimezone: true }),
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
  },
  (t) => [primaryKey({ columns: [t.groupId, t.userId] })],
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
