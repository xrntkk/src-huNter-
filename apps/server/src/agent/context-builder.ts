import { inArray, eq, and, desc } from 'drizzle-orm'
import { generateText } from 'ai'
import { getDb, endpoints, targetMemory, memories } from '@src-agent/db'
import { extractHost } from './host-utils.js'
import { getFastModel } from './model-router.js'
import { logger } from '../logger/index.js'

export async function buildEndpointContext(
  sessionId: string,
  selectedEndpointIds: string[],
): Promise<string> {
  if (!selectedEndpointIds.length) return ''

  const db = getDb()
  // Scope to the current session — selected IDs from the UI must never
  // resolve to endpoints belonging to a different project/session.
  const selected = await db
    .select()
    .from(endpoints)
    .where(and(eq(endpoints.sessionId, sessionId), inArray(endpoints.id, selectedEndpointIds)))

  if (!selected.length) return ''

  const lines = selected.map(ep => {
    const params = ep.params as Record<string, unknown> | null
    const paramStr = params ? JSON.stringify(params) : 'none'
    const reqBody = (ep.sampleRequest as { body?: string } | null)?.body ?? ''
    const respBody = (ep.sampleResponse as { body?: string; status?: number } | null)
    return `### ${ep.method} ${ep.pathTemplate}
- URL: ${ep.url}
- Source: ${ep.source}
- Tech Stack: ${(ep.techStack as string[]).join(', ') || 'unknown'}
- Risk Hints: ${(ep.riskHints as string[]).join(', ') || 'none'}
- Params: ${paramStr}
${reqBody ? `- Sample Request Body: ${reqBody.slice(0, 200)}` : ''}
${respBody ? `- Sample Response: HTTP ${respBody.status}\n  ${respBody.body?.slice(0, 200) ?? ''}` : ''}`
  })

  return `## 当前选中的接口（重点测试）\n\n${lines.join('\n\n')}`
}

/**
 * Within-session memory lookup. Given the current user message, extract a
 * host and pull (a) the latest summary written by memory-extractor for
 * that host **within this session**, (b) up to 20 historical endpoints from
 * the same session on the same host. Returns formatted markdown for
 * injection into the dynamic prompt context, or '' when no host is
 * parseable / no rows exist.
 *
 * Strictly scoped to `sessionId`: two different projects (sessions) — even
 * targeting the same host — never see each other's data.
 */
export async function buildTargetMemoryContext(sessionId: string, userMsg: string): Promise<string> {
  const host = extractHost(userMsg)
  if (!host) return ''

  const db = getDb()

  const memRow = (
    await db
      .select()
      .from(targetMemory)
      .where(and(eq(targetMemory.sessionId, sessionId), eq(targetMemory.host, host)))
      .limit(1)
  )[0]
  const knownEndpoints = await db
    .select({
      method: endpoints.method,
      pathTemplate: endpoints.pathTemplate,
      description: endpoints.description,
      verificationStatus: endpoints.verificationStatus,
    })
    .from(endpoints)
    .where(and(eq(endpoints.sessionId, sessionId), eq(endpoints.host, host)))
    .orderBy(desc(endpoints.createdAt))
    .limit(20)

  if (!memRow && knownEndpoints.length === 0) return ''

  const parts: string[] = [`## 本会话历史经验（target host: ${host}）`]

  if (memRow) {
    parts.push(`### 上次扫描结论（${new Date(memRow.updatedAt).toISOString().slice(0, 10)}）`)
    parts.push(memRow.summary)
    if (memRow.techStack && (memRow.techStack as string[]).length) {
      parts.push(`已识别技术栈：${(memRow.techStack as string[]).join(', ')}`)
    }
  }

  if (knownEndpoints.length) {
    parts.push(`### 历史已发现接口（最多 20 条，按时间倒序）`)
    parts.push(
      knownEndpoints
        .map(ep => {
          const status =
            ep.verificationStatus === 'verified_vulnerable'
              ? ' [已验证有漏洞]'
              : ep.verificationStatus === 'verified_safe'
                ? ' [已验证安全]'
                : ''
          const desc = ep.description ? ` — ${ep.description}` : ''
          return `- ${ep.method} ${ep.pathTemplate}${status}${desc}`
        })
        .join('\n'),
    )
  }

  parts.push('（避免重复探测已确认的方向；将精力放在历史未覆盖的路径与新出现的接口。）')

  return parts.join('\n\n')
}

/**
 * Select relevant agent-authored memories for the current turn. Uses a fast
 * model side-query to pick at most 5 memories from the session's full set,
 * avoiding injecting everything into the prompt.
 *
 * Returns formatted markdown or '' if no memories or selection fails.
 */
export async function selectRelevantMemories(
  sessionId: string,
  userMsg: string,
): Promise<string> {
  const db = getDb()
  const allMems = await db
    .select()
    .from(memories)
    .where(eq(memories.sessionId, sessionId))
    .orderBy(desc(memories.createdAt))
    .limit(30)

  if (allMems.length === 0) return ''

  if (allMems.length <= 3) {
    return formatMemories(allMems)
  }

  try {
    const titles = allMems.map((m, i) => `${i}: [${m.kind}] ${m.title}`).join('\n')
    const { text } = await generateText({
      model: getFastModel(),
      system: '你是一个记忆相关性筛选器。给定用户当前任务和一组记忆标题，返回最相关的记忆编号（最多5个），用逗号分隔。只输出数字，不要解释。',
      prompt: `当前任务: ${userMsg.slice(0, 300)}\n\n可用记忆:\n${titles}\n\n返回相关记忆编号:`,
      maxRetries: 1,
    })

    const indices = text.match(/\d+/g)?.map(Number).filter(i => i >= 0 && i < allMems.length) ?? []
    if (indices.length === 0) return formatMemories(allMems.slice(0, 5))
    const selected = indices.slice(0, 5).map(i => allMems[i])
    return formatMemories(selected)
  } catch (err) {
    logger.warn('[selectRelevantMemories] Side-query failed, falling back to recency:', err)
    return formatMemories(allMems.slice(0, 5))
  }
}

function formatMemories(mems: Array<{ kind: string; title: string; content: string; createdAt: Date | string }>): string {
  if (mems.length === 0) return ''
  const lines = mems.map(m =>
    `- [${m.kind}] **${m.title}**: ${m.content.slice(0, 150)}`,
  )
  return `## Agent 记忆（相关子集）\n\n${lines.join('\n')}`
}
