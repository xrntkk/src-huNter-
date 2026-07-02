import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import { sessions } from './sessions.js'

export type FactType =
  | 'endpoint'
  | 'vuln_candidate'
  | 'verified_vuln'
  | 'tech_stack'
  | 'false_positive'
  | 'domain'
  | 'service'
  | 'note'

export interface FactContent {
  [key: string]: unknown
}

export const facts = sqliteTable('facts', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  threadId: text('thread_id').notNull(),
  type: text('type', {
    enum: ['endpoint', 'vuln_candidate', 'verified_vuln', 'tech_stack', 'false_positive', 'domain', 'service', 'note'],
  }).notNull(),
  /** Structured fact payload (endpoint URL, vuln details, etc.) */
  content: text('content', { mode: 'json' }).notNull(),
  /** Origin: tool name or agent identifier that produced this fact */
  source: text('source').notNull(),
  /** Optional tool call ID that created this fact */
  sourceToolCallId: text('source_tool_call_id'),
  /** Parent fact IDs this fact derives from (JSON string[]) */
  basedOnFactIds: text('based_on_fact_ids', { mode: 'json' }).$type<string[]>(),
  /** Confidence 0-100 */
  confidence: integer('confidence'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
})
