import { tool } from 'ai'
import { z } from 'zod'
import { nanoid } from 'nanoid'
import { getDb, requestLogs } from '@src-agent/db'
import { untrustedBlock } from '../untrusted.js'

/**
 * web_search — 联网搜索工具（Bing HTML 回退）。
 *
 * 搜索能力主要由 Firecrawl MCP 提供（搜索 + 抓取 + 爬取 + 地图 + 提取）。
 * 本工具作为无 key 时的免费回退，直接解析 Bing HTML。
 *
 * 返回结构化的 {title, url, snippet} 列表。需要读取页面正文时由 agent 自行
 * 调用 http_request 抓取（保持工具职责单一）。
 */

interface SearchHit {
  title: string
  url: string
  snippet: string
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

/**
 * Bing HTML 端点解析。无需 API key，结构稳定，国内国际双可达。
 * Bing 已于 2025-08 下线官方 Search API，但 www.bing.com/search 的 HTML
 * 仍然公开，<li class="b_algo"> 块包含 title/url/snippet。
 */
async function searchBing(query: string, topK: number, signal: AbortSignal): Promise<SearchHit[]> {
  const url = new URL('https://www.bing.com/search')
  url.searchParams.set('q', query)
  url.searchParams.set('count', String(topK))
  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'en-US,en;q=0.9',
      Accept: 'text/html',
    },
    signal,
  })
  if (!res.ok) throw new Error(`Bing ${res.status}`)
  const html = await res.text()

  const hits: SearchHit[] = []
  // 每条结果在 <li class="b_algo">…</li>；标题在 <h2><a href="…">title</a></h2>；
  // 摘要在 <p class="b_lineclamp…">…</p> 或首个 <p>。
  const blockRe = /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/g
  let blockMatch: RegExpExecArray | null
  while ((blockMatch = blockRe.exec(html)) !== null && hits.length < topK) {
    const block = blockMatch[1] ?? ''
    const titleMatch = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block)
    if (!titleMatch) continue
    const rawUrl = titleMatch[1] ?? ''
    const title = stripTags(titleMatch[2] ?? '').trim()
    const snippetMatch =
      /<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(block) ??
      /<p[^>]*>([\s\S]*?)<\/p>/.exec(block)
    const snippet = stripTags(snippetMatch?.[1] ?? '').trim()
    // Bing 偶尔把外链包成 bing.com/ck/a?...&u=a1<base64url> — 解开取真实地址
    const u = unwrapBingRedirect(rawUrl)
    if (u && title) hits.push({ title, url: u, snippet })
  }
  return hits
}

/** Bing 把外链包成 https://www.bing.com/ck/a?...&u=a1<base64url> — 解开取真实地址。 */
function unwrapBingRedirect(href: string): string {
  try {
    const u = new URL(href, 'https://www.bing.com')
    if (u.pathname !== '/ck/a') return href
    const encoded = u.searchParams.get('u')
    if (!encoded) return href
    // 形如 a1aHR0cHM6... — 去掉前缀 "a1"，剩余是 base64url
    const b64 = encoded.startsWith('a1') ? encoded.slice(2) : encoded
    const decoded = Buffer.from(b64, 'base64url').toString('utf-8')
    return decoded.startsWith('http') ? decoded : href
  } catch {
    return href
  }
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

export const webSearchTool = (sessionId: string) =>
  tool({
    description:
      '联网搜索资料（Bing 回退）。适合查询最新漏洞披露、CVE 详情、技术文档、API 参考、未在本地知识库的内容。' +
      '返回 {title, url, snippet} 列表，需要正文时再用 http_request 抓取。' +
      '提示：配置 Firecrawl MCP 可获得更强大的搜索 + 抓取 + 爬取能力。',
    inputSchema: z.object({
      query: z.string().min(1).describe('搜索关键词，例如 "CVE-2024-12345 PoC" 或 "Spring Boot Actuator 未授权访问"'),
      topK: z.number().int().min(1).max(10).default(5).describe('返回结果数（1-10，默认 5）'),
    }),
    execute: async ({ query, topK }) => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 20000)
      const startedAt = Date.now()
      try {
        let hits = await searchBing(query, topK, controller.signal)

        // 截断 snippet 防止单条过长占用 timeline 上下文
        hits = hits.slice(0, topK).map(h => ({
          ...h,
          snippet: h.snippet.length > 400 ? `${h.snippet.slice(0, 400)}…` : h.snippet,
        }))

        try {
          const db = getDb()
          await db.insert(requestLogs).values({
            id: nanoid(),
            sessionId,
            method: 'GET',
            url: `web_search:bing?q=${encodeURIComponent(query)}`,
            requestHeaders: null,
            requestBody: null,
            responseStatus: 200,
            responseBody: JSON.stringify(hits).slice(0, 3000),
            testPurpose: `web_search (bing): ${query}`,
            createdAt: new Date(),
          })
        } catch {
          /* 日志失败不影响主流程 */
        }

        return {
          backend: 'bing',
          query,
          count: hits.length,
          durationMs: Date.now() - startedAt,
          // snippet 来自外部网页，是攻击者可控内容 → nonce 隔离（title/url 保持原样供模型引用）
          results: hits.map(h => ({ ...h, snippet: h.snippet ? untrustedBlock(h.snippet) : '' })),
          ...(hits.length === 0
            ? { hint: '未找到结果，可换关键词或在设置中启用 Firecrawl MCP 获得更强搜索能力' }
            : {}),
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          backend: 'bing',
          query,
          error: message,
          hint: 'Bing 偶尔会重定向到验证页，可重试或在设置中启用 Firecrawl MCP 获得更稳定的搜索',
        }
      } finally {
        clearTimeout(timeout)
      }
    },
  })
