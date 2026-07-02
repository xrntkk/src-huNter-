/**
 * Cross-session "lessons learned" extractor.
 *
 * Called from the agent finish hook (src-agent.ts onStep:finish) when a
 * session has produced ≥1 successful add_endpoint call. Uses the FAST
 * model (configured via models.json `fastModelId`) to summarize what was
 * learned about a target host into ≤200 字 of natural language, then
 * UPSERTs into `target_memory` keyed on host.
 *
 * Read back at session start by buildTargetMemoryContext to inject "what
 * we already know about this host" into the dynamic prompt context.
 *
 * Failure modes:
 * - No host extractable from any add_endpoint URL → skip silently
 * - Same host updated <30 min ago → skip (debounce against multi-finish loops)
 * - Fast model errors → log + skip (fire-and-forget; never block release())
 */

import { generateText } from 'ai'
import { eq, and } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { getDb, endpoints, findings, targetMemory } from '@src-agent/db'
import type { MessageStore } from './message-store.js'
import { extractHost } from './host-utils.js'
import { getFastModel } from './model-router.js'
import { logger } from '../logger/index.js'

const MIN_REEXTRACT_INTERVAL_MS = 30 * 60 * 1000 // 30 min

export async function extractTargetMemory(opts: {
  sessionId: string
  threadId: string
  store: MessageStore
}): Promise<void> {
  const { sessionId, threadId, store } = opts

  // 1. Walk tool activity for add_endpoint calls; extract first plausible host.
  const { lines } = store.getToolActivitySince(0)
  let host: string | null = null
  let endpointCallCount = 0
  let findingCallCount = 0

  for (const line of lines) {
    if (line.startsWith('调用 add_endpoint:')) {
      endpointCallCount++
      if (!host) {
        const m = line.match(/"url"\s*:\s*"([^"]+)"/)
        host = extractHost(m?.[1]) ?? host
      }
    } else if (line.startsWith('调用 add_finding:')) {
      findingCallCount++
    }
  }

  if (!host) {
    logger.info(`[MemoryExtractor] No host extractable from session ${sessionId}, skipping`)
    return
  }

  // 2. Debounce: skip if we updated this (session, host) memory recently.
  const db = getDb()
  const existing = await db
    .select()
    .from(targetMemory)
    .where(and(eq(targetMemory.sessionId, sessionId), eq(targetMemory.host, host)))
    .limit(1)
  const existingRow = existing[0]
  if (existingRow) {
    const age = Date.now() - new Date(existingRow.updatedAt).getTime()
    if (age < MIN_REEXTRACT_INTERVAL_MS) {
      logger.info(`[MemoryExtractor] session=${sessionId} host=${host} updated ${Math.round(age / 1000)}s ago (<30min), skipping`)
      return
    }
  }

  // 3. Build summarization prompt from the tail of the transcript + DB counts.
  const dump = store.toProseTranscript()
  const tail = dump.slice(-6000)

  // Counts are scoped to THIS session — projects are fully isolated, even
  // when two sessions target the same host.
  const allEndpointsForHost = await db
    .select({ id: endpoints.id, techStack: endpoints.techStack })
    .from(endpoints)
    .where(and(eq(endpoints.sessionId, sessionId), eq(endpoints.host, host)))
  const totalEndpoints = allEndpointsForHost.length
  const allFindingsForSession = await db.select({ id: findings.id }).from(findings).where(eq(findings.sessionId, sessionId))
  const totalFindings = allFindingsForSession.length

  // Aggregate tech stack across all endpoints we know for this host.
  const stackSet = new Set<string>()
  for (const ep of allEndpointsForHost) {
    for (const t of (ep.techStack as string[] | null) ?? []) stackSet.add(t)
  }
  const techStack = Array.from(stackSet).slice(0, 10)

  const prompt =
    `请用 200 字以内中文，总结对目标 ${host} 已经掌握的信息，供下一次扫描快速跳过已穷尽的方向。\n\n` +
    `本次/历史累计：发现 ${totalEndpoints} 个接口、${totalFindings} 个漏洞结论。识别到的技术栈：${techStack.join(', ') || '未知'}。\n\n` +
    `近期探索片段：\n${tail}\n\n` +
    `要点：1) 接口/路径模式 2) 技术栈与认证机制 3) 已验证的安全/漏洞结论 4) 下次应避免重复的方向。只输出纯总结文字，不要解释、不要 JSON、不要 Markdown 标题。`

  let summary = ''
  try {
    const { text } = await generateText({
      system: '你是 SRC 漏洞挖掘 agent 的"长期记忆"摘要器，只输出纯中文总结。',
      model: getFastModel(),
      prompt,
      maxRetries: 1,
    })
    summary = text.trim()
  } catch (err) {
    logger.warn(`[MemoryExtractor] fast-model summary failed for host=${host}:`, err)
    return
  }

  if (!summary) return

  // 4. UPSERT — drizzle/SQLite has no .onConflict in this version's path,
  // so do a manual update-or-insert.
  const now = new Date()
  if (existingRow) {
    await db
      .update(targetMemory)
      .set({
        sessionId,
        threadId,
        summary,
        techStack,
        endpointCount: totalEndpoints,
        findingCount: totalFindings,
        updatedAt: now,
      })
      .where(eq(targetMemory.id, existingRow.id))
    logger.info(`[MemoryExtractor] Updated memory for host=${host} (endpoints=${totalEndpoints}, findings=${totalFindings})`)
  } else {
    await db.insert(targetMemory).values({
      id: nanoid(),
      host,
      sessionId,
      threadId,
      summary,
      techStack,
      endpointCount: totalEndpoints,
      findingCount: totalFindings,
      updatedAt: now,
    })
    logger.info(`[MemoryExtractor] Created memory for host=${host} (endpoints=${totalEndpoints}, findings=${totalFindings})`)
  }
  // Touch endpointCallCount / findingCallCount to keep the per-session signal — currently logged for debug.
  logger.info(`[MemoryExtractor] session ${sessionId}: ${endpointCallCount} add_endpoint calls, ${findingCallCount} add_finding calls`)
}
