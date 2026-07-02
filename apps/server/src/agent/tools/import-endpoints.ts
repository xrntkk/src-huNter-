import { tool } from 'ai'
import { z } from 'zod'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { endpointItemSchema, insertEndpoints, type EndpointItem } from './add-endpoints-batch.js'
import type { ObservationStore } from '../observation-store.js'

/**
 * Bulk-import endpoints from a JSON file in the session workspace. The model
 * passes only a file path — the server reads + parses + inserts directly, so
 * arbitrarily large endpoint lists never round-trip through the model context
 * (no stdout truncation, no fan-out to sub-agents, no token cost per row).
 *
 * Expected file shape: a JSON array of endpoint objects, or an object with an
 * `endpoints` array. Each item matches the add_endpoints_batch schema; invalid
 * items are skipped and counted rather than failing the whole import.
 */
export const importEndpointsTool = (
  sessionId: string,
  threadId: string,
  observationStore?: ObservationStore,
) =>
  tool({
    description:
      '从工作区 JSON 文件批量导入接口入库。当你已把大量接口（几十到上千个）写到 workspace 下的 JSON 文件时，' +
      '用本工具直接入库——只传文件路径，服务端读取解析，数据不经过模型上下文，无截断、无 token 消耗、无需分片。' +
      '文件格式：接口对象数组，或 {"endpoints": [...]}。每个对象字段同 add_endpoints_batch（url/method/pathTemplate/source 必填）。' +
      '同 method+pathTemplate 自动去重；格式非法的条目自动跳过并计数。这是大批量入库的首选工具。',
    inputSchema: z.object({
      path: z
        .string()
        .describe('相对 workspace/{sessionId}/ 的 JSON 文件路径，如 "recon/endpoints.json"'),
    }),
    execute: async ({ path: filePath }) => {
      const baseDir = join(process.cwd(), 'workspace', sessionId)
      const targetPath = join(baseDir, filePath)

      // Prevent directory traversal (same guard as file_system tool).
      if (!targetPath.startsWith(baseDir)) {
        return { success: false, error: '路径超出工作目录范围' }
      }
      if (!existsSync(targetPath)) {
        return { success: false, error: `文件不存在: ${filePath}` }
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(readFileSync(targetPath, 'utf-8'))
      } catch (err) {
        return { success: false, error: `JSON 解析失败: ${err instanceof Error ? err.message : String(err)}` }
      }

      // Accept either a bare array or { endpoints: [...] }.
      const rawItems = Array.isArray(parsed)
        ? parsed
        : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { endpoints?: unknown }).endpoints))
          ? (parsed as { endpoints: unknown[] }).endpoints
          : null
      if (!rawItems) {
        return { success: false, error: '文件格式无效：需为接口数组或 {"endpoints": [...]}' }
      }

      // Validate each item; skip + count invalid ones rather than failing all.
      const valid: EndpointItem[] = []
      let invalid = 0
      for (const raw of rawItems) {
        const r = endpointItemSchema.safeParse(raw)
        if (r.success) valid.push(r.data)
        else invalid++
      }

      if (valid.length === 0) {
        return { success: false, error: `无有效接口（共 ${rawItems.length} 条，全部格式非法）`, invalid }
      }

      const result = await insertEndpoints(sessionId, threadId, valid, observationStore)
      return { success: true, fileTotal: rawItems.length, invalid, ...result }
    },
  })
