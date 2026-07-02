/**
 * Telemetry — structured event collection for agent behaviour analysis.
 *
 * In addition to in-memory aggregation, every emitted event is persisted to
 * the `telemetry_events` table (best-effort, fire-and-forget) so the dashboard
 * routes can aggregate over historical runs.
 */

import { nanoid } from 'nanoid'
import { getDb, telemetryEvents } from '@src-agent/db'
import { estimateCost } from './cost-calculator.js'
import { logger } from '../logger/index.js'

export type TelemetryEventType =
  | 'agent_start'
  | 'agent_stop'
  | 'agent_abort'
  | 'tool_call'
  | 'tool_result'
  | 'tool_error'
  | 'skill_loaded'
  | 'permission_decision'
  | 'plan_generated'
  | 'plan_task_completed'
  | 'timeline_compress'
  | 'stagnation_nudge'
  | 'model_error'
  | 'model_usage'
  | 'context_snapshot'

export interface TelemetryEvent {
  type: TelemetryEventType
  timestamp: number
  sessionId?: string
  /**
   * Thread the event belongs to. Defaults to the collector's ctx.threadId, but
   * a sub-agent run (which shares the parent's collector) overrides this with
   * its own task id so per-sub-session aggregation stays distinct.
   */
  threadId?: string
  iteration?: number
  data: Record<string, unknown>
}

export interface TelemetryContext {
  sessionId?: string
  threadId?: string
}

export class TelemetryCollector {
  private events: TelemetryEvent[] = []
  private _totalInputTokens = 0
  private _totalCacheReadTokens = 0
  private _totalCacheWriteTokens = 0
  private _totalOutputTokens = 0
  private ctx: TelemetryContext

  constructor(ctx: TelemetryContext = {}) {
    this.ctx = ctx
  }

  emit(event: Omit<TelemetryEvent, 'timestamp'>): void {
    const full: TelemetryEvent = {
      ...event,
      timestamp: Date.now(),
    }
    this.events.push(full)

    // Track cumulative token usage for cache hit rate calculation
    if (event.type === 'model_usage') {
      const d = event.data as { inputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; outputTokens?: number }
      this._totalInputTokens += d.inputTokens ?? 0
      this._totalCacheReadTokens += d.cacheReadTokens ?? 0
      this._totalCacheWriteTokens += d.cacheWriteTokens ?? 0
      this._totalOutputTokens += d.outputTokens ?? 0
    }

    // Console output for development / debugging
    const prefix = `[Telemetry] ${full.type}`
    const extra = Object.entries(full.data)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(' ')
    if (extra) {
      logger.info(`${prefix} | ${extra}`)
    } else {
      logger.info(prefix)
    }

    // Persist to DB (best-effort, never throw into the agent loop).
    void this.persist(full)
  }

  private async persist(ev: TelemetryEvent): Promise<void> {
    try {
      const d = ev.data as Record<string, unknown>
      const inputTokens = typeof d.inputTokens === 'number' ? d.inputTokens : null
      const outputTokens = typeof d.outputTokens === 'number' ? d.outputTokens : null
      const cacheReadTokens = typeof d.cacheReadTokens === 'number' ? d.cacheReadTokens : null
      const cacheWriteTokens = typeof d.cacheWriteTokens === 'number' ? d.cacheWriteTokens : null
      const durationMs = typeof d.durationMs === 'number' ? d.durationMs : null
      const toolName = typeof d.toolName === 'string' ? d.toolName : null
      const modelId = typeof d.modelId === 'string' ? d.modelId : null
      const costUsd = ev.type === 'model_usage'
        ? estimateCost(modelId, { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens })
        : null

      await getDb().insert(telemetryEvents).values({
        id: nanoid(),
        sessionId: ev.sessionId ?? this.ctx.sessionId ?? null,
        threadId: ev.threadId ?? this.ctx.threadId ?? null,
        iteration: ev.iteration ?? null,
        type: ev.type,
        toolName,
        modelId,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        durationMs,
        costUsd,
        data: JSON.stringify(d),
        createdAt: ev.timestamp,
      })
    } catch (err) {
      // Swallow — telemetry is best-effort and must never break the agent.
      logger.warn('[Telemetry] persist failed:', err instanceof Error ? err.message : err)
    }
  }

  /** Cache hit rate: proportion of input tokens served from cache. */
  cacheHitRate(): number {
    const total = this._totalCacheReadTokens + this._totalInputTokens
    if (total === 0) return 0
    return this._totalCacheReadTokens / total
  }

  /** Cumulative token usage stats. */
  tokenStats(): { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; cacheHitRate: number } {
    return {
      inputTokens: this._totalInputTokens,
      outputTokens: this._totalOutputTokens,
      cacheReadTokens: this._totalCacheReadTokens,
      cacheWriteTokens: this._totalCacheWriteTokens,
      cacheHitRate: this.cacheHitRate(),
    }
  }

  /** Return all events collected so far and clear the buffer. */
  flush(): TelemetryEvent[] {
    const all = [...this.events]
    this.events = []
    return all
  }

  /** Return a copy without clearing. */
  snapshot(): TelemetryEvent[] {
    return [...this.events]
  }

  count(): number {
    return this.events.length
  }
}
