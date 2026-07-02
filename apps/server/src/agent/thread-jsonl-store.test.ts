import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelMessage } from 'ai'
import { ThreadJsonlStore } from './thread-jsonl-store.js'

let tmp: string
let prevRoot: string | undefined

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'jsonl-test-'))
  prevRoot = process.env.THREAD_JSONL_ROOT
  process.env.THREAD_JSONL_ROOT = tmp
})
afterEach(() => {
  if (prevRoot == null) delete process.env.THREAD_JSONL_ROOT
  else process.env.THREAD_JSONL_ROOT = prevRoot
  rmSync(tmp, { recursive: true, force: true })
})

describe('ThreadJsonlStore', () => {
  it('returns an empty load when the file does not exist', async () => {
    const r = await ThreadJsonlStore.load('thread-missing')
    expect(r).toEqual({ messages: [], meta: [], markers: [], lastSeq: 0, corruptLines: 0 })
  })

  it('round-trips messages, meta, and markers', async () => {
    const tid = 'thread-1'
    const m1: ModelMessage = { role: 'user', content: 'hello' }
    const m2: ModelMessage = { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }
    await ThreadJsonlStore.appendMessage(tid, 1, m1)
    await ThreadJsonlStore.appendMessage(tid, 2, m2)
    await ThreadJsonlStore.appendMeta(tid, 3, 'compression', 'short summary')
    await ThreadJsonlStore.appendMeta(tid, 4, 'skill_loaded', 'src-recon')
    await ThreadJsonlStore.appendMarker(tid, 5, { kind: 'turn_start', iteration: 1, ts: Date.now() })

    const loaded = await ThreadJsonlStore.load(tid)
    expect(loaded.messages.length).toBe(2)
    expect(loaded.meta.length).toBe(2)
    expect(loaded.markers.length).toBe(1)
    expect(loaded.lastSeq).toBe(5)
    expect(loaded.corruptLines).toBe(0)
  })

  it('skips a corrupt trailing line (write-during-crash) without losing earlier data', async () => {
    const tid = 'thread-corrupt'
    await ThreadJsonlStore.appendMessage(tid, 1, { role: 'user', content: 'real' })
    appendFileSync(ThreadJsonlStore.path(tid), '{"t":"msg","seq":2,"ts":"x","msg":INVALID')
    const loaded = await ThreadJsonlStore.load(tid)
    expect(loaded.messages.length).toBe(1)
    expect(loaded.corruptLines).toBe(1)
  })

  it('writeSnapshot is atomic and produces matching load output', async () => {
    const tid = 'thread-snap'
    const messages: ModelMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
    ]
    const { path, lastSeq } = await ThreadJsonlStore.writeSnapshot(tid, {
      messages,
      meta: [{ kind: 'compression', payload: 'sum' }, { kind: 'skill_loaded', payload: 'recon' }],
      markers: [],
    })
    expect(path).toContain(tmp)
    expect(lastSeq).toBe(4)

    const loaded = await ThreadJsonlStore.load(tid)
    expect(loaded.messages.length).toBe(2)
    expect(loaded.meta.length).toBe(2)
    expect(loaded.lastSeq).toBe(4)
  })

  it('serializes interleaved appends per-thread (no torn lines)', async () => {
    const tid = 'thread-concurrent'
    // Fire 20 appends without awaits; the internal queue must serialise them.
    const promises: Array<Promise<void>> = []
    for (let i = 1; i <= 20; i++) {
      promises.push(ThreadJsonlStore.appendMessage(tid, i, { role: 'user', content: String(i) }))
    }
    await Promise.all(promises)
    const loaded = await ThreadJsonlStore.load(tid)
    expect(loaded.corruptLines).toBe(0)
    expect(loaded.messages.length).toBe(20)
    expect(loaded.lastSeq).toBe(20)
  })

  it('refuses path traversal in threadId by sanitising the filename', () => {
    const path = ThreadJsonlStore.path('../../etc/passwd')
    expect(path).toContain(tmp)
    // No path separators or dots may survive into the on-disk filename
    // (otherwise we'd escape data/threads/).
    const fname = path.split('/').pop()!
    expect(fname).not.toContain('..')
    expect(fname).not.toContain('/')
    expect(fname.endsWith('.jsonl')).toBe(true)
  })
})
