import {index, integer, primaryKey, sqliteTable, text} from 'drizzle-orm/sqlite-core';

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  displayName: text('display_name').notNull(),
  role: text('role').notNull().default('student'),
  createdAt: integer('created_at').notNull(),
});

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
