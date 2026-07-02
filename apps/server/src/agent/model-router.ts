import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createMoonshotAI } from '@ai-sdk/moonshotai'
import { wrapLanguageModel, type LanguageModel } from 'ai'
import { devToolsMiddleware } from '@ai-sdk/devtools'
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ModelConfig, ModelsConfigFile } from '@src-agent/types'
import { ClaudeAgentLanguageModel } from './claude-agent-language-model.js'
import { resolveCliExecutable } from '../utils/claude-cli-detect.js'
import { getCapability, type ModelCapability } from './model-capabilities.js'
import { logger } from '../logger/index.js'

const MODELS_CONFIG_PATH = resolve(process.cwd(), '../../config/models.json')

/**
 * Module-level cache for the parsed models config. Keyed on the file's
 * `mtimeMs` so we only re-read+parse when the file actually changed on disk.
 * `getModel` / `getFastModel` / `getModelForPhase` / capability queries all
 * hit this on every agent call, so avoiding repeated `readFileSync` matters.
 *
 * `null` data means "file missing or unparseable" — we still cache the mtime
 * (when present) so we don't keep retrying on every call until the file
 * changes.
 */
let cachedConfig: { data: ModelsConfigFile | null; mtime: number } | null = null

/**
 * Optionally wrap a model with the AI SDK DevTools middleware. Opt-in via the
 * `AI_DEVTOOLS=1` env var (dev only) so production and normal dev runs are
 * untouched. Pair with `npx @ai-sdk/devtools` to inspect inputs/outputs/tool
 * calls/usage at http://localhost:4983. Skipped for the claude-cli adapter,
 * which is not a standard LanguageModelV3 instance.
 */
function maybeWrapWithDevtools(model: LanguageModel): LanguageModel {
  if (process.env.AI_DEVTOOLS !== '1') return model
  // Callers only ever pass concrete model instances (never the string form of
  // the LanguageModel union), so this cast is safe.
  if (typeof model === 'string') return model
  logger.info('[ModelRouter] AI DevTools middleware enabled')
  // The `ai` LanguageModel union spans V2|V3; provider instances here are V3.
  return wrapLanguageModel({
    model: model as Parameters<typeof wrapLanguageModel>[0]['model'],
    middleware: devToolsMiddleware(),
  })
}

function loadModelsConfig(): ModelsConfigFile | null {
  // One stat call gives us both existence and mtime — no need for the prior
  // existsSync + readFileSync two-step.
  let mtime: number
  try {
    mtime = statSync(MODELS_CONFIG_PATH).mtimeMs
  } catch {
    // File missing (or unreadable stat): cache the absence so we don't retry
    // every call. mtime = -1 ensures any future file creation (mtime >= 0)
    // will be detected as a change.
    if (cachedConfig?.mtime === -1) return cachedConfig.data
    cachedConfig = { data: null, mtime: -1 }
    return null
  }

  if (cachedConfig && cachedConfig.mtime === mtime) {
    return cachedConfig.data
  }

  try {
    const data = JSON.parse(readFileSync(MODELS_CONFIG_PATH, 'utf-8')) as ModelsConfigFile
    cachedConfig = { data, mtime }
    return data
  } catch (e) {
    logger.error(`[ModelRouter] Failed to parse ${MODELS_CONFIG_PATH}: ${e instanceof Error ? e.message : String(e)}`)
    // Cache the parse failure too (with the current mtime) so we don't keep
    // re-reading a broken file until it's actually modified.
    cachedConfig = { data: null, mtime }
    return null
  }
}

/**
 * Force-invalidate the models config cache. Call after writing
 * `config/models.json` (e.g. PUT /settings/models) so the next
 * `loadModelsConfig()` re-reads from disk instead of returning the stale
 * cached copy.
 */
export function reloadModelsConfig(): void {
  cachedConfig = null
}

/** Ensure OpenAI-compatible endpoints end with /v1 (most providers expect this). */
function ensureOpenAIV1Suffix(raw: string): string {
  let url = raw.trim().replace(/\/$/, '')
  if (!url.endsWith('/v1')) {
    url += '/v1'
  }
  return url
}

/** DeepSeek-specific normalization: strip accidental /anthropic suffix, then add /v1. */
function normalizeDeepSeekBaseURL(raw: string): string {
  let url = raw.trim().replace(/\/$/, '')
  if (url.endsWith('/anthropic')) {
    url = url.slice(0, -'/anthropic'.length)
  }
  if (url.endsWith('/anthropic/')) {
    url = url.slice(0, -'/anthropic/'.length)
  }
  url = url.replace(/\/$/, '')
  if (!url.endsWith('/v1')) {
    url += '/v1'
  }
  return url
}

function buildModelFromConfig(cfg: ModelConfig): LanguageModel {
  const { provider, baseURL, apiKey, modelId } = cfg

  switch (provider) {
    case 'anthropic': {
      // @ai-sdk/anthropic appends `/messages` to the baseURL directly.
      // Third-party proxies often require `/v1/messages`, so ensure the
      // baseURL ends with `/v1` when a custom URL is provided.
      let url = baseURL.replace(/\/$/, '')
      if (url && !url.endsWith('/v1')) {
        url = url + '/v1'
      }
      logger.info(`[ModelRouter] Anthropic baseURL: ${url}`)
      const anthropic = createAnthropic({ baseURL: url || undefined, apiKey })
      return maybeWrapWithDevtools(anthropic(modelId as never))
    }
    case 'deepseek': {
      // Official @ai-sdk/deepseek provider. It captures `reasoning_content`
      // as a structured `reasoning` stream part and round-trips it via
      // providerMetadata.openaiCompatible when needed. baseURL still needs the
      // /v1 suffix (and accidental /anthropic stripped) — that's a transport
      // concern, not model-specific behaviour.
      const url = normalizeDeepSeekBaseURL(baseURL)
      logger.info(`[ModelRouter] DeepSeek endpoint: ${url}`)
      const deepseek = createDeepSeek({ baseURL: url, apiKey })
      return maybeWrapWithDevtools(deepseek(modelId))
    }
    case 'openai': {
      const url = ensureOpenAIV1Suffix(baseURL)
      const openai = createOpenAI({ baseURL: url, apiKey })
      return maybeWrapWithDevtools(openai(modelId as never))
    }
    case 'openrouter': {
      const url = ensureOpenAIV1Suffix(baseURL)
      const openai = createOpenAI({
        baseURL: url,
        apiKey,
        headers: { 'HTTP-Referer': 'https://src-agent.local', 'X-Title': 'SRC Agent' },
      })
      return maybeWrapWithDevtools(openai(modelId as never))
    }
    case 'kimi': {
      // Kimi / Moonshot via the official @ai-sdk/moonshotai provider (built on
      // @ai-sdk/openai-compatible — same base as DeepSeek's provider, so
      // reasoning_content is preserved rather than dropped by the generic
      // createOpenAI path). The Kimi Code API baseURL already includes the
      // /coding/v1 path, so pass it through as-is (don't append /v1).
      const url = baseURL.trim().replace(/\/$/, '')
      logger.info(`[ModelRouter] Kimi (moonshotai) endpoint: ${url}`)
      const moonshot = createMoonshotAI({ baseURL: url, apiKey })
      return maybeWrapWithDevtools(moonshot(modelId))
    }
    case 'claude-cli': {
      // Native bridge: no HTTP loopback. The adapter calls
      // `@anthropic-ai/claude-agent-sdk` directly and reuses the local
      // `~/.claude/` OAuth credentials. baseURL / apiKey on the ModelConfig
      // are intentionally ignored for this provider.
      //
      // Resolve which CLI binary to drive. Priority:
      //   1. `CLAUDE_CLI_PATH` env (absolute path, user override)
      //   2. `claude-internal` on PATH (internal Anthropic build)
      //   3. `claude` on PATH (public Claude Code CLI)
      //   4. Unset → SDK falls back to its bundled `cli.js`
      const explicit = process.env.CLAUDE_CLI_PATH
      const cliPath = explicit && explicit.trim()
        ? explicit.trim()
        : resolveCliExecutable('claude-internal') ?? resolveCliExecutable('claude')
      logger.info(`[ModelRouter] Claude CLI native (modelId=${modelId || '(default)'}, cli=${cliPath ?? '(SDK bundled)'})`)
      // Not wrapped with devtools: this is a custom adapter, not a standard
      // LanguageModelV3 instance.
      return new ClaudeAgentLanguageModel({
        modelId,
        ...(cliPath ? { pathToClaudeCodeExecutable: cliPath } : {}),
      }) as unknown as LanguageModel
    }
    default: {
      const url = ensureOpenAIV1Suffix(baseURL)
      const openai = createOpenAI({ baseURL: url, apiKey })
      return maybeWrapWithDevtools(openai(modelId as never))
    }
  }
}

/**
 * Fallback provider using legacy env vars (for backward compatibility).
 */
function buildFallbackProvider(): { getModel: (id?: string) => LanguageModel; modelId: string } {
  const baseURL = process.env.ANTHROPIC_BASE_URL
  const apiKey = process.env.ANTHROPIC_API_KEY ?? ''
  const modelId = process.env.ANTHROPIC_MODEL ?? 'deepseek-chat'

  logger.info('[ModelRouter] Fallback env:', { baseURL: baseURL || '(unset)', apiKey: apiKey ? '***' : '(empty)', modelId })

  const isDeepSeek = baseURL?.includes('deepseek.com')

  if (isDeepSeek && baseURL) {
    // DeepSeek via the official provider (structured reasoning support).
    const url = normalizeDeepSeekBaseURL(baseURL)
    logger.info(`[ModelRouter] DeepSeek fallback endpoint: ${url}`)
    const deepseek = createDeepSeek({ baseURL: url, apiKey })
    return { getModel: () => deepseek(modelId), modelId }
  }

  if (baseURL) {
    const anthropic = createAnthropic({ baseURL, apiKey })
    return { getModel: () => anthropic(modelId as never), modelId }
  }

  const anthropic = createAnthropic({ apiKey })
  return { getModel: () => anthropic(modelId as never), modelId }
}

/**
 * Resolve the model for the main agent loop.
 *
 * Model selection is driven entirely by user configuration — no keyword-based
 * task-type guessing. Priority:
 *   1. `requestedModelId` (explicit per-request choice from the UI)
 *   2. `models.json` `activeModelId` (user's configured default)
 *   3. `OVERRIDE_MODEL` env (legacy escape hatch)
 *   4. Built-in fallback provider
 *
 * Rationale: keyword matching ("爬"/"扫描"/"报告") to silently swap models was
 * inaccurate and overrode the user's explicit choice. Let the user pick the
 * model and let the model itself decide how to approach the task.
 */
export function getModel(requestedModelId?: string): LanguageModel {
  const modelsConfig = loadModelsConfig()

  // Try to use the requested model ID first
  if (requestedModelId && modelsConfig) {
    const model = modelsConfig.models.find(m => m.id === requestedModelId)
    if (model) {
      logger.info(`[ModelRouter] getModel → using requested model: ${model.name} (${model.provider}/${model.modelId})`)
      return buildModelFromConfig(model)
    }
    logger.warn(`[ModelRouter] getModel → requestedModelId="${requestedModelId}" not found in config, falling back`)
  }

  // Fall back to active model from config
  if (modelsConfig?.activeModelId) {
    const activeModel = modelsConfig.models.find(m => m.id === modelsConfig.activeModelId)
    if (activeModel) {
      logger.info(`[ModelRouter] getModel → using active model: ${activeModel.name} (${activeModel.provider}/${activeModel.modelId})`)
      return buildModelFromConfig(activeModel)
    }
  }

  // Full override via env (legacy)
  if (process.env.OVERRIDE_MODEL) {
    const fallback = buildFallbackProvider()
    return fallback.getModel(process.env.OVERRIDE_MODEL)
  }

  // Legacy fallback
  const fallback = buildFallbackProvider()
  return fallback.getModel()
}


/**
 * Whether the model that will actually drive the main loop supports a very
 * large (~1M token) context window. Resolves the same model the loop would
 * (requested → active) and reads its `largeContext` flag. Used to scale the
 * timeline compression thresholds. Defaults to false when unconfigured.
 */
export function isLargeContextModel(requestedModelId?: string): boolean {
  const cfg = loadModelsConfig()
  if (!cfg) return false
  const id = requestedModelId || cfg.activeModelId
  const model = cfg.models.find(m => m.id === id)
  return Boolean(model?.largeContext)
}

/**
 * Resolve the tool-call protocol for the model that will drive the loop.
 * 'native' (default) → structured function-calling; 'text' → the model only
 * emits tool calls as prose and the normalizer's text-recovery fallback must
 * run. Declarative replacement for the old hard-coded `isDeepSeek` check.
 */
export function getToolProtocol(requestedModelId?: string): 'native' | 'text' {
  const cfg = loadModelsConfig()
  if (!cfg) return 'native'
  const id = requestedModelId || cfg.activeModelId
  const model = cfg.models.find(m => m.id === id)
  return model?.toolProtocol ?? 'native'
}

/**
 * Resolve the per-call `providerOptions` for the model driving the loop, read
 * from `models.json`. Returns undefined when unconfigured so callers can omit
 * the field entirely (no behavioural change). Lets the user enable e.g.
 * Anthropic extended thinking or OpenAI reasoning effort per model without
 * code changes.
 *
 * For Anthropic models, automatically injects cacheControl to enable prompt
 * prefix caching (static system prompt sections are cached, reducing cost).
 */
export function getProviderOptions(
  requestedModelId?: string,
): Record<string, Record<string, unknown>> | undefined {
  const cfg = loadModelsConfig()
  if (!cfg) return undefined
  const id = requestedModelId || cfg.activeModelId
  const model = cfg.models.find(m => m.id === id)
  const opts = model?.providerOptions ? { ...model.providerOptions } : {}

  // Auto-enable prompt caching for Anthropic provider
  if (model?.provider === 'anthropic') {
    if (!opts.anthropic) opts.anthropic = {}
    if (typeof opts.anthropic === 'object' && opts.anthropic !== null) {
      const a = opts.anthropic as Record<string, unknown>
      if (!a.cacheControl) a.cacheControl = { type: 'ephemeral' }
    }
  }

  return Object.keys(opts).length > 0 ? opts : undefined
}


/**
 * Resolve the model for a specific agent-loop phase (recon / enum / test /
 * report). Lets the user route cheap models to early phases and stronger
 * models to verification / reporting via `models.json` `phaseModelIds`.
 *
 * Priority:
 *   1. `requestedModelId` (explicit per-request choice — always wins)
 *   2. `phaseModelIds[phase]` (user's per-phase override)
 *   3. fall through to `getModel(requestedModelId)` (active → override → fallback)
 *
 * Fully backward-compatible: when `phaseModelIds` is unset the result is
 * identical to `getModel(requestedModelId)`.
 */
export function getModelForPhase(
  phase: 'recon' | 'enum' | 'test' | 'report',
  requestedModelId?: string,
): LanguageModel {
  if (requestedModelId) return getModel(requestedModelId)

  const cfg = loadModelsConfig()
  const phaseId = cfg?.phaseModelIds?.[phase]
  if (phaseId && cfg) {
    const m = cfg.models.find(x => x.id === phaseId)
    if (m) {
      logger.info(`[ModelRouter] getModelForPhase(${phase}) → ${m.id} (${m.provider})`)
      return buildModelFromConfig(m)
    }
    logger.warn(`[ModelRouter] phaseModelIds.${phase}="${phaseId}" not found in models[], falling back to active`)
  }
  return getModel()
}


/**
 * compression, intent classification, target-memory extraction, etc.
 *
 * Priority:
 *   1. `models.json` `fastModelId` field (preferred — explicit user config)
 *   2. Fall back to `getModel('chat')` (i.e. the active main model)
 *
 * Callers should treat this as best-effort: if the cheap model fails the
 * surrounding feature should degrade gracefully (e.g. compression skips,
 * intent defaults to chitchat) rather than retry on the main model.
 */
export function getFastModel(): LanguageModel {
  const cfg = loadModelsConfig()
  if (cfg?.fastModelId) {
    const m = cfg.models.find(x => x.id === cfg.fastModelId)
    if (m) {
      logger.info(`[ModelRouter] getFastModel → ${m.id} (${m.provider})`)
      return buildModelFromConfig(m)
    }
    logger.warn(`[ModelRouter] fastModelId="${cfg.fastModelId}" not found in models[], falling back to main`)
  }
  return getModel('chat')
}

/**
 * Resolve the runtime capability for the model that will drive the loop —
 * context window, output budget, cache-edit support. Used by MessageStore
 * to compute model-specific compression thresholds (plan three) and by the
 * agent loop to gate microCompact (plan five).
 *
 * Resolution mirrors getModel(): requestedModelId → activeModelId. When the
 * model isn't declared in models.json (legacy env path or unknown id) we
 * fall back to the built-in capability table by id.
 */
export function getModelCapability(requestedModelId?: string): ModelCapability {
  const cfg = loadModelsConfig()
  if (cfg) {
    const id = requestedModelId || cfg.activeModelId
    const m = cfg.models.find(x => x.id === id)
    if (m) return getCapability(m)
  }
  // Legacy path: derive from env-configured modelId.
  const envId = requestedModelId || process.env.OVERRIDE_MODEL || process.env.ANTHROPIC_MODEL || ''
  return getCapability(envId || undefined)
}
