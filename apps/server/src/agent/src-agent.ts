import { eq } from 'drizzle-orm'
import { getDb, threadTimelines, threads } from '@src-agent/db'
import { MemoryLayer } from './memory-layer.js'
import { PromptBuilder } from './prompt-builder.js'
import { SkillRegistry } from './skill-registry.js'
import { mcpManager } from '../mcp/manager.js'
import { getModel, getFastModel, isLargeContextModel, getToolProtocol, getProviderOptions, getModelCapability } from './model-router.js'
import { ThreadJsonlStore } from './thread-jsonl-store.js'
import { MessageStore } from './message-store.js'
import { runAgentLoop, agentLoopToDataStreamResponse, StepChannel, type AgentStep } from './agent-loop.js'
import { ObservationStore } from './observation-store.js'
import { PlanNotes } from './plan-notes.js'
import { Observer } from './observer.js'
import { HierarchicalAbortController } from './hierarchical-abort.js'
import { loadSkill } from './skill-loader.js'
import { resolveSlashCommand } from './slash-commands.js'
import type { Tool } from 'ai'
import { TelemetryCollector } from './telemetry.js'
import { createTraceId, type TraceContext } from './langfuse-trace.js'
import { flushLangfuse } from '../instrumentation.js'
import { PermissionChecker } from './permissions.js'
import { subagentRegistry } from './subagent-registry.js'
import type { ChatRequest } from '@src-agent/types'
import { logger } from '../logger/index.js'
import { buildToolMap } from './tool-builder.js'
import { PersistenceCoordinator } from './persistence-coordinator.js'

// ─── Session state (keyed by threadId for timeline isolation) ─────────────────

interface ThreadState {
  store: MessageStore
  observationStore: ObservationStore
  observer: Observer
  abortController: HierarchicalAbortController
  busy: boolean
  pendingApprovals?: Array<{ approvalId: string; toolCallId: string; toolName: string; args: Record<string, unknown>; reason: string }>
  /** Tracking fields for append-only JSONL persistence. */
  lastPersistedMsgCount: number
  lastPersistedSeq: number
}

const threadStore = new Map<string, ThreadState>()

function getOrCreateThread(sessionId: string, threadId: string): ThreadState {
  if (!threadStore.has(threadId)) {
    const state: ThreadState = {
      store: new MessageStore(),
      observationStore: new ObservationStore(sessionId, threadId),
      observer: new Observer(getFastModel()),
      abortController: new HierarchicalAbortController(),
      busy: false,
      lastPersistedMsgCount: 0,
      lastPersistedSeq: 0,
    }
    threadStore.set(threadId, state)
  }
  return threadStore.get(threadId)!
}

/**
 * Acquire exclusive execution for a thread. If a run is already in progress:
 *   1. Abort the in-flight AbortController (stops streamText + sync sub-agents)
 *   2. Abort all async sub-agents spawned under this thread
 *   3. Replace AbortController for the new run
 *
 * Returns a release() that is idempotent — safe to call multiple times (the
 * first call flips busy=false; subsequent calls are no-ops). This prevents
 * double-release races when stopAgent() and the finish step both trigger.
 */
function acquireRun(sessionId: string, threadId: string): { release: () => void; signal: AbortSignal } {
  const state = getOrCreateThread(sessionId, threadId)
  if (state.busy) {
    state.abortController.abort()
    state.abortController = new HierarchicalAbortController()
    // Kill orphaned async sub-agents from the preempted run
    subagentRegistry.abortAllForThread(threadId)
  }
  state.busy = true
  let released = false
  const release = () => {
    if (released) return
    released = true
    state.busy = false
  }
  return { release, signal: state.abortController.signal }
}

// ─── MessageStore + ObservationStore init / persist (keyed by threadId) ──────

export async function initThreadState(sessionId: string, threadId: string): Promise<{ store: MessageStore; observationStore: ObservationStore }> {
  const state = getOrCreateThread(sessionId, threadId)

  // Load conversation from DB if empty. Legacy Timeline rows are ignored
  // (MessageStore.deserialize returns an empty store for non-v2 data).
  if (state.store.isEmpty()) {
    try {
      const db = getDb()
      const row = await db
        .select()
        .from(threadTimelines)
        .where(eq(threadTimelines.threadId, threadId))
        .get()

      // Plan one — JSONL hot path. When the row points at a JSONL log we
      // restore from disk. Otherwise, if the row still carries a legacy blob
      // and JSONL mode is enabled, we one-shot migrate it before continuing.
      if (row?.jsonlPath) {
        const loaded = await ThreadJsonlStore.load(threadId)
        state.store = MessageStore.fromJsonl(loaded, row.compressedSummary ?? null)
        state.lastPersistedMsgCount = loaded.messages.length
        state.lastPersistedSeq = loaded.lastSeq
        if (loaded.corruptLines > 0) {
          logger.warn(`[ThreadJsonlStore] Skipped ${loaded.corruptLines} corrupt line(s) for thread ${threadId}`)
        }
        if (row.timelineData) {
          const obs = MessageStore.extractObserverState(row.timelineData)
          if (obs) state.observer.restore(obs)
        }
        logger.info(`[MessageStore] Restored thread ${threadId} from JSONL (lastSeq=${loaded.lastSeq}, msgs=${loaded.messages.length})`)
      } else if (row?.timelineData) {
        state.store = MessageStore.deserialize(row.timelineData)
        const observerSnapshot = MessageStore.extractObserverState(row.timelineData)
        if (observerSnapshot) {
          state.observer.restore(observerSnapshot)
          logger.info(`[Observer] Restored for thread ${threadId} (${observerSnapshot.rounds.length} rounds)`)
        }
        logger.info(`[MessageStore] Restored for thread ${threadId} from blob`)

        if (jsonlEnabled()) {
          try {
            const { lastSeq, messageCount } = await migrateBlobToJsonl(threadId, state.store)
            state.lastPersistedMsgCount = messageCount
            state.lastPersistedSeq = lastSeq
          } catch (err) {
            logger.warn(`[ThreadJsonlStore] Migration failed for thread ${threadId}; staying on blob.`, err)
          }
        }
      }
    } catch (err) {
      logger.error('[MessageStore] Failed to restore from DB:', err)
    }
  }

  // Load ObservationStore from DB if not loaded
  if (!(state.observationStore as any)['loaded']) {
    try {
      state.observationStore.load()
    } catch (err) {
      logger.error('[ObservationStore] Failed to load from DB:', err)
    }
  }

  return { store: state.store, observationStore: state.observationStore }
}

/** Restore (or return cached) MessageStore for a thread — used by the history route. */
export async function initTimeline(threadId: string): Promise<MessageStore> {
  const state = threadStore.get(threadId)
  if (state && !state.store.isEmpty()) return state.store

  // Thread not in memory or store is empty — load from DB
  try {
    const db = getDb()
    const row = await db
      .select()
      .from(threadTimelines)
      .where(eq(threadTimelines.threadId, threadId))
      .get()

    if (row?.jsonlPath) {
      const loaded = await ThreadJsonlStore.load(threadId)
      const store = MessageStore.fromJsonl(loaded, row.compressedSummary ?? null)
      if (state) state.store = store
      logger.info(`[MessageStore] Restored thread ${threadId} from JSONL (history view)`)
      return store
    }
    if (row?.timelineData) {
      const store = MessageStore.deserialize(row.timelineData)
      if (state) state.store = store
      logger.info(`[MessageStore] Restored for thread ${threadId}`)
      return store
    }
  } catch (err) {
    logger.error('[MessageStore] Failed to restore from DB:', err)
  }
  return state?.store ?? new MessageStore()
}

/** True iff the user opted into JSONL persistence via env. */
function jsonlEnabled(): boolean {
  const raw = (process.env.THREAD_STORAGE ?? 'legacy').toLowerCase()
  return raw === 'jsonl' || raw === 'on' || raw === '1' || raw === 'true'
}

/**
 * One-shot migrate a thread's legacy blob into a per-thread JSONL log. Writes
 * the snapshot atomically (tmp + rename) and stamps `jsonlPath / lastSeq`
 * onto the SQLite row so subsequent restores take the JSONL path. Idempotent —
 * a re-run just rewrites the snapshot from the live store.
 */
async function migrateBlobToJsonl(threadId: string, store: MessageStore): Promise<{ lastSeq: number; messageCount: number }> {
  const messages = [...store.getMessages()]
  const markers = [...store.getMarkers()]
  const meta: Array<{ kind: 'compression' | 'skill_loaded'; payload: unknown }> = []
  const summary = store.getCompressionSummary()
  if (summary) meta.push({ kind: 'compression', payload: summary })
  for (const skill of store.getLoadedSkillNames()) meta.push({ kind: 'skill_loaded', payload: skill })

  const { path, lastSeq } = await ThreadJsonlStore.writeSnapshot(threadId, { messages, meta, markers })
  const db = getDb()
  db.update(threadTimelines).set({
    jsonlPath: path,
    lastSeq,
    messageCount: messages.length,
    compressedSummary: summary ?? null,
  }).where(eq(threadTimelines.threadId, threadId)).run()
  logger.info(`[ThreadJsonlStore] Migrated thread ${threadId}: ${messages.length} msgs, lastSeq=${lastSeq}, path=${path}`)
  return { lastSeq, messageCount: messages.length }
}

/** Periodic compaction threshold: after this many new messages, do a full rewrite. */
const PERSIST_COMPACTION_THRESHOLD = 50

function persistTimeline(threadId: string, store: MessageStore): void {
  try {
    const db = getDb()
    const state = threadStore.get(threadId)
    const observerState = state?.observer.serialize()
    const now = new Date()

    if (jsonlEnabled()) {
      const messages = [...store.getMessages()]
      const summary = store.getCompressionSummary()
      const observerOnlyBlob = observerState
        ? JSON.stringify({ version: 3, observer: observerState })
        : null

      const lastCount = state?.lastPersistedMsgCount ?? 0
      const lastSeq = state?.lastPersistedSeq ?? 0

      // Full rewrite (compaction) when: first persist, messages dropped
      // (compression/PTL), threshold exceeded, or a previous rewrite is
      // still in flight (lastSeq === -1 sentinel).
      const needsFullRewrite =
        lastCount === 0 ||
        messages.length < lastCount ||
        messages.length - lastCount > PERSIST_COMPACTION_THRESHOLD ||
        lastSeq < 0

      if (needsFullRewrite) {
        const markers = [...store.getMarkers()]
        const meta: Array<{ kind: 'compression' | 'skill_loaded'; payload: unknown }> = []
        if (summary) meta.push({ kind: 'compression', payload: summary })
        for (const skill of store.getLoadedSkillNames()) meta.push({ kind: 'skill_loaded', payload: skill })

        // Mark in-flight synchronously to prevent append-only races.
        if (state) {
          state.lastPersistedMsgCount = messages.length
          state.lastPersistedSeq = -1
        }

        ThreadJsonlStore.writeSnapshot(threadId, { messages, meta, markers })
          .then(({ path, lastSeq: newLastSeq }) => {
            if (state) state.lastPersistedSeq = newLastSeq
            try {
              db.insert(threadTimelines).values({
                threadId, timelineData: observerOnlyBlob, jsonlPath: path,
                lastSeq: newLastSeq, messageCount: messages.length,
                compressedSummary: summary ?? null, updatedAt: now,
              }).run()
            } catch {
              db.update(threadTimelines).set({
                timelineData: observerOnlyBlob, jsonlPath: path,
                lastSeq: newLastSeq, messageCount: messages.length,
                compressedSummary: summary ?? null, updatedAt: now,
              }).where(eq(threadTimelines.threadId, threadId)).run()
            }
            // If new messages arrived during the rewrite, re-persist to catch them.
            const currentLen = store.getMessages().length
            if (state && currentLen > state.lastPersistedMsgCount) {
              persistTimeline(threadId, store)
            }
          })
          .catch(err => {
            if (state) state.lastPersistedSeq = 0
            logger.error('[ThreadJsonlStore] persist failed:', err)
          })
        return
      }

      if (messages.length > lastCount) {
        // Append-only: write only new messages since last persist.
        const newMessages = messages.slice(lastCount)
        let seq = lastSeq
        const entries = newMessages.map(msg => { seq++; return { seq, msg } })
        const newLastSeq = seq

        // Update state synchronously to prevent seq collision.
        if (state) {
          state.lastPersistedMsgCount = messages.length
          state.lastPersistedSeq = newLastSeq
        }

        Promise.all(entries.map(({ seq, msg }) => ThreadJsonlStore.appendMessage(threadId, seq, msg)))
          .then(() => {
            try {
              db.update(threadTimelines).set({
                timelineData: observerOnlyBlob,
                lastSeq: newLastSeq,
                messageCount: messages.length,
                compressedSummary: summary ?? null,
                updatedAt: now,
              }).where(eq(threadTimelines.threadId, threadId)).run()
            } catch (err) {
              logger.error('[ThreadJsonlStore] DB update failed:', err)
            }
          })
          .catch(err => logger.error('[ThreadJsonlStore] append failed:', err))
        return
      }

      // No new messages — just update observer state in DB.
      try {
        db.update(threadTimelines).set({
          timelineData: observerOnlyBlob,
          updatedAt: now,
        }).where(eq(threadTimelines.threadId, threadId)).run()
      } catch { /* ignore */ }
      return
    }

    // Legacy blob mode (default).
    const data = store.serialize(observerState)
    try {
      db.insert(threadTimelines).values({ threadId, timelineData: data, updatedAt: now }).run()
    } catch {
      db.update(threadTimelines).set({ timelineData: data, updatedAt: now }).where(eq(threadTimelines.threadId, threadId)).run()
    }
  } catch (err) {
    logger.error('[MessageStore] Failed to persist:', err)
  }
}

// ─── Agent stop ───────────────────────────────────────────────────────────────

export function stopAgent(threadId: string): boolean {
  const state = threadStore.get(threadId)
  if (!state) return false
  state.abortController.abort()
  state.abortController = new HierarchicalAbortController()
  state.busy = false
  // Cascade abort to all async sub-agents spawned under this thread
  subagentRegistry.abortAllForThread(threadId)
  return true
}

/** Check if an agent loop is currently running for this thread. */
export function isAgentRunning(threadId: string): boolean {
  const state = threadStore.get(threadId)
  return state?.busy ?? false
}

// ─── Main agent entry point ───────────────────────────────────────────────────

export async function runSRCAgent(sessionId: string, threadId: string, request: ChatRequest, _signal?: AbortSignal) {
  const { messages, selectedEndpointIds, modelId, approvals, selectedMcpServers } = request
  const rawUserMsg = messages.filter(m => m.role === 'user').at(-1)?.content ?? ''

  // Slash-command resolution: `/recon` etc. carry no prompt over the wire — the
  // real (hidden) prompt is injected here. The model sees `injectedPrompt`; the
  // UI bubble shows only `command.label` (via the CMD marker in appendUser).
  const slash = resolveSlashCommand(rawUserMsg)
  const lastUserMsg = slash ? slash.injectedPrompt : rawUserMsg
  // Display label shown in the chat bubble: the command token plus any
  // user-typed supplementary text (address, etc) — never the hidden prompt.
  const commandLabel = slash
    ? `/${slash.command.name}${slash.extra ? ` ${slash.extra}` : ''}`
    : undefined
  // Merge the command's skills into the turn's visible catalog (deduped).
  const selectedSkills = slash
    ? [...new Set([...(request.selectedSkills ?? []), ...slash.command.skills])]
    : request.selectedSkills

  // Resume-from-approval: when the request carries approval decisions, join
  // them with the tool calls this thread paused on and skip treating the
  // incoming message as fresh user input.
  const threadForApproval = getOrCreateThread(sessionId, threadId)
  const pending = threadForApproval.pendingApprovals ?? []
  const resumeApprovals = approvals && approvals.length > 0 && pending.length > 0
    ? approvals
        .map(a => {
          const match = pending.find(p => p.toolCallId === a.toolCallId)
          return match ? { approvalId: match.approvalId, approved: a.approved, note: a.note } : null
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
    : []
  const isApprovalResume = resumeApprovals.length > 0
  // Consume the pending set so it can't be replayed twice.
  if (isApprovalResume) threadForApproval.pendingApprovals = undefined

  // Acquire exclusive run per thread — aborts any in-flight loop for this thread.
  const { release, signal } = acquireRun(sessionId, threadId)

  try {
    const model = getModel(modelId)

    // Restore or create message store + ObservationStore (per thread, not per session)
    const { store, observationStore } = await initThreadState(sessionId, threadId)
    const observer = getOrCreateThread(sessionId, threadId).observer

    // Unified memory layer — aggregates the 4 knowledge memory systems.
    const memoryLayer = new MemoryLayer({ sessionId, threadId, observationStore })

    const [memoryCtx, allMcpTools] = await Promise.all([
      memoryLayer.buildContext({ selectedEndpointIds, lastUserMsg }),
      mcpManager.getToolsForAI(),
    ])
    const { endpointContext: endpointCtx, targetMemoryContext: targetMemoryCtx, relevantMemoryContext: relevantMemoryCtx } = memoryCtx

    // Filter MCP tools to only selected servers (if specified)
    const mcpTools = (selectedMcpServers && selectedMcpServers.length > 0)
      ? Object.fromEntries(
          Object.entries(allMcpTools).filter(([toolName]) => {
            const serverName = toolName.split('__')[0]
            return selectedMcpServers.includes(serverName)
          }),
        )
      : allMcpTools

    // Restore SkillRegistry from skills tracked in the store. Entries may be
    // bare skill names or composite "name#subPath" keys for sub-documents.
    const skillRegistry = new SkillRegistry()
    for (const key of store.getLoadedSkillNames()) {
      const hashIdx = key.indexOf('#')
      const name = hashIdx >= 0 ? key.slice(0, hashIdx) : key
      const subPath = hashIdx >= 0 ? key.slice(hashIdx + 1) : ''
      const result = loadSkill(name, subPath || undefined)
      if (result) skillRegistry.load(result.name, result.content, result.subPath)
    }
    // `selectedSkills` narrows the agent's *visible* skill catalog for this turn.
    // It does NOT pre-load skill bodies — the agent still goes through `load_skill`
    // when it needs the methodology. Already-loaded skills (via the registry above)
    // remain available regardless of the visibility filter.
    const visibleSkillNames = (selectedSkills && selectedSkills.length > 0)
      ? [...selectedSkills]
      : undefined

    // PlanNotes: lightweight text holder for the model's own plan.
    const planNotes = new PlanNotes()

    // Forward declaration so PromptBuilder can read the live toolMap each build()
    // (coreTools is populated below). We pass a getter, so the lookup happens
    // lazily and always reflects the current registered toolset.
    let coreToolsRef: Record<string, Tool> = {}

    const promptBuilder = new PromptBuilder({
      endpointContext: endpointCtx,
      targetMemoryContext: targetMemoryCtx,
      relevantMemoryContext: relevantMemoryCtx,
      observationStore,
      planNotes,
      selectedEndpointIds,
      skillRegistry,
      visibleSkillNames,
      mcpInstructionContext: mcpManager.buildInstructionsContext(),
      toolMap: () => coreToolsRef,
      getObserverSection: () => observer.buildBoardSection(),
      getPostCompressionProgress: () => {
        if (store.wasRecentlyCompressed()) {
          return observationStore.summarizeProgress()
        }
        return ''
      },
    })
    const getSystem = () => promptBuilder.build()

    const telemetry = new TelemetryCollector({ sessionId, threadId })
    // One Langfuse trace per turn of this thread. sessionId groups every
    // thread's traces in the Session view; threadId (→ userId) keeps the main
    // run distinct from each spawned sub-agent's lane.
    const traceContext: TraceContext = {
      traceId: await createTraceId(`${threadId}:${Date.now()}`),
      sessionId,
      threadId,
      kind: 'main',
    }
    const permissionChecker = new PermissionChecker()
    // Allow all discovered MCP tools by name
    permissionChecker.addMcpAllowlist(Object.keys(mcpTools))

    // Add user message to the store. On an approval resume the incoming message
    // is a control signal (the approve/deny payload), not new conversation, so
    // we don't append it — the loop's resumeApprovals replay drives the turn.
    if (lastUserMsg && !isApprovalResume) {
      const nonce = Math.random().toString(36).slice(2, 6).toUpperCase()
      store.appendUser(lastUserMsg, nonce, commandLabel)

      // Auto-name the thread from the first user message when title is null.
      // For slash commands, prefer the friendly label over the verbose prompt.
      try {
        const db = getDb()
        const [t] = await db.select().from(threads).where(eq(threads.id, threadId))
        if (t && !t.title) {
          const titleSource = slash ? slash.command.label : lastUserMsg
          const title = titleSource.replace(/\s+/g, ' ').trim().slice(0, 40)
          if (title) {
            await db.update(threads).set({ title }).where(eq(threads.id, threadId))
          }
        }
      } catch (err) {
        logger.warn('[ThreadAutoName] failed (non-blocking):', err)
      }
    }

    // Side channel for sub-agent steps to flow into the SSE stream
    // even when the main generator is blocked by sync tool execution.
    const sideChannel = new StepChannel()

    // Persistence coordinator — handles debounced persistence, action logs,
    // telemetry emission, sub-agent step routing, and finish-time cleanup.
    const persistenceCoordinator = new PersistenceCoordinator({
      sessionId,
      threadId,
      store,
      skillRegistry,
      telemetry,
      sideChannel,
      release,
      persistFn: () => persistTimeline(threadId, store),
      observationPersistFn: () => observationStore.persist(),
      setPendingApprovals: pending => { threadForApproval.pendingApprovals = pending },
      memoryLayer,
    })

    // Build tool map via the extracted tool builder.
    const coreTools = buildToolMap({
      sessionId, threadId, observationStore, skillRegistry, store,
      visibleSkillNames, planNotes, mcpTools,
      mcpInstructionContext: mcpManager.buildInstructionsContext(),
      model, modelId, permissionChecker, endpointCtx,
      getSystem, onStep: persistenceCoordinator.handleStep, signal, telemetry,
    })

    // Bind the live tool map for the PromptBuilder dynamic tool catalog.
    coreToolsRef = coreTools

    const steps = runAgentLoop({
      model,
      getSystem,
      store,
      tools: coreTools,
      observationStore,
      planNotes,
      getActiveTools: () => skillRegistry.getActiveTools(),
      maxIterations: 1000,
      signal,
      permissionChecker,
      parentThreadId: threadId,
      sessionId,
      selectedEndpointIds,
      observer,
      largeContext: isLargeContextModel(modelId),
      capability: getModelCapability(modelId),
      toolProtocol: getToolProtocol(modelId),
      providerOptions: getProviderOptions(modelId),
      resumeApprovals: isApprovalResume ? resumeApprovals : undefined,
      onStep: persistenceCoordinator.handleStep,
      telemetry,
      traceContext,
      getContextBreakdown: () => promptBuilder.tokenEstimate(),
    })

    // On approval resume, prepend tool_call steps for the approved tools so the
    // frontend stream has matching tool-input-available parts before tool results arrive.
    let outputSteps: AsyncGenerator<AgentStep> = steps
    if (isApprovalResume && pending.length > 0) {
      const approvedPending = pending.filter(p =>
        approvals!.some(a => a.toolCallId === p.toolCallId && a.approved),
      )
      outputSteps = (async function* () {
        for (const p of approvedPending) {
          yield { type: 'tool_call', iteration: 0, toolCallId: p.toolCallId, toolName: p.toolName, args: p.args } as AgentStep
        }
        yield* steps
      })()
    }

    // Flush Langfuse spans once this turn's stream is fully drained (success,
    // error, or early-return). The 5s periodic flush would eventually catch
    // them, but flushing at turn-end makes a just-finished trace appear in the
    // dashboard immediately.
    outputSteps = (async function* (inner: AsyncGenerator<AgentStep>) {
      try {
        yield* inner
      } finally {
        void flushLangfuse()
      }
    })(outputSteps)

    return agentLoopToDataStreamResponse(outputSteps, sideChannel)
  } catch (err) {
    release()
    throw err
  }
}

// ─── Accessors ────────────────────────────────────────────────────────────────

export function getTimeline(threadId: string): MessageStore | undefined {
  return threadStore.get(threadId)?.store
}

export function clearTimeline(threadId: string): void {
  const state = threadStore.get(threadId)
  if (state) {
    state.abortController.abort()
    threadStore.delete(threadId)
  }
  subagentRegistry.abortAllForThread(threadId)
  try {
    const db = getDb()
    db.delete(threadTimelines).where(eq(threadTimelines.threadId, threadId)).run()
  } catch (err) {
    logger.error('[Timeline] Failed to clear from DB:', err)
  }
}
