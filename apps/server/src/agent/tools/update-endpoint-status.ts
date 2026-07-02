import { tool } from 'ai'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { getDb, endpoints } from '@src-agent/db'

export const updateEndpointStatusTool = (sessionId: string) =>
  tool({
    description:
      '更新接口的验证状态。测试完一个接口后调用此工具标记结果：verified_safe（已测试无漏洞）或 verified_vulnerable（已确认存在漏洞）。',
    inputSchema: z.object({
      endpointId: z.string().describe('要更新的接口 ID'),
      status: z
        .enum(['verified_safe', 'verified_vulnerable'])
        .describe('验证结果：verified_safe=已测试无漏洞，verified_vulnerable=已确认存在漏洞'),
    }),
    execute: async (params) => {
      const db = getDb()
      const [ep] = await db
        .select({ id: endpoints.id, sessionId: endpoints.sessionId })
        .from(endpoints)
        .where(eq(endpoints.id, params.endpointId))
        .limit(1)

      if (!ep) return { success: false, error: '接口不存在' }
      if (ep.sessionId !== sessionId) return { success: false, error: '接口不属于当前会话' }

      await db
        .update(endpoints)
        .set({ verificationStatus: params.status })
        .where(eq(endpoints.id, params.endpointId))

      return { success: true, endpointId: params.endpointId, status: params.status }
    },
  })
