import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  domain: text('domain').notNull(),
  title: text('title'),
  status: text('status', {
    enum: ['idle', 'crawling', 'ready', 'testing', 'completed'],
  })
    .notNull()
    .default('idle'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})
