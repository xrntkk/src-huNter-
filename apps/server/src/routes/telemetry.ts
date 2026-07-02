import { Hono } from 'hono'
import { eq, and, gte, desc, sql, count } from 'drizzle-orm'
import { getDb, telemetryEvents } from '@src-agent/db'

export const telemetryRouter = new Hono()

const DAY = 24 * 60 * 60 * 1000

function bucketSizeFor(range: 'day' | 'week' | 'month'): number {
  if (range === 'day') return 60 * 60 * 1000
  return 24 * 60 * 60 * 1000
}

function rangeWindowMs(range: 'day' | 'week' | 'month'): number {
  if (range === 'day') return DAY
  if (range === 'week') return 7 * DAY
  return 30 * DAY
}

// Welford-style percentile from sorted in-memory durations. Cheap for our
// volumes (≤ a few thousand tool calls per window). Returns ms.
function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))
  return sorted[idx]
}

// GET /api/telemetry/session/:sessionId/summary
telemetryRouter.get('/session/:sessionId/summary', async c => {
  const sessionId = c.req.param('sessionId')
  const db = getDb()
  const rows = await db
    .select({
      type: telemetryEvents.type,
      inputTokens: sql<number>`COALESCE(SUM(${telemetryEvents.inputTokens}), 0)`,
      outputTokens: sql<number>`COALESCE(SUM(${telemetryEvents.outputTokens}), 0)`,
      cacheReadTokens: sql<number>`COALESCE(SUM(${telemetryEvents.cacheReadTokens}), 0)`,
      cacheWriteTokens: sql<number>`COALESCE(SUM(${telemetryEvents.cacheWriteTokens}), 0)`,
      cost: sql<number>`COALESCE(SUM(${telemetryEvents.costUsd}), 0)`,
      n: count(),
    })
    .from(telemetryEvents)
    .where(eq(telemetryEvents.sessionId, sessionId))
    .groupBy(telemetryEvents.type)

  const s = {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    totalTokens: 0, cacheHitRate: 0, modelCalls: 0, toolCalls: 0, toolErrors: 0,
    costUsd: 0, errorRate: 0, events: 0,
  }
  for (const r of rows) {
    s.events += r.n
    if (r.type === 'model_usage') {
      s.inputTokens += Number(r.inputTokens)
      s.outputTokens += Number(r.outputTokens)
      s.cacheReadTokens += Number(r.cacheReadTokens)
      s.cacheWriteTokens += Number(r.cacheWriteTokens)
      s.modelCalls += r.n
      s.costUsd += Number(r.cost)
    }
    if (r.type === 'tool_call') s.toolCalls += r.n
    if (r.type === 'tool_error') s.toolErrors += r.n
  }
  s.totalTokens = s.inputTokens + s.outputTokens + s.cacheReadTokens + s.cacheWriteTokens
  const denom = s.cacheReadTokens + s.inputTokens
  s.cacheHitRate = denom === 0 ? 0 : s.cacheReadTokens / denom
  s.errorRate = s.toolCalls === 0 ? 0 : s.toolErrors / s.toolCalls
  return c.json(s)
})

// GET /api/telemetry/session/:sessionId/subagents
telemetryRouter.get('/session/:sessionId/subagents', async c => {
  const sessionId = c.req.param('sessionId')
  const db = getDb()
  // subagent_tasks keyed by parent_thread_id; threads table joins via session
  const rows = db.all(sql`
    SELECT t.task_id, t.description, t.status, t.started_at, t.finished_at,
           t.tool_call_count, t.tool_error_count, t.endpoints_found, t.findings_found,
           t.summary, t.error
    FROM subagent_tasks t
    JOIN threads th ON th.id = t.parent_thread_id
    WHERE th.session_id = ${sessionId}
    ORDER BY t.started_at DESC
    LIMIT 50
  `)
  return c.json(rows)
})

// GET /api/telemetry/session/:sessionId/trace
// Returns iterations grouped with their event sequences — built-in alternative
// to Langfuse trace UI. Bounded to the most recent N iterations.
telemetryRouter.get('/session/:sessionId/trace', async c => {
  const sessionId = c.req.param('sessionId')
  const limit = Math.min(Number(c.req.query('iterations') ?? 30), 100)
  const db = getDb()

  // Pull all events for this session ordered by time; group in-process by iteration
  const rows = await db
    .select()
    .from(telemetryEvents)
    .where(eq(telemetryEvents.sessionId, sessionId))
    .orderBy(desc(telemetryEvents.createdAt))
    .limit(limit * 80) // generous cap; one iteration averages ~10–30 events

  type Iter = {
    iteration: number
    startedAt: number
    endedAt: number
    modelId: string | null
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    costUsd: number
    modelCalls: number
    toolCalls: number
    toolErrors: number
    events: typeof rows
  }

  const byIter = new Map<number, Iter>()
  for (const ev of rows) {
    const iter = ev.iteration ?? 0
    if (!byIter.has(iter)) {
      byIter.set(iter, {
        iteration: iter,
        startedAt: ev.createdAt, endedAt: ev.createdAt,
        modelId: null,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        costUsd: 0, modelCalls: 0, toolCalls: 0, toolErrors: 0,
        events: [],
      })
    }
    const cur = byIter.get(iter)!
    cur.startedAt = Math.min(cur.startedAt, ev.createdAt)
    cur.endedAt = Math.max(cur.endedAt, ev.createdAt)
    if (ev.modelId) cur.modelId = ev.modelId
    if (ev.type === 'model_usage') {
      cur.inputTokens += ev.inputTokens ?? 0
      cur.outputTokens += ev.outputTokens ?? 0
      cur.cacheReadTokens += ev.cacheReadTokens ?? 0
      cur.cacheWriteTokens += ev.cacheWriteTokens ?? 0
      cur.costUsd += ev.costUsd ?? 0
      cur.modelCalls += 1
    }
    if (ev.type === 'tool_call') cur.toolCalls += 1
    if (ev.type === 'tool_error') cur.toolErrors += 1
    cur.events.push(ev)
  }

  // Sort each iteration's events ascending (so timeline reads top-to-bottom)
  for (const iter of byIter.values()) iter.events.sort((a, b) => a.createdAt - b.createdAt)

  // Most recent iterations first, bounded by limit
  const iterations = [...byIter.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, limit)
  return c.json({ iterations })
})

// GET /api/telemetry/session/:sessionId/context
// Latest context_snapshot per thread (main run + each sub-agent) so the UI can
// render a live "how full is the context" gauge per sub-session, plus the
// system-prompt section breakdown for the most recent snapshot.
telemetryRouter.get('/session/:sessionId/context', async c => {
  const sessionId = c.req.param('sessionId')
  const db = getDb()
  const rows = await db
    .select()
    .from(telemetryEvents)
    .where(and(
      eq(telemetryEvents.sessionId, sessionId),
      eq(telemetryEvents.type, 'context_snapshot'),
    ))
    .orderBy(desc(telemetryEvents.createdAt))
    .limit(500)

  // Keep the newest snapshot per threadId (rows already newest-first).
  type Lane = {
    threadId: string | null
    iteration: number | null
    modelId: string | null
    contextTokens: number
    effectiveTokens: number
    contextWindowTokens: number | null
    pct: number
    llmSummaryWatermark: number | null
    ptlBlockWatermark: number | null
    warningLevel: 'ok' | 'warn' | 'critical' | null
    kind: string
    sections: Record<string, number> | null
    updatedAt: number
  }
  const byThread = new Map<string, Lane>()
  for (const r of rows) {
    const key = r.threadId ?? '__main__'
    if (byThread.has(key)) continue
    let parsed: Record<string, unknown> = {}
    try { parsed = r.data ? JSON.parse(r.data) : {} } catch { /* ignore */ }
    const sections = (parsed.sections && typeof parsed.sections === 'object')
      ? parsed.sections as Record<string, number>
      : null
    const rawLevel = parsed.warningLevel
    const warningLevel: 'ok' | 'warn' | 'critical' | null =
      rawLevel === 'ok' || rawLevel === 'warn' || rawLevel === 'critical' ? rawLevel : null
    byThread.set(key, {
      threadId: r.threadId,
      iteration: r.iteration,
      modelId: r.modelId ?? (typeof parsed.modelId === 'string' ? parsed.modelId : null),
      contextTokens: Number(parsed.contextTokens ?? 0),
      effectiveTokens: Number(parsed.effectiveTokens ?? 0),
      contextWindowTokens: parsed.contextWindowTokens != null ? Number(parsed.contextWindowTokens) : null,
      pct: Number(parsed.pct ?? 0),
      llmSummaryWatermark: parsed.llmSummaryWatermark != null ? Number(parsed.llmSummaryWatermark) : null,
      ptlBlockWatermark: parsed.ptlBlockWatermark != null ? Number(parsed.ptlBlockWatermark) : null,
      warningLevel,
      kind: typeof parsed.kind === 'string' ? parsed.kind : 'main',
      sections,
      updatedAt: r.createdAt,
    })
  }

  // main lane first, then sub-agents by most-recently-updated
  const lanes = [...byThread.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'main' ? -1 : 1
    return b.updatedAt - a.updatedAt
  })
  return c.json({ lanes })
})

// GET /api/telemetry/global?range=day|week|month
telemetryRouter.get('/global', async c => {
  const range = (c.req.query('range') ?? 'day') as 'day' | 'week' | 'month'
  if (!['day', 'week', 'month'].includes(range)) {
    return c.json({ error: 'invalid range' }, 400)
  }
  const window = rangeWindowMs(range)
  const bucket = bucketSizeFor(range)
  const since = Date.now() - window
  const db = getDb()

  const usageRows = await db
    .select({
      bucket: sql<number>`(${telemetryEvents.createdAt} / ${bucket}) * ${bucket}`,
      inputTokens: sql<number>`COALESCE(SUM(${telemetryEvents.inputTokens}), 0)`,
      outputTokens: sql<number>`COALESCE(SUM(${telemetryEvents.outputTokens}), 0)`,
      cacheReadTokens: sql<number>`COALESCE(SUM(${telemetryEvents.cacheReadTokens}), 0)`,
      cacheWriteTokens: sql<number>`COALESCE(SUM(${telemetryEvents.cacheWriteTokens}), 0)`,
      cost: sql<number>`COALESCE(SUM(${telemetryEvents.costUsd}), 0)`,
      modelCalls: count(),
    })
    .from(telemetryEvents)
    .where(and(eq(telemetryEvents.type, 'model_usage'), gte(telemetryEvents.createdAt, since)))
    .groupBy(sql`(${telemetryEvents.createdAt} / ${bucket})`)
    .orderBy(sql`(${telemetryEvents.createdAt} / ${bucket})`)

  const toolRows = await db
    .select({
      bucket: sql<number>`(${telemetryEvents.createdAt} / ${bucket}) * ${bucket}`,
      type: telemetryEvents.type,
      n: count(),
    })
    .from(telemetryEvents)
    .where(and(
      sql`${telemetryEvents.type} IN ('tool_call', 'tool_error')`,
      gte(telemetryEvents.createdAt, since),
    ))
    .groupBy(sql`(${telemetryEvents.createdAt} / ${bucket})`, telemetryEvents.type)

  const topTools = await db
    .select({ toolName: telemetryEvents.toolName, n: count() })
    .from(telemetryEvents)
    .where(and(eq(telemetryEvents.type, 'tool_call'), gte(telemetryEvents.createdAt, since)))
    .groupBy(telemetryEvents.toolName)
    .orderBy(desc(count()))
    .limit(10)

  // By-model breakdown (cost + tokens + calls)
  const byModel = await db
    .select({
      modelId: telemetryEvents.modelId,
      calls: count(),
      inputTokens: sql<number>`COALESCE(SUM(${telemetryEvents.inputTokens}), 0)`,
      outputTokens: sql<number>`COALESCE(SUM(${telemetryEvents.outputTokens}), 0)`,
      cost: sql<number>`COALESCE(SUM(${telemetryEvents.costUsd}), 0)`,
    })
    .from(telemetryEvents)
    .where(and(eq(telemetryEvents.type, 'model_usage'), gte(telemetryEvents.createdAt, since)))
    .groupBy(telemetryEvents.modelId)
    .orderBy(desc(sql`COALESCE(SUM(${telemetryEvents.costUsd}), 0)`))

  // Tool latency rows for percentile + slowest-N. Pull raw durations (≤ a few
  // thousand) and aggregate in-process — SQLite doesn't have percentile fns.
  const durRows = await db
    .select({ toolName: telemetryEvents.toolName, durationMs: telemetryEvents.durationMs })
    .from(telemetryEvents)
    .where(and(
      sql`${telemetryEvents.type} = 'tool_result'`,
      gte(telemetryEvents.createdAt, since),
      sql`${telemetryEvents.durationMs} IS NOT NULL`,
    ))
    .limit(20_000)

  const allDurs: number[] = []
  const byTool = new Map<string, number[]>()
  for (const r of durRows) {
    if (typeof r.durationMs !== 'number') continue
    allDurs.push(r.durationMs)
    if (!r.toolName) continue
    const arr = byTool.get(r.toolName) ?? []
    arr.push(r.durationMs)
    byTool.set(r.toolName, arr)
  }
  allDurs.sort((a, b) => a - b)
  const latency = {
    count: allDurs.length,
    p50: pct(allDurs, 0.5),
    p95: pct(allDurs, 0.95),
    p99: pct(allDurs, 0.99),
    max: allDurs[allDurs.length - 1] ?? 0,
  }
  const slowestTools = [...byTool.entries()]
    .map(([name, arr]) => {
      arr.sort((a, b) => a - b)
      return { name, count: arr.length, p50: pct(arr, 0.5), p95: pct(arr, 0.95) }
    })
    .sort((a, b) => b.p95 - a.p95)
    .slice(0, 10)

  // Total error rate
  let totalCalls = 0, totalErrors = 0
  for (const r of toolRows) {
    if (r.type === 'tool_call') totalCalls += r.n
    else if (r.type === 'tool_error') totalErrors += r.n
  }
  const errorRate = totalCalls === 0 ? 0 : totalErrors / totalCalls

  return c.json({
    range,
    bucketMs: bucket,
    since,
    usage: usageRows.map(r => ({
      bucket: Number(r.bucket),
      inputTokens: Number(r.inputTokens),
      outputTokens: Number(r.outputTokens),
      cacheReadTokens: Number(r.cacheReadTokens),
      cacheWriteTokens: Number(r.cacheWriteTokens),
      costUsd: Number(r.cost),
      modelCalls: r.modelCalls,
    })),
    tools: toolRows.map(r => ({ bucket: Number(r.bucket), type: r.type, n: r.n })),
    topTools: topTools.filter(r => r.toolName).map(r => ({ name: r.toolName!, count: r.n })),
    byModel: byModel.map(r => ({
      modelId: r.modelId ?? 'unknown',
      calls: r.calls,
      inputTokens: Number(r.inputTokens),
      outputTokens: Number(r.outputTokens),
      costUsd: Number(r.cost),
    })),
    latency,
    slowestTools,
    errorRate,
    totalCalls,
    totalErrors,
  })
})

// GET /api/telemetry/recent?sessionId=&limit=50
telemetryRouter.get('/recent', async c => {
  const sessionId = c.req.query('sessionId')
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200)
  const db = getDb()
  const rows = await db
    .select()
    .from(telemetryEvents)
    .where(sessionId ? eq(telemetryEvents.sessionId, sessionId) : sql`1=1`)
    .orderBy(desc(telemetryEvents.createdAt))
    .limit(limit)
  return c.json(rows)
})
