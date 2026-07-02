import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core'
import { memories } from './memories.js'

/**
 * Directed relations between `memories` nodes. `relation` is a free-form label
 * (e.g. 'relates_to' | 'caused_by' | 'supersedes'). Composite PK on
 * (from, to, relation) makes link insertion idempotent.
 */
export const memoryEdges = sqliteTable(
  'memory_edges',
  {
    from: text('from_id')
      .notNull()
      .references(() => memories.id, { onDelete: 'cascade' }),
    to: text('to_id')
      .notNull()
      .references(() => memories.id, { onDelete: 'cascade' }),
    relation: text('relation').notNull().default('relates_to'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.from, t.to, t.relation] }),
  }),
)
