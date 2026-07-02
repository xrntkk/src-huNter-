import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import { sessions } from './sessions.js'

export const sessionTimelines = sqliteTable('session_timelines', {
  sessionId: text('session_id')
    .primaryKey()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  timelineData: text('timeline_data').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})
