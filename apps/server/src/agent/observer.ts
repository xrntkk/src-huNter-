/**
 * Observer — proactive, orthogonal context curation (P3).
 *
 * The Timeline already has a three-tier *defensive* compaction (microCompact /
 * LLM summary / PTL recovery) that fires when the context approaches provider
 * limits. The Observer is a different, *proactive* layer: every N iterations it
 * uses the fast model to compress "the tool I/O since the last curation" into a
 * single short round-summary, accumulating a small rolling board that is shown
 * to the main model as a "近期进展" section.
 *
 * Crucially it is purely additive:
 *   - It NEVER mutates or drops timeline items (that stays the job of compress).
 *   - It only PRODUCES a markdown section consumed by the prompt builder.
 *   - All failures degrade silently (board stays as-is / empty) so it can never
 *     block or break the main loop.
 *
 * This avoids regressions: with the Observer disabled or failing, behaviour is
 * identical to before.
 */

import { generateText, type LanguageModel } from 'ai'
import type { MessageStore } from './message-store.js'
import { logger } from '../logger/index.js'

interface ObserverOptions {
  /** Curate every N iterations (default 5). First curation at i === interval. */
  interval?: number
  /** Max rolling round-summaries to retain (default 6). */
  maxRounds?: number
}

export class Observer {
  private rounds: string[] = []
  private curationCursor = 0
  private readonly interval: number
  private readonly maxRounds: number

  constructor(
    private readonly fastModel: LanguageModel,
    opts: ObserverOptions = {},
  ) {
    this.interval = opts.interval ?? 5
    this.maxRounds = opts.maxRounds ?? 6
  }

  /**
   * Curate iff this iteration lands on the interval boundary. Summarizes the
   * tool activity added since the last curation into one round summary. Silent
   * no-op on any failure or when there's nothing new.
   */
  async maybeCurate(iteration: number, store: MessageStore): Promise<void> {
    if (!this.wantsCurate(iteration)) return

    const { lines, nextCursor } = store.getToolActivitySince(this.curationCursor)
    if (lines.length === 0) return

    // Advance the cursor regardless of LLM outcome so we don't re-summarize the
    // same span on the next interval (avoids duplicate work / drift).
    this.curationCursor = nextCursor

    const transcript = lines.join('\n')
    try {
      const { text } = await generateText({
        model: this.fastModel,
        system:
          '你是一个渗透测试进展记录员。把给定的一段工具调用记录压缩成一条不超过 120 字的进展摘要，' +
          '聚焦：探测了什么、有什么关键结果（发现的接口/漏洞线索/失败原因）、下一步隐含方向。只输出摘要文本，用中文。',
        prompt: transcript,
        maxRetries: 0,
      })
      this.consumeRoundSummary(text, iteration, lines.length)
    } catch (err) {
      logger.warn('[Observer] curation failed (non-blocking):', err instanceof Error ? err.message : String(err))
    }
  }

  /** Whether the Observer would curate on this iteration (interval boundary). */
  wantsCurate(iteration: number): boolean {
    return iteration >= this.interval && iteration % this.interval === 0
  }

  /**
   * Ingest a round summary produced externally (e.g. by the merged curation
   * call in MemoryCurator). Handles trimming + logging.
   */
  consumeRoundSummary(rawText: string, iteration: number, itemCount: number): void {
    const summary = rawText.trim()
    if (!summary) return
    this.rounds.push(summary)
    if (this.rounds.length > this.maxRounds) {
      this.rounds = this.rounds.slice(this.rounds.length - this.maxRounds)
    }
    logger.info(`[Observer] curated round @iter ${iteration} (${itemCount} items → ${summary.length}ch, ${this.rounds.length} rounds retained)`)
  }

  /**
   * Advance the curation cursor without running an LLM call. Used by the
   * MemoryCurator after a merged call so the next standalone maybeCurate
   * doesn't re-summarize the same span.
   */
  advanceCursor(store: MessageStore): { lineCount: number; transcript: string } | null {
    const { lines, nextCursor } = store.getToolActivitySince(this.curationCursor)
    if (lines.length === 0) return null
    this.curationCursor = nextCursor
    return { lineCount: lines.length, transcript: lines.join('\n') }
  }

  /** Render the rolling board as a prompt section. Empty string when no rounds. */
  buildBoardSection(): string {
    if (this.rounds.length === 0) return ''
    const lines = this.rounds.map((r, idx) => `${idx + 1}. ${r}`)
    return lines.join('\n')
  }

  /** Serialize state for persistence alongside the thread timeline. */
  serialize(): { rounds: string[]; curationCursor: number } {
    return { rounds: [...this.rounds], curationCursor: this.curationCursor }
  }

  /** Restore state from a previously serialized snapshot. */
  restore(snapshot: { rounds?: string[]; curationCursor?: number }): void {
    if (snapshot.rounds) this.rounds = [...snapshot.rounds]
    if (snapshot.curationCursor != null) this.curationCursor = snapshot.curationCursor
  }
}
