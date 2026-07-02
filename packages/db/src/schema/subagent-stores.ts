import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

export const subagentStores = sqliteTable('subagent_stores', {
  taskId: text('task_id').primaryKey(),
  storeData: text('store_data').notNull(),
  systemPrompt: text('system_prompt'),
  agentType: text('agent_type'),
  createdAt: integer('created_at').notNull(),
})
