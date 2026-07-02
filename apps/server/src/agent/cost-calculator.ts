/**
 * Cost calculator — estimates USD per LLM call from token counts.
 *
 * Prices are in USD per **1M tokens** and reflect public pricing as of
 * 2026-06. The numbers are deliberately conservative — for trend visibility,
 * not invoicing. Add new entries as you onboard providers.
 */

export interface ModelPrice {
  /** Match by exact id, prefix (id ends with '*'), or contains. */
  match: string
  /** USD per 1M input tokens (cache miss). */
  input: number
  /** USD per 1M output tokens. */
  output: number
  /** USD per 1M cache-read tokens. Anthropic charges 0.1× input; OpenAI 0.5×. */
  cacheRead: number
  /** USD per 1M cache-write tokens. Anthropic charges 1.25× input; OpenAI 1×. */
  cacheWrite: number
}

const TABLE: ModelPrice[] = [
  // Anthropic
  { match: 'claude-opus-4',     input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75 },
  { match: 'claude-sonnet-4',   input:  3.00, output: 15.00, cacheRead: 0.30, cacheWrite:  3.75 },
  { match: 'claude-haiku-4',    input:  0.80, output:  4.00, cacheRead: 0.08, cacheWrite:  1.00 },
  { match: 'claude-3-5-sonnet', input:  3.00, output: 15.00, cacheRead: 0.30, cacheWrite:  3.75 },
  { match: 'claude-3-5-haiku',  input:  0.80, output:  4.00, cacheRead: 0.08, cacheWrite:  1.00 },
  // OpenAI
  { match: 'gpt-5',             input:  5.00, output: 20.00, cacheRead: 2.50, cacheWrite:  5.00 },
  { match: 'gpt-4o',            input:  2.50, output: 10.00, cacheRead: 1.25, cacheWrite:  2.50 },
  { match: 'gpt-4o-mini',       input:  0.15, output:  0.60, cacheRead: 0.075, cacheWrite: 0.15 },
  { match: 'o3',                input:  2.00, output:  8.00, cacheRead: 0.50, cacheWrite:  2.00 },
  // DeepSeek
  { match: 'deepseek-chat',     input:  0.27, output:  1.10, cacheRead: 0.07, cacheWrite:  0.27 },
  { match: 'deepseek-reasoner', input:  0.55, output:  2.19, cacheRead: 0.14, cacheWrite:  0.55 },
  // Kimi (Moonshot)
  { match: 'moonshot-v1-128k',  input:  6.00, output:  6.00, cacheRead: 0.60, cacheWrite:  6.00 },
  { match: 'kimi-k2',           input:  0.60, output:  2.50, cacheRead: 0.15, cacheWrite:  0.60 },
]

const FALLBACK: ModelPrice = {
  match: '*', input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75,
}

export function priceFor(modelId: string | undefined | null): ModelPrice {
  if (!modelId) return FALLBACK
  const id = modelId.toLowerCase()
  for (const p of TABLE) if (id.includes(p.match)) return p
  return FALLBACK
}

export function estimateCost(
  modelId: string | undefined | null,
  usage: {
    inputTokens?: number | null
    outputTokens?: number | null
    cacheReadTokens?: number | null
    cacheWriteTokens?: number | null
  },
): number {
  const p = priceFor(modelId)
  const m = (n: number | null | undefined) => (n ?? 0) / 1_000_000
  return (
    m(usage.inputTokens) * p.input +
    m(usage.outputTokens) * p.output +
    m(usage.cacheReadTokens) * p.cacheRead +
    m(usage.cacheWriteTokens) * p.cacheWrite
  )
}
