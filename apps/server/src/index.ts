import './instrumentation.js'
import { bootstrapLangfuse } from './instrumentation.js'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { sessionsRouter } from './routes/sessions.js'
import { endpointsRouter } from './routes/endpoints.js'
import { chatRouter } from './routes/chat.js'
import { reportsRouter } from './routes/reports.js'
import { settingsRouter } from './routes/settings.js'
import { workspaceRouter } from './routes/workspace.js'
import { threadsRouter } from './routes/threads.js'
import { systemRouter } from './routes/system.js'
import { telemetryRouter } from './routes/telemetry.js'
import { mcpManager } from './mcp/manager.js'
import { detectClaudeCli } from './utils/claude-cli-detect.js'
import { loadIntelConfig } from './agent/intel/config.js'
import Database from 'better-sqlite3'
import { mkdirSync, existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { logger, errObj } from './logger/index.js'

// ── Global unhandled error handlers ────────────────────────────────────────

process.on('uncaughtException', (err, origin) => {
  logger.fatal({ err: errObj(err), origin }, 'UncaughtException — process will exit')
  // Let pino flush before exiting
  setTimeout(() => process.exit(1), 1000)
})

process.on('unhandledRejection', (reason, promise) => {
  logger.error({ err: errObj(reason), promiseType: typeof promise }, 'UnhandledRejection')
})

// Warn on unhandled warnings
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning') return // suppress Node experimental warnings
  logger.warn({ err: errObj(warning) }, `ProcessWarning: ${warning.name}`)
})

function loadEnvFile() {
  const envPath = resolve(process.cwd(), '.env')
  if (!existsSync(envPath)) return
  try {
    const content = readFileSync(envPath, 'utf-8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const idx = trimmed.indexOf('=')
      if (idx === -1) continue
      const key = trimmed.slice(0, idx).trim()
      const value = trimmed.slice(idx + 1).trim()
      if (key) process.env[key] = value
    }
    logger.info('[Env] Loaded .env file')
  } catch (err) {
    logger.warn({ err: errObj(err) }, '[Env] Failed to load .env')
  }
}

loadEnvFile()
bootstrapLangfuse()

const app = new Hono()

// ── Global middleware ─────────────────────────────────────────────────────

// HTTP request logging (structured)
app.use('*', async (c, next) => {
  const start = Date.now()
  const method = c.req.method
  const path = c.req.path
  try {
    await next()
    const ms = Date.now() - start
    const status = c.res.status
    if (status >= 500) {
      logger.error({ method, path, status, ms }, 'HTTP 5xx')
    } else if (status >= 400) {
      logger.warn({ method, path, status, ms }, 'HTTP 4xx')
    } else {
      logger.info({ method, path, status, ms }, 'HTTP request')
    }
  } catch (err) {
    const ms = Date.now() - start
    logger.error({ method, path, ms, err: errObj(err) }, 'HTTP middleware error')
    throw err
  }
})

app.use(
  '*',
  cors({
    origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  }),
)

// ── Global error handler (must be registered after routes) ─────────────────

app.onError((err, c) => {
  const method = c.req.method
  const path = c.req.path
  logger.error({ err: errObj(err), method, path }, 'Unhandled route error')

  // Hono HTTPException carries a status code
  if ('status' in err && typeof (err as any).status === 'number') {
    const status = (err as any).status as number
    return c.json({ error: (err as Error).message || 'Internal Server Error' }, status as any)
  }

  return c.json({ error: (err as Error).message || 'Internal Server Error' }, 500)
})

app.get('/health', c => c.json({ ok: true, ts: Date.now() }))

app.route('/api/sessions', sessionsRouter)
app.route('/api', endpointsRouter)
app.route('/api', chatRouter)
app.route('/api', reportsRouter)
app.route('/api', settingsRouter)
app.route('/api/sessions', workspaceRouter)
app.route('/api', threadsRouter)
app.route('/api', systemRouter)
app.route('/api/telemetry', telemetryRouter)

const PORT = Number(process.env.PORT ?? 3001)
const DB_URL = resolve(process.cwd(), process.env.DATABASE_URL ?? './data/src-agent.db')

function initDatabase() {
  mkdirSync(dirname(DB_URL), { recursive: true })
  const sqlite = new Database(DB_URL)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
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
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      host TEXT,
      method TEXT NOT NULL DEFAULT 'UNKNOWN',
      path_template TEXT NOT NULL,
      params TEXT,
      sample_request TEXT,
      sample_response TEXT,
      source TEXT NOT NULL,
      source_url TEXT,
      tech_stack TEXT NOT NULL DEFAULT '[]',
      risk_hints TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS findings (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      endpoint_id TEXT REFERENCES endpoints(id) ON DELETE SET NULL,
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
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      method TEXT NOT NULL,
      url TEXT NOT NULL,
      request_headers TEXT,
      request_body TEXT,
      response_status INTEGER,
      response_body TEXT,
      test_purpose TEXT,
      created_at INTEGER NOT NULL
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
  `)
  // Idempotent column migrations for existing databases
  const addColumn = (table: string, column: string, def: string) => {
    try {
      sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`)
    } catch (err: any) {
      if (!/duplicate column name/i.test(String(err?.message))) throw err
    }
  }
  addColumn('endpoints', 'host', 'TEXT')
  addColumn('endpoints', 'description', 'TEXT')
  addColumn('endpoints', 'verification_status', "TEXT NOT NULL DEFAULT 'unverified'")
  addColumn('telemetry_events', 'model_id', 'TEXT')
  addColumn('telemetry_events', 'cost_usd', 'REAL')
  // Create index after ensuring the column exists
  try {
    sqlite.exec('CREATE INDEX IF NOT EXISTS idx_endpoints_host ON endpoints(host)')
  } catch { /* already exists */ }
  sqlite.close()
  logger.info({ dbPath: DB_URL }, '[DB] Tables ready')
}

const TELEMETRY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

function startTelemetryRetentionJob() {
  const sweep = () => {
    try {
      const sqlite = new Database(DB_URL)
      const cutoff = Date.now() - TELEMETRY_RETENTION_MS
      const info = sqlite.prepare('DELETE FROM telemetry_events WHERE created_at < ?').run(cutoff)
      sqlite.close()
      if (info.changes > 0) logger.info({ pruned: info.changes }, '[Telemetry] Retention sweep')
    } catch (err) {
      logger.warn({ err: errObj(err) }, '[Telemetry] Retention sweep failed')
    }
  }
  sweep()
  setInterval(sweep, 6 * 60 * 60 * 1000).unref()
}

async function bootstrap() {
  initDatabase()
  startTelemetryRetentionJob()
  // 把 config/intel.json 中的凭据同步到 process.env，供 gather_intel 工具读取
  loadIntelConfig()

  const cli = detectClaudeCli()
  if (cli.found) {
    logger.info({ version: cli.version, executable: cli.executable }, '[CLI] Claude detected')
  }

  await mcpManager.init()

  serve({ fetch: app.fetch, port: PORT }, () => {
    logger.info({ port: PORT }, '[Server] Running')
  })
}

bootstrap().catch(err => {
  logger.fatal({ err: errObj(err) }, '[Server] Bootstrap failed')
  process.exit(1)
})
