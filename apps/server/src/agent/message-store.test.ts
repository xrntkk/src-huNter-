import { describe, it, expect } from 'vitest'
import type { ModelMessage } from 'ai'
import { MessageStore } from './message-store.js'

describe('MessageStore', () => {
  it('round-trips messages through serialize/deserialize', () => {
    const s = new MessageStore()
    s.appendUser('hello')
    s.appendResponse([
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ])
    const restored = MessageStore.deserialize(s.serialize())
    expect(restored.getMessages()).toEqual(s.getMessages())
    expect(restored.length).toBe(2)
  })

  it('converts legacy Timeline JSON into viewable + continuable messages', () => {
    const legacy = JSON.stringify({
      nextId: 6,
      items: [
        { id: 1, type: 'user', content: '扫描 example.com', metadata: { nonce: 'AB12' } },
        { id: 2, type: 'assistant_thought', content: '先看首页。' },
        { id: 3, type: 'tool_call', content: '', metadata: { toolName: 'http_request', toolArgs: { url: '/' }, toolCallId: 'c1' } },
        { id: 4, type: 'tool_result', content: '200 OK', metadata: { toolName: 'http_request', toolCallId: 'c1' } },
        { id: 5, type: 'skill_loaded', content: 'recon', metadata: { skillName: 'recon' } },
        // Unanswered call must be dropped so the model view stays provider-valid.
        { id: 6, type: 'tool_call', content: '', metadata: { toolName: 'http_request', toolArgs: { url: '/x' }, toolCallId: 'c2' } },
      ],
    })
    const s = MessageStore.deserialize(legacy)
    expect(s.isEmpty()).toBe(false)
    expect(s.getLoadedSkillNames()).toEqual(['recon'])

    // History view: ordered native parts, text then tool.
    const hist = s.toHistoryMessages()
    expect(hist[0]).toEqual({ role: 'user', parts: [{ type: 'text', text: '扫描 example.com' }] })
    const asst = hist.find(h => h.role === 'assistant')!
    expect(asst.parts[0]).toEqual({ type: 'text', text: '先看首页。' })
    expect(asst.parts[1]).toMatchObject({ type: 'tool', toolCallId: 'c1', toolName: 'http_request' })

    // Model view: no orphan tool-calls (c2 dropped, c1 paired).
    const model = s.toModelMessages()
    const callIds = new Set<string>()
    const resIds = new Set<string>()
    for (const m of model) {
      if (typeof m.content === 'string') continue
      for (const p of m.content as Array<{ type: string; toolCallId?: string }>) {
        if (p.type === 'tool-call') callIds.add(p.toolCallId!)
        if (p.type === 'tool-result') resIds.add(p.toolCallId!)
      }
    }
    expect([...callIds]).toEqual(['c1'])
    expect([...callIds].every(id => resIds.has(id))).toBe(true)
  })

  it('wraps user content with nonce tags for the model view', () => {
    const s = new MessageStore()
    s.appendUser('find bugs', 'AB12')
    const msgs = s.toModelMessages()
    expect(msgs[0]).toEqual({ role: 'user', content: '<|TAG_AB12|>\nfind bugs\n<|TAG_END_AB12|>' })
  })

  it('prepends compression summary and guarantees a leading user turn', () => {
    const s = new MessageStore()
    // only a system message → toModelMessages must inject a user turn
    s.appendSystem('seed')
    const msgs = s.toModelMessages()
    expect(msgs.some(m => m.role === 'user')).toBe(true)
  })

  it('tracks loaded skills without polluting the model context', () => {
    const s = new MessageStore()
    s.addSkillLoaded('recon')
    s.addSkillLoaded('recon') // dedupe
    s.appendUser('go')
    expect(s.getLoadedSkillNames()).toEqual(['recon'])
    expect(s.toModelMessages().every(m => m.role !== 'system' || !String(m.content).includes('recon'))).toBe(true)
  })

  it('builds frontend history as ordered native parts (text + tool interleaved)', () => {
    const s = new MessageStore()
    s.appendUser('scan')
    const resp: ModelMessage[] = [
      { role: 'assistant', content: [
        { type: 'text', text: 'calling' },
        { type: 'tool-call', toolCallId: 'tc1', toolName: 'http_request', input: { url: '/' } },
      ] },
      { role: 'tool', content: [
        { type: 'tool-result', toolCallId: 'tc1', toolName: 'http_request', output: { type: 'text', value: '200 OK' } },
      ] },
    ]
    s.appendResponse(resp)
    const hist = s.toHistoryMessages()
    expect(hist[0]).toEqual({ role: 'user', parts: [{ type: 'text', text: 'scan' }] })
    expect(hist[1].role).toBe('assistant')
    // Native order: text run first, then the tool part — no CHRONO markers.
    expect(hist[1].parts[0]).toEqual({ type: 'text', text: 'calling' })
    expect(hist[1].parts[1]).toMatchObject({ type: 'tool', toolCallId: 'tc1', toolName: 'http_request' })
    const serialized = JSON.stringify(hist)
    expect(serialized).not.toContain('CHRONO')
  })

  it('recoverFromPTL drops oldest rounds and keeps a valid leading turn', () => {
    const s = new MessageStore()
    for (let i = 0; i < 5; i++) {
      s.appendUser(`round ${i}`)
      s.appendResponse([{ role: 'assistant', content: [{ type: 'text', text: `reply ${i}` }] }])
    }
    const before = s.length
    expect(s.recoverFromPTL()).toBe(true)
    expect(s.length).toBeLessThan(before)
    // summary note recorded
    expect(s.toModelMessages()[0].content).toContain('PTL 恢复')
  })

  it('sanitizes orphan tool-call / tool-result in toModelMessages()', () => {
    const s = new MessageStore()
    s.appendUser('hi')
    // assistant tool-call with NO matching tool-result anywhere → orphan
    s.appendResponse([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'calling' },
          { type: 'tool-call', toolCallId: 'orphanCall', toolName: 'http_request', input: {} },
        ],
      } as never,
      // an unrelated tool-result with no preceding tool-call → orphan
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'orphanResult', toolName: 'noop', output: { type: 'text', value: 'x' } },
        ],
      } as never,
    ])
    const out = s.toModelMessages()
    // No orphan tool-call should remain in any assistant message.
    for (const m of out) {
      if (m.role !== 'assistant' || typeof m.content === 'string') continue
      for (const p of m.content) {
        if (p.type === 'tool-call') {
          expect(p.toolCallId).not.toBe('orphanCall')
        }
      }
    }
    // No orphan tool-result should remain in any tool message either.
    for (const m of out) {
      if (m.role !== 'tool' || typeof m.content === 'string') continue
      for (const p of m.content) {
        if (p.type === 'tool-result') {
          expect(p.toolCallId).not.toBe('orphanResult')
        }
      }
    }
  })
})
