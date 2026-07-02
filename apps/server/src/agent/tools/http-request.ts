import { tool } from 'ai'
import { z } from 'zod'
import { nanoid } from 'nanoid'
import { getDb, requestLogs } from '@src-agent/db'
import { untrustedBlock } from '../untrusted.js'

export const httpRequestTool = (sessionId: string) =>
  tool({
    description:
      '构造并发送 HTTP 请求，用于漏洞验证。每次只修改一个参数，对比响应差异。',
    inputSchema: z.object({
      method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD', 'TRACE']),
      url: z.string().describe('完整请求 URL'),
      headers: z.record(z.string()).optional().describe('请求头，如 Authorization、Cookie 等'),
      body: z.string().optional().describe('请求体（JSON 字符串或 form-data）'),
      testPurpose: z.string().describe('本次请求的测试目的，如：测试删除他人订单越权'),
    }),
    execute: async params => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 30000)

      try {
        const res = await fetch(params.url, {
          method: params.method,
          headers: params.headers,
          body: params.body,
          signal: controller.signal,
          // Follow redirects but don't throw on 4xx/5xx
          redirect: 'follow',
        })

        const responseText = await res.text().catch(() => '')
        const truncated = responseText.slice(0, 3000)

        // Log to DB
        const db = getDb()
        await db.insert(requestLogs).values({
          id: nanoid(),
          sessionId,
          method: params.method,
          url: params.url,
          requestHeaders: params.headers ?? null,
          requestBody: params.body ?? null,
          responseStatus: res.status,
          responseBody: truncated,
          testPurpose: params.testPurpose,
          createdAt: new Date(),
        })

        return {
          status: res.status,
          statusText: res.statusText,
          headers: Object.fromEntries(res.headers.entries()),
          // 响应体由目标站点完全控制，是 prompt injection 入口 → nonce 隔离
          body: truncated ? untrustedBlock(truncated) : '',
          bodyLength: responseText.length,
          truncated: responseText.length > 3000,
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { error: message, status: 0, body: '' }
      } finally {
        clearTimeout(timeout)
      }
    },
  })
