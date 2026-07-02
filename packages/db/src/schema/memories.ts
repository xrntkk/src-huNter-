import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import { sessions } from './sessions.js'

/**
 * Agent-authored long-term memory nodes. Distinct from `target_memory`
 * (auto-extracted host summaries) and `facts` (structured pentest findings):
 * `memories` are free-form notes the agent itself decides to record via the
 * `memory` tool — lessons, hypotheses, reusable context — and links between
 * them form the memory graph rendered in the 'memory' LeftTab.
 */
export const memories = sqliteTable('memories', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  /** Coarse category, e.g. 'note' | 'lesson' | 'hypothesis' | 'todo'. Free-form. */
  kind: text('kind').notNull().default('note'),
  title: text('title').notNull(),
  content: text('content').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
})
