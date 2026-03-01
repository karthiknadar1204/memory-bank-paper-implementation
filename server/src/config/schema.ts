import {
  pgTable,
  serial,
  bigserial,
  varchar,
  timestamp,
  integer,
  jsonb,
  text,
  date,
  index,
  unique,
  real,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }).unique().notNull(),
  password: varchar('password', { length: 255 }).notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});

export const conversationMessages = pgTable(
  'conversation_messages',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sessionId: varchar('session_id', { length: 255 }),
    messageId: varchar('message_id', { length: 255 }).unique().notNull(),
    role: varchar('role', { length: 32 }).notNull(),
    content: text('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    strength: integer('strength').notNull().default(1),
    lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    retention: real('retention'),
    metadata: jsonb('metadata').default({}),
  },
  (t) => [
    index('idx_conversation_messages_user_id_created').on(t.userId, t.createdAt),
    index('idx_conversation_messages_user_id_last_accessed').on(t.userId, t.lastAccessedAt),
    index('idx_conversation_messages_message_id').on(t.messageId),
  ]
);

export const dailySummaries = pgTable(
  'daily_summaries',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    summaryDate: date('summary_date').notNull(),
    summaryText: text('summary_text').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    strength: integer('strength').notNull().default(3),
    lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    metadata: jsonb('metadata').default({}),
  },
  (t) => [
    unique('daily_summaries_user_id_summary_date_key').on(t.userId, t.summaryDate),
    index('idx_daily_summaries_user_id_date').on(t.userId, t.summaryDate),
  ]
);

export const userGlobalMemory = pgTable('user_global_memory', {
  userId: integer('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  globalSummaryText: text('global_summary_text'),
  portraitText: text('portrait_text'),
  traitsJson: jsonb('traits_json'),
  version: integer('version').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  strength: integer('strength').notNull().default(5),
  lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  metadata: jsonb('metadata').default({}),
});
