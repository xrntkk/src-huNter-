/**
 * Model capability table — per-model context window + output budgets.
 *
 * Replaces the binary `largeContext` flag with an explicit numeric
 * `contextWindowTokens` so the compression thresholds scale with the model
 * actually in use. `MessageStore.compress()` reads this via
 * `resolveThresholds(modelId)` to compute "compress water-line" /
 * "PTL block water-line" values that match the provider, instead of
 * one-size-fits-all 140k / 800k cliffs.
 *
 * Data sources, in order:
 *   1. `models.json` per-model `contextWindowTokens` / `maxOutputTokens` overrides
 *      (so users can declare new models without code changes).
 *   2. Built-in table for common public models (Anthropic / DeepSeek / OpenAI /
 *      Kimi / OpenRouter).
 *   3. `largeContext: true` legacy flag → 1M window fallback.
 *   4. Conservative default — 64k window, 8k output.
 *
 * Override knobs:
 *   - `TIMELINE_COMPRESS_TOKENS` env still wins (operations escape hatch).
 *   - `MICRO_COMPACT_*` env still wins (handled separately by plan five).
 */
import type { ModelConfig } from '@src-agent/types'

export interface ModelCapability {
  /** Model id as it appears in models.json (`m.id`), or the raw provider modelId. */
  modelId: string
  /** Total tokens the provider accepts in a single request (input + output). */
  contextWindowTokens: number
  /** Upper bound on output tokens for one streamText call. */
  maxOutputTokens: number
  /** True iff the provider supports Anthropic-style cache-edit operations.
   * Drives the microCompact gate (plan 5). Defaults to false. */
  supportsCacheEdit?: boolean
}

const DEFAULT_CAP: ModelCapability = {
  modelId: '__default__',
  contextWindowTokens: 64_000,
  maxOutputTokens: 8_000,
}

/**
 * Match patterns are tested in order; the first hit wins. Patterns are matched
 * against both the user-visible `id` and the raw provider `modelId` so either
 * spelling works.
 */
const BUILTIN_TABLE: Array<{ test: (id: string) => boolean; cap: ModelCapability }> = [
  // Anthropic Claude — 1M (Opus 4.7 [1m]) / 200k (rest)
  { test: id => /claude.*\[1m\]/i.test(id) || /claude.*1m/i.test(id), cap: { modelId: 'claude-1m', contextWindowTokens: 1_000_000, maxOutputTokens: 32_000, supportsCacheEdit: true } },
  { test: id => /claude-(opus|sonnet|haiku)/i.test(id) || /claude-3/i.test(id) || /claude-4/i.test(id), cap: { modelId: 'claude', contextWindowTokens: 200_000, maxOutputTokens: 16_000, supportsCacheEdit: true } },

  // DeepSeek — 64k (chat) / 64k (reasoner)
  { test: id => /deepseek-(reasoner|chat)/i.test(id), cap: { modelId: 'deepseek', contextWindowTokens: 64_000, maxOutputTokens: 8_000 } },

  // Kimi / Moonshot — 128k–1M depending on variant
  { test: id => /kimi.*k2|moonshot.*128k/i.test(id), cap: { modelId: 'kimi-128k', contextWindowTokens: 128_000, maxOutputTokens: 8_000 } },
  { test: id => /kimi|moonshot/i.test(id), cap: { modelId: 'kimi', contextWindowTokens: 200_000, maxOutputTokens: 8_000 } },

  // OpenAI / GPT — gpt-4.1 has a 1M window; 4o ~128k
  { test: id => /gpt-4\.1/i.test(id), cap: { modelId: 'gpt-4.1', contextWindowTokens: 1_000_000, maxOutputTokens: 32_000 } },
  { test: id => /gpt-4o|gpt-4-turbo/i.test(id), cap: { modelId: 'gpt-4o', contextWindowTokens: 128_000, maxOutputTokens: 16_000 } },
  { test: id => /^o\d|^gpt-5|reasoning/i.test(id), cap: { modelId: 'openai-reasoning', contextWindowTokens: 200_000, maxOutputTokens: 32_000 } },
]

function lookupBuiltin(id: string): ModelCapability | null {
  for (const row of BUILTIN_TABLE) if (row.test(id)) return { ...row.cap, modelId: id }
  return null
}

/**
 * Resolve a capability for the given model. The caller should pass the
 * resolved `ModelConfig` from models.json when available so per-model
 * overrides apply; otherwise pass just the id and we fall back to the
 * built-in table → conservative default.
 */
export function getCapability(modelOrId: string | ModelConfig | undefined): ModelCapability {
  if (!modelOrId) return DEFAULT_CAP
  if (typeof modelOrId === 'string') {
    return lookupBuiltin(modelOrId) ?? DEFAULT_CAP
  }
  const cfg = modelOrId
  const overrideCtx = (cfg as unknown as { contextWindowTokens?: number }).contextWindowTokens
  const overrideOut = (cfg as unknown as { maxOutputTokens?: number }).maxOutputTokens
  const builtin = lookupBuiltin(cfg.modelId) ?? lookupBuiltin(cfg.id)
  // Legacy: largeContext:true → 1M window when no explicit number is set.
  const legacyLarge: ModelCapability | null = cfg.largeContext
    ? { modelId: cfg.id, contextWindowTokens: 1_000_000, maxOutputTokens: 32_000, supportsCacheEdit: cfg.provider === 'anthropic' }
    : null
  const base = builtin ?? legacyLarge ?? DEFAULT_CAP
  return {
    modelId: cfg.id,
    contextWindowTokens: overrideCtx && overrideCtx > 0 ? overrideCtx : base.contextWindowTokens,
    maxOutputTokens: overrideOut && overrideOut > 0 ? overrideOut : base.maxOutputTokens,
    supportsCacheEdit: base.supportsCacheEdit ?? (cfg.provider === 'anthropic'),
  }
}

export interface CompressionThresholds {
  /** Soft pre-warning water-line — used by plan 5 microCompact. */
  microCompact: number
  /** LLM-summary compression water-line — current `compress()` trigger. */
  llmSummary: number
  /** Hard "should never write past this" water-line for PTL guard. */
  ptlBlock: number
  /** Effective context window after reserving output tokens. */
  effectiveTokens: number
}

const AUTOCOMPACT_BUFFER_TOKENS = 13_000
const MANUAL_COMPACT_BUFFER_TOKENS = 3_000

function envInt(name: string): number | undefined {
  const raw = process.env[name]
  if (!raw) return undefined
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/**
 * Compute the three water-lines for a given model. Operators can still
 * override via env (TIMELINE_COMPRESS_TOKENS / TIMELINE_MICRO_COMPACT_TOKENS)
 * — those win. With no env set, the values scale from the model's actual
 * context window.
 */
export function resolveThresholds(cap: ModelCapability): CompressionThresholds {
  const reservedOutput = Math.min(cap.maxOutputTokens, 20_000)
  const effective = Math.max(8_000, cap.contextWindowTokens - reservedOutput)
  const llmSummaryDefault = effective - AUTOCOMPACT_BUFFER_TOKENS
  const llmSummary = envInt('TIMELINE_COMPRESS_TOKENS') ?? llmSummaryDefault
  const microCompact = envInt('TIMELINE_MICRO_COMPACT_TOKENS') ?? Math.floor(llmSummary * 0.6)
  const ptlBlock = effective - MANUAL_COMPACT_BUFFER_TOKENS
  return { microCompact, llmSummary, ptlBlock, effectiveTokens: effective }
}
