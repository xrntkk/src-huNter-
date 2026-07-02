/**
 * PersistenceCoordinator — extracted from runSRCAgent.
 *
 * Encapsulates the per-turn step handler that:
 *   1. Routes sub-agent steps to the SSE side channel.
 *   2. Stashes pending tool-approval calls for resume.
 *   3. Debounces timeline + observation persistence.
 *   4. Emits telemetry events for meaningful steps.
 *   5. Writes action logs to the DB.
 *   6. On finish: releases the run lock and triggers cross-session
 *      memory extraction (non-blocking).
 *
 * This is a pure coordination layer — it does not own the MessageStore
 * or ObservationStore; it receives curried persist callbacks so the
 * caller controls the persistence strategy (blob vs JSONL).
 */
import { nanoid } from 'nanoid'
import { getDb, actionLogs } from '@src-agent/db'
import type { AgentStep } from './agent-loop.js'
import type { StepChannel } from './stream-formatter.js'
import type { MessageStore } from './message-store.js'
import type { SkillRegistry } from './skill-registry.js'
import type { TelemetryCollector } from './telemetry.js'
import type { MemoryLayer } from './memory-layer.js'
import { logger } from '../logger/index.js'

export interface PendingApproval {
  approvalId: string
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  reason: string
}

export interface PersistenceCoordinatorOptions {
  sessionId: string
  threadId: string
  store: MessageStore
  skillRegistry: SkillRegistry
  telemetry: TelemetryCollector
  sideChannel: StepChannel
  release: () => void
  /** Curried persistTimeline(threadId, store) — caller controls strategy. */
  persistFn: () => void
  /** Curried observationStore.persist() — may throw; caller wraps. */
  observationPersistFn: () => void
  /** Setter for stashing pending approvals on the thread state. */
  setPendingApprovals: (pending: PendingApproval[] | undefined) => void
  /** Unified memory layer — drives finish-time extraction. */
  memoryLayer: MemoryLayer
}

const PERSIST_DEBOUNCE_MS = 150

export class PersistenceCoordinator {
  private readonly opts: PersistenceCoordinatorOptions
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private persistPending = false

  constructor(opts: PersistenceCoordinatorOptions) {
    this.opts = opts
  }

  /** Flush any debounced persistence immediately. */
  flushImmediate(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    this.persistPending = false
    this.opts.persistFn()
    try { this.opts.observationPersistFn() } catch { /* ignore */ }
  }

  private schedulePersist(immediate: boolean): void {
    if (immediate) {
      this.flushImmediate()
      return
    }
    this.persistPending = true
    if (!this.persistTimer) {
      this.persistTimer = setTimeout(() => {
        this.persistTimer = null
        if (this.persistPending) {
          this.persistPending = false
          this.opts.persistFn()
          try { this.opts.observationPersistFn() } catch { /* ignore */ }
        }
      }, PERSIST_DEBOUNCE_MS)
    }
  }

  /**
   * The unified step handler. Called by runAgentLoop's onStep callback
   * and by spawn_agent / continue_subagent's onParentStep.
   */
  handleStep = (step: AgentStep): void => {
    const { sessionId, store, skillRegistry, telemetry, sideChannel, release, setPendingApprovals, memoryLayer } = this.opts

    // Streaming text deltas are accumulated into the store's draft so a page
    // refresh mid-stream can surface what the model has produced so far via
    // /messages. Not persisted to DB / telemetry (too granular).
    if (step.type === 'text_delta') {
      store.appendDraft(step.delta)
      return
    }

    // Sub-agent steps go into the side channel for real-time streaming.
    if (step.type === 'subagent_step') {
      sideChannel.push(step)
      return
    }

    // Stash pending tool-approval calls so the next request can resume them.
    if (step.type === 'tool_approval') {
      setPendingApprovals(step.pending)
    }

    // Persist timeline only on steps that actually change conversation state.
    const needsPersist = step.type === 'tool_result' || step.type === 'tool_error'
      || step.type === 'finish' || step.type === 'tool_approval' || step.type === 'system_nudge'
    if (needsPersist) {
      const immediate = step.type === 'finish' || step.type === 'tool_approval'
      this.schedulePersist(immediate)
    }

    // Telemetry — skip streaming-only steps that would spam logs.
    const telEvent = (() => {
      switch (step.type) {
        case 'tool_call': return { type: 'tool_call' as const, sessionId, iteration: step.iteration, data: { toolName: step.toolName, args: step.args } }
        case 'tool_error': return { type: 'tool_error' as const, sessionId, iteration: step.iteration, data: { toolName: step.toolName, error: step.error, durationMs: step.durationMs } }
        case 'tool_result': return { type: 'tool_result' as const, sessionId, iteration: step.iteration, data: { toolName: step.toolName, durationMs: step.durationMs } }
        case 'finish': return { type: 'agent_stop' as const, sessionId, iteration: step.iteration, data: { reason: step.reason, skillsLoaded: skillRegistry.names() } }
        case 'system_nudge': return { type: 'stagnation_nudge' as const, sessionId, iteration: step.iteration, data: { message: step.message } }
        case 'tool_approval': return { type: 'permission_decision' as const, sessionId, iteration: step.iteration, data: { pending: step.pending.map(p => p.toolName) } }
        default: return null
      }
    })()
    if (telEvent) telemetry.emit(telEvent)

    // Action logs
    try {
      const db = getDb()
      const base = { id: nanoid(), sessionId, iteration: step.iteration, createdAt: new Date() }
      switch (step.type) {
        case 'thinking': db.insert(actionLogs).values({ ...base, stepType: 'thinking', result: step.content }).run(); break
        case 'reasoning': db.insert(actionLogs).values({ ...base, stepType: 'reasoning', result: step.content }).run(); break
        case 'tool_call': db.insert(actionLogs).values({ ...base, stepType: 'tool_call', toolName: step.toolName, toolArgs: step.args }).run(); break
        case 'tool_result': db.insert(actionLogs).values({ ...base, stepType: 'tool_result', toolName: step.toolName, result: step.result as string }).run(); break
        case 'tool_error': db.insert(actionLogs).values({ ...base, stepType: 'tool_error', toolName: step.toolName, error: step.error }).run(); break
        case 'finish':
          db.insert(actionLogs).values({ ...base, stepType: 'finish', result: step.reason }).run()
          release()
          memoryLayer.extractOnFinish(store)
          break
        case 'system_nudge': db.insert(actionLogs).values({ ...base, stepType: 'system_nudge', result: step.message }).run(); break
      }
    } catch (err) {
      logger.error('[ActionLog] Failed to persist:', err)
    }
  }
}
