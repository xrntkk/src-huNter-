import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import { threads } from './threads.js'

export const threadTimelines = sqliteTable('thread_timelines', {
  threadId: text('thread_id')
    .primaryKey()
    .references(() => threads.id, { onDelete: 'cascade' }),
  /**
   * Legacy v2/v3 JSON blob. Plan one (JSONL persistence) writes new
   * conversations to a per-thread JSONL file at `jsonlPath` instead, but
   * existing rows keep their blob until the first read migrates them.
   * Nullable for new rows on the JSONL hot path.
   */
  timelineData: text('timeline_data'),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  /**
   * Plan one. Absolute or repo-relative path to the per-thread JSONL log
   * file. Set once when migrating from blob → jsonl, or when a new thread
   * is created with `THREAD_STORAGE=jsonl`. Null ⇒ legacy blob mode.
   */
  jsonlPath: text('jsonl_path'),
  /** Total messages persisted to JSONL — quick UI/debug stat. */
  messageCount: integer('message_count'),
  /** Highest `seq` value written to the JSONL file. Used for crash recovery. */
  lastSeq: integer('last_seq'),
  /**
   * Compression summary persisted out-of-band so the JSONL file can stay
   * append-only message records. When set, MessageStore restores it as
   * the `compression.summary` on load.
   */
  compressedSummary: text('compressed_summary'),
})

