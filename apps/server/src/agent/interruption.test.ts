import { describe, it, expect } from 'vitest'
import type { ModelMessage } from 'ai'
import { analyzeInterruption, recoveryPromptFor, describeInterruption, type InterruptionMarker } from './interruption.js'
import { MessageStore } from './message-store.js'

const MARKER_TS = 1700000000000
const m = (kind: InterruptionMarker['kind'], extra: Partial<InterruptionMarker> = {}): InterruptionMarker =>
  ({ kind, iteration: 1, ts: MARKER_TS, ...extra } as InterruptionMarker)

describe('analyzeInterruption', () => {
  it('returns none on empty marker list', () => {
    expect(analyzeInterruption({ markers: [], messages: [] })).toEqual({ kind: 'none' })
  })

  it('returns none when the latest commit closed the run cleanly', () => {
    const markers: InterruptionMarker[] = [
      m('turn_start'),
      m('tool_started', { toolName: 't', toolCallId: 'c1', argsPreview: '{}' }),
      m('turn_committed'),
    ]
    const msgs: ModelMessage[] = [
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 't', output: { type: 'text', value: 'ok' } }] } as ModelMessage,
    ]
    expect(analyzeInterruption({ markers, messages: msgs }).kind).toBe('none')
  })

  it('detects tool_in_flight when tool started but no result was persisted', () => {
    const markers: InterruptionMarker[] = [
      m('turn_committed'),
      m('turn_start'),
      m('tool_started', { toolName: 'http', toolCallId: 'cX', argsPreview: '{"u":1}' }),
    ]
    const r = analyzeInterruption({ markers, messages: [] })
    expect(r).toMatchObject({ kind: 'tool_in_flight', toolName: 'http', toolCallId: 'cX' })
  })

  it('classifies aborted_by_user with at:tool_call when a tool was running', () => {
    const markers: InterruptionMarker[] = [
      m('turn_start'),
      m('tool_started', { toolName: 'http', toolCallId: 'c1', argsPreview: '{}' }),
      m('turn_aborted'),
    ]
    const r = analyzeInterruption({ markers, messages: [] })
    expect(r).toMatchObject({ kind: 'aborted_by_user', at: 'tool_call', toolName: 'http' })
  })

  it('classifies aborted_by_user with at:streaming when no tool was running', () => {
    const markers: InterruptionMarker[] = [m('turn_start'), m('turn_aborted')]
    expect(analyzeInterruption({ markers, messages: [] })).toMatchObject({ kind: 'aborted_by_user', at: 'streaming' })
  })

  it('classifies transport_error from the latest marker', () => {
    const markers: InterruptionMarker[] = [
      m('turn_start'),
      m('transport_error', { error: 'EAI_AGAIN', reconnectable: true }),
    ]
    const r = analyzeInterruption({ markers, messages: [] })
    expect(r).toMatchObject({ kind: 'transport_error', reconnectable: true })
  })
})

describe('describeInterruption / recoveryPromptFor', () => {
  it('produces non-empty prose for every non-none state', () => {
    const states = [
      { kind: 'aborted_by_user', at: 'tool_call', toolName: 'http' } as const,
      { kind: 'tool_in_flight', toolName: 'http', toolCallId: 'c1', argsPreview: '{}' } as const,
      { kind: 'model_stream_truncated', partialText: 'half...' } as const,
      { kind: 'transport_error', error: 'ETIMEDOUT', reconnectable: false } as const,
    ]
    for (const s of states) {
      expect(describeInterruption(s).length).toBeGreaterThan(0)
      expect(recoveryPromptFor(s).length).toBeGreaterThan(0)
    }
  })

  it('returns empty for kind none', () => {
    expect(describeInterruption({ kind: 'none' })).toBe('')
    expect(recoveryPromptFor({ kind: 'none' })).toBe('')
  })
})

describe('MessageStore interruption integration', () => {
  it('drops orphan tool-call when state is aborted_by_user (no synthetic result)', () => {
    const s = new MessageStore()
    s.appendUser('hi')
    s.appendResponse([
      { role: 'assistant', content: [
        { type: 'text', text: 'fetching' },
        { type: 'tool-call', toolCallId: 'cAbort', toolName: 'http_request', input: {} },
      ] } as ModelMessage,
    ])
    s.appendInterruptionMarker(m('turn_start'))
    s.appendInterruptionMarker(m('tool_started', { toolName: 'http_request', toolCallId: 'cAbort', argsPreview: '{}' }))
    s.appendInterruptionMarker(m('turn_aborted'))

    const restored = MessageStore.deserialize(s.serialize())
    const state = restored.getLastInterruption()
    expect(state.kind).toBe('aborted_by_user')

    // Synthetic tool result must NOT be appended on user-abort path.
    const messages = restored.getMessages()
    const hasFakeResult = messages.some(msg =>
      msg.role === 'tool' && Array.isArray(msg.content) && msg.content.some(p =>
        p.type === 'tool-result' && p.toolCallId === 'cAbort'
      )
    )
    expect(hasFakeResult).toBe(false)
  })

  it('injects synthetic tool-result for tool_in_flight state', () => {
    const s = new MessageStore()
    s.appendUser('hi')
    s.appendResponse([
      { role: 'assistant', content: [
        { type: 'tool-call', toolCallId: 'cInFlight', toolName: 'bash', input: {} },
      ] } as ModelMessage,
    ])
    s.appendInterruptionMarker(m('turn_committed'))
    s.appendInterruptionMarker(m('turn_start'))
    s.appendInterruptionMarker(m('tool_started', { toolName: 'bash', toolCallId: 'cInFlight', argsPreview: '{}' }))

    const restored = MessageStore.deserialize(s.serialize())
    const state = restored.getLastInterruption()
    expect(state.kind).toBe('tool_in_flight')

    const messages = restored.getMessages()
    const synthetic = messages.flatMap(msg =>
      msg.role === 'tool' && Array.isArray(msg.content)
        ? msg.content.filter(p => p.type === 'tool-result' && p.toolCallId === 'cInFlight')
        : []
    )
    expect(synthetic.length).toBe(1)
  })

  it('injectRecoveryPrompt is one-shot and clears the state', () => {
    const s = new MessageStore()
    s.appendUser('hi')
    s.appendInterruptionMarker(m('turn_start'))
    s.appendInterruptionMarker(m('transport_error', { error: 'ECONNRESET', reconnectable: true }))

    const restored = MessageStore.deserialize(s.serialize())
    expect(restored.getLastInterruption().kind).toBe('transport_error')
    const before = restored.getMessages().length
    restored.injectRecoveryPrompt()
    expect(restored.getMessages().length).toBe(before + 1)
    expect(restored.getLastInterruption().kind).toBe('none')
    // Idempotent
    restored.injectRecoveryPrompt()
    expect(restored.getMessages().length).toBe(before + 1)
  })
})
