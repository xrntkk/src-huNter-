import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { ClaudeCliInfo } from '@src-agent/types'

let cached: ClaudeCliInfo | null = null
const _resolveCache = new Map<string, string | undefined>()

/**
 * Convert a Git Bash / MSYS2 Unix-style path (/c/Users/...) to a Windows
 * native path (C:\Users\...). On non-Windows or already-native paths this
 * is a no-op.
 */
function toNativePath(p: string): string {
  // /c/Users/... → C:\Users\...
  const msysMatch = p.match(/^\/([a-zA-Z])(\/.*)?$/)
  if (msysMatch) {
    const drive = msysMatch[1].toUpperCase()
    const rest = (msysMatch[2] ?? '').replace(/\//g, '\\')
    return `${drive}:${rest}`
  }
  return p
}

/**
 * Resolve a CLI binary name (e.g. "claude", "claude-internal") to its
 * absolute path on disk via `which`. Returns `undefined` if not found.
 * On Windows, converts Git Bash paths to native Windows paths and appends
 * .exe if needed so the SDK's fs.existsSync check passes.
 */
export function resolveCliExecutable(name: string): string | undefined {
  if (_resolveCache.has(name)) return _resolveCache.get(name)
  let result: string | undefined
  try {
    // stdio: pipe stdout, silence stderr — `which` prints the whole PATH to
    // stderr on a miss, which would otherwise spam the log every iteration.
    const raw = execSync(`which ${name}`, {
      encoding: 'utf-8',
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (raw) {
      let resolved = toNativePath(raw)
      // On Windows, `which` may omit the .exe extension
      if (process.platform === 'win32' && !existsSync(resolved) && existsSync(resolved + '.exe')) {
        resolved = resolved + '.exe'
      }
      result = existsSync(resolved) ? resolved : undefined
    }
  } catch {
    result = undefined
  }
  _resolveCache.set(name, result)
  return result
}

/**
 * Detect whether the Claude Code CLI (`claude`) is installed locally.
 */
export function detectClaudeCli(): ClaudeCliInfo {
  if (cached) return cached
  const exe = resolveCliExecutable('claude')
  if (!exe) {
    cached = { found: false }
    return cached
  }
  try {
    const version = execSync(`"${exe}" --version`, { encoding: 'utf-8', timeout: 2000 }).trim()
    cached = { found: true, version, executable: exe }
  } catch {
    cached = { found: false }
  }
  return cached
}

export function resetClaudeCliCache(): void {
  cached = null
}
