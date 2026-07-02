import { tool } from 'ai'
import { z } from 'zod'
import { eq, and, inArray } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { getDb, endpoints } from '@src-agent/db'
import { extractHost } from '../host-utils.js'
import { emitGraphUpdate } from './add-endpoint.js'
import type { ObservationStore } from '../observation-store.js'

export const endpointItemSchema = z.object({
  url: z.string().describe('完整接口 URL'),
  method: z
    .enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'UNKNOWN'])
    .default('UNKNOWN'),
  pathTemplate: z
    .string()
    .describe('参数化路径，数字 ID 替换为 {id}，如 /api/orders/{id}'),
  description: z
    .string()
    .optional()
    .describe('一句话说明用途，结合路径/参数/响应推断业务含义'),
  source: z.enum(['js_parse', 'network_intercept', 'page_link', 'form', 'manual']),
  sampleRequest: z
    .object({
      headers: z.record(z.string()).optional(),
      body: z.string().optional(),
    })
    .optional(),
  sampleResponse: z
    .object({
      status: z.number(),
      body: z.string().max(500),
    })
    .optional(),
  techStack: z.array(z.string()).optional(),
  riskHints: z.array(z.string()).optional(),
})

export type EndpointItem = z.infer<typeof endpointItemSchema>

export interface InsertEndpointsResult {
  total: number
  inserted: number
  skipped: number
  insertedSample: Array<{ id: string; method: string; pathTemplate: string }>
}

/** Max rows per INSERT — bounds SQLite bound-variable count for large imports. */
const INSERT_CHUNK = 100

/**
 * Shared endpoint-ingestion core used by both `add_endpoints_batch` (model
 * passes an array inline) and `import_endpoints` (server reads a JSON file).
 * Handles in-batch dedup, DB existence check, chunked insert, graph broadcast,
 * and ObservationStore recording. Keeping this server-side means large imports
 * never round-trip through the model context.
 */
export async function insertEndpoints(
  sessionId: string,
  threadId: string,
  items: EndpointItem[],
  observationStore?: ObservationStore,
): Promise<InsertEndpointsResult> {
  const db = getDb()

  // 入参内部去重（避免同批次重复）
  const seen = new Set<string>()
  const deduped: EndpointItem[] = []
  for (const it of items) {
    const key = `${it.method}::${it.pathTemplate}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(it)
  }

  // 批量查已存在记录（同 session + method + pathTemplate）
  const pathTemplates = deduped.map(it => it.pathTemplate)
  const existingRows = pathTemplates.length > 0
    ? await db
        .select({ method: endpoints.method, pathTemplate: endpoints.pathTemplate, id: endpoints.id })
        .from(endpoints)
        .where(
          and(
            eq(endpoints.sessionId, sessionId),
            inArray(endpoints.pathTemplate, pathTemplates),
          ),
        )
    : []

  const existingKeys = new Set(existingRows.map(r => `${r.method}::${r.pathTemplate}`))

  const inserted: Array<{ id: string; method: string; pathTemplate: string }> = []
  const skipped: Array<{ method: string; pathTemplate: string }> = []
  const now = new Date()

  const rowsToInsert: Array<typeof endpoints.$inferInsert> = []
  for (const it of deduped) {
    const key = `${it.method}::${it.pathTemplate}`
    if (existingKeys.has(key)) {
      skipped.push({ method: it.method, pathTemplate: it.pathTemplate })
      continue
    }
    const id = nanoid()
    rowsToInsert.push({
      id,
      sessionId,
      url: it.url,
      host: extractHost(it.url),
      method: it.method,
      pathTemplate: it.pathTemplate,
      description: it.description ?? null,
      source: it.source,
      sampleRequest: it.sampleRequest ?? null,
      sampleResponse: it.sampleResponse ?? null,
      techStack: it.techStack ?? [],
      riskHints: it.riskHints ?? [],
      createdAt: now,
    })
    inserted.push({ id, method: it.method, pathTemplate: it.pathTemplate })
  }

  // 分块 insert，避免大批量超出 SQLite 变量上限
  for (let i = 0; i < rowsToInsert.length; i += INSERT_CHUNK) {
    await db.insert(endpoints).values(rowsToInsert.slice(i, i + INSERT_CHUNK))
  }

  // 一次性广播：单条 batch 事件 + 每条 endpoint_added 兼容现有 UI
  if (inserted.length > 0) {
    emitGraphUpdate(sessionId, {
      type: 'endpoints_batch_added',
      count: inserted.length,
      endpoints: inserted,
    })
    for (const ep of inserted) {
      emitGraphUpdate(sessionId, { type: 'endpoint_added', endpoint: ep })
    }
  }

  // ObservationStore 记录
  if (observationStore) {
    for (const it of deduped) {
      const insertedRec = inserted.find(
        r => r.method === it.method && r.pathTemplate === it.pathTemplate,
      )
      if (!insertedRec) continue
      observationStore.addFact({
        sessionId,
        threadId,
        type: 'endpoint',
        content: {
          endpointId: insertedRec.id,
          url: it.url,
          method: it.method,
          pathTemplate: it.pathTemplate,
          description: it.description,
          techStack: it.techStack,
          riskHints: it.riskHints,
        },
        source: 'add_endpoints_batch',
        confidence: 100,
      })
    }
  }

  return {
    total: deduped.length,
    inserted: inserted.length,
    skipped: skipped.length,
    insertedSample: inserted.slice(0, 10),
  }
}

export const addEndpointsBatchTool = (
  sessionId: string,
  threadId: string,
  observationStore?: ObservationStore,
) =>
  tool({
    description:
      '批量记录接口（一次调用导入多个）。适合从 JS 文件或大段网络日志一次性提取出几十/上百个接口的场景，' +
      '相比逐个调用 add_endpoint 大幅减少模型 token 消耗与往返次数。' +
      '同 method+pathTemplate 自动去重（已存在的会跳过）。',
    inputSchema: z.object({
      endpoints: z
        .array(endpointItemSchema)
        .min(1)
        .max(200)
        .describe('要批量记录的接口数组（1-200 个）'),
    }),
    execute: async ({ endpoints: items }) => {
      const result = await insertEndpoints(sessionId, threadId, items, observationStore)
      return { success: true, ...result }
    },
  })
