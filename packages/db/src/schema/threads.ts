import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import { sessions } from './sessions.js'

export const threads = sqliteTable('threads', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  title: text('title'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
})
