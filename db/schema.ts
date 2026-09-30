import {index, integer, primaryKey, sqliteTable, text, uniqueIndex} from 'drizzle-orm/sqlite-core';

export const customPhrases = sqliteTable('custom_phrases', {
  id: text('id').primaryKey(),
  textRu: text('text_ru').notNull(),
  textEn: text('text_en').notNull().default(''),
  nameKey: text('name_key').notNull(),
  createdAt: integer('created_at').notNull(),
}, table => [uniqueIndex('idx_custom_phrases_name_key').on(table.nameKey)]);

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  displayName: text('display_name').notNull(),
  role: text('role').notNull().default('student'),
  createdAt: integer('created_at').notNull(),
});

export const emailCredentials = sqliteTable('email_credentials', {
  accountId: text('account_id').primaryKey().references(() => accounts.id),
  emailKey: text('email_key').notNull(),
  salt: text('salt').notNull(),
  passwordHash: text('password_hash').notNull(),
  iterations: integer('iterations').notNull(),
  failedAttempts: integer('failed_attempts').notNull().default(0),
  lockedUntil: integer('locked_until').notNull().default(0),
  createdAt: integer('created_at').notNull(),
}, table => [uniqueIndex('idx_email_credentials_email').on(table.emailKey)]);

export const emailSessions = sqliteTable('email_sessions', {
  tokenHash: text('token_hash').primaryKey(),
  accountId: text('account_id').notNull().references(() => accounts.id),
  expiresAt: integer('expires_at').notNull(),
  createdAt: integer('created_at').notNull(),
}, table => [index('idx_email_sessions_account').on(table.accountId)]);

export const lessonMaterials = sqliteTable('lesson_materials', {
  phraseId: text('phrase_id').primaryKey(),
  instructionsRu: text('instructions_ru').notNull().default(''),
  instructionsEn: text('instructions_en').notNull().default(''),
  videoKey: text('video_key'),
  updatedAt: integer('updated_at').notNull(),
});

export const lessonProgress = sqliteTable('lesson_progress', {
  userId: text('user_id').notNull().references(() => accounts.id),
  phraseId: text('phrase_id').notNull(),
  status: text('status').notNull(),
  startedAt: integer('started_at').notNull(),
  completedAt: integer('completed_at'),
}, table => [
  primaryKey({columns: [table.userId, table.phraseId]}),
  index('idx_lesson_progress_user').on(table.userId),
]);
