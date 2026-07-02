import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from './schema/index.js'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export * from './schema/index.js'
export { schema }

const DB_URL = process.env.DATABASE_URL ?? './data/src-agent.db'

let _db: ReturnType<typeof drizzle> | null = null

function ensureTables(sqlite: any) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      domain TEXT NOT NULL,
      title TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS endpoints (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      url TEXT NOT NULL,
      method TEXT NOT NULL DEFAULT 'UNKNOWN',
      path_template TEXT NOT NULL,
      description TEXT,
      verification_status TEXT NOT NULL DEFAULT 'unverified',
      params TEXT,
      sample_request TEXT,
      sample_response TEXT,
      source TEXT NOT NULL,
      source_url TEXT,
      host TEXT,
      tech_stack TEXT NOT NULL DEFAULT '[]',
      risk_hints TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS findings (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      endpoint_id TEXT,
      type TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      repro_steps TEXT NOT NULL DEFAULT '[]',
      evidence TEXT,
      status TEXT NOT NULL DEFAULT 'unconfirmed',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS request_logs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      method TEXT NOT NULL,
      url TEXT NOT NULL,
      request_headers TEXT,
      request_body TEXT,
      response_status INTEGER,
      response_body TEXT,
      test_purpose TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS action_logs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      iteration INTEGER NOT NULL,
      step_type TEXT NOT NULL,
      tool_name TEXT,
      tool_args TEXT,
      result TEXT,
      error TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_timelines (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      timeline_data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      title TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS thread_timelines (
      thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
      timeline_data TEXT,
      updated_at INTEGER NOT NULL,
      jsonl_path TEXT,
      message_count INTEGER,
      last_seq INTEGER,
      compressed_summary TEXT
    );

    CREATE TABLE IF NOT EXISTS target_memory (
      id             TEXT PRIMARY KEY,
      host           TEXT NOT NULL,
      session_id     TEXT,
      thread_id      TEXT,
      summary        TEXT NOT NULL,
      tech_stack     TEXT NOT NULL DEFAULT '[]',
      endpoint_count INTEGER NOT NULL DEFAULT 0,
      finding_count  INTEGER NOT NULL DEFAULT 0,
      updated_at     INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_target_memory_host ON target_memory(host);
    CREATE INDEX IF NOT EXISTS idx_endpoints_host ON endpoints(host);

    CREATE TABLE IF NOT EXISTS subagent_tasks (
      task_id TEXT PRIMARY KEY,
      parent_thread_id TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      tool_call_count INTEGER NOT NULL DEFAULT 0,
      tool_error_count INTEGER NOT NULL DEFAULT 0,
      endpoints_found INTEGER NOT NULL DEFAULT 0,
      findings_found INTEGER NOT NULL DEFAULT 0,
      summary TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_subagent_tasks_thread ON subagent_tasks(parent_thread_id);

    CREATE TABLE IF NOT EXISTS telemetry_events (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      thread_id TEXT,
      iteration INTEGER,
      type TEXT NOT NULL,
      tool_name TEXT,
      model_id TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      duration_ms INTEGER,
      cost_usd REAL,
      data TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_telemetry_session ON telemetry_events(session_id);
    CREATE INDEX IF NOT EXISTS idx_telemetry_thread ON telemetry_events(thread_id);
    CREATE INDEX IF NOT EXISTS idx_telemetry_type ON telemetry_events(type);
    CREATE INDEX IF NOT EXISTS idx_telemetry_created ON telemetry_events(created_at);

    CREATE TABLE IF NOT EXISTS subagent_stores (
      task_id TEXT PRIMARY KEY,
      store_data TEXT NOT NULL,
      system_prompt TEXT,
      agent_type TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT NOT NULL,
      source_tool_call_id TEXT,
      based_on_fact_ids TEXT,
      confidence INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_facts_session ON facts(session_id);
    CREATE INDEX IF NOT EXISTS idx_facts_thread ON facts(thread_id);
    CREATE INDEX IF NOT EXISTS idx_facts_type ON facts(type);


    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      kind TEXT NOT NULL DEFAULT 'note',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);

    CREATE TABLE IF NOT EXISTS memory_edges (
      from_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      to_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      relation TEXT NOT NULL DEFAULT 'relates_to',
      created_at INTEGER NOT NULL,
      PRIMARY KEY (from_id, to_id, relation)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_edges_from ON memory_edges(from_id);
    CREATE INDEX IF NOT EXISTS idx_memory_edges_to ON memory_edges(to_id);
  `)
}

export function getDb() {
  if (_db) return _db
  mkdirSync(dirname(DB_URL), { recursive: true })
  const sqlite = new Database(DB_URL)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  ensureTables(sqlite)
  migrateColumns(sqlite)
  _db = drizzle(sqlite, { schema })
  return _db
}

/**
 * Idempotent column additions for tables created by older versions.
 * CREATE TABLE IF NOT EXISTS won't add new columns to an existing table,
 * so we ALTER TABLE here and swallow the "duplicate column" error.
 */
function migrateColumns(sqlite: any) {
  const addColumn = (table: string, column: string, def: string) => {
    try {
      sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`)
    } catch (err: any) {
      // SQLite throws if the column already exists — that's the expected no-op.
      if (!/duplicate column name/i.test(String(err?.message))) throw err
    }
  }
  addColumn('endpoints', 'description', 'TEXT')
  addColumn('endpoints', 'verification_status', "TEXT NOT NULL DEFAULT 'unverified'")
  addColumn('endpoints', 'host', 'TEXT')
  // Index on the newly added column (CREATE INDEX IF NOT EXISTS is idempotent)
  try {
    sqlite.exec('CREATE INDEX IF NOT EXISTS idx_endpoints_host ON endpoints(host)')
  } catch { /* already exists */ }

  addColumn('subagent_tasks', 'progress', 'TEXT')
  addColumn('telemetry_events', 'model_id', 'TEXT')
  addColumn('telemetry_events', 'cost_usd', 'REAL')

  // Drop legacy intents table (replaced by model-driven plan notes).
  try { sqlite.exec('DROP TABLE IF EXISTS intents') } catch { /* ignore */ }
  try { sqlite.exec('DROP INDEX IF EXISTS idx_intents_session') } catch { /* ignore */ }
  try { sqlite.exec('DROP INDEX IF EXISTS idx_intents_thread') } catch { /* ignore */ }
  try { sqlite.exec('DROP INDEX IF EXISTS idx_intents_status') } catch { /* ignore */ }

  // Plan one: per-thread JSONL persistence metadata.
  addColumn('thread_timelines', 'jsonl_path', 'TEXT')
  addColumn('thread_timelines', 'message_count', 'INTEGER')
  addColumn('thread_timelines', 'last_seq', 'INTEGER')
  addColumn('thread_timelines', 'compressed_summary', 'TEXT')
}

export async function runMigrations() {
  const db = getDb()
  migrate(db, { migrationsFolder: './src/migrations' })
}
