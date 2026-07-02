import { logger } from '../logger/index.js'

/**
 * Tool Result Formatters — per-tool result normalization and summarization.
 *
 * Extracts the monolithic summarizeResult() switch from Timeline into an
 * extensible registry. Each formatter receives the raw tool result and returns
 * a concise, LLM-friendly string for timeline context.
 */

export type ToolResultFormatter = (result: unknown) => string

class FormatterRegistry {
  private formatters = new Map<string, ToolResultFormatter>()

  register(toolName: string, formatter: ToolResultFormatter): void {
    this.formatters.set(toolName, formatter)
  }

  format(toolName: string, result: unknown): string {
    const formatter = this.formatters.get(toolName)
    if (formatter) {
      try {
        return formatter(result)
      } catch (err) {
        return `[Formatter error for ${toolName}] ${err instanceof Error ? err.message : String(err)}`
      }
    }
    return defaultFormat(result)
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + `...[truncated, ${text.length - max} chars omitted]`
}

function stripHtml(text: string): string {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function summarizeBody(body: unknown, max = 260): string {
  if (body === null || body === undefined) return ''
  const raw = typeof body === 'string' ? body : JSON.stringify(body)
  const text = raw.includes('<html') || raw.includes('<!DOCTYPE') ? stripHtml(raw) : raw
  return truncate(text, max)
}

function defaultFormat(result: unknown): string {
  if (result === null || result === undefined) return '无返回结果'
  const text = typeof result === 'string' ? result : JSON.stringify(result)
  return truncate(text, 400)
}

const registry = new FormatterRegistry()

registry.register('http_request', (result) => {
  if (typeof result !== 'object' || result === null) return defaultFormat(result)
  const r = result as Record<string, unknown>
  const status = r.status ?? '?'
  const statusText = r.statusText ?? ''
  const headers = r.headers && typeof r.headers === 'object' ? r.headers as Record<string, unknown> : undefined
  const location = r.location ?? r.redirectedTo ?? r.redirectUrl ?? headers?.location
  const body = summarizeBody(r.body, 220)
  const parts = [`[HTTP ${status} ${statusText}]`]
  if (location) parts.push(`Redirect/Location: ${String(location)}`)
  if (body) parts.push(body)
  return parts.join(' ')
})

registry.register('add_endpoint', (result) => {
  if (typeof result !== 'object' || result === null) return defaultFormat(result)
  const r = result as Record<string, unknown>
  if (r.duplicate) return '接口已存在（重复）'
  if (r.success) return '记录成功'
  return defaultFormat(result)
})

registry.register('add_finding', (result) => {
  if (typeof result !== 'object' || result === null) return defaultFormat(result)
  const r = result as Record<string, unknown>
  if (r.duplicate) return '发现已存在（重复）'
  if (r.success) return '记录成功'
  return defaultFormat(result)
})

registry.register('delete_finding', (result) => {
  if (typeof result !== 'object' || result === null) return defaultFormat(result)
  const r = result as Record<string, unknown>
  if (r.success) return `已删除: ${r.deletedTitle ?? r.deletedId}`
  return `删除失败: ${r.error ?? JSON.stringify(r)}`
})

registry.register('update_finding', (result) => {
  if (typeof result !== 'object' || result === null) return defaultFormat(result)
  const r = result as Record<string, unknown>
  if (r.success) {
    const fields = Array.isArray(r.updatedFields) ? (r.updatedFields as string[]).join(',') : ''
    return `已更新 finding ${r.findingId}${fields ? ` (${fields})` : ''}`
  }
  return `更新失败: ${r.error ?? JSON.stringify(r)}`
})

registry.register('query_knowledge', (result) => {
  if (typeof result !== 'object' || result === null) return defaultFormat(result)
  const r = result as Record<string, unknown>
  if (r.found === false) return '知识库未找到相关内容'
  const results = r.results
  if (Array.isArray(results)) {
    const snippets = results.map((x: any) => x.content?.slice(0, 80) ?? '').join(' | ')
    return `知识库找到 ${results.length} 条结果: ${snippets}`
  }
  return defaultFormat(result)
})

registry.register('load_skill', (result) => {
  if (typeof result !== 'object' || result === null) return defaultFormat(result)
  const r = result as Record<string, unknown>
  if (r.loaded === true) return `Skill 已加载: ${r.skillName ?? 'unknown'}`
  return defaultFormat(result)
})

registry.register('create_plan', (result) => {
  if (typeof result !== 'object' || result === null) return defaultFormat(result)
  const r = result as Record<string, unknown>
  return String(r.summary ?? defaultFormat(result))
})

registry.register('add_intent', (result) => {
  if (typeof result !== 'object' || result === null) return defaultFormat(result)
  const r = result as Record<string, unknown>
  return String(r.summary ?? defaultFormat(result))
})

registry.register('conclude_intent', (result) => {
  if (typeof result !== 'object' || result === null) return defaultFormat(result)
  const r = result as Record<string, unknown>
  return String(r.summary ?? defaultFormat(result))
})

registry.register('spawn_agent', (result) => {
  if (typeof result !== 'object' || result === null) return defaultFormat(result)
  const r = result as Record<string, unknown>
  return `[子 Agent 完成] ${String(r.summary ?? '')}`
})

registry.register('python_exec', (result) => {
  if (typeof result !== 'object' || result === null) return defaultFormat(result)
  const r = result as Record<string, unknown>
  const stdout = typeof r.stdout === 'string' ? r.stdout : ''
  const stderr = typeof r.stderr === 'string' ? r.stderr : ''
  const exitCode = r.exitCode ?? r.code ?? 0
  const parts = []
  if (stdout) parts.push(`stdout: ${truncate(stdout, 300)}`)
  if (stderr) parts.push(`stderr: ${truncate(stderr, 200)}`)
  return parts.length === 0 ? `[Python exit ${exitCode}] 无输出` : `[Python exit ${exitCode}] ${parts.join(' | ')}`
})

registry.register('file_system', (result) => {
  if (typeof result !== 'object' || result === null) return defaultFormat(result)
  const r = result as Record<string, unknown>
  const action = r.action ?? 'unknown'
  const path = r.path ?? ''
  if (action === 'read' && typeof r.content === 'string') return `[File read: ${path}] ${truncate(r.content, 200)}`
  if (action === 'list' && Array.isArray(r.entries)) return `[File list: ${path}] ${r.entries.length} entries`
  if (action === 'write') return `[File write: ${path}] 成功`
  return defaultFormat(result)
})

registry.register('browser_navigate', (result) => {
  if (typeof result !== 'object' || result === null) return defaultFormat(result)
  const r = result as Record<string, unknown>
  return `[Browser navigate] ${r.url ?? ''} → ${r.title ?? '无标题'}`
})

registry.register('browser_get_text', (result) => {
  if (typeof result !== 'object' || result === null) return defaultFormat(result)
  const r = result as Record<string, unknown>
  const candidate = r.text ?? r.content ?? r.body ?? r.result ?? r.value ?? r.markdown ?? r.html
  const text = typeof candidate === 'string'
    ? candidate
    : candidate === undefined
      ? JSON.stringify(r)
      : JSON.stringify(candidate)
  return `[Browser text] ${truncate(text ?? '', 300)}`
})

registry.register('browser_click', (result) => {
  if (typeof result !== 'object' || result === null) return defaultFormat(result)
  const r = result as Record<string, unknown>
  return `[Browser click] ${r.selector ?? ''} → ${r.url ?? 'same page'}`
})

registry.register('browser_screenshot', (result) => {
  if (typeof result !== 'object' || result === null) return defaultFormat(result)
  const r = result as Record<string, unknown>
  return `[Browser screenshot] ${r.path ?? ''}`
})

registry.register('browser_fill', (result) => {
  if (typeof result !== 'object' || result === null) return defaultFormat(result)
  const r = result as Record<string, unknown>
  return `[Browser fill] ${r.selector ?? ''}`
})

registry.register('browser_evaluate', (result) => {
  if (typeof result !== 'object' || result === null) return defaultFormat(result)
  const r = result as Record<string, unknown>
  const res = typeof r.result === 'string' ? r.result : JSON.stringify(r.result)
  return `[Browser eval] ${truncate(res ?? '', 300)}`
})

registry.register('browser_close', () => '[Browser] 已关闭')

export function formatToolResult(toolName: string, result: unknown): string {
  const formatted = registry.format(toolName, result)
  logger.info(`[ToolFormatter] ${toolName}: input=${JSON.stringify(result).slice(0, 200)} -> output=${formatted.slice(0, 300)}`)
  return formatted
}

export function registerToolFormatter(toolName: string, formatter: ToolResultFormatter): void {
  registry.register(toolName, formatter)
}
