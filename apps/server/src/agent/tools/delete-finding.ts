import { tool } from 'ai'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { getDb, findings } from '@src-agent/db'
import { emitGraphUpdate } from './add-endpoint.js'
import type { ObservationStore } from '../observation-store.js'
import { logger } from '../../logger/index.js'

export const deleteFindingTool = (sessionId: string, _threadId: string, observationStore?: ObservationStore) =>
  tool({
    description:
      '删除一条已记录的漏洞发现(finding)。用于误报、重复记录或需要撤销的场景。',
    inputSchema: z.object({
      findingId: z.string().describe('要删除的 finding ID'),
      reason: z.string().optional().describe('删除原因（可选，如：误报、重复、信息不足）'),
    }),
    execute: async params => {
      const db = getDb()

      // 先查询确认存在且属于当前 session
      const existing = await db
        .select()
        .from(findings)
        .where(eq(findings.id, params.findingId))
        .get()

      if (!existing) {
        return { success: false, error: `finding ${params.findingId} 不存在` }
      }
      if (existing.sessionId !== sessionId) {
        return { success: false, error: '无权删除此 finding（不属于当前会话）' }
      }

      // 执行删除
      await db.delete(findings).where(eq(findings.id, params.findingId))

      // SSE 通知前端
      emitGraphUpdate(sessionId, {
        type: 'finding_deleted',
        findingId: params.findingId,
      })

      // 从 ObservationStore 中移除关联的 vuln_candidate fact
      if (observationStore) {
        try {
          const relatedFacts = observationStore.getFactsBySource('add_finding')
            .filter(f => (f.content as Record<string, unknown>)?.findingId === params.findingId)
          for (const f of relatedFacts) {
            observationStore.deleteFact(f.id)
          }
          if (relatedFacts.length > 0) {
            logger.info(`[delete_finding] Removed ${relatedFacts.length} associated ObservationStore entries`)
          }
        } catch {
          // non-blocking: fact graph 操作失败不影响删除结果
        }
      }

      return { success: true, deletedId: params.findingId, deletedTitle: existing.title }
    },
  })
