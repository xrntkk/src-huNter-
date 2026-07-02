import { tool } from 'ai'
import { z } from 'zod'
import { eq, and, like, or, desc } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { getDb, memories, memoryEdges } from '@src-agent/db'
import { emitGraphUpdate } from './add-endpoint.js'

/**
 * Agent long-term memory tool. Lets the model deliberately record, revise,
 * search, and link free-form notes that persist across the session and feed
 * the memory-graph panel. Distinct from auto-extracted target_memory and
 * structured facts — this is the agent's own scratchpad of durable insights.
 *
 * Custom (not Anthropic's memory_20250818) because that tool is Claude-only
 * and this project runs multiple providers.
 */
export const memoryTool = (sessionId: string) =>
  tool({
    description:
      '长期记忆。用于跨步骤记录值得复用的洞察、教训、假设或待办，并在记忆之间建立关联，形成记忆图谱。' +
      'action=create 新建记忆；update 修改已有记忆；view 查看全部或单条；search 按关键词检索；link 在两条记忆间建立有向关系。',
    inputSchema: z.object({
      action: z.enum(['create', 'update', 'view', 'search', 'link']),
      // create / update
      id: z.string().optional().describe('update/view 单条时的记忆 id'),
      kind: z
        .enum(['note', 'lesson', 'hypothesis', 'todo'])
        .optional()
        .describe('记忆类别，默认 note'),
      title: z.string().optional().describe('create 必填：简短标题'),
      content: z.string().optional().describe('create 必填：记忆正文'),
      // search
      query: z.string().optional().describe('search 必填：关键词，匹配标题或正文'),
      // link
      from: z.string().optional().describe('link 必填：源记忆 id'),
      to: z.string().optional().describe('link 必填：目标记忆 id'),
      relation: z
        .string()
        .optional()
        .describe('link 关系标签，如 relates_to/caused_by/supersedes，默认 relates_to'),
    }),
    execute: async (params) => {
      const db = getDb()

      switch (params.action) {
        case 'create': {
          if (!params.title || !params.content) {
            return { success: false, error: 'create 需要 title 和 content' }
          }
          const id = nanoid()
          await db.insert(memories).values({
            id,
            sessionId,
            kind: params.kind ?? 'note',
            title: params.title,
            content: params.content,
            createdAt: new Date(),
          })
          emitGraphUpdate(sessionId, { type: 'memory_added', memory: { id, title: params.title } })
          return { success: true, id }
        }

        case 'update': {
          if (!params.id) return { success: false, error: 'update 需要 id' }
          const patch: Record<string, unknown> = {}
          if (params.title !== undefined) patch.title = params.title
          if (params.content !== undefined) patch.content = params.content
          if (params.kind !== undefined) patch.kind = params.kind
          if (Object.keys(patch).length === 0) {
            return { success: false, error: 'update 未提供任何要修改的字段' }
          }
          const res = await db
            .update(memories)
            .set(patch)
            .where(and(eq(memories.id, params.id), eq(memories.sessionId, sessionId)))
            .returning({ id: memories.id })
          if (res.length === 0) return { success: false, error: `未找到记忆 ${params.id}` }
          emitGraphUpdate(sessionId, { type: 'memory_added', memory: { id: params.id } })
          return { success: true, id: params.id }
        }

        case 'view': {
          if (params.id) {
            const rows = await db
              .select()
              .from(memories)
              .where(and(eq(memories.id, params.id), eq(memories.sessionId, sessionId)))
              .limit(1)
            if (rows.length === 0) return { success: false, error: `未找到记忆 ${params.id}` }
            return { success: true, memory: rows[0] }
          }
          const rows = await db
            .select()
            .from(memories)
            .where(eq(memories.sessionId, sessionId))
            .orderBy(desc(memories.createdAt))
            .limit(100)
          return { success: true, memories: rows, count: rows.length }
        }

        case 'search': {
          if (!params.query) return { success: false, error: 'search 需要 query' }
          const q = `%${params.query}%`
          const rows = await db
            .select()
            .from(memories)
            .where(
              and(
                eq(memories.sessionId, sessionId),
                or(like(memories.title, q), like(memories.content, q)),
              ),
            )
            .orderBy(desc(memories.createdAt))
            .limit(50)
          return { success: true, memories: rows, count: rows.length }
        }

        case 'link': {
          if (!params.from || !params.to) {
            return { success: false, error: 'link 需要 from 和 to' }
          }
          // Validate both endpoints belong to this session before linking.
          const found = await db
            .select({ id: memories.id })
            .from(memories)
            .where(
              and(
                eq(memories.sessionId, sessionId),
                or(eq(memories.id, params.from), eq(memories.id, params.to)),
              ),
            )
          if (found.length < 2) {
            return { success: false, error: 'from/to 必须都是本会话内已存在的记忆 id' }
          }
          const relation = params.relation ?? 'relates_to'
          try {
            await db
              .insert(memoryEdges)
              .values({ from: params.from, to: params.to, relation, createdAt: new Date() })
          } catch {
            // Composite PK collision → edge already exists; treat as idempotent.
          }
          emitGraphUpdate(sessionId, {
            type: 'memory_added',
            edge: { from: params.from, to: params.to, relation },
          })
          return { success: true, from: params.from, to: params.to, relation }
        }
      }
    },
  })
