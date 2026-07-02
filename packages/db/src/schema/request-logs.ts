import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import { sessions } from './sessions.js'

export const requestLogs = sqliteTable('request_logs', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  method: text('method').notNull(),
  url: text('url').notNull(),
  requestHeaders: text('request_headers', { mode: 'json' }),
  requestBody: text('request_body'),
  responseStatus: integer('response_status'),
  responseBody: text('response_body'),
  testPurpose: text('test_purpose'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
})
