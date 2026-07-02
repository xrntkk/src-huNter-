import { STATIC_PROMPT_SECTIONS, DYNAMIC_BOUNDARY, type SystemPromptSection } from '../prompts/system.js'
import { loadSkillsForContext } from './skill-loader.js'
import { buildToolCatalog } from './tool-catalog.js'
import { buildAgentTypeCatalog } from './agent-loader.js'
import type { Tool } from 'ai'
import type { SkillRegistry } from './skill-registry.js'
import type { ObservationStore } from './observation-store.js'
import type { PlanNotes } from './plan-notes.js'

export { type SystemPromptSection } from '../prompts/system.js'

export interface PromptBuilderOptions {
  endpointContext?: string
  targetMemoryContext?: string
  relevantMemoryContext?: string
  observationStore?: ObservationStore
  planNotes?: PlanNotes
  selectedEndpointIds?: string[]
  skillRegistry: SkillRegistry
  /**
   * Skill names the user narrowed the agent down to for this turn.
   * Empty/undefined = full catalog visible. Affects only the catalog rendering;
   * already-loaded skill bodies (via `load_skill`) remain in the system prompt
   * regardless of visibility.
   */
  visibleSkillNames?: string[]
  mcpInstructionContext?: string
  /** Live tool map (or getter for late binding) — used to render the dynamic tool catalog. */
  toolMap?: Record<string, Tool> | (() => Record<string, Tool>)
  /** Render the agentType catalog into the dynamic section (defaults to true). */
  includeAgentTypeCatalog?: boolean
  getObserverSection?: () => string
  /** Called each build(); returns progress summary when compression just happened. */
  getPostCompressionProgress?: () => string
}

function section(title: string, content?: string): string {
  if (!content || !content.trim()) return ''
  return `## ${title}\n${content.trim()}`
}

/**
 * Rough token estimate: ~4 chars per token for Chinese text, ~3.5 for mixed.
 */
function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 3.8)
}

/**
 * Cache-aware, section-based prompt builder.
 *
 * Static sections (identity, rules, tools, workflow, style, input protocol)
 * stay stable across turns to maximize prompt prefix cache hits. Dynamic
 * sections (plan, memory, facts, MCP, skills) are appended after the
 * DYNAMIC_BOUNDARY marker.
 */
export class PromptBuilder {
  private readonly endpointContext?: string
  private readonly targetMemoryContext?: string
  private readonly relevantMemoryContext?: string
  private readonly observationStore?: ObservationStore
  private readonly planNotes?: PlanNotes
  private readonly selectedEndpointIds?: string[]
  private readonly skillRegistry: SkillRegistry
  private readonly visibleSkillNames?: string[]
  private readonly mcpInstructionContext?: string
  private readonly toolMap?: Record<string, Tool> | (() => Record<string, Tool>)
  private readonly includeAgentTypeCatalog: boolean
  private readonly getObserverSection?: () => string
  private readonly getPostCompressionProgress?: () => string

  constructor(options: PromptBuilderOptions) {
    this.endpointContext = options.endpointContext
    this.targetMemoryContext = options.targetMemoryContext
    this.relevantMemoryContext = options.relevantMemoryContext
    this.observationStore = options.observationStore
    this.planNotes = options.planNotes
    this.selectedEndpointIds = options.selectedEndpointIds
    this.skillRegistry = options.skillRegistry
    this.visibleSkillNames = options.visibleSkillNames
    this.mcpInstructionContext = options.mcpInstructionContext
    this.toolMap = options.toolMap
    this.includeAgentTypeCatalog = options.includeAgentTypeCatalog ?? true
    this.getObserverSection = options.getObserverSection
    this.getPostCompressionProgress = options.getPostCompressionProgress
  }

  private renderToolCatalog(): string {
    if (!this.toolMap) return ''
    const m = typeof this.toolMap === 'function' ? this.toolMap() : this.toolMap
    if (!m || Object.keys(m).length === 0) return ''
    return buildToolCatalog(m)
  }

  /**
   * Build all prompt sections (static + dynamic) as structured data.
   * Useful for debugging, token analysis, and cache management.
   */
  buildSections(): SystemPromptSection[] {
    // Catalog reflects user-narrowed visibility (if any). Already-loaded
    // skill bodies live in the dynamic `loaded_skills` section below and
    // are not affected by the visibility filter.
    const skillsContext = loadSkillsForContext(this.visibleSkillNames)
    // When the visibility set is non-empty, the catalog becomes turn-specific
    // and must NOT be cached as part of the static prefix — otherwise other
    // threads with different selections would hit a stale cached prefix.
    const catalogIsDynamic = !!(this.visibleSkillNames && this.visibleSkillNames.length > 0)
    const staticWithSkills: SystemPromptSection[] = [
      ...STATIC_PROMPT_SECTIONS,
      ...(skillsContext && !catalogIsDynamic
        ? [{ name: 'base_skills', content: skillsContext, cacheable: true }]
        : []),
    ]

    const observationsContext = this.observationStore?.buildContextPrompt({ selectedEndpointIds: this.selectedEndpointIds }) ?? ''
    const planNotesContent = this.planNotes?.get() ?? ''

    const dynamicSections: SystemPromptSection[] = [
      { name: 'post_compression_progress', content: this.getPostCompressionProgress?.() ?? '', cacheable: false },
      ...(catalogIsDynamic && skillsContext
        ? [{ name: 'visible_skills_catalog', content: skillsContext, cacheable: false }]
        : []),
      { name: 'tool_catalog', content: this.renderToolCatalog(), cacheable: false },
      { name: 'agent_type_catalog', content: this.includeAgentTypeCatalog ? buildAgentTypeCatalog() : '', cacheable: true },
      { name: 'plan_notes', content: section('当前计划', planNotesContent), cacheable: false },
      { name: 'observer', content: section('近期进展（Observer 策展）', this.getObserverSection?.() ?? ''), cacheable: true },
      { name: 'endpoint_context', content: section('已选接口上下文', this.endpointContext), cacheable: true },
      { name: 'target_memory', content: this.targetMemoryContext?.trim() ?? '', cacheable: true },
      { name: 'relevant_memory', content: this.relevantMemoryContext?.trim() ?? '', cacheable: true },
      { name: 'observations', content: section('当前态势（观测数据）', observationsContext), cacheable: false },
      { name: 'mcp_instructions', content: section('MCP 服务说明', this.mcpInstructionContext), cacheable: false },
      { name: 'loaded_skills', content: this.skillRegistry.buildSystemFragment(), cacheable: true },
    ].filter(s => s.content.trim() !== '')

    return [...staticWithSkills, ...dynamicSections]
  }

  /**
   * Build the full system prompt as a single string (backward-compatible).
   * Static sections are joined first, then DYNAMIC_BOUNDARY, then dynamic sections.
   */
  build(): string {
    const sections = this.buildSections()
    const staticNames = new Set(STATIC_PROMPT_SECTIONS.map(s => s.name))
    staticNames.add('base_skills')

    const staticParts = sections.filter(s => staticNames.has(s.name)).map(s => s.content)
    const dynamicParts = sections.filter(s => !staticNames.has(s.name)).map(s => s.content)

    const parts = [...staticParts]
    if (dynamicParts.length > 0) {
      parts.push(DYNAMIC_BOUNDARY)
      parts.push(...dynamicParts)
    }

    return parts.filter(Boolean).join('\n\n---\n\n')
  }

  /**
   * Estimate token usage per section. Useful for debugging and optimization.
   */
  tokenEstimate(): Record<string, number> {
    const sections = this.buildSections()
    const result: Record<string, number> = {}
    let total = 0
    for (const s of sections) {
      const tokens = estimateTokens(s.content)
      result[s.name] = tokens
      total += tokens
    }
    result._total = total
    return result
  }
}
