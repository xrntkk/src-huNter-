/**
 * Agent-type loader — merges built-in sub-agent roles (agent-types.ts) with
 * user-defined roles loaded from `config/agents/*.yaml`. User definitions
 * override built-ins by name, mirroring the skills loader pattern:
 *   - source of truth for custom roles: config/agents/<name>.yaml
 *   - enable/disable state: config/agents.json  ({ disabled: string[] })
 *   - reloadAgents() drops the cache so the next access re-scans
 *
 * `model: inherit` in YAML is treated as "no override" (field left undefined).
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import yaml from 'js-yaml'
import { BUILT_IN_AGENTS, type AgentTypeDefinition } from './agent-types.js'

const AGENTS_DIR = resolve(process.cwd(), '..', '..', 'config', 'agents')
const AGENTS_CONFIG = resolve(process.cwd(), '..', '..', 'config', 'agents.json')

export type AgentSource = 'built-in' | 'custom'

export interface AgentTypeInfo extends AgentTypeDefinition {
  source: AgentSource
  enabled: boolean
}

function readDisabled(): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(AGENTS_CONFIG, 'utf-8')) as { disabled?: string[] }
    return new Set(parsed.disabled ?? [])
  } catch {
    return new Set()
  }
}

function writeDisabled(disabled: Set<string>): void {
  mkdirSync(resolve(process.cwd(), '..', '..', 'config'), { recursive: true })
  writeFileSync(AGENTS_CONFIG, JSON.stringify({ disabled: [...disabled].sort() }, null, 2) + '\n')
}

/** Parse one YAML agent file into a definition. Returns undefined on bad shape. */
function parseAgentYaml(raw: string): AgentTypeDefinition | undefined {
  let doc: unknown
  try {
    doc = yaml.load(raw)
  } catch {
    return undefined
  }
  if (!doc || typeof doc !== 'object') return undefined
  const o = doc as Record<string, unknown>
  const name = typeof o.name === 'string' ? o.name.trim() : ''
  const systemPrompt = typeof o.system_prompt === 'string' ? o.system_prompt : ''
  if (!name || !systemPrompt) return undefined

  const toStrArray = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined
  const model = typeof o.model === 'string' && o.model !== 'inherit' ? o.model : undefined
  const tools = toStrArray(o.tools)
  const disallowedTools = toStrArray(o.disallowed_tools)

  return {
    name,
    description: typeof o.description === 'string' ? o.description : name,
    ...(typeof o.when_to_use === 'string' ? { whenToUse: o.when_to_use } : {}),
    systemPrompt,
    ...(tools ? { tools } : {}),
    ...(disallowedTools ? { disallowedTools } : {}),
    ...(typeof o.max_iterations === 'number' ? { maxIterations: o.max_iterations } : {}),
    ...(model ? { model } : {}),
    ...(typeof o.background === 'boolean' ? { background: o.background } : {}),
  }
}

interface AgentCache {
  mtimeMs: number
  custom: AgentTypeDefinition[]
}
let cache: AgentCache | undefined

function dirMtime(): number {
  try {
    return statSync(AGENTS_DIR).mtimeMs
  } catch {
    return 0
  }
}

/** Scan config/agents/*.yaml fresh. */
function discoverCustomFresh(): AgentTypeDefinition[] {
  if (!existsSync(AGENTS_DIR)) return []
  try {
    return readdirSync(AGENTS_DIR, { withFileTypes: true })
      .filter(d => d.isFile() && /\.(ya?ml)$/i.test(d.name))
      .map(d => parseAgentYaml(readFileSync(join(AGENTS_DIR, d.name), 'utf-8')))
      .filter((a): a is AgentTypeDefinition => !!a)
  } catch {
    return []
  }
}

function discoverCustom(): AgentTypeDefinition[] {
  const mtime = dirMtime()
  if (cache && cache.mtimeMs === mtime) return cache.custom
  const custom = discoverCustomFresh()
  cache = { mtimeMs: mtime, custom }
  return custom
}

/** Force a re-scan on next access. Call from the settings reload hook. */
export function reloadAgents(): void {
  cache = undefined
}

/** Merge built-ins with custom YAML defs; custom overrides built-in by name. */
function mergedDefs(): Array<{ def: AgentTypeDefinition; source: AgentSource }> {
  const byName = new Map<string, { def: AgentTypeDefinition; source: AgentSource }>()
  for (const def of BUILT_IN_AGENTS) byName.set(def.name, { def, source: 'built-in' })
  for (const def of discoverCustom()) byName.set(def.name, { def, source: 'custom' })
  return [...byName.values()]
}

/**
 * Resolve an agent type by name. Returns disabled types too — a saved sub-agent
 * referencing a now-disabled type should still rehydrate its role on resume.
 */
export function resolveAgentType(name: string): AgentTypeDefinition | undefined {
  return mergedDefs().find(e => e.def.name === name)?.def
}

/** List every known type (built-in + custom) with source + enabled state, for the settings UI. */
export function listAgentTypes(): AgentTypeInfo[] {
  const disabled = readDisabled()
  return mergedDefs()
    .map(({ def, source }) => ({ ...def, source, enabled: !disabled.has(def.name) }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Only the enabled types — used to build the catalog injected into the prompt. */
function enabledDefs(): AgentTypeDefinition[] {
  const disabled = readDisabled()
  return mergedDefs().filter(e => !disabled.has(e.def.name)).map(e => e.def)
}

export function buildAgentTypeCatalog(): string {
  const defs = enabledDefs()
  if (defs.length === 0) return ''
  const blocks = defs.map(a => {
    const lines = [`### \`${a.name}\` — ${a.description}`]
    const toolList = a.tools && a.tools.length > 0 ? a.tools.join(', ') : '继承父 Agent 完整工具集'
    lines.push(`- Tools: ${toolList}`)
    const iters = a.maxIterations ? `${a.maxIterations}` : '由父 Agent 设定'
    lines.push(`- Max iterations: ${iters} | Model: ${a.model ?? 'inherit'}`)
    if (a.whenToUse) lines.push(`- When to use: ${a.whenToUse}`)
    return lines.join('\n')
  })
  return (
    `## 可用子 Agent 类型 (agentType)\n\n` +
    `指定 agentType 后，子 Agent 使用该角色专属的系统提示和受限工具集；不指定则继承父 Agent 的完整工具集。\n\n` +
    `${blocks.join('\n\n')}\n\n` +
    `使用方式: spawn_agent({ agentType: "名称", mode: "async", prompt: "..." })`
  )
}

// ─── CRUD helpers (used by the settings route) ──────────────────────────────

const NAME_RE = /^[a-z0-9_-]+$/i

function agentFilePath(name: string): string {
  return join(AGENTS_DIR, `${name}.yaml`)
}

/** Raw YAML for a custom agent. Built-ins have no file → returns undefined. */
export function readCustomAgentYaml(name: string): string | undefined {
  if (!NAME_RE.test(name)) return undefined
  const p = agentFilePath(name)
  return existsSync(p) ? readFileSync(p, 'utf-8') : undefined
}

/** Write (create or overwrite) a custom agent YAML file. Validates name + shape. */
export function writeCustomAgent(name: string, content: string): { ok: true } | { error: string } {
  if (!NAME_RE.test(name)) return { error: 'Invalid name (letters, digits, _ and - only)' }
  if (!parseAgentYaml(content)) {
    return { error: 'Invalid agent YAML: requires at least `name:` and `system_prompt:`' }
  }
  mkdirSync(AGENTS_DIR, { recursive: true })
  writeFileSync(agentFilePath(name), content)
  reloadAgents()
  return { ok: true }
}

/** Delete a custom agent file. Built-ins (no file) cannot be deleted. */
export function deleteCustomAgent(name: string): boolean {
  const p = agentFilePath(name)
  if (!existsSync(p)) return false
  rmSync(p, { force: true })
  reloadAgents()
  return true
}

export function setAgentEnabled(name: string, enabled: boolean): void {
  const disabled = readDisabled()
  if (enabled) disabled.delete(name)
  else disabled.add(name)
  writeDisabled(disabled)
  reloadAgents()
}


