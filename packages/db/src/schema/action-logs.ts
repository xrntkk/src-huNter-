import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import { sessions } from './sessions.js'

export const actionLogs = sqliteTable('action_logs', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  iteration: integer('iteration').notNull(),
  stepType: text('step_type', {
    enum: ['thinking', 'reasoning', 'tool_call', 'tool_result', 'tool_error', 'finish', 'system_nudge', 'plan_update'],
  }).notNull(),
  toolName: text('tool_name'),
  toolArgs: text('tool_args', { mode: 'json' }),
  result: text('result', { mode: 'json' }),
  error: text('error'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
})
