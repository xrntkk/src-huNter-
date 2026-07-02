import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core'

export const telemetryEvents = sqliteTable('telemetry_events', {
  id: text('id').primaryKey(),
  sessionId: text('session_id'),
  threadId: text('thread_id'),
  iteration: integer('iteration'),
  type: text('type').notNull(),
  toolName: text('tool_name'),
  modelId: text('model_id'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  cacheReadTokens: integer('cache_read_tokens'),
  cacheWriteTokens: integer('cache_write_tokens'),
  durationMs: integer('duration_ms'),
  costUsd: real('cost_usd'),
  data: text('data'),
  createdAt: integer('created_at').notNull(),
})
