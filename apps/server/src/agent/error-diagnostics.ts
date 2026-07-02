/**
 * Structured error diagnostics for the AI SDK agent loop.
 *
 * Classifies errors from the Vercel AI SDK into actionable categories with
 * rich context, replacing ad-hoc console.warn / bare message logging.
 */

import { APICallError, RetryError, LoadAPIKeyError, InvalidPromptError, NoContentGeneratedError } from 'ai'
import { logger } from '../logger/index.js'

export type ErrorCategory =
  | 'api_call'         // HTTP-level failures (4xx/5xx, network, DNS)
  | 'auth'             // API key missing / invalid / expired
  | 'rate_limit'       // 429 / quota exhausted
  | 'context_overflow' // prompt too long / context_length_exceeded
  | 'model_not_found'  // model ID doesn't exist at provider
  | 'invalid_request'  // malformed prompt or params
  | 'no_content'       // model produced empty response
  | 'retry_exhausted'  // all retries failed
  | 'network'          // connection refused / DNS / timeout
  | 'abort'            // user or system cancelled
  | 'unknown'          // unclassified

export interface DiagnosedError {
  category: ErrorCategory
  message: string
  /** HTTP status code if available */
  statusCode?: number
  /** Whether the SDK considers this retryable */
  retryable: boolean
  /** Provider API URL that failed */
  url?: string
  /** Truncated response body from provider */
  responseBody?: string
  /** Root cause error (unwrapped from RetryError etc.) */
  cause?: string
  /** Number of retry attempts before failure */
  retryAttempts?: number
  /** Model ID involved (if determinable) */
  modelId?: string
  /** Suggestion for resolution */
  hint?: string
}

const PTL_RE = /prompt is too long|context.?length|maximum context|context_length_exceeded|too many tokens|token limit/i
const RATE_LIMIT_RE = /rate.?limit|too many requests|quota|exceeded.*limit/i
const AUTH_RE = /invalid.*key|unauthorized|authentication|invalid.*api.?key|permission denied|forbidden/i
const MODEL_RE = /model.*not.*found|does not exist|no such model|unknown model|model.*unavailable/i
const NETWORK_RE = /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|socket hang up|network|DNS/i

function classifyStatusCode(code: number | undefined): ErrorCategory | null {
  if (!code) return null
  if (code === 401 || code === 403) return 'auth'
  if (code === 429) return 'rate_limit'
  if (code === 404) return 'model_not_found'
  if (code === 400) return 'invalid_request'
  if (code >= 500) return 'api_call'
  return null
}

function classifyMessage(msg: string): ErrorCategory | null {
  if (PTL_RE.test(msg)) return 'context_overflow'
  if (RATE_LIMIT_RE.test(msg)) return 'rate_limit'
  if (AUTH_RE.test(msg)) return 'auth'
  if (MODEL_RE.test(msg)) return 'model_not_found'
  if (NETWORK_RE.test(msg)) return 'network'
  return null
}

function buildHint(category: ErrorCategory, statusCode?: number): string {
  switch (category) {
    case 'auth':
      return '检查 config/models.json 中的 apiKey 配置，或确认环境变量是否设置正确'
    case 'rate_limit':
      return '已触发提供商速率限制，等待片刻后重试或切换到其他模型'
    case 'context_overflow':
      return '上下文超过模型最大长度，系统将自动裁剪并重试'
    case 'model_not_found':
      return '模型 ID 不存在于提供商，检查 models.json 中的 modelId 拼写'
    case 'invalid_request':
      if (statusCode === 400) return '请求参数被提供商拒绝，可能是 prompt 格式或参数配置问题'
      return '请求格式有误，检查 prompt 或 tool 配置'
    case 'network':
      return '无法连接到模型提供商，检查 baseURL 和网络连通性'
    case 'no_content':
      return '模型未生成任何内容，可能是 prompt 过于约束或模型拒绝回答'
    case 'retry_exhausted':
      return '多次重试均失败，查看 lastError 了解根因'
    case 'api_call':
      return '提供商 API 返回服务端错误，稍后重试或检查提供商状态页'
    case 'abort':
      return '请求被取消'
    default:
      return ''
  }
}

/**
 * Diagnose an error from the AI SDK into a structured format.
 * Handles APICallError, RetryError, LoadAPIKeyError, InvalidPromptError,
 * NoContentGeneratedError, and generic Error instances.
 */
export function diagnoseError(error: unknown): DiagnosedError {
  // AbortError
  if (error instanceof Error && error.name === 'AbortError') {
    return { category: 'abort', message: 'Request aborted', retryable: false, hint: buildHint('abort') }
  }

  // AI SDK: RetryError — wraps the final error after all retries exhausted
  if (RetryError.isInstance(error)) {
    const lastErr = error.lastError
    const inner = lastErr ? diagnoseError(lastErr) : null
    return {
      category: inner?.category ?? 'retry_exhausted',
      message: error.message,
      statusCode: inner?.statusCode,
      retryable: false,
      url: inner?.url,
      responseBody: inner?.responseBody,
      cause: inner?.message,
      retryAttempts: error.errors?.length ?? 0,
      hint: inner?.hint ?? buildHint('retry_exhausted'),
    }
  }

  // AI SDK: APICallError — the most common operational error
  if (APICallError.isInstance(error)) {
    const msg = error.message
    const code = error.statusCode

    // Refine category beyond raw status code
    let category = classifyStatusCode(code) ?? classifyMessage(msg) ?? 'api_call'
    // 400 that's actually a context overflow
    if (code === 400 && PTL_RE.test(msg)) category = 'context_overflow'

    return {
      category,
      message: msg,
      statusCode: code,
      retryable: error.isRetryable ?? false,
      url: error.url,
      responseBody: error.responseBody ? String(error.responseBody).slice(0, 500) : undefined,
      cause: error.cause instanceof Error ? error.cause.message : undefined,
      hint: buildHint(category, code),
    }
  }

  // AI SDK: LoadAPIKeyError
  if (LoadAPIKeyError.isInstance(error)) {
    return {
      category: 'auth',
      message: error.message,
      retryable: false,
      hint: buildHint('auth'),
    }
  }

  // AI SDK: InvalidPromptError
  if (InvalidPromptError.isInstance(error)) {
    // Capture the underlying validation cause (Zod error or similar) for
    // pinpointing exactly which message/part is malformed. The top-level
    // message is always the generic "does not match schema" string.
    let causeDetail = ''
    try {
      const raw = error.cause
      if (raw) {
        causeDetail = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2)
      }
    } catch { /* best-effort */ }
    return {
      category: 'invalid_request',
      message: error.message,
      retryable: false,
      cause: causeDetail.slice(0, 2000) || undefined,
      hint: 'prompt 结构不符合 AI SDK 的 ModelMessage[] schema（常见于非法 part：空 text、空 content 数组、缺 toolCallId 的 tool-call/result）。' +
        `底层原因: ${causeDetail ? causeDetail.slice(0, 300) : '无详细信息'} — ` +
        '查看 workspace/{sessionId}/tool-results/invalid-prompt-iter*.json 定位具体是哪条消息、哪个 part 出错。',
    }
  }

  // AI SDK: NoContentGeneratedError
  if (NoContentGeneratedError.isInstance(error)) {
    return {
      category: 'no_content',
      message: error.message || 'Model produced no content',
      retryable: true,
      hint: buildHint('no_content'),
    }
  }

  // Generic Error fallback — try to classify by message content
  if (error instanceof Error) {
    const category = classifyMessage(error.message) ?? 'unknown'
    return {
      category,
      message: error.message,
      retryable: false,
      cause: error.cause instanceof Error ? error.cause.message : undefined,
      hint: buildHint(category),
    }
  }

  // Non-Error throw
  return {
    category: 'unknown',
    message: String(error),
    retryable: false,
  }
}

/**
 * Format a diagnosed error for structured console output.
 * Produces a multi-line string suitable for server logs.
 */
export function formatDiagnosedError(diag: DiagnosedError, context?: { iteration?: number; phase?: string }): string {
  const parts: string[] = []

  const prefix = context?.iteration ? `[AgentLoop][Iter ${context.iteration}]` : '[AgentLoop]'
  parts.push(`${prefix} ERROR [${diag.category}] ${diag.message}`)

  if (diag.statusCode) parts.push(`  status: ${diag.statusCode}`)
  if (diag.url) parts.push(`  url: ${diag.url}`)
  if (diag.retryable) parts.push(`  retryable: true`)
  if (diag.retryAttempts) parts.push(`  retryAttempts: ${diag.retryAttempts}`)
  if (diag.cause) parts.push(`  cause: ${diag.cause}`)
  if (diag.responseBody) parts.push(`  responseBody: ${diag.responseBody}`)
  if (diag.hint) parts.push(`  hint: ${diag.hint}`)
  if (context?.phase) parts.push(`  phase: ${context.phase}`)

  return parts.join('\n')
}

/**
 * Determine if an error represents a prompt-too-long condition.
 * Used by the loop to trigger PTL recovery.
 */
export function isPtlError(error: unknown): boolean {
  const diag = diagnoseError(error)
  return diag.category === 'context_overflow'
}

/**
 * Determine the user-facing error message for the SSE stream.
 * Returns a concise Chinese message suitable for display in the UI.
 */
export function getUserFacingMessage(diag: DiagnosedError): string {
  switch (diag.category) {
    case 'auth': return `认证失败: ${diag.hint}`
    case 'rate_limit': return `请求频率过高，请稍后重试`
    case 'context_overflow': return `上下文超限，正在自动裁剪...`
    case 'model_not_found': return `模型不存在: ${diag.hint}`
    case 'network': return `无法连接提供商: ${diag.hint}`
    case 'no_content': return `模型未生成内容，正在重试...`
    case 'retry_exhausted': return `多次重试失败: ${diag.cause || diag.message}`
    case 'invalid_request': return `请求参数错误: ${diag.message}`
    case 'abort': return `请求已取消`
    case 'api_call': return `API 调用失败 (${diag.statusCode || 'unknown'}): ${diag.message}`
    default: return `未知错误: ${diag.message}`
  }
}
