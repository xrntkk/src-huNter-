import { tool } from 'ai'
import { z } from 'zod'
import { eq, and } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { getDb, endpoints } from '@src-agent/db'
import { extractHost } from '../host-utils.js'
import type { ObservationStore } from '../observation-store.js'

// SSE emitter registry (keyed by sessionId)
const emitters = new Map<string, Array<(event: unknown) => void>>()

export function registerEmitter(sessionId: string, fn: (event: unknown) => void) {
  const list = emitters.get(sessionId) ?? []
  list.push(fn)
  emitters.set(sessionId, list)
  return () => {
    const l = emitters.get(sessionId) ?? []
    emitters.set(sessionId, l.filter(f => f !== fn))
  }
}

export function emitGraphUpdate(sessionId: string, event: unknown) {
  const fns = emitters.get(sessionId) ?? []
  fns.forEach(fn => fn(event))
}

export const addEndpointTool = (sessionId: string, threadId: string, observationStore?: ObservationStore) =>
  tool({
    description:
      '将发现的 API 接口记录到接口图谱。在爬取过程中每发现一个新接口就调用一次。相同 method+pathTemplate 的接口自动去重。',
    inputSchema: z.object({
      url: z.string().describe('完整的接口 URL'),
      method: z
        .enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'UNKNOWN'])
        .default('UNKNOWN'),
      pathTemplate: z
        .string()
        .describe('参数化路径，如 /api/orders/{id}，将数字 ID 替换为 {id}'),
      description: z
        .string()
        .optional()
        .describe('用一句话说明这个接口是干什么的，便于后续排查。如"根据订单ID查询订单详情，疑似存在越权风险"。结合路径、参数、响应内容推断其业务用途。'),
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
          body: z.string().max(500).describe('响应体前500字符'),
        })
        .optional(),
      techStack: z
        .array(z.string())
        .optional()
        .describe('识别到的技术栈，如 ["spring-boot", "jwt"]'),
      riskHints: z
        .array(z.string())
        .optional()
        .describe('风险提示，如 ["contains_id_param", "requires_auth", "admin_path"]'),
    }),
    execute: async params => {
      const db = getDb()
      // 去重：同 sessionId + method + pathTemplate
      const existing = await db
        .select({ id: endpoints.id })
        .from(endpoints)
        .where(
          and(
            eq(endpoints.sessionId, sessionId),
            eq(endpoints.method, params.method),
            eq(endpoints.pathTemplate, params.pathTemplate),
          ),
        )
        .limit(1)

      if (existing.length > 0) {
        return { success: true, endpointId: existing[0].id, duplicate: true }
      }

      const id = nanoid()
      await db.insert(endpoints).values({
        id,
        sessionId,
        url: params.url,
        host: extractHost(params.url),
        method: params.method,
        pathTemplate: params.pathTemplate,
        description: params.description ?? null,
        source: params.source,
        sampleRequest: params.sampleRequest ?? null,
        sampleResponse: params.sampleResponse ?? null,
        techStack: params.techStack ?? [],
        riskHints: params.riskHints ?? [],
        createdAt: new Date(),
      })

      emitGraphUpdate(sessionId, {
        type: 'endpoint_added',
        endpoint: { id, method: params.method, pathTemplate: params.pathTemplate },
      })

      // Cairn-style Fact recording
      if (observationStore) {
        observationStore.addFact({
          sessionId,
          threadId,
          type: 'endpoint',
          content: {
            endpointId: id,
            url: params.url,
            method: params.method,
            pathTemplate: params.pathTemplate,
            description: params.description,
            techStack: params.techStack,
            riskHints: params.riskHints,
          },
          source: 'add_endpoint',
          confidence: 100,
        })
      }

      return { success: true, endpointId: id, duplicate: false }
    },
  })
