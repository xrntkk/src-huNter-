import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

export const subagentTasks = sqliteTable('subagent_tasks', {
  taskId: text('task_id').primaryKey(),
  parentThreadId: text('parent_thread_id').notNull(),
  description: text('description').notNull(),
  status: text('status', { enum: ['running', 'completed', 'failed', 'aborted'] }).notNull(),
  startedAt: integer('started_at').notNull(),
  finishedAt: integer('finished_at'),
  toolCallCount: integer('tool_call_count').notNull().default(0),
  toolErrorCount: integer('tool_error_count').notNull().default(0),
  endpointsFound: integer('endpoints_found').notNull().default(0),
  findingsFound: integer('findings_found').notNull().default(0),
  summary: text('summary'),
  error: text('error'),
  progress: text('progress'),
})
