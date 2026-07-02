/**
 * Dynamic tool catalog renderer.
 *
 * Generates a compact tool list for the system prompt by introspecting the
 * runtime tool map (Vercel AI SDK `Tool` objects expose `description`).
 * Replaces the previously hardcoded TOOLS section in prompts/system.ts so
 * adding/removing a tool no longer requires editing a static string.
 */

import type { Tool } from 'ai'

/** Heuristic grouping by tool name prefix / well-known names. */
function groupOf(name: string): string {
  if (name.startsWith('browser_')) return '浏览器'
  if (name.startsWith('add_endpoint') || name === 'import_endpoints' || name === 'export_endpoints' || name === 'list_endpoints' || name === 'update_endpoint_status') return '接口图谱'
  if (name === 'add_finding' || name === 'delete_finding' || name === 'update_finding') return '漏洞记录'
  if (name === 'http_request') return '网络探测'
  if (name === 'gather_intel' || name === 'web_search') return '信息收集'
  if (name === 'python_exec' || name === 'bash' || name === 'file_system') return '脚本/Shell/文件'
  if (name === 'load_skill' || name === 'query_knowledge' || name === 'memory') return '知识/记忆/技能'
  if (name === 'spawn_agent' || name === 'query_subagent' || name === 'abort_subagent' || name === 'continue_subagent' || name === 'send_message') return '子 Agent'
  if (name === 'create_plan' || name === 'add_intent' || name === 'conclude_intent') return '计划'
  if (name === 'ask_user') return '交互'
  if (name.includes('__')) return 'MCP'
  return '其它'
}

/** First sentence (truncated) — keeps the catalog compact. */
function firstSentence(s: string, max = 80): string {
  const trimmed = s.trim().replace(/\s+/g, ' ')
  const cut = trimmed.split(/[。.；;]/)[0]
  return cut.length > max ? cut.slice(0, max) + '…' : cut
}

export function buildToolCatalog(toolMap: Record<string, Tool>): string {
  const entries = Object.entries(toolMap)
  if (entries.length === 0) return ''

  const groups = new Map<string, Array<{ name: string; desc: string }>>()
  for (const [name, t] of entries) {
    const desc = (t as { description?: string }).description ?? ''
    const g = groupOf(name)
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g)!.push({ name, desc: firstSentence(desc) })
  }

  // Stable group order — matches the old hardcoded ordering for cache locality.
  const order = ['信息收集', '网络探测', '浏览器', '接口图谱', '漏洞记录', '知识/记忆/技能', '脚本/Shell/文件', '子 Agent', '计划', '交互', 'MCP', '其它']
  const lines: string[] = ['## 工具', '']
  for (const g of order) {
    const items = groups.get(g)
    if (!items || items.length === 0) continue
    items.sort((a, b) => a.name.localeCompare(b.name))
    const inline = items.map(i => i.desc ? `\`${i.name}\`(${i.desc})` : `\`${i.name}\``).join('，')
    lines.push(`**${g}**: ${inline}`)
  }
  lines.push('')
  lines.push('每个工具的完整入参/输出由运行时通过 tool schema 注入到模型；本目录仅作为可选清单参考。')
  return lines.join('\n')
}
