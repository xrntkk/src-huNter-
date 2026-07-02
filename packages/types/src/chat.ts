export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt?: number
}

export interface GraphUpdateEvent {
  type: 'endpoint_added' | 'finding_added' | 'finding_deleted' | 'finding_updated' | 'session_status' | 'memory_added'
  data: unknown
}

export interface ChatRequest {
  messages: ChatMessage[]
  selectedEndpointIds: string[]
  modelId?: string
  /**
   * Skill names to pre-load into the agent's system prompt for this request.
   * When provided, the specified skills are loaded at agent start (in addition
   * to any already persisted in the timeline). Empty array = no extra skills.
   */
  selectedSkills?: string[]
  /**
   * MCP server names to enable for this request. When provided, only tools
   * from these servers are made available to the agent. Omitted/empty = all
   * configured servers are available (current default behaviour).
   */
  selectedMcpServers?: string[]
  /**
   * Tool-approval decisions sent when resuming a loop that paused with reason
   * 'tool_approval'. Keyed by the paused tool call's id. When present, the
   * agent applies these decisions (execute approved / record denied) before
   * its first model turn instead of treating the message as new user input.
   */
  approvals?: Array<{ toolCallId: string; approved: boolean; note?: string }>
}

// --- Model Config ---
export type ModelProvider = 'anthropic' | 'openai' | 'deepseek' | 'openrouter' | 'kimi' | 'claude-cli'

/**
 * How the model emits and consumes tool calls.
 *   'native' — structured function-calling (tool-call / tool-result message
 *              parts). The standard path; works for Anthropic, OpenAI,
 *              DeepSeek v4, Kimi, OpenRouter, etc.
 *   'text'   — the model only emits tool calls as plain text (e.g. some
 *              older / OpenRouter-proxied models). Enables the text-recovery
 *              fallback in the model output normalizer.
 * Defaults to 'native' when unset.
 */
export type ToolProtocol = 'native' | 'text'

export interface ModelConfig {
  id: string
  name: string
  provider: ModelProvider
  baseURL: string
  apiKey: string
  modelId: string
  /**
   * Whether this model supports a very large (~1M token) context window.
   * When the active main model has this set, the timeline compression
   * thresholds are raised substantially so long sessions aren't compacted
   * prematurely. Optional — defaults to false (standard ~200K budget).
   */
  largeContext?: boolean
  /**
   * Declarative capability: how this model handles tool calls. Replaces the
   * old hard-coded `isDeepSeek` branching. Defaults to 'native' (structured
   * function-calling). Set to 'text' only for models that cannot emit native
   * tool calls and must be recovered from prose.
   */
  toolProtocol?: ToolProtocol
  /**
   * Optional provider-specific options forwarded verbatim to streamText /
   * generateText as `providerOptions`. Keyed by provider namespace, e.g.
   * `{ anthropic: { thinking: { type: 'enabled', budgetTokens: 8000 } } }`
   * or `{ openai: { reasoningEffort: 'high' } }`. The AI SDK routes each
   * namespace to the matching provider and ignores the rest, so unrelated
   * keys are harmless. Omitted ⇒ no provider options sent (current behaviour).
   */
  providerOptions?: Record<string, Record<string, unknown>>
  /**
   * Optional explicit context window size (input + output) for this model,
   * in tokens. When set, overrides both the built-in capability table and
   * the legacy `largeContext` flag for compression-threshold calculations.
   * Useful for self-hosted / proxy / fine-tuned models whose window does
   * not match the public defaults. Omitted ⇒ derive from the built-in table.
   */
  contextWindowTokens?: number
  /**
   * Optional explicit upper bound on output tokens per streamText call.
   * Reserved against the context window when computing the compression
   * water-line. Omitted ⇒ derive from the built-in table.
   */
  maxOutputTokens?: number
}

export interface ModelsConfigFile {
  models: ModelConfig[]
  activeModelId: string
  /**
   * Optional ID of a "fast / cheap" model used for auxiliary calls
   * (timeline compression, intent classification, target-memory extraction,
   * tool-result summarization, etc.). When unset, those calls fall back to
   * the active main model — functional but more expensive.
   */
  fastModelId?: string
  /**
   * Optional per-phase model overrides for the main agent loop. Lets the user
   * route cheap models to recon/enum and stronger models to test/report.
   * Any phase left unset falls back to `activeModelId`. Fully optional —
   * absent ⇒ the active model is used for every phase (current behaviour).
   */
  phaseModelIds?: Partial<Record<'recon' | 'enum' | 'test' | 'report', string>>
}

// --- System Info ---
export interface ClaudeCliInfo {
  found: boolean
  version?: string
  executable?: string
}

export interface SystemInfo {
  claudeCli: ClaudeCliInfo
  langfuse?: {
    enabled: boolean
    baseURL: string | null
  }
}
