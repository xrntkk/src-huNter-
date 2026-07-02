import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import { sessions } from './sessions.js'

export const endpoints = sqliteTable('endpoints', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  /** Hostname extracted from `url` (e.g. "example.com"). Indexed for cross-session memory lookups. Nullable for legacy rows. */
  host: text('host'),
  method: text('method', {
    enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'UNKNOWN'],
  })
    .notNull()
    .default('UNKNOWN'),
  pathTemplate: text('path_template').notNull(),
  description: text('description'),
  verificationStatus: text('verification_status', {
    enum: ['unverified', 'verified_safe', 'verified_vulnerable'],
  }).notNull().default('unverified'),
  params: text('params', { mode: 'json' }),
  sampleRequest: text('sample_request', { mode: 'json' }),
  sampleResponse: text('sample_response', { mode: 'json' }),
  source: text('source', {
    enum: ['js_parse', 'network_intercept', 'page_link', 'form', 'manual'],
  }).notNull(),
  sourceUrl: text('source_url'),
  techStack: text('tech_stack', { mode: 'json' }).$type<string[]>().notNull().default([]),
  riskHints: text('risk_hints', { mode: 'json' }).$type<string[]>().notNull().default([]),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
})
