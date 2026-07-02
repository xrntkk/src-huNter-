/**
 * Vitest global setup — runs once before any test module is imported.
 *
 * The @src-agent/db package resolves its sqlite path from DATABASE_URL at
 * import time and caches the handle as a module-level singleton. We must point
 * it at a disposable per-run database BEFORE any code touches getDb(), so tests
 * never read or mutate the real ./data/src-agent.db.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'src-agent-test-'))
process.env.DATABASE_URL = join(dir, 'test.db')
