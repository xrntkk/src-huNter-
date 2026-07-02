/**
 * 模型 API 连接失败的指数退避重连策略。
 *
 * 设计参考 ClaudeCode `services/api/withRetry.ts`：指数退避 + 抖动 + 服务端
 * retry-after 头优先。错误是否可重试的判断委托给 error-diagnostics 的分类，
 * 避免在两处维护并行的状态码 / 关键字规则。
 *
 * 仅用于 agent-loop.ts 的 runSingleStream 内层重连，不覆盖 plan-engine /
 * observer 等辅助路径——它们的失败应直接降级。
 */

import { APICallError } from 'ai'
import { diagnoseError, type ErrorCategory } from './error-diagnostics.js'

export const RECONNECT_MAX_RETRIES = 10
export const RECONNECT_BASE_DELAY_MS = 500
export const RECONNECT_MAX_DELAY_MS = 32_000

/**
 * 这些错误类别在"流尚未产出任何内容"时值得重连：
 * - network: ECONNRESET / ENOTFOUND / ETIMEDOUT 等连接层错误
 * - api_call: 5xx 服务端错误（提供商内部错误，通常瞬时）
 * - rate_limit: 429（按 retry-after 等待后重试）
 * - no_content: 模型输出为空（可能是临时质量问题）
 *
 * 不重试的类别走原有错误路径上报：
 * - auth: API key 错，重试无意义
 * - context_overflow: PTL，由 store.recoverFromPTL() 单独处理
 * - model_not_found: 模型 ID 错，重试无意义
 * - invalid_request: 请求结构错（400 非 PTL），重试无意义
 * - abort: 用户主动取消
 * - retry_exhausted: 看内层 cause（diagnoseError 已展开）
 * - unknown: 谨慎起见不重试
 */
const RECONNECTABLE_CATEGORIES: ReadonlySet<ErrorCategory> = new Set([
  'network',
  'api_call',
  'rate_limit',
  'no_content',
])

export function isReconnectable(err: unknown): boolean {
  const diag = diagnoseError(err)
  // RetryError 包装时 diagnoseError 已经把 category 替换成内层错误的 category，
  // 所以这里直接读 diag.category 即可，不必再展开 cause。
  return RECONNECTABLE_CATEGORIES.has(diag.category)
}

/** 从 APICallError.responseHeaders 读 retry-after（秒），转毫秒。 */
function getRetryAfterMs(err: unknown): number | null {
  if (!APICallError.isInstance(err)) return null
  const headers = err.responseHeaders
  if (!headers) return null
  // headers 可能大小写混杂；优先精确匹配，再做不区分大小写的兜底。
  const raw = headers['retry-after'] ?? headers['Retry-After']
    ?? Object.entries(headers).find(([k]) => k.toLowerCase() === 'retry-after')?.[1]
  if (!raw) return null
  const seconds = parseInt(raw, 10)
  if (Number.isNaN(seconds) || seconds < 0) return null
  return Math.min(seconds * 1000, RECONNECT_MAX_DELAY_MS)
}

/**
 * 计算下一次退避毫秒数。
 * - 服务端 retry-after 头优先（429 等显式速率限制时尊重）
 * - 否则指数退避 base * 2^(attempt-1)，封顶 maxDelay，叠加 25% 抖动避免雷鸣
 *
 * @param attempt 1-based 当前重试次数（第 1 次重试时传 1）
 */
export function computeBackoffMs(attempt: number, err: unknown): number {
  const retryAfter = getRetryAfterMs(err)
  if (retryAfter !== null) return retryAfter

  const baseDelay = Math.min(
    RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt - 1),
    RECONNECT_MAX_DELAY_MS,
  )
  const jitter = Math.random() * 0.25 * baseDelay
  return Math.floor(baseDelay + jitter)
}

/**
 * abort-aware sleep。每 100ms 轮询一次 signal，触发后立即 reject。
 * 不引入额外依赖（AI SDK 不导出 sleep）。
 */
export function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('AbortError'))
      return
    }
    const start = Date.now()
    const tick = () => {
      if (signal?.aborted) {
        clearTimeout(timer)
        reject(new Error('AbortError'))
        return
      }
      const elapsed = Date.now() - start
      if (elapsed >= ms) {
        resolve()
        return
      }
      timer = setTimeout(tick, Math.min(100, ms - elapsed))
    }
    let timer: NodeJS.Timeout = setTimeout(tick, Math.min(100, ms))
  })
}
