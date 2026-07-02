import { tool } from 'ai'
import { z } from 'zod'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { eq, and, like } from 'drizzle-orm'
import { getDb, endpoints } from '@src-agent/db'

/**
 * Export the session's endpoints to a JSON file in the workspace. The output
 * shape is import-compatible (same fields as add_endpoints_batch /
 * import_endpoints), so an exported file can be read straight back by
 * import_endpoints — useful for backup, cross-session transfer, or handing the
 * endpoint inventory to another tool. Data is written server-side; only a
 * compact summary returns to the model (no large dump through context).
 */
export const exportEndpointsTool = (sessionId: string) =>
  tool({
    description:
      '导出当前会话的接口为 JSON 文件，写入工作区。格式与 import_endpoints 兼容，可被原样读回（备份/跨会话迁移/交给其它工具）。' +
      '可按 method、路径模式、验证状态筛选导出子集。数据由服务端写文件，只返回计数摘要，不经过模型上下文。',
    inputSchema: z.object({
      path: z
        .string()
        .describe('输出文件相对路径，相对 workspace/{sessionId}/，如 "recon/endpoints-export.json"'),
      method: z
        .enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'UNKNOWN'])
        .optional()
        .describe('仅导出该 HTTP 方法'),
      pathPattern: z
        .string()
        .optional()
        .describe('路径模糊匹配，如 "%user%" 仅导出含 user 的路径'),
      status: z
        .enum(['unverified', 'verified_safe', 'verified_vulnerable'])
        .optional()
        .describe('仅导出该验证状态的接口'),
    }),
    execute: async ({ path: relPath, method, pathPattern, status }) => {
      const baseDir = join(process.cwd(), 'workspace', sessionId)
      const targetPath = join(baseDir, relPath)

      // Prevent directory traversal (same guard as file_system / import tool).
      if (!targetPath.startsWith(baseDir)) {
        return { success: false, error: '路径超出工作目录范围' }
      }

      const db = getDb()
      const conditions = [eq(endpoints.sessionId, sessionId)]
      if (method) conditions.push(eq(endpoints.method, method))
      if (pathPattern) conditions.push(like(endpoints.pathTemplate, pathPattern))
      if (status) conditions.push(eq(endpoints.verificationStatus, status))
      const where = conditions.length === 1 ? conditions[0] : and(...conditions)

      const rows = await db.select().from(endpoints).where(where)

      // Shape each row to the import-compatible schema (omit DB-internal fields
      // like id/sessionId/createdAt so the file round-trips through import).
      const exported = rows.map(r => ({
        url: r.url,
        method: r.method,
        pathTemplate: r.pathTemplate,
        ...(r.description ? { description: r.description } : {}),
        source: r.source,
        ...(r.sampleRequest ? { sampleRequest: r.sampleRequest } : {}),
        ...(r.sampleResponse ? { sampleResponse: r.sampleResponse } : {}),
        ...(r.techStack && r.techStack.length > 0 ? { techStack: r.techStack } : {}),
        ...(r.riskHints && r.riskHints.length > 0 ? { riskHints: r.riskHints } : {}),
      }))

      try {
        mkdirSync(dirname(targetPath), { recursive: true })
        writeFileSync(targetPath, JSON.stringify(exported, null, 2), 'utf-8')
      } catch (err) {
        return { success: false, error: `写入失败: ${err instanceof Error ? err.message : String(err)}` }
      }

      return {
        success: true,
        path: relPath,
        exported: exported.length,
        importCompatible: true,
      }
    },
  })
