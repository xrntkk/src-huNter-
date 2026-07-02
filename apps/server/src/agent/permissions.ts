/**
 * Permission system — allow/deny/ask rules for tool execution.
 *
 * Design:
 * - allow: execute immediately.
 * - ask: pause the loop and request interactive user approval (HITL). On
 *   approval the tool runs; on denial a tool_error is recorded. Unknown core
 *   tools and dangerous filesystem ops resolve to 'ask'.
 * - deny: hard block, never executes (e.g. MCP tools not in the allowlist).
 */

import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { logger } from '../logger/index.js'

export type PermissionBehavior = 'allow' | 'deny' | 'ask'

export interface PermissionRule {
  toolName: string
  behavior: PermissionBehavior
  argFilter?: Record<string, string>
}

export interface PermissionDecision {
  behavior: PermissionBehavior
  reason: string
}

/**
 * On-disk shape of `config/permissions.json`. Used by `loadRulesFromConfig()`
 * and the `GET/PATCH /settings/permissions` routes.
 */
export interface PermissionConfigFile {
  rules: PermissionRule[]
}

const DEFAULT_RULES: PermissionRule[] = [
  // Dangerous filesystem operations — require explicit user approval rather
  // than a hard block, so the user can authorize a delete per-call.
  { toolName: 'file_system', behavior: 'ask', argFilter: { action: 'delete' } },
  { toolName: 'file_system', behavior: 'ask', argFilter: { action: 'rm' } },
  { toolName: 'file_system', behavior: 'ask', argFilter: { action: 'rmdir' } },
  // Safe filesystem operations
  { toolName: 'file_system', behavior: 'allow', argFilter: { action: 'read' } },
  { toolName: 'file_system', behavior: 'allow', argFilter: { action: 'list' } },
  { toolName: 'file_system', behavior: 'allow', argFilter: { action: 'write' } },
  // Core tools always allowed
  { toolName: 'http_request', behavior: 'allow' },
  { toolName: 'web_search', behavior: 'allow' },
  { toolName: 'gather_intel', behavior: 'allow' },
  { toolName: 'add_endpoint', behavior: 'allow' },
  { toolName: 'add_endpoints_batch', behavior: 'allow' },
  { toolName: 'import_endpoints', behavior: 'allow' },
  { toolName: 'export_endpoints', behavior: 'allow' },
  { toolName: 'memory', behavior: 'allow' },
  { toolName: 'add_finding', behavior: 'allow' },
  { toolName: 'delete_finding', behavior: 'ask' },
  { toolName: 'update_finding', behavior: 'allow' },
  { toolName: 'list_endpoints', behavior: 'allow' },
  { toolName: 'update_endpoint_status', behavior: 'allow' },
  { toolName: 'query_knowledge', behavior: 'allow' },
  { toolName: 'load_skill', behavior: 'allow' },
  { toolName: 'write_plan', behavior: 'allow' },
  { toolName: 'spawn_agent', behavior: 'allow' },
  { toolName: 'query_subagent', behavior: 'allow' },
  { toolName: 'abort_subagent', behavior: 'allow' },
  { toolName: 'continue_subagent', behavior: 'allow' },
  { toolName: 'send_message', behavior: 'allow' },
  { toolName: 'python_exec', behavior: 'allow' },
  { toolName: 'bash', behavior: 'allow' },
  { toolName: 'ask_user', behavior: 'allow' },
  // Browser tools
  { toolName: 'browser_navigate', behavior: 'allow' },
  { toolName: 'browser_login_wait', behavior: 'allow' },
  { toolName: 'browser_get_text', behavior: 'allow' },
  { toolName: 'browser_click', behavior: 'allow' },
  { toolName: 'browser_fill', behavior: 'allow' },
  { toolName: 'browser_evaluate', behavior: 'allow' },
  { toolName: 'browser_screenshot', behavior: 'allow' },
  { toolName: 'browser_close', behavior: 'allow' },
]

// ─── Runtime config loading (config/permissions.json) ────────────────────────
//
// Rules are read from `config/permissions.json` so they can be adjusted without
// a code change. `DEFAULT_RULES` is kept as a fallback so a missing or broken
// config file never breaks first-run. The file is re-read lazily on mtime
// change (one `stat` per `getRules()` call) — no file watcher, simple and
// reliable. Mirrors the caching pattern in `model-router.ts`.

const PERMISSIONS_CONFIG_PATH = resolve(process.cwd(), '../../config/permissions.json')

let cachedRules: { data: PermissionRule[] | null; mtime: number } | null = null

/**
 * Read & parse `config/permissions.json`. Returns null when the file is
 * missing or fails to parse (caller falls back to DEFAULT_RULES). Results are
 * cached by mtime: a `stat` per call, full re-read only when the file changed.
 */
function loadRulesFromConfig(): PermissionRule[] | null {
  let mtime: number
  try {
    mtime = statSync(PERMISSIONS_CONFIG_PATH).mtimeMs
  } catch {
    // File missing (or unreadable stat): cache the absence so we don't retry
    // every call. mtime = -1 ensures any future file creation (mtime >= 0)
    // will be detected as a change.
    if (cachedRules?.mtime === -1) return cachedRules.data
    cachedRules = { data: null, mtime: -1 }
    return null
  }

  if (cachedRules && cachedRules.mtime === mtime) {
    return cachedRules.data
  }

  try {
    const raw = readFileSync(PERMISSIONS_CONFIG_PATH, 'utf-8')
    const parsed = JSON.parse(raw) as PermissionConfigFile
    const rules = Array.isArray(parsed.rules) ? parsed.rules : null
    cachedRules = { data: rules, mtime }
    return rules
  } catch (e) {
    logger.error(
      `[Permissions] Failed to parse ${PERMISSIONS_CONFIG_PATH}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    )
    // Cache the parse failure too (with the current mtime) so we don't keep
    // re-reading a broken file until it's actually modified.
    cachedRules = { data: null, mtime }
    return null
  }
}

/**
 * Resolve the active rule set: config file if present & valid, else
 * `DEFAULT_RULES`. This is the single source of truth consumed by
 * `PermissionChecker` and `createSubagentChecker`.
 */
export function getRules(): PermissionRule[] {
  return loadRulesFromConfig() ?? DEFAULT_RULES
}

/**
 * Force-invalidate the rules cache. Call after writing
 * `config/permissions.json` (e.g. PATCH /settings/permissions) so the next
 * `getRules()` re-reads from disk instead of returning the stale cached copy.
 */
export function reloadPermissionsConfig(): void {
  cachedRules = null
}

export class PermissionChecker {
  private rules: PermissionRule[]
  /** MCP tool names explicitly allowed (e.g. "myserver__my_tool"). */
  private mcpAllowlist = new Set<string>()

  constructor(rules: PermissionRule[] = getRules()) {
    this.rules = [...rules]
  }

  /**
   * Allow a set of MCP tool names (format: "serverName__toolName").
   * Call this after McpManager.getToolsForAI() to whitelist discovered tools.
   */
  addMcpAllowlist(toolNames: string[]): void {
    for (const name of toolNames) this.mcpAllowlist.add(name)
  }

  check(toolName: string, args: Record<string, unknown>): PermissionDecision {
    // MCP tools (contain "__"): check allowlist first
    if (toolName.includes('__')) {
      if (this.mcpAllowlist.has(toolName)) {
        return { behavior: 'allow', reason: `MCP tool in allowlist: ${toolName}` }
      }
      return { behavior: 'deny', reason: `MCP tool not in allowlist (fail-closed): ${toolName}` }
    }

    const matches = this.rules.filter(r => {
      if (r.toolName !== toolName) return false
      if (!r.argFilter) return true
      return Object.entries(r.argFilter).every(([k, v]) => args[k] === v)
    })

    if (matches.length === 0) {
      return { behavior: 'ask', reason: `未配置权限规则，工具: ${toolName}` }
    }

    if (matches.some(r => r.behavior === 'deny')) {
      return { behavior: 'deny', reason: `权限规则拒绝: ${toolName}` }
    }
    if (matches.some(r => r.behavior === 'ask')) {
      return { behavior: 'ask', reason: `需要确认: ${toolName}` }
    }
    return { behavior: 'allow', reason: `权限规则允许: ${toolName}` }
  }

  addRule(rule: PermissionRule): void {
    this.rules = this.rules.filter(r => {
      if (r.toolName !== rule.toolName) return true
      if (rule.argFilter && r.argFilter) {
        return !Object.entries(rule.argFilter).every(([k, v]) => r.argFilter![k] === v)
      }
      return !rule.argFilter && !r.argFilter
    })
    this.rules.push(rule)
  }
}

// ─── Subagent permission modes ────────────────────────────────────────────────

export type SubagentPermissionMode = 'inherit' | 'auto_readonly' | 'permissive'

/**
 * Rules for `auto_readonly` mode: all current 'allow' tools stay allowed,
 * but any 'ask' tool (user-confirmation-required) is downgraded to 'deny'
 * so async sub-agents never block waiting for human input.
 *
 * Derived from the live rule set (`getRules()`) rather than a static copy of
 * DEFAULT_RULES, so config-driven rule changes propagate to sub-agents too.
 */
function buildAutoReadonlyRules(rules: PermissionRule[]): PermissionRule[] {
  return rules.map(r => (r.behavior === 'ask' ? { ...r, behavior: 'deny' as const } : r))
}

function buildPermissiveRules(rules: PermissionRule[]): PermissionRule[] {
  return rules.map(r => ({ ...r, behavior: 'allow' as const }))
}

/**
 * Create a PermissionChecker appropriate for a sub-agent's execution mode.
 *
 * - `inherit`: same rules as parent (for sync sub-agents that can surface prompts)
 * - `auto_readonly`: 'ask' rules become 'deny' (async sub-agents can't wait for user)
 * - `permissive`: everything allowed (trusted, explicitly opted-in)
 */
export function createSubagentChecker(
  parentChecker: PermissionChecker | undefined,
  mode: SubagentPermissionMode,
): PermissionChecker | undefined {
  switch (mode) {
    case 'inherit':
      return parentChecker
    case 'auto_readonly':
      return new PermissionChecker(buildAutoReadonlyRules(getRules()))
    case 'permissive':
      return new PermissionChecker(buildPermissiveRules(getRules()))
  }
}
