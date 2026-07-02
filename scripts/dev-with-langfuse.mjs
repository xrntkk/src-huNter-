#!/usr/bin/env node
// One-shot dev launcher: brings up Langfuse + injects keys into apps/server/.env,
// then hands off to `moon run :dev`. Idempotent — re-running won't duplicate
// keys or restart healthy containers.
//
// Usage:  pnpm dev:full
// Skip Langfuse entirely:  pnpm dev (existing behaviour, untouched)

import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const ENV_PATH = resolve(ROOT, 'apps/server/.env')
const COMPOSE_FILE = resolve(ROOT, 'docker-compose.langfuse.yml')
const LANGFUSE_URL = 'http://localhost:3100'
const HEALTH_URL = `${LANGFUSE_URL}/api/public/health`
const READY_TIMEOUT_MS = 180_000

// Keep these in sync with docker-compose.langfuse.yml LANGFUSE_INIT_*.
const PRESET = {
  LANGFUSE_PUBLIC_KEY: 'pk-lf-src-agent-dev',
  LANGFUSE_SECRET_KEY: 'sk-lf-src-agent-dev',
  LANGFUSE_BASE_URL: LANGFUSE_URL,
}

function log(msg) { process.stdout.write(`[dev:full] ${msg}\n`) }
function warn(msg) { process.stderr.write(`[dev:full] ${msg}\n`) }

function dockerAvailable() {
  const r = spawnSync('docker', ['--version'], { stdio: 'ignore' })
  if (r.status !== 0) return false
  const c = spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' })
  return c.status === 0
}

function bringUpLangfuse() {
  log('docker compose up -d (langfuse stack)')
  const r = spawnSync('docker', ['compose', '-f', COMPOSE_FILE, 'up', '-d'], {
    stdio: 'inherit',
    cwd: ROOT,
  })
  if (r.status !== 0) throw new Error('docker compose up failed')
}

async function waitForHealth() {
  const deadline = Date.now() + READY_TIMEOUT_MS
  log(`waiting for ${HEALTH_URL} (up to ${READY_TIMEOUT_MS / 1000}s)`)
  let lastErr = ''
  while (Date.now() < deadline) {
    try {
      const res = await fetch(HEALTH_URL)
      if (res.ok) {
        log('langfuse is ready')
        return
      }
      lastErr = `HTTP ${res.status}`
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err)
    }
    await new Promise(r => setTimeout(r, 2000))
  }
  throw new Error(`langfuse not ready within deadline (last: ${lastErr})`)
}

function ensureEnvKeys() {
  const lines = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf-8').split('\n') : []
  const present = new Set(lines.map(l => l.split('=')[0]?.trim()).filter(Boolean))
  const additions = []
  for (const [k, v] of Object.entries(PRESET)) {
    if (!present.has(k)) additions.push(`${k}=${v}`)
  }
  if (additions.length === 0) {
    log('apps/server/.env already has LANGFUSE_* keys (skip)')
    return
  }
  const sep = lines.length && lines[lines.length - 1].trim() !== '' ? '\n' : ''
  const block = `${sep}\n# Langfuse (auto-injected by dev:full)\n${additions.join('\n')}\n`
  writeFileSync(ENV_PATH, lines.join('\n') + block)
  log(`appended ${additions.length} key(s) to apps/server/.env`)
}

function runMoon() {
  log('starting moon run :dev')
  const proc = spawn('pnpm', ['dev'], { stdio: 'inherit', cwd: ROOT })
  const forward = sig => () => proc.kill(sig)
  process.on('SIGINT', forward('SIGINT'))
  process.on('SIGTERM', forward('SIGTERM'))
  proc.on('exit', code => process.exit(code ?? 0))
}

async function main() {
  if (!dockerAvailable()) {
    warn('docker / docker compose not found — falling back to plain `pnpm dev`')
    warn('install Docker Desktop to enable Langfuse: https://www.docker.com')
    runMoon()
    return
  }
  if (!existsSync(COMPOSE_FILE)) throw new Error(`missing ${COMPOSE_FILE}`)
  if (!existsSync(ENV_PATH)) {
    warn(`apps/server/.env not found — copy .env.example first, then re-run`)
    process.exit(1)
  }
  bringUpLangfuse()
  await waitForHealth()
  ensureEnvKeys()
  log(`Langfuse UI:    ${LANGFUSE_URL}`)
  log(`  login:         dev@src-agent.local / dev-password`)
  log(`  project:       src-agent`)
  runMoon()
}

main().catch(err => {
  warn(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
