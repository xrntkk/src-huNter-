import { tool } from 'ai'
import { z } from 'zod'
import { eq, and, like, sql } from 'drizzle-orm'
import { getDb, endpoints, findings } from '@src-agent/db'

export const listEndpointsTool = (sessionId: string) =>
  tool({
    description:
      '查询当前会话已记录的 API 接口列表。可按 method、路径模式、验证状态筛选。用于了解已发现哪些接口、哪些还未测试。',
    inputSchema: z.object({
      method: z
        .enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'UNKNOWN'])
        .optional()
        .describe('按 HTTP 方法筛选'),
      pathPattern: z
        .string()
        .optional()
        .describe('路径模糊匹配，如 "%user%" 匹配所有包含 user 的路径'),
      status: z
        .enum(['unverified', 'verified_safe', 'verified_vulnerable'])
        .optional()
        .describe('按验证状态筛选'),
      limit: z.number().default(50).describe('返回数量上限'),
      offset: z.number().default(0).describe('分页偏移'),
    }),
    execute: async (params) => {
      const db = getDb()

      const conditions = [eq(endpoints.sessionId, sessionId)]
      if (params.method) conditions.push(eq(endpoints.method, params.method))
      if (params.pathPattern) conditions.push(like(endpoints.pathTemplate, params.pathPattern))
      if (params.status) conditions.push(eq(endpoints.verificationStatus, params.status))

      const where = conditions.length === 1 ? conditions[0] : and(...conditions)

      const eps = await db
        .select()
        .from(endpoints)
        .where(where)
        .limit(params.limit)
        .offset(params.offset)

      const allFindings = await db
        .select({ endpointId: findings.endpointId })
        .from(findings)
        .where(eq(findings.sessionId, sessionId))

      const findingCounts = new Map<string, number>()
      for (const f of allFindings) {
        if (f.endpointId) findingCounts.set(f.endpointId, (findingCounts.get(f.endpointId) ?? 0) + 1)
      }

      const total = await db
        .select({ count: sql<number>`count(*)` })
        .from(endpoints)
        .where(where)
        .then(r => r[0]?.count ?? 0)

      return {
        total,
        endpoints: eps.map(ep => ({
          id: ep.id,
          method: ep.method,
          pathTemplate: ep.pathTemplate,
          url: ep.url,
          description: ep.description,
          verificationStatus: ep.verificationStatus,
          findingCount: findingCounts.get(ep.id) ?? 0,
          riskHints: ep.riskHints,
          techStack: ep.techStack,
        })),
      }
    },
  })
