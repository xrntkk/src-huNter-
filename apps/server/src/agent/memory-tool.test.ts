/**
 * memory tool CRUD + graph tests. Run against the disposable test database
 * (DATABASE_URL is set by test/setup.ts). Exercises create/update/view/
 * search/link via the tool's execute, then asserts the underlying rows.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { nanoid } from 'nanoid'
import { getDb, sessions, memories, memoryEdges } from '@src-agent/db'
import { eq } from 'drizzle-orm'
import { memoryTool } from '../agent/tools/memory.js'

function makeSession(): string {
  const id = nanoid()
  const now = new Date()
  getDb().insert(sessions).values({
    id,
    domain: 'example.com',
    title: 'test',
    status: 'idle',
    createdAt: now,
    updatedAt: now,
  }).run()
  return id
}

// The tool's execute is invoked by the SDK with (args, context); in tests we
// call it directly with a minimal cast since the tool ignores the context.
type Exec = (args: unknown, ctx?: unknown) => Promise<any>
const run = (sessionId: string, args: unknown) =>
  (memoryTool(sessionId).execute as unknown as Exec)(args)

describe('memory tool', () => {
  let sessionId: string

  beforeEach(() => {
    sessionId = makeSession()
  })

  it('creates a memory and reads it back via view by id', async () => {
    const created = await run(sessionId, {
      action: 'create',
      kind: 'lesson',
      title: 'JWT alg=none',
      content: '目标接受 alg=none 的 JWT',
    })
    expect(created.success).toBe(true)
    expect(created.id).toBeTruthy()

    const viewed = await run(sessionId, { action: 'view', id: created.id })
    expect(viewed.success).toBe(true)
    expect(viewed.memory.title).toBe('JWT alg=none')
    expect(viewed.memory.kind).toBe('lesson')
  })

  it('rejects create without title/content', async () => {
    const res = await run(sessionId, { action: 'create', title: '缺正文' })
    expect(res.success).toBe(false)
  })

  it('updates an existing memory', async () => {
    const { id } = await run(sessionId, {
      action: 'create',
      title: 'orig',
      content: 'orig body',
    })
    const upd = await run(sessionId, { action: 'update', id, content: 'new body' })
    expect(upd.success).toBe(true)

    const row = getDb().select().from(memories).where(eq(memories.id, id)).all()[0]
    expect(row.content).toBe('new body')
    expect(row.title).toBe('orig')
  })

  it('searches by keyword across title and content', async () => {
    await run(sessionId, { action: 'create', title: 'SQL 注入', content: 'order by 探测' })
    await run(sessionId, { action: 'create', title: '无关', content: '只是笔记' })

    const byTitle = await run(sessionId, { action: 'search', query: '注入' })
    expect(byTitle.count).toBe(1)
    const byContent = await run(sessionId, { action: 'search', query: 'order by' })
    expect(byContent.count).toBe(1)
  })

  it('links two memories idempotently', async () => {
    const a = await run(sessionId, { action: 'create', title: 'A', content: 'a' })
    const b = await run(sessionId, { action: 'create', title: 'B', content: 'b' })

    const linked = await run(sessionId, {
      action: 'link',
      from: a.id,
      to: b.id,
      relation: 'caused_by',
    })
    expect(linked.success).toBe(true)

    // Re-linking the same edge must not throw or duplicate.
    await run(sessionId, { action: 'link', from: a.id, to: b.id, relation: 'caused_by' })
    const edges = getDb().select().from(memoryEdges).where(eq(memoryEdges.from, a.id)).all()
    expect(edges.length).toBe(1)
    expect(edges[0].relation).toBe('caused_by')
  })

  it('refuses to link ids outside the session', async () => {
    const a = await run(sessionId, { action: 'create', title: 'A', content: 'a' })
    const res = await run(sessionId, { action: 'link', from: a.id, to: 'nonexistent' })
    expect(res.success).toBe(false)
  })
})
