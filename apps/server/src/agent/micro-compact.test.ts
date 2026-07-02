import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { ModelMessage } from 'ai'
import { microCompactInPlace } from './micro-compact.js'

const ANTHROPIC_CAP = {
  modelId: 'claude-test',
  contextWindowTokens: 200_000,
  maxOutputTokens: 16_000,
  supportsCacheEdit: true,
}

const NON_CACHEABLE_CAP = {
  modelId: 'deepseek-test',
  contextWindowTokens: 64_000,
  maxOutputTokens: 8_000,
  supportsCacheEdit: false,
}

function build(numTurns: number): ModelMessage[] {
  const messages: ModelMessage[] = []
  for (let i = 0; i < numTurns; i++) {
    messages.push({ role: 'user', content: `q${i}` })
    messages.push({
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: `c${i}`, toolName: 'http_request', input: {} }],
    } as ModelMessage)
    messages.push({
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: `c${i}`,
        toolName: 'http_request',
        output: { type: 'text', value: 'X'.repeat(60_000) }, // big body each turn
      }],
    } as ModelMessage)
  }
  return messages
}

let prevMode: string | undefined
beforeEach(() => {
  prevMode = process.env.MICRO_COMPACT
})
afterEach(() => {
  if (prevMode == null) delete process.env.MICRO_COMPACT
  else process.env.MICRO_COMPACT = prevMode
})

describe('microCompactInPlace', () => {
  it('no-ops when capability is not cache-edit capable', () => {
    const msgs = build(10)
    const r = microCompactInPlace('t', msgs, { capability: NON_CACHEABLE_CAP })
    expect(r.cleared).toBe(0)
    expect(r.bytesFreed).toBe(0)
  })

  it('forces a run with MICRO_COMPACT=on regardless of capability', () => {
    process.env.MICRO_COMPACT = 'on'
    const msgs = build(10)
    const r = microCompactInPlace('t', msgs, { capability: NON_CACHEABLE_CAP })
    expect(r.cleared).toBeGreaterThan(0)
  })

  it('preserves the latest 6 turns by default', () => {
    process.env.MICRO_COMPACT = 'on'
    const msgs = build(10) // 10 turns
    const before = msgs.map(m => JSON.stringify(m))
    microCompactInPlace('t', msgs, { capability: ANTHROPIC_CAP, recentKeepTurns: 6 })
    // The last 6 user turns + their tool messages should be untouched.
    const after = msgs.map(m => JSON.stringify(m))
    // Trailing 18 entries (6 turns × 3 messages) must match.
    expect(after.slice(after.length - 18)).toEqual(before.slice(before.length - 18))
  })

  it('keeps protected tools (e.g. create_plan) intact', () => {
    process.env.MICRO_COMPACT = 'on'
    const msgs: ModelMessage[] = []
    // 8 protected tool results then 8 unprotected.
    for (let i = 0; i < 8; i++) {
      msgs.push({ role: 'user', content: `q${i}` })
      msgs.push({
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: `cp${i}`,
          toolName: 'create_plan',
          output: { type: 'text', value: 'PLAN_BODY'.repeat(10_000) },
        }],
      } as ModelMessage)
    }
    for (let i = 0; i < 8; i++) {
      msgs.push({ role: 'user', content: `qx${i}` })
      msgs.push({
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: `c${i}`,
          toolName: 'http_request',
          output: { type: 'text', value: 'OTHER'.repeat(10_000) },
        }],
      } as ModelMessage)
    }
    microCompactInPlace('t', msgs, { capability: ANTHROPIC_CAP, recentKeepTurns: 1, triggerTokens: 1_000 })
    const planResult = msgs.find(m => m.role === 'tool' && Array.isArray(m.content) && m.content.some(p =>
      p.type === 'tool-result' && p.toolName === 'create_plan'
    )) as ModelMessage
    const planPart = (planResult.content as Array<{ type: string; output: { value: unknown } }>).find(p => p.type === 'tool-result')!
    expect(planPart.output.value).not.toContain('旧工具结果已裁剪')
  })

  it('does not re-trim tool results already replaced by spillover pointer', () => {
    process.env.MICRO_COMPACT = 'on'
    const msgs: ModelMessage[] = [
      { role: 'user', content: 'q' },
      {
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: 'cSpill',
          toolName: 'http_request',
          output: { type: 'text', value: 'first 500 chars... [完整结果已落盘: workspace/...]' },
        }],
      } as ModelMessage,
      // Force the recent-cutoff out of the way:
      ...Array.from({ length: 20 }, (_, i) => ({ role: 'user', content: `f${i}` } as ModelMessage)),
    ]
    const r = microCompactInPlace('t', msgs, { capability: ANTHROPIC_CAP, recentKeepTurns: 2, triggerTokens: 1 })
    expect(r.cleared).toBe(0)
  })
})
