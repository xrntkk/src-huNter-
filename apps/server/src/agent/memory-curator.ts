/**
 * MemoryCurator — coordinates the Observer + SessionMemoryExtractor LLM calls
 * to avoid redundant fast-model invocations on the same iteration.
 *
 * Both systems summarize overlapping content (recent tool activity / session
 * progress). When their triggers coincide (e.g. iteration 10: Observer every 5,
 * SessionMemory every 10), the Curator merges them into a single LLM call that
 * produces both a round summary and a session-memory update. When only one
 * fires, it delegates to that system's existing method.
 *
 * Additionally, the Curator runs BEFORE compress so that:
 *   1. A fresh sessionMemory lets compress take the fast-path (no LLM call).
 *   2. When compress does run the slow-path, it refreshes sessionMemory
 *      internally (see message-store.ts), so the Curator skips the standalone
 *      SessionMemoryExtractor extraction on iterations where compress fired.
 */

import { generateText, type LanguageModel } from 'ai'
import type { MessageStore } from './message-store.js'
import type { Observer } from './observer.js'
import type { SessionMemoryExtractor } from './session-memory.js'
import { logger } from '../logger/index.js'

/** Tag the model uses to delimit the two outputs in a merged call. */
const ROUND_TAG = '【进展】'
const MEMORY_TAG = '【记忆】'

export class MemoryCurator {
  constructor(
    private readonly observer: Observer,
    private readonly sessionMemory: SessionMemoryExtractor,
  ) {}

  /**
   * Run curation for this iteration. Returns true if any curation ran.
   *
   * Should be called BEFORE compress so that a fresh sessionMemory lets
   * compress take the fast-path (no LLM call). When compress subsequently
   * runs the slow-path, it refreshes sessionMemory internally.
   *
   * @param iteration  Current loop iteration (1-based).
   * @param store      The message store (read-only access).
   * @param fastModel  The fast model for side-queries.
   */
  async curate(
    iteration: number,
    store: MessageStore,
    fastModel: LanguageModel,
  ): Promise<boolean> {
    const observerWants = this.observer.wantsCurate(iteration)
    const memoryWants = this.sessionMemory.shouldExtract(iteration, store.estimateTokens())

    // Both want to fire → merged single LLM call.
    if (observerWants && memoryWants) {
      try {
        await this.mergedCurate(iteration, store, fastModel)
      } catch (err) {
        logger.warn('[MemoryCurator] merged curate failed (non-blocking):', err instanceof Error ? err.message : String(err))
      }
      return true
    }

    // Only SessionMemoryExtractor.
    if (memoryWants) {
      try {
        await this.sessionMemory.extract(store, fastModel, iteration)
      } catch (err) {
        logger.warn('[MemoryCurator] session memory extraction failed (non-blocking):', err instanceof Error ? err.message : String(err))
      }
      return true
    }

    // Only Observer.
    if (observerWants) {
      try {
        await this.observer.maybeCurate(iteration, store)
      } catch (err) {
        logger.warn('[MemoryCurator] observer curation failed (non-blocking):', err instanceof Error ? err.message : String(err))
      }
      return true
    }

    return false
  }

  /**
   * Single LLM call that produces both a round summary (for the Observer) and
   * a session-memory update (for SessionMemoryExtractor). The model is asked
   * to emit both sections delimited by 【进展】 / 【记忆】 tags.
   */
  private async mergedCurate(
    iteration: number,
    store: MessageStore,
    fastModel: LanguageModel,
  ): Promise<void> {
    // Advance the observer cursor and grab the tool-activity transcript.
    const observerInput = this.observer.advanceCursor(store)
    if (!observerInput) {
      // No new tool activity — just run session memory extraction alone.
      await this.sessionMemory.extract(store, fastModel, iteration)
      return
    }

    const transcript = store.toProseTranscript()
    const tail = transcript.slice(-8000)
    const existingMemory = this.sessionMemory.getLatestMemory()
    const existingCtx = existingMemory ? `\n\n已有记忆（需要更新/补充）：\n${existingMemory}` : ''

    const prompt = `请基于以下对话记录和工具活动，同时产出两段摘要：

${ROUND_TAG} 不超过 120 字的近期进展摘要。聚焦：探测了什么、关键结果（发现的接口/漏洞线索/失败原因）、下一步隐含方向。

${MEMORY_TAG} 不超过 500 字的会话记忆更新。聚焦：
1. 已发现的关键接口及其风险特征
2. 已确认的漏洞（类型、位置、严重度）
3. 重要的策略决策和方向变更
4. 被阻断的路径（404 集中区、WAF 拦截等）
5. 当前工作阶段和下一步方向
${existingCtx}

工具活动记录：
${observerInput.transcript}

对话记录（最近部分）：
${tail}

请严格按照以下格式输出，不要额外的解释或标题：
${ROUND_TAG}
<进展摘要>

${MEMORY_TAG}
<记忆摘要>`

    try {
      const { text } = await generateText({
        model: fastModel,
        system: '你是一个安全测试会话的记忆管理器。严格按照指定格式输出两段摘要。',
        prompt,
        maxRetries: 0,
      })

      const parsed = this.parseMergedOutput(text)
      if (parsed.round) {
        this.observer.consumeRoundSummary(parsed.round, iteration, observerInput.lineCount)
      }
      if (parsed.memory) {
        this.sessionMemory.setMemory(parsed.memory, iteration, store.estimateTokens())
      }
      logger.info(`[MemoryCurator] merged curate @iter ${iteration} (round=${parsed.round?.length ?? 0}ch, memory=${parsed.memory?.length ?? 0}ch)`)
    } catch (err) {
      // Fallback: run both independently so one failure doesn't lose both.
      logger.warn('[MemoryCurator] merged call failed, falling back to independent extraction:', err instanceof Error ? err.message : String(err))
      this.observer.consumeRoundSummary('', iteration, 0)
      await this.sessionMemory.extract(store, fastModel, iteration)
    }
  }

  /**
   * Parse the merged LLM output into { round, memory } segments.
   * Tolerant of missing tags or ordering — best-effort extraction.
   */
  private parseMergedOutput(text: string): { round: string | null; memory: string | null } {
    const roundIdx = text.indexOf(ROUND_TAG)
    const memIdx = text.indexOf(MEMORY_TAG)

    let round: string | null = null
    let memory: string | null = null

    if (roundIdx !== -1) {
      const start = roundIdx + ROUND_TAG.length
      const end = memIdx !== -1 && memIdx > roundIdx ? memIdx : text.length
      round = text.slice(start, end).trim()
    }

    if (memIdx !== -1) {
      const start = memIdx + MEMORY_TAG.length
      memory = text.slice(start).trim()
    }

    return { round: round || null, memory: memory || null }
  }
}
