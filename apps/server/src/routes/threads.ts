import { Hono } from 'hono'
import { nanoid } from 'nanoid'
import { eq, desc } from 'drizzle-orm'
import { getDb, threads } from '@src-agent/db'

export const threadsRouter = new Hono()

// List threads for a session
threadsRouter.get('/sessions/:sessionId/threads', async c => {
  const db = getDb()
  const sessionId = c.req.param('sessionId')
  const list = await db
    .select()
    .from(threads)
    .where(eq(threads.sessionId, sessionId))
    .orderBy(desc(threads.createdAt))
  return c.json(list)
})

// Create a new thread in a session
threadsRouter.post('/sessions/:sessionId/threads', async c => {
  const db = getDb()
  const sessionId = c.req.param('sessionId')
  const body = await c.req.json<{ title?: string }>()
  const id = nanoid()
  const now = new Date()
  await db.insert(threads).values({
    id,
    sessionId,
    title: body.title ?? null,
    createdAt: now,
  })
  const [thread] = await db.select().from(threads).where(eq(threads.id, id))
  return c.json(thread, 201)
})

// Delete a thread
threadsRouter.delete('/threads/:threadId', async c => {
  const db = getDb()
  const threadId = c.req.param('threadId')
  await db.delete(threads).where(eq(threads.id, threadId))
  return c.json({ ok: true })
})

// Rename a thread
threadsRouter.patch('/sessions/:sessionId/threads/:threadId', async c => {
  const db = getDb()
  const threadId = c.req.param('threadId')
  const body = await c.req.json<{ title?: string }>()
  const title = (body.title ?? '').trim()
  if (!title) return c.json({ error: 'title is required' }, 400)
  await db.update(threads).set({ title }).where(eq(threads.id, threadId))
  const [thread] = await db.select().from(threads).where(eq(threads.id, threadId))
  if (!thread) return c.json({ error: 'thread not found' }, 404)
  return c.json(thread)
})
