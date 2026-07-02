/**
 * MemoryLayer — unified coordinator for the agent's knowledge memory systems.
 *
 * Replaces the scattered `buildEndpointContext` / `buildTargetMemoryContext` /
 * `selectRelevantMemories` invocation sites in src-agent.ts, and the direct
 * `extractTargetMemory` call in PersistenceCoordinator. All four knowledge
 * memory systems are routed through this single facade so future changes to
 * retrieval strategy, caching, or scoping have one touchpoint.
 *
 * Memory systems coordinated:
 *   1. ObservationStore     — per-session structured facts (endpoints, vulns).
 *   2. target_memory        — per-(session, host) cross-run summaries.
 *   3. memories + edges     — per-session agent-authored notes.
 *   4. selected endpoints   — per-turn UI selection (DB-backed).
 *
 * Not wrapped here:
 *   - MessageStore          — produces ModelMessage[] (not prompt sections);
 *                             stays owned by the agent loop.
 *   - Observer              — loop-coupled rolling curation; its LLM call is
 *                             merged in task 14.
 *   - SessionMemoryExtractor — in-loop compression fast-path; loop-coupled.
 */

import {
  buildEndpointContext,
  buildTargetMemoryContext,
  selectRelevantMemories,
} from './context-builder.js'
import { extractTargetMemory } from './memory-extractor.js'
import type { ObservationStore } from './observation-store.js'
import type { MessageStore } from './message-store.js'
import { logger } from '../logger/index.js'

export interface MemoryLayerOptions {
  sessionId: string
  threadId: string
  observationStore: ObservationStore
}

export interface BuildContextOptions {
  /** Endpoint IDs selected in the UI for this turn. */
  selectedEndpointIds: string[]
  /** Latest user message — used for host extraction + memory relevance. */
  lastUserMsg: string
}

export interface MemoryContext {
  /** Markdown for the "selected endpoints" prompt section. */
  endpointContext: string
  /** Markdown for the "target host memory" prompt section. */
  targetMemoryContext: string
  /** Markdown for the "agent-authored memories" prompt section. */
  relevantMemoryContext: string
}

export class MemoryLayer {
  constructor(private readonly opts: MemoryLayerOptions) {}

  /** Session id under which all memory is scoped. */
  get sessionId(): string {
    return this.opts.sessionId
  }

  /** Thread id used for persistence scoping. */
  get threadId(): string {
    return this.opts.threadId
  }

  /** Live observation store — PromptBuilder reads facts via this. */
  get observation(): ObservationStore {
    return this.opts.observationStore
  }

  /**
   * Build the dynamic memory context for the current turn. Runs the three
   * independent DB + side-query retrievals in parallel and returns them as
   * distinct sections so PromptBuilder can place each under its own header.
   *
   * All three are strictly scoped to `sessionId` — two projects targeting the
   * same host never see each other's data.
   */
  async buildContext(opts: BuildContextOptions): Promise<MemoryContext> {
    const [endpointContext, targetMemoryContext, relevantMemoryContext] = await Promise.all([
      buildEndpointContext(this.opts.sessionId, opts.selectedEndpointIds),
      buildTargetMemoryContext(this.opts.sessionId, opts.lastUserMsg),
      selectRelevantMemories(this.opts.sessionId, opts.lastUserMsg),
    ])
    return { endpointContext, targetMemoryContext, relevantMemoryContext }
  }

  /**
   * Finish-time extraction. Fires the cross-session target_memory summarizer
   * when the session produced ≥1 add_endpoint call. Debounced per (session,
   * host) — see memory-extractor.ts. Fire-and-forget; never blocks release().
   *
   * Other systems self-persist (ObservationStore via persist()) or are
   * in-loop only (Observer, SessionMemoryExtractor) and need no finish hook.
   */
  extractOnFinish(store: MessageStore): void {
    if (!store.hasToolCall('add_endpoint')) return
    void extractTargetMemory({
      sessionId: this.opts.sessionId,
      threadId: this.opts.threadId,
      store,
    }).catch(err => {
      logger.warn('[MemoryLayer] extractOnFinish failed (non-blocking):', err)
    })
  }
}
