import { tool } from 'ai'
import { z } from 'zod'
import { eq, and } from 'drizzle-orm'
import { getDb, findings } from '@src-agent/db'
import { emitGraphUpdate } from './add-endpoint.js'
import type { ObservationStore } from '../observation-store.js'
import { logger } from '../../logger/index.js'

export const updateFindingTool = (sessionId: string, _threadId: string, observationStore?: ObservationStore) =>
  tool({
    description:
      '二次修改已记录的漏洞 finding。支持修改严重程度、状态、标题、描述、复现步骤、证据。' +
      '典型场景：复核后发现评级偏高/偏低时调整 severity；判定为误报时将 status 改为 false_positive；' +
      '补充更完整的证据或描述。不要用它删除 finding（用 delete_finding）。',
    inputSchema: z.object({
      findingId: z.string().describe('要修改的 finding ID'),
      severity: z
        .enum(['info', 'low', 'medium', 'high', 'critical'])
        .optional()
        .describe('新的严重程度（可选，不传则不变）'),
      status: z
        .enum(['unconfirmed', 'confirmed', 'false_positive'])
        .optional()
        .describe('新的状态（可选）。confirmed=已确认真实漏洞；false_positive=判定为误报；unconfirmed=重置为待确认'),
      title: z.string().max(100).optional().describe('新的漏洞标题（可选）'),
      description: z.string().optional().describe('新的漏洞描述（可选）'),
      reproSteps: z.array(z.string()).optional().describe('新的复现步骤列表（可选，整体替换）'),
      evidence: z
        .object({
          request: z.string().describe('触发漏洞的 HTTP 请求'),
          response: z.string().describe('服务器响应（截断到1000字符内）'),
        })
        .optional()
        .describe('新的证据（可选，整体替换）'),
      reason: z
        .string()
        .optional()
        .describe('修改原因（可选，便于审计。如：复核后为误报、原评级偏高、补充证据）'),
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
        return { success: false, error: '无权修改此 finding（不属于当前会话）' }
      }

      // 构造仅包含已提供字段的 patch
      const patch: Record<string, unknown> = {}
      if (params.severity !== undefined) patch.severity = params.severity
      if (params.status !== undefined) patch.status = params.status
      if (params.title !== undefined) patch.title = params.title
      if (params.description !== undefined) patch.description = params.description
      if (params.reproSteps !== undefined) patch.reproSteps = params.reproSteps
      if (params.evidence !== undefined) patch.evidence = params.evidence

      if (Object.keys(patch).length === 0) {
        return { success: false, error: '未提供任何可更新字段' }
      }

      await db
        .update(findings)
        .set(patch)
        .where(and(eq(findings.id, params.findingId), eq(findings.sessionId, sessionId)))

      // SSE 通知前端刷新图谱
      emitGraphUpdate(sessionId, {
        type: 'finding_updated',
        finding: {
          id: params.findingId,
          severity: params.severity ?? existing.severity,
          status: params.status ?? existing.status,
          title: params.title ?? existing.title,
        },
      })

      // 同步 ObservationStore 中的 vuln_candidate fact：
      // - 标记为 false_positive 时移除关联 fact（与 delete_finding 行为一致，
      //   误报不再计入"已确认漏洞/线索"统计）
      // - 其他字段更新不改动 fact（DB finding 是报告的唯一真相，fact 仅作
      //   高层态势感知，不需要严格同步 severity/title 等细节）
      if (observationStore && params.status === 'false_positive') {
        try {
          const relatedFacts = observationStore
            .getFactsBySource('add_finding')
            .filter(f => (f.content as Record<string, unknown>)?.findingId === params.findingId)
          for (const f of relatedFacts) {
            observationStore.deleteFact(f.id)
          }
          if (relatedFacts.length > 0) {
            logger.info(
              `[update_finding] Removed ${relatedFacts.length} false_positive ObservationStore entries` +
                (params.reason ? ` (reason: ${params.reason})` : ''),
            )
          }
        } catch {
          // non-blocking: fact graph 操作失败不影响更新结果
        }
      }

      return {
        success: true,
        findingId: params.findingId,
        updatedFields: Object.keys(patch),
        reason: params.reason,
      }
    },
  })
