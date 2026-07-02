import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

/**
 * Cross-session "lessons learned" per target host.
 *
 * One row per host (UPSERT on host). Populated by the agent finish hook
 * when a session has produced ≥1 endpoint. Read back at session start to
 * inject "what we already know about this host" into the dynamic prompt
 * context — letting subsequent scans skip already-explored directions.
 */
export const targetMemory = sqliteTable('target_memory', {
  id: text('id').primaryKey(),
  host: text('host').notNull(),
  /** Originating session — nullable when the row gets cross-session merged. */
  sessionId: text('session_id'),
  /** Originating thread — nullable for the same reason. */
  threadId: text('thread_id'),
  /** ≤200 字 自然语言总结：技术栈、已验证的发现、下次应跳过的方向。 */
  summary: text('summary').notNull(),
  techStack: text('tech_stack', { mode: 'json' }).$type<string[]>().notNull().default([]),
  endpointCount: integer('endpoint_count').notNull().default(0),
  findingCount: integer('finding_count').notNull().default(0),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})
