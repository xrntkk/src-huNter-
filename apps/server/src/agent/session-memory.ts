/**
 * SessionMemoryExtractor — incremental session memory for compression fast-path.
 *
 * Instead of calling the LLM for a full summary every time compression triggers,
 * this module maintains an incrementally-updated memory of the session's key
 * decisions, findings, and progress. When compression fires, if the memory is
 * fresh enough it can be used directly as the summary, skipping an LLM call.
 *
 * Extraction triggers:
 *   - Every N iterations (default 10)
 *   - Or when token growth exceeds a threshold (default 10K)
 *
 * The memory is a condensed narrative focused on:
 *   - Discovered endpoints and their significance
 *   - Confirmed vulnerabilities
 *   - Key decisions and strategy changes
 *   - Blocked paths and failures
 */

import { generateText, type LanguageModel } from 'ai'
import type { MessageStore } from './message-store.js'
import { logger } from '../logger/index.js'

const EXTRACT_INTERVAL = 10
const EXTRACT_TOKEN_DELTA = 10_000

export class SessionMemoryExtractor {
  private memory: string | null = null
  private lastExtractIteration = 0
  private lastExtractTokens = 0

  /** Check if extraction should run this iteration. */
  shouldExtract(iteration: number, currentTokens: number): boolean {
    if (iteration - this.lastExtractIteration >= EXTRACT_INTERVAL) return true
    if (currentTokens - this.lastExtractTokens >= EXTRACT_TOKEN_DELTA) return true
    return false
  }

  /**
   * Run incremental extraction: summarize the recent conversation into a
   * condensed memory that captures key progress. The existing memory is
   * provided as context so the model produces a delta-aware update.
   */
  async extract(
    store: MessageStore,
    fastModel: LanguageModel,
    iteration: number,
  ): Promise<string | null> {
    const transcript = store.toProseTranscript()
    if (!transcript || transcript.length < 200) return this.memory

    const existingCtx = this.memory
      ? `\n\n已有记忆（需要更新/补充）：\n${this.memory}`
      : ''

    const prompt = `请基于以下对话记录，提取/更新一份简洁的会话记忆摘要。聚焦：
1. 已发现的关键接口及其风险特征
2. 已确认的漏洞（类型、位置、严重度）
3. 重要的策略决策和方向变更
4. 被阻断的路径（404 集中区、WAF 拦截等）
5. 当前工作阶段和下一步方向

只输出更新后的完整摘要，不超过 500 字，用中文。${existingCtx}

对话记录（最近部分）：
${transcript.slice(-8000)}`

    try {
      const { text } = await generateText({
        model: fastModel,
        system: '你是一个安全测试会话记忆管理器。输出简洁的结构化摘要。',
        prompt,
        maxRetries: 0,
      })
      const summary = text.trim()
      if (summary) {
        this.memory = summary
        this.lastExtractIteration = iteration
        this.lastExtractTokens = store.estimateTokens()
        logger.info(`[SessionMemory] Extracted at iter ${iteration} (${summary.length}ch)`)
      }
      return this.memory
    } catch (err) {
      logger.warn('[SessionMemory] Extraction failed (non-blocking):', err instanceof Error ? err.message : String(err))
      return this.memory
    }
  }

  /** Get the latest memory, or null if never extracted. */
  getLatestMemory(): string | null {
    return this.memory
  }

  /** How many iterations since the last extraction. */
  freshness(currentIteration: number): number {
    return currentIteration - this.lastExtractIteration
  }

  /** Whether the memory is fresh enough to use as a compression summary. */
  isFreshEnough(currentIteration: number, threshold = 5): boolean {
    return this.memory !== null && this.freshness(currentIteration) <= threshold
  }

  /**
   * Externally set the memory + freshness marker without an LLM call. Used by
   * MemoryCurator to ingest a summary produced by a merged/combined call
   * (e.g. when compress's slow-path summary doubles as the session memory).
   */
  setMemory(summary: string, iteration: number, currentTokens: number): void {
    const trimmed = summary.trim()
    if (!trimmed) return
    this.memory = trimmed
    this.lastExtractIteration = iteration
    this.lastExtractTokens = currentTokens
    logger.info(`[SessionMemory] Set externally at iter ${iteration} (${trimmed.length}ch)`)
  }
}
