/**
 * Plan four — post-compact context re-attachment.
 *
 * After `MessageStore.compress()` drops the oldest 70% of messages and
 * prepends an LLM summary, the model can lose load-bearing state that the
 * summary inevitably elides: the active Plan, the endpoint targets the
 * loop is currently working on, and the names of any skills the loop
 * already pulled into context.
 *
 * This module assembles a single high-density `system` message that is
 * unshifted onto the store right after compression succeeds. It is
 * budget-bounded (default 30k tokens) and prioritised: Plan > Skills >
 * Endpoints. Skills already inlined in the system prompt (via the prompt
 * builder's dynamic context boundary) are skipped to avoid duplication.
 *
 * Sections always carry a "更新时间" footer so the model can self-judge
 * staleness instead of treating the snapshot as fresh.
 */
import type { ModelMessage } from 'ai'
import type { ObservationStore } from './observation-store.js'

export interface ReattachBudget {
  totalTokens: number
  perSectionTokens: number
}

export interface ReattachContext {
  threadId: string
  observationStore: ObservationStore | null
  planNotes: string | null
  loadedSkillNames: string[]
}

const DEFAULT_BUDGET: ReattachBudget = {
  totalTokens: 30_000,
  perSectionTokens: 5_000,
}

function envInt(name: string): number | undefined {
  const raw = process.env[name]
  if (!raw) return undefined
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

function resolveBudget(): ReattachBudget {
  return {
    totalTokens: envInt('POST_COMPACT_REATTACH_BUDGET_TOKENS') ?? DEFAULT_BUDGET.totalTokens,
    perSectionTokens: envInt('POST_COMPACT_REATTACH_PER_SECTION_TOKENS') ?? DEFAULT_BUDGET.perSectionTokens,
  }
}

function isDisabled(): boolean {
  const raw = (process.env.POST_COMPACT_REATTACH ?? 'on').toLowerCase()
  return raw === 'off' || raw === '0' || raw === 'false'
}

/** Char ≈ 0.55 token heuristic (matches MessageStore.estimateTokens). */
function tokenCost(s: string): number {
  return Math.ceil(s.length * 0.55)
}

/**
 * Truncate a section body to fit `tokens`. We measure in tokens but trim by
 * characters for speed; on overflow, append a "[已截断 N 项]" footer when
 * `truncatedItemCount` is known.
 */
function fitToTokens(body: string, tokens: number, truncatedItemCount?: number): string {
  if (tokenCost(body) <= tokens) return body
  const charBudget = Math.max(0, Math.floor(tokens / 0.55) - 30)
  const slice = body.slice(0, charBudget)
  const note = truncatedItemCount && truncatedItemCount > 0 ? `\n[…已截断 ${truncatedItemCount} 项]` : '\n[…内容超出预算被截断]'
  return slice + note
}

/**
 * Build the Plan Notes section. Returns null when no plan notes exist.
 */
function buildPlanNotesSection(ctx: ReattachContext, tokens: number): string | null {
  if (!ctx.planNotes) return null
  const body = ['### 当前计划笔记', ctx.planNotes].join('\n')
  return fitToTokens(body, tokens)
}

/**
 * Build the Skills section. We only emit names; the bodies are already in
 * the system prompt (prompt-builder loads them after the cache boundary),
 * so duplicating them here would just inflate input tokens.
 */
function buildSkillsSection(ctx: ReattachContext, tokens: number): string | null {
  if (ctx.loadedSkillNames.length === 0) return null
  const body = [
    '### 已加载 Skill',
    `当前已加载（无需重新 load_skill）：${ctx.loadedSkillNames.join(', ')}`,
  ].join('\n')
  return fitToTokens(body, tokens)
}

/**
 * Build the Endpoint section from the ObservationStore. Includes endpoint facts
 * with brief metadata; truncates to fit budget.
 */
function buildEndpointSection(ctx: ReattachContext, tokens: number): string | null {
  if (!ctx.observationStore) return null
  const endpoints = ctx.observationStore.getFactsByType('endpoint' as never)
  if (endpoints.length === 0) return null
  const lines: string[] = ['### 进行中的目标 Endpoint']
  let kept = 0
  let dropped = 0
  for (const fact of endpoints) {
    let preview = ''
    try {
      const c = fact.content as unknown
      if (typeof c === 'string') preview = c
      else if (c && typeof c === 'object') preview = JSON.stringify(c)
    } catch { preview = '(unrenderable)' }
    const line = `- [${fact.id.slice(0, 8)}] ${preview.slice(0, 200)}`
    if (tokenCost(lines.join('\n') + '\n' + line) > tokens) { dropped++; continue }
    lines.push(line); kept++
  }
  if (kept === 0) return null
  if (dropped > 0) lines.push(`[…超出预算，已省略 ${dropped} 个端点]`)
  return lines.join('\n')
}

/**
 * Build the full reattach message. Returns null when nothing meaningful
 * could be assembled (no plan, no skills, no endpoints) or the feature is
 * disabled via env. The message is shaped as a `system` ModelMessage so
 * `toModelMessages()` carries it through to the next streamText call.
 */
export function buildReattachMessage(ctx: ReattachContext): ModelMessage | null {
  if (isDisabled()) return null
  const budget = resolveBudget()
  // Reserve ~600 tokens for the framing prose / footer.
  const headerCost = 800
  const remainingTotal = Math.max(0, budget.totalTokens - headerCost)

  const planBudget = Math.min(budget.perSectionTokens, remainingTotal)
  const planSection = buildPlanNotesSection(ctx, planBudget)
  let used = planSection ? tokenCost(planSection) : 0

  const skillsBudget = Math.min(budget.perSectionTokens, Math.max(0, remainingTotal - used))
  const skillsSection = buildSkillsSection(ctx, skillsBudget)
  used += skillsSection ? tokenCost(skillsSection) : 0

  const endpointBudget = Math.min(budget.perSectionTokens, Math.max(0, remainingTotal - used))
  const endpointSection = buildEndpointSection(ctx, endpointBudget)

  const sections = [planSection, skillsSection, endpointSection].filter(Boolean) as string[]
  if (sections.length === 0) return null

  const now = new Date().toISOString()
  const body = [
    '## 压缩后上下文复原',
    '以下信息从历史摘要无法完整复原，特此重注入。请把它当作"上次更新于此刻的快照"，必要时主动核对。',
    '',
    ...sections,
    '',
    `_更新时间: ${now}_`,
  ].join('\n')
  return { role: 'system', content: body }
}
