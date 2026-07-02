import { describe, it, expect } from 'vitest'
import { getCapability, resolveThresholds } from './model-capabilities.js'

describe('model-capabilities', () => {
  it('matches built-in claude entries by id', () => {
    const cap = getCapability('claude-opus-4-7')
    expect(cap.contextWindowTokens).toBe(200_000)
    expect(cap.supportsCacheEdit).toBe(true)
  })

  it('detects [1m] suffix for the 1M variant', () => {
    const cap = getCapability('claude-opus-4-7[1m]')
    expect(cap.contextWindowTokens).toBe(1_000_000)
    expect(cap.supportsCacheEdit).toBe(true)
  })

  it('honours per-model override on ModelConfig', () => {
    const cap = getCapability({
      id: 'custom',
      name: 'custom',
      provider: 'openai',
      baseURL: '',
      apiKey: '',
      modelId: 'unknown-model',
      contextWindowTokens: 250_000,
      maxOutputTokens: 12_000,
    })
    expect(cap.contextWindowTokens).toBe(250_000)
    expect(cap.maxOutputTokens).toBe(12_000)
  })

  it('falls back to legacy largeContext flag → 1M', () => {
    const cap = getCapability({
      id: 'legacy', name: 'legacy', provider: 'openrouter',
      baseURL: '', apiKey: '', modelId: 'foo', largeContext: true,
    })
    expect(cap.contextWindowTokens).toBe(1_000_000)
  })

  it('unknown id falls back to conservative default', () => {
    const cap = getCapability('totally-made-up-model')
    expect(cap.contextWindowTokens).toBe(64_000)
  })

  it('resolveThresholds yields ordered water-lines', () => {
    const cap = getCapability('claude-opus-4-7')
    const t = resolveThresholds(cap)
    // microCompact < llmSummary <= ptlBlock; effective ≤ context
    expect(t.microCompact).toBeLessThan(t.llmSummary)
    expect(t.llmSummary).toBeLessThanOrEqual(t.ptlBlock)
    expect(t.effectiveTokens).toBeLessThanOrEqual(cap.contextWindowTokens)
  })

  it('respects TIMELINE_COMPRESS_TOKENS env override', () => {
    const prev = process.env.TIMELINE_COMPRESS_TOKENS
    process.env.TIMELINE_COMPRESS_TOKENS = '90000'
    try {
      const t = resolveThresholds(getCapability('claude-opus-4-7'))
      expect(t.llmSummary).toBe(90_000)
    } finally {
      if (prev == null) delete process.env.TIMELINE_COMPRESS_TOKENS
      else process.env.TIMELINE_COMPRESS_TOKENS = prev
    }
  })
})
