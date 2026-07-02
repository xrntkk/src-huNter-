import { tool } from 'ai'
import { z } from 'zod'
import { nanoid } from 'nanoid'
import { getDb, findings } from '@src-agent/db'
import { emitGraphUpdate } from './add-endpoint.js'
import type { ObservationStore } from '../observation-store.js'

export const addFindingTool = (sessionId: string, threadId: string, observationStore?: ObservationStore) =>
  tool({
    description:
      '将已验证的漏洞记录到接口图谱。只在有充分证据时调用，不要记录误报。',
    inputSchema: z.object({
      endpointId: z.string().optional().describe('关联的接口 ID（可选）'),
      type: z.enum([
        'idor', 'sqli', 'xss', 'ssrf', 'ssti', 'rce',
        'logic', 'auth_bypass', 'info_disclosure', 'other',
      ]),
      severity: z.enum(['info', 'low', 'medium', 'high', 'critical']),
      title: z.string().max(100).describe('漏洞标题，如：GET /api/orders/{id} 存在越权访问'),
      description: z.string().describe('漏洞描述和影响分析'),
      reproSteps: z.array(z.string()).describe('完整的复现步骤列表'),
      evidence: z.object({
        request: z.string().describe('触发漏洞的 HTTP 请求'),
        response: z.string().describe('服务器响应（截断到1000字符内）'),
      }),
    }),
    execute: async params => {
      const db = getDb()
      const id = nanoid()
      await db.insert(findings).values({
        id,
        sessionId,
        endpointId: params.endpointId ?? null,
        type: params.type,
        severity: params.severity,
        title: params.title,
        description: params.description,
        reproSteps: params.reproSteps,
        evidence: params.evidence,
        status: 'unconfirmed',
        createdAt: new Date(),
      })

      emitGraphUpdate(sessionId, {
        type: 'finding_added',
        finding: { id, type: params.type, severity: params.severity, title: params.title },
      })

      if (observationStore) {
        observationStore.addFact({
          sessionId,
          threadId,
          type: 'vuln_candidate',
          content: {
            findingId: id,
            endpointId: params.endpointId,
            type: params.type,
            severity: params.severity,
            title: params.title,
            description: params.description,
          },
          source: 'add_finding',
          confidence: 70,
        })
      }

      return { success: true, findingId: id }
    },
  })
