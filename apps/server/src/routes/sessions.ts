import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq, desc, count } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { getDb, sessions, endpoints, findings, threads } from '@src-agent/db'

export const sessionsRouter = new Hono()

sessionsRouter.get('', async c => {
  const db = getDb()
  const all = await db.select().from(sessions).orderBy(desc(sessions.createdAt))

  // Aggregate endpoint/finding counts per session in two grouped queries
  const epCounts = await db
    .select({ sessionId: endpoints.sessionId, count: count() })
    .from(endpoints)
    .groupBy(endpoints.sessionId)
  const fdCounts = await db
    .select({ sessionId: findings.sessionId, count: count() })
    .from(findings)
    .groupBy(findings.sessionId)

  const epMap = new Map(epCounts.map(r => [r.sessionId, r.count]))
  const fdMap = new Map(fdCounts.map(r => [r.sessionId, r.count]))

  return c.json(
    all.map(s => ({
      ...s,
      endpointCount: epMap.get(s.id) ?? 0,
      findingCount: fdMap.get(s.id) ?? 0,
    })),
  )
})

sessionsRouter.post(
  '/',
  zValidator('json', z.object({
    domain: z.string()
      .trim()
      .min(1, '请输入目标域名')
      // 裸域名(example.com)、带端口/路径都先补 https://，再按 URL 校验
      .transform(v => (/^https?:\/\//i.test(v) ? v : `https://${v}`))
      .pipe(z.string().url('域名格式不正确')),
    title: z.string().optional(),
  })),
  async c => {
    const { domain, title } = c.req.valid('json')
    const db = getDb()
    const now = Date.now()
    const id = nanoid()
    const [session] = await db
      .insert(sessions)
      .values({ id, domain, title: title ?? null, status: 'idle', createdAt: new Date(now), updatedAt: new Date(now) })
      .returning()

    // Create a default thread for the new session
    const threadId = nanoid()
    await db.insert(threads).values({
      id: threadId,
      sessionId: id,
      title: '新会话',
      createdAt: new Date(now),
    })

    return c.json(session, 201)
  },
)

sessionsRouter.get('/:id', async c => {
  const db = getDb()
  const id = c.req.param('id')
  const [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, id))
  if (!session) return c.json({ error: 'Not found' }, 404)

  // Include stats
  const [epCount] = await db.select({ count: count() }).from(endpoints).where(eq(endpoints.sessionId, id))
  const [fdCount] = await db.select({ count: count() }).from(findings).where(eq(findings.sessionId, id))

  return c.json({
    ...session,
    endpointCount: epCount?.count ?? 0,
    findingCount: fdCount?.count ?? 0,
  })
})

sessionsRouter.patch(
  '/:id',
  zValidator(
    'json',
    z.object({
      status: z.enum(['idle', 'crawling', 'ready', 'testing', 'analyzing', 'completed', 'error']).optional(),
      title: z.string().optional(),
    }),
  ),
  async c => {
    const db = getDb()
    const updates = c.req.valid('json')
    const setData: Record<string, unknown> = { updatedAt: new Date() }
    if (updates.title !== undefined) setData.title = updates.title
    if (updates.status !== undefined) setData.status = updates.status
    const [updated] = await db
      .update(sessions)
      .set(setData as Parameters<ReturnType<typeof db.update>['set']>[0])
      .where(eq(sessions.id, c.req.param('id')))
      .returning()
    if (!updated) return c.json({ error: 'Not found' }, 404)
    return c.json(updated)
  },
)

sessionsRouter.delete('/:id', async c => {
  const db = getDb()
  await db.delete(sessions).where(eq(sessions.id, c.req.param('id')))
  return c.body(null, 204)
})

// GET /sessions/:id/stats - summary stats for a session
sessionsRouter.get('/:id/stats', async c => {
  const db = getDb()
  const id = c.req.param('id')

  const [epCount] = await db.select({ count: count() }).from(endpoints).where(eq(endpoints.sessionId, id))
  const [fdCount] = await db.select({ count: count() }).from(findings).where(eq(findings.sessionId, id))

  const severities = await db.select({ severity: findings.severity, count: count() })
    .from(findings)
    .where(eq(findings.sessionId, id))
    .groupBy(findings.severity)

  return c.json({
    endpointCount: epCount?.count ?? 0,
    findingCount: fdCount?.count ?? 0,
    findings: Object.fromEntries(severities.map(s => [s.severity, s.count])),
  })
})
