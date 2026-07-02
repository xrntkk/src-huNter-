import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import { sessions } from './sessions.js'
import { endpoints } from './endpoints.js'

export const findings = sqliteTable('findings', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  endpointId: text('endpoint_id').references(() => endpoints.id, {
    onDelete: 'set null',
  }),
  type: text('type', {
    enum: ['idor', 'sqli', 'xss', 'ssrf', 'ssti', 'rce', 'logic', 'auth_bypass', 'info_disclosure', 'other'],
  }).notNull(),
  severity: text('severity', {
    enum: ['info', 'low', 'medium', 'high', 'critical'],
  }).notNull(),
  title: text('title').notNull(),
  description: text('description'),
  reproSteps: text('repro_steps', { mode: 'json' }).$type<string[]>().notNull().default([]),
  evidence: text('evidence', { mode: 'json' }),
  status: text('status', {
    enum: ['unconfirmed', 'confirmed', 'false_positive'],
  })
    .notNull()
    .default('unconfirmed'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
})
