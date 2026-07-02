/**
 * Plan five — MicroCompact: cache-friendly tool-result trimming.
 *
 * Goal: when many medium-sized tool results accumulate over a long Anthropic
 * session, replace the bodies of the *oldest* ones with a marker string so
 * the prefix stays cache-eligible while the conversation tokens come down.
 * The 70%-cut full compress() destroys cache hit rate; microCompact trims
 * surgically so the prefix → cache breakpoint sits unchanged.
 *
 * Activation:
 *   - Only when the bound capability supports cache-edit (Anthropic family).
 *   - Triggered before compress() each iteration. Two thresholds:
 *       * size-based — total tokens of "old" tool-results crosses
 *         `MICRO_COMPACT_TRIGGER_TOKENS` (default 30k).
 *       * time-based — wall clock since the previous trim exceeded the
 *         Anthropic prompt cache TTL (`CACHE_TTL_MS`, default 5min). Cache
 *         is gone anyway, so we re-shape the prefix while it's cheap.
 *
 * Protections:
 *   - Latest `RECENT_KEEP_TURNS` (default 6) message turns keep their
 *     full tool-result bodies — those are still actively reasoned over.
 *   - `PROTECTED_TOOLS` (create_plan / load_skill / add_finding /
 *     add_endpoint / memory) are never trimmed: their results carry IDs
 *     the model rereads, not bulk payload.
 *   - Anything matching the spillover pointer prefix is skipped — that
 *     content was already off-loaded by `result-spillover.ts`.
 *
 * Off-by-default-on-non-Anthropic. ENV `MICRO_COMPACT=on|off|auto` (auto =
 * driven by capability.supportsCacheEdit; the default).
 */
import type { ModelMessage } from 'ai'
import type { ModelCapability } from './model-capabilities.js'
import { logger } from '../logger/index.js'

export interface MicroCompactOptions {
  capability?: ModelCapability | null
  triggerTokens?: number
  recentKeepTurns?: number
  cacheTtlMs?: number
  protectedTools?: ReadonlySet<string>
}

export interface MicroCompactResult {
  cleared: number
  bytesFreed: number
  reason: 'size' | 'ttl' | null
}

const DEFAULT_PROTECTED: ReadonlySet<string> = new Set([
  'create_plan',
  'add_intent',
  'conclude_intent',
  'load_skill',
  'add_endpoint',
  'add_endpoints_batch',
  'add_finding',
  'delete_finding',
  'update_finding',
  'update_endpoint_status',
  'memory',
])

const SPILLOVER_MARKER = '[完整结果已落盘:'
const MICRO_COMPACT_PLACEHOLDER = '[旧工具结果已裁剪——如需可重新调用]'

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function envMode(): 'auto' | 'on' | 'off' {
  const raw = (process.env.MICRO_COMPACT ?? 'auto').toLowerCase()
  if (raw === 'on' || raw === 'true' || raw === '1') return 'on'
  if (raw === 'off' || raw === 'false' || raw === '0') return 'off'
  return 'auto'
}

function shouldRun(opts: MicroCompactOptions): boolean {
  const mode = envMode()
  if (mode === 'off') return false
  if (mode === 'on') return true
  // auto: only when capability declares cache-edit support.
  return Boolean(opts.capability?.supportsCacheEdit)
}

/**
 * Char × 0.55 ≈ tokens. Matches MessageStore.estimateTokens — we don't need
 * provider-accurate counts, only a stable ordering.
 */
function approxTokens(str: string): number {
  return Math.ceil(str.length * 0.55)
}

function previewLooksSpilled(value: unknown): boolean {
  if (typeof value !== 'string') return false
  return value.includes(SPILLOVER_MARKER) || value === MICRO_COMPACT_PLACEHOLDER
}

interface ToolResultRef {
  msgIndex: number
  partIndex: number
  toolName: string
  toolCallId: string
  approxTokens: number
}

function collectStaleToolResults(
  messages: readonly ModelMessage[],
  recentKeepTurns: number,
  protectedTools: ReadonlySet<string>,
): { stale: ToolResultRef[]; recentCutoff: number } {
  // Walk from the end; the last `recentKeepTurns` user-rooted turns are
  // protected. A "turn" is anchored at a user message — so we scan back
  // until we have crossed `recentKeepTurns` user messages.
  let userSeen = 0
  let cutoff = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      userSeen++
      if (userSeen >= recentKeepTurns) { cutoff = i; break }
    }
  }
  const stale: ToolResultRef[] = []
  for (let mi = 0; mi < cutoff; mi++) {
    const m = messages[mi]
    if (m.role !== 'tool' || typeof m.content === 'string') continue
    for (let pi = 0; pi < m.content.length; pi++) {
      const part = m.content[pi]
      if (part.type !== 'tool-result') continue
      if (protectedTools.has(part.toolName)) continue
      const out = part.output
      if (!out || (out.type !== 'text' && out.type !== 'json')) continue
      const value = (out as { value: unknown }).value
      if (previewLooksSpilled(value)) continue
      const raw = typeof value === 'string' ? value : JSON.stringify(value)
      stale.push({
        msgIndex: mi,
        partIndex: pi,
        toolName: part.toolName,
        toolCallId: part.toolCallId,
        approxTokens: approxTokens(raw),
      })
    }
  }
  return { stale, recentCutoff: cutoff }
}

/**
 * In-place clear: rebuilds the offending message with the trimmed parts.
 * Returns the number of cleared parts and the byte reclaim. Mutates
 * `messages` directly so the caller's MessageStore sees the change without
 * re-serialising.
 */
function applyClears(messages: ModelMessage[], targets: ToolResultRef[]): { cleared: number; bytesFreed: number } {
  if (targets.length === 0) return { cleared: 0, bytesFreed: 0 }
  // Group by msgIndex so each message is rebuilt once.
  const byMsg = new Map<number, Set<number>>()
  for (const t of targets) {
    let s = byMsg.get(t.msgIndex)
    if (!s) { s = new Set(); byMsg.set(t.msgIndex, s) }
    s.add(t.partIndex)
  }
  let cleared = 0
  let bytesFreed = 0
  for (const [mi, partIdxs] of byMsg) {
    const m = messages[mi]
    if (m.role !== 'tool' || typeof m.content === 'string') continue
    const next = m.content.map((part, pi) => {
      if (!partIdxs.has(pi) || part.type !== 'tool-result') return part
      const out = part.output
      if (!out || (out.type !== 'text' && out.type !== 'json')) return part
      const beforeStr = typeof (out as { value: unknown }).value === 'string'
        ? ((out as { value: string }).value)
        : JSON.stringify((out as { value: unknown }).value)
      bytesFreed += beforeStr.length - MICRO_COMPACT_PLACEHOLDER.length
      cleared++
      return {
        ...part,
        output: { type: 'text' as const, value: MICRO_COMPACT_PLACEHOLDER },
      }
    })
    messages[mi] = { ...m, content: next } as ModelMessage
  }
  return { cleared, bytesFreed }
}

/**
 * Track per-thread last-trim time so the time-based gate fires at most
 * once per cache TTL window. Using a module-level Map keeps the API
 * pure-functional from the caller's POV (no class state to thread).
 */
const lastTrimAtMs = new Map<string, number>()

/**
 * Run microCompact against an in-memory message list. Returns counts so
 * the caller can emit telemetry. Caller is responsible for keying by
 * threadId — pass any stable opaque string (`threadId` from the agent
 * loop) to the time-based gate.
 */
export function microCompactInPlace(
  threadId: string,
  messages: ModelMessage[],
  opts: MicroCompactOptions = {},
): MicroCompactResult {
  const result: MicroCompactResult = { cleared: 0, bytesFreed: 0, reason: null }
  if (!shouldRun(opts)) return result

  const triggerTokens = envInt('MICRO_COMPACT_TRIGGER_TOKENS', opts.triggerTokens ?? 30_000)
  const recentKeepTurns = opts.recentKeepTurns ?? envInt('MICRO_COMPACT_KEEP_TURNS', 6)
  const cacheTtlMs = opts.cacheTtlMs ?? envInt('MICRO_COMPACT_CACHE_TTL_MS', 5 * 60_000)
  const protectedTools = opts.protectedTools ?? DEFAULT_PROTECTED

  const { stale } = collectStaleToolResults(messages, recentKeepTurns, protectedTools)
  if (stale.length === 0) return result

  const totalStaleTokens = stale.reduce((acc, x) => acc + x.approxTokens, 0)
  const now = Date.now()
  const last = lastTrimAtMs.get(threadId) ?? 0
  const ttlExpired = last > 0 && now - last >= cacheTtlMs

  let triggered: 'size' | 'ttl' | null = null
  if (totalStaleTokens >= triggerTokens) triggered = 'size'
  else if (ttlExpired) triggered = 'ttl'

  if (!triggered) return result

  const applied = applyClears(messages, stale)
  lastTrimAtMs.set(threadId, now)
  result.cleared = applied.cleared
  result.bytesFreed = applied.bytesFreed
  result.reason = triggered
  if (applied.cleared > 0) {
    logger.info(`[microCompact] thread=${threadId} reason=${triggered} cleared=${applied.cleared} bytesFreed=${applied.bytesFreed}`)
  }
  return result
}

export const __testing = { collectStaleToolResults, applyClears, MICRO_COMPACT_PLACEHOLDER }
