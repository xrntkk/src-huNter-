import { streamText, stepCountIs, hasToolCall, type Tool, type LanguageModel, type ModelMessage, type ToolSet, type PrepareStepFunction } from 'ai'
// StepChannel + agentLoopToDataStreamResponse now live in stream-formatter.ts;
// re-exported here for backward compatibility with existing import sites.
export { StepChannel, agentLoopToDataStreamResponse } from './stream-formatter.js'
import { MessageStore } from './message-store.js'
import { PermissionChecker } from './permissions.js'
import { getFastModel } from './model-router.js'
import type { ModelCapability } from './model-capabilities.js'
import { resolveThresholds } from './model-capabilities.js'
import { buildTelemetryMetadata, type TraceContext } from './langfuse-trace.js'
import { buildReattachMessage } from './post-compact-reattach.js'
import { microCompactInPlace } from './micro-compact.js'
import { subagentRegistry } from './subagent-registry.js'
import { isConcurrentSafe, isBarrierTool } from './tool-metadata.js'
import type { ObservationStore } from './observation-store.js'
import type { PlanNotes } from './plan-notes.js'
import type { Observer } from './observer.js'
import { diagnoseError, formatDiagnosedError } from './error-diagnostics.js'
import { validateModelMessages, summarizeIssues, dumpInvalidPrompt } from './message-validator.js'
import { isReconnectable, computeBackoffMs, sleepWithAbort, RECONNECT_MAX_RETRIES } from './retry-policy.js'
import { StagnationDetector } from './stagnation-detector.js'
import { SessionMemoryExtractor } from './session-memory.js'
import { MemoryCurator } from './memory-curator.js'
import type { TelemetryCollector } from './telemetry.js'
import { logger, errObj, LOG_FILE_PATH } from '../logger/index.js'

const log = logger.child({ component: 'AgentLoop' })

export type AgentStep =
  | { type: 'text_delta'; iteration: number; delta: string }
  | { type: 'reasoning'; iteration: number; content: string }
  | { type: 'thinking'; iteration: number; content: string }
  | { type: 'tool_call'; iteration: number; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: 'tool_result'; iteration: number; toolCallId: string; toolName: string; result: unknown; durationMs?: number }
  | { type: 'tool_error'; iteration: number; toolCallId: string; toolName: string; error: string; durationMs?: number }
  | { type: 'finish'; iteration: number; reason: string }
  | { type: 'system_nudge'; iteration: number; message: string }
  | {
      type: 'tool_approval'
      iteration: number
      /** Tool calls awaiting user approval before they can execute. */
      pending: Array<{
        approvalId: string
        toolCallId: string
        toolName: string
        args: Record<string, unknown>
        reason: string
      }>
    }
  | { type: 'plan_notes'; iteration: number; notes: string }
  | {
      type: 'usage'
      iteration: number
      usage: {
        inputTokens?: number
        outputTokens?: number
        totalTokens?: number
        cacheReadTokens?: number
        cacheWriteTokens?: number
        reasoningTokens?: number
      }
    }
  | { type: 'subagent_step'; iteration: number; taskId: string; description: string; childStep: AgentStep }

interface AgentLoopOptions {
  model: LanguageModel
  getSystem: () => string
  store: MessageStore
  tools: Record<string, Tool>
  /** Passive observation store for facts (endpoints, vulns, etc.). */
  observationStore?: ObservationStore
  /** Model's freeform plan notes — injected into prompt + reattach. */
  planNotes?: PlanNotes
  maxIterations?: number
  signal?: AbortSignal
  onStep?: (step: AgentStep) => void
  permissionChecker?: PermissionChecker
  /**
   * Optional session id — used to spill oversized tool results to the session
   * workspace (workspace/{sessionId}/tool-results) instead of bloating the
   * timeline. Child agents may omit it (keeps the inline behaviour).
   */
  sessionId?: string
  /**
   * Optional thread id — used to flush async sub-agent completion
   * notifications into the parent timeline at each iteration. Child
   * agents (spawn_agent) don't pass this so they never get notifications.
   */
  parentThreadId?: string
  /**
   * Endpoints the user explicitly selected in the UI — used by the objective
   * completion signal to check whether the requested targets are all verified
   * before honouring a "task complete" stop.
   */
  selectedEndpointIds?: string[]
  /**
   * Optional proactive curation layer. When provided, the loop calls
   * `observer.maybeCurate()` each iteration; the curated board is surfaced to
   * the model via the prompt builder. Purely additive — omitting it changes
   * nothing.
   */
  observer?: Observer
  /**
   * Active skill tool contract resolver. When it returns a non-empty list, the
   * loop narrows the LLM's visible tool set that step to those tools plus a
   * fixed escape-hatch set (load_skill/ask_user/add_finding/list_endpoints).
   * Returns undefined ⇒ full tool set. Backed by SkillRegistry.getActiveTools().
   */
  getActiveTools?: () => string[] | undefined
  /**
   * Whether the active main model supports a ~1M context window. Raises the
   * timeline compression thresholds so long sessions aren't compacted early.
   */
  largeContext?: boolean
  /**
   * Resolved model capability (context window + output budget + cache-edit
   * support). When present this drives compression water-line calculation
   * via MessageStore.bindCapability(). Optional — older callers fall back
   * to the legacy `largeContext` boolean.
   */
  capability?: ModelCapability
  /**
   * How the model emits tool calls. 'native' (default) → structured
   * function-calling; the normalizer's text-recovery fallback stays off.
   * 'text' → the model only emits tool calls as prose, so the normalizer
   * recovers them from text. Declarative — replaces hard-coded model checks.
   */
  toolProtocol?: 'native' | 'text'
  /**
   * Optional provider-specific options forwarded to streamText as
   * `providerOptions` (e.g. Anthropic extended thinking, OpenAI reasoning
   * effort). Resolved from models.json by the caller. Omitted ⇒ none sent.
   */
  providerOptions?: Record<string, Record<string, unknown>>
  /**
   * Resolved tool-approval decisions supplied on resume after the loop paused
   * with reason 'tool_approval'. Each entry pairs the SDK's approvalId with the
   * user's choice. On resume these are injected into the stored messages as
   * native `tool-approval-response` parts before the next streamText run, so the
   * SDK executes the approved calls and skips the denied ones. Absent/empty ⇒
   * normal start.
   */
  resumeApprovals?: Array<{
    approvalId: string
    approved: boolean
    note?: string
  }>
  /**
   * Optional token budget. When set, the loop tracks cumulative usage and
   * injects nudges at 80% / force-stops at 95%.
   */
  tokenBudget?: {
    maxOutputTokens?: number
    maxTotalTokens?: number
  }
  /**
   * Optional TelemetryCollector instance. When provided, the loop injects SDK
   * event callbacks to capture per-tool-call durationMs from the AI SDK.
   */
  telemetry?: TelemetryCollector
  /**
   * Langfuse trace context for this run. When present, every streamText call
   * is tagged so all iterations group under one trace, and the run is bound to
   * the session (sessionId) and sub-session lane (userId = threadId). Absent ⇒
   * legacy flat metadata (no grouping).
   */
  traceContext?: TraceContext
  /**
   * Returns per-section token estimates for the current system prompt (e.g.
   * `promptBuilder.tokenEstimate()`), used to render the prompt-section
   * breakdown in the context_snapshot. Optional.
   */
  getContextBreakdown?: () => Record<string, number>
}


// __RUNAGENTLOOP_PLACEHOLDER__

/**
 * Detect AI SDK's ToolCallNotFoundForApprovalError.
 *
 * Non-native Anthropic providers (ark-code-latest, etc.) may emit
 * tool-approval-request chunks whose toolCallId was never registered as
 * an actual tool-call. The SDK throws this error internally, but it is
 * a provider compatibility quirk — not a fatal stream error.
 */
function isToolCallNotFoundForApproval(error: unknown): boolean {
  if (error instanceof Error) {
    return (error as { name?: string }).name === 'AI_ToolCallNotFoundForApprovalError'
  }
  return false
}

/**
 * Detect and fix orphaned tool-calls in the message history.
 *
 * When a previous task terminates abnormally (crash, timeout, force-kill), the
 * store may contain an assistant message with tool-call parts whose
 * corresponding tool-result was never persisted. The AI SDK detects this
 * inconsistency and throws "Tool result is missing for tool call ..." before
 * streamText even starts, killing the agent loop.
 *
 * This function scans for orphaned tool-calls and inserts synthetic error
 * tool-result messages so the SDK accepts the prompt. The model will see a
 * clear error for each lost call and can recover gracefully.
 */
function repairOrphanedToolCalls(messages: ModelMessage[]): ModelMessage[] {
  // Collect all toolCallIds that have corresponding tool-result parts
  const resolvedIds = new Set<string>()
  for (const msg of messages) {
    if (msg.role !== 'tool') continue
    const parts = msg.content as Array<{ type: string; toolCallId?: unknown }>
    for (const part of parts) {
      if (part.type === 'tool-result' && typeof part.toolCallId === 'string') {
        resolvedIds.add(part.toolCallId)
      }
    }
  }

  // Scan assistant messages for orphaned tool-calls
  let hasOrphans = false
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    const parts = msg.content as Array<{ type: string; toolCallId?: unknown; toolName?: unknown }>
    for (const part of parts) {
      if (part.type === 'tool-call' && typeof part.toolCallId === 'string' && !resolvedIds.has(part.toolCallId)) {
        hasOrphans = true
        break
      }
    }
    if (hasOrphans) break
  }

  if (!hasOrphans) return messages

  // Build repaired array: for each assistant message with orphaned tool-calls,
  // insert synthetic tool-result messages right after it
  const repaired: ModelMessage[] = []
  for (const msg of messages) {
    repaired.push(msg)
    if (msg.role !== 'assistant') continue

    const parts = msg.content as Array<{ type: string; toolCallId?: unknown; toolName?: unknown }>
    const orphanedIds: string[] = []
    for (const part of parts) {
      if (part.type === 'tool-call' && typeof part.toolCallId === 'string' && !resolvedIds.has(part.toolCallId)) {
        orphanedIds.push(part.toolCallId)
      }
    }

    if (orphanedIds.length === 0) continue

    log.warn(
      { orphanCount: orphanedIds.length, callIds: orphanedIds.map(id => id.slice(0, 16)) },
      'Repairing orphaned tool-calls — inserting synthetic error results (previous task may have terminated abnormally)',
    )

    for (const callId of orphanedIds) {
      repaired.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: callId,
            toolName: 'unknown',
            result: '[系统恢复] 此工具调用的结果已丢失（可能因上次任务异常终止），已自动补充占位结果以恢复对话。请根据上下文推断是否需要重新执行。',
          } as { type: string; toolCallId: string; toolName: string; result: unknown },
        ],
      } as unknown as ModelMessage)
    }
  }

  return repaired
}

/**
 * Wrap each tool with a native `needsApproval` derived from the
 * PermissionChecker. The SDK auto-executes tools during a multi-step run; the
 * permission rules become approval gates:
 *   - allow → needsApproval false (runs immediately)
 *   - ask   → needsApproval true  (SDK emits tool-approval-request, run pauses)
 *   - deny  → needsApproval true, but the wrapped execute refuses with a clear
 *             error if it ever runs (the server auto-denies these on resume).
 *
 * Tools keep their original `execute`; we only add `needsApproval`. Tools
 * without an execute (none, currently) are passed through unchanged.
 */
function applyApprovalGates(
  tools: Record<string, Tool>,
  permissionChecker?: PermissionChecker,
): ToolSet {
  if (!permissionChecker) return tools as ToolSet
  const out: Record<string, Tool> = {}
  for (const [name, def] of Object.entries(tools)) {
    out[name] = {
      ...def,
      needsApproval: async (input: unknown) => {
        const decision = permissionChecker.check(name, (input ?? {}) as Record<string, unknown>)
        return decision.behavior !== 'allow'
      },
    } as Tool
  }
  return out as ToolSet
}

/**
 * Concurrent tool batching with barrier semantics.
 *
 * Plain concurrent tools (http_request, browser_*) run in parallel via
 * Promise.all. Barrier tools (sync spawn_agent) run in parallel with other
 * barriers in the same batch, but block any non-barrier tool until they all
 * finish — so the parent's other tool calls cannot race against running child
 * agents. Without this, the LLM emitting `spawn_agent + http_request` in one
 * step would fire both immediately; the parent should be conceptually paused
 * while the children run.
 *
 * Non-concurrent tools execute immediately (no batching).
 */
class ToolBatch {
  private pending: Array<{ name: string; resolve: (v: unknown) => void; reject: (e: unknown) => void; fn: () => Promise<unknown> }> = []
  private scheduled = false

  enqueue<T>(name: string, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push({ name, resolve: resolve as (v: unknown) => void, reject, fn })
      if (!this.scheduled) {
        this.scheduled = true
        // Flush on next microtask — collects all calls from the same SDK step
        queueMicrotask(() => this.flush())
      }
    })
  }

  private flush(): void {
    const batch = this.pending.splice(0)
    this.scheduled = false
    if (batch.length === 0) return
    if (batch.length === 1) {
      batch[0].fn().then(batch[0].resolve, batch[0].reject)
      return
    }

    const barriers = batch.filter(b => isBarrierTool(b.name))
    const others = batch.filter(b => !isBarrierTool(b.name))

    if (barriers.length === 0) {
      log.info(`[ToolBatch] Executing ${batch.length} concurrent-safe tool calls in parallel`)
      void Promise.all(batch.map(b => b.fn().then(b.resolve, b.reject))).catch(() => {})
      return
    }

    if (others.length === 0) {
      log.info(`[ToolBatch] Executing ${barriers.length} barrier tool calls in parallel`)
      void Promise.all(barriers.map(b => b.fn().then(b.resolve, b.reject))).catch(() => {})
      return
    }

    // Mixed batch: run barriers in parallel first, then non-barriers.
    // This blocks the parent's other tool calls while children run.
    log.info(
      `[ToolBatch] Mixed batch: ${barriers.length} barrier(s) [${barriers.map(b => b.name).join(',')}] block ` +
      `${others.length} non-barrier tool(s) [${others.map(b => b.name).join(',')}]`,
    )
    void (async () => {
      try {
        await Promise.all(barriers.map(b => b.fn().then(b.resolve, b.reject)))
      } catch { /* per-call rejections already routed via .then */ }
      try {
        await Promise.all(others.map(b => b.fn().then(b.resolve, b.reject)))
      } catch { /* per-call rejections already routed via .then */ }
    })()
  }
}

function batchConcurrentTools(tools: ToolSet): ToolSet {
  const batch = new ToolBatch()
  const out: Record<string, Tool> = {}
  for (const [name, def] of Object.entries(tools as Record<string, Tool>)) {
    if (isConcurrentSafe(name) && def.execute) {
      const originalExecute = def.execute
      out[name] = {
        ...def,
        execute: (input: unknown, opts: unknown) =>
          batch.enqueue(name, () => (originalExecute as (i: unknown, o: unknown) => Promise<unknown>)(input, opts)),
      } as Tool
    } else {
      out[name] = def
    }
  }
  return out as ToolSet
}

/** Outcome of a single streamText run, classified for the outer driver. */
type StreamOutcome =
  | { kind: 'stop'; finishReason: string; responseMessages: ModelMessage[]; executedTools: string[]; askedUser: boolean }
  | { kind: 'continue'; responseMessages: ModelMessage[]; executedTools: string[]; askedUser: boolean }
  | { kind: 'approval'; pending: Array<{ approvalId: string; toolCallId: string; toolName: string; args: Record<string, unknown>; reason: string }>; responseMessages: ModelMessage[]; executedTools: string[]; askedUser: boolean }
  | { kind: 'aborted'; responseMessages: ModelMessage[]; executedTools: string[]; askedUser: boolean }
  | { kind: 'error'; error: string; isPtl: boolean; reconnectable: boolean; responseMessages: ModelMessage[]; executedTools: string[]; askedUser: boolean }

/**
 * Run one multi-step streamText pass. The SDK auto-executes tools (with native
 * needsApproval gating) and produces assistant + tool messages. We mirror the
 * stream parts as AgentSteps for the UI and classify the terminal state.
 */
async function* runSingleStream(args: {
  iteration: number
  messages: ModelMessage[]
  systemText: string
  model: LanguageModel
  tools: ToolSet
  maxTokens?: number
  providerOptions?: Record<string, Record<string, unknown>>
  signal?: AbortSignal
  onStep?: (step: AgentStep) => void
  telemetry?: TelemetryCollector
  sessionId?: string
  prepareStep?: PrepareStepFunction<ToolSet>
  /** Langfuse grouping context — when present, every span lands under one trace. */
  traceContext?: TraceContext
  /** Live context occupation (0–1) for this iteration — surfaced as observation metadata. */
  contextPct?: number
  contextTokens?: number
  effectiveTokens?: number
}): AsyncGenerator<AgentStep, StreamOutcome> {
  const { iteration: i, messages: rawMessages, systemText, model, tools, maxTokens, providerOptions, signal, onStep, telemetry, sessionId, prepareStep, traceContext, contextPct, contextTokens, effectiveTokens } = args
  // Repair orphaned tool-calls before handing messages to the SDK.
  // When a previous task terminates abnormally, the message store may contain
  // assistant tool-call parts without corresponding tool-result parts. The SDK
  // rejects such prompts with "Tool result is missing for tool call ...".
  // Synthetic error results let the model recover gracefully.
  const messages = repairOrphanedToolCalls(rawMessages)
  let executedTools: string[] = []
  let pending: Array<{ approvalId: string; toolCallId: string; toolName: string; args: Record<string, unknown>; reason: string }> = []
  let askedUser = false
  let streamedReasoning = ''
  // Live accumulation of assistant text as it streams. Used to reconstruct a
  // partial assistant message when the stream errors mid-flight (result.response
  // rejects), so already-visible output survives reconnect / refresh.
  let streamedText = ''
  let toolDurations = new Map<string, number>()

  // 进度标记：流一旦 yield 过任何用户可见内容（文本/推理/tool-call/tool-result），
  // 后续断流就不再透明重连——避免 UI 出现重复的文本/工具记录。
  let hasProgress = false

  let result!: ReturnType<typeof streamText>
  let streamError: unknown
  let streamAborted = false

  // 外层重连循环：仅在 streamText 创建/握手阶段失败、或流尚未产出任何进度
  // 时才重试。命中进度后断流走原 'error' 路径上报。
  for (let attempt = 1; attempt <= RECONNECT_MAX_RETRIES + 1; attempt++) {
    if (signal?.aborted) {
      return { kind: 'aborted', responseMessages: [], executedTools, askedUser }
    }

    // 重置每次 streamText 的局部状态（首次运行也会执行，与初始化等价）
    executedTools = []
    pending = []
    askedUser = false
    streamedReasoning = ''
    streamedText = ''
    toolDurations = new Map()
    streamError = undefined
    streamAborted = false
    hasProgress = false

    try {
      result = streamText({
        model,
        system: systemText,
        messages,
        tools,
        ...(maxTokens ? { maxTokens } : {}),
        stopWhen: [stepCountIs(24), hasToolCall('ask_user')],
        // 内层 SDK 重试关闭——退避完全交给本函数的外层循环，避免双重退避叠加。
        maxRetries: 0,
        abortSignal: signal,
        ...(prepareStep ? { prepareStep } : {}),
        experimental_telemetry: {
          isEnabled: true,
          functionId: 'src-agent.runSingleStream',
          // Capture the full prompt (system + messages) and the model's output
          // so a Langfuse trace shows exactly what was sent — these default on
          // in the SDK, but we pin them so a future SDK default-flip can't
          // silently drop prompt visibility.
          recordInputs: true,
          recordOutputs: true,
          metadata: traceContext
            ? buildTelemetryMetadata(traceContext, { iteration: i, contextPct, contextTokens, effectiveTokens })
            : {
                sessionId: sessionId ?? 'unknown',
                iteration: i,
              },
        },
        onError: ({ error }) => {
          const diag = diagnoseError(error)
          log.warn(formatDiagnosedError(diag, { iteration: i }))
        },
        experimental_onToolCallFinish: ({ toolCall, durationMs }) => {
          toolDurations.set(toolCall.toolCallId, durationMs)
        },
        // Per-step usage: streamText runs up to 24 internal model calls;
        // result.usage is the aggregate. Emit one telemetry row per actual
        // model invocation so the dashboard counts model calls correctly.
        onStepFinish: ({ usage }) => {
          if (!usage) return
          const u = usage as { inputTokens?: number; outputTokens?: number; totalTokens?: number; outputTokenDetails?: { reasoningTokens?: number }; inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number } }
          const modelId = (model as { modelId?: string }).modelId
          telemetry?.emit({
            type: 'model_usage',
            sessionId,
            iteration: i,
            data: {
              modelId,
              inputTokens: u.inputTokens, outputTokens: u.outputTokens, totalTokens: u.totalTokens,
              reasoningTokens: u.outputTokenDetails?.reasoningTokens,
              cacheReadTokens: u.inputTokenDetails?.cacheReadTokens,
              cacheWriteTokens: u.inputTokenDetails?.cacheWriteTokens,
            },
          })
        },
        ...(providerOptions ? { providerOptions: providerOptions as Parameters<typeof streamText>[0]['providerOptions'] } : {}),
      })
    } catch (err) {
      // streamText 在握手前同步抛出（如 LoadAPIKeyError，或 prompt schema 校验失败的
      // InvalidPromptError）。后者本地预检若没抓到（SDK 比我们更严），在此兜底落盘，
      // 把完整 prompt + SDK 原始报错写到 workspace，避免只剩一句不可定位的报错。
      const diag0 = diagnoseError(err)
      if (diag0.category === 'invalid_request') {
        const recheck = validateModelMessages(messages)
        // Capture the raw SDK error cause for post-mortem — InvalidPromptError.cause
        // contains the underlying Zod validation issue with field-level pointers.
        let sdkCause = ''
        try {
          const cause = (err as { cause?: unknown }).cause
          if (cause) sdkCause = typeof cause === 'string' ? cause : JSON.stringify(cause, null, 2)
        } catch { /* best-effort */ }
        const dumpPath = dumpInvalidPrompt({
          sessionId, iteration: i, messages,
          issues: recheck.ok ? undefined : recheck.issues,
          systemText, sdkError: diag0.message + (sdkCause ? `\n\nCaused by: ${sdkCause}` : ''),
          modelId: (model as { modelId?: string }).modelId,
        })
        log.error(
          {
            iteration: i,
            category: diag0.category,
            sdkMessage: diag0.message,
            sdkCause: sdkCause.slice(0, 500),
            dumpPath: dumpPath ? `workspace/${sessionId ?? 'unknown'}/${dumpPath}` : null,
            localIssues: recheck.ok ? null : summarizeIssues(recheck.issues),
          },
          'streamText rejected prompt (model messages schema mismatch)',
        )
      }
      // 按错误分类决定是否退避重连。
      if (!isReconnectable(err) || attempt > RECONNECT_MAX_RETRIES) {
        const diag = diagnoseError(err)
        return { kind: 'error', error: diag.message, isPtl: diag.category === 'context_overflow', reconnectable: isReconnectable(err), responseMessages: [], executedTools, askedUser }
      }
      const delayMs = computeBackoffMs(attempt, err)
      const diag = diagnoseError(err)
      const nudge: AgentStep = { type: 'system_nudge', iteration: i, message: `[模型连接] ${diag.message} — ${Math.round(delayMs / 1000)}s 后重试 (${attempt}/${RECONNECT_MAX_RETRIES})` }
      yield nudge; onStep?.(nudge)
      log.warn({ iteration: i, attempt, maxRetries: RECONNECT_MAX_RETRIES, delayMs, category: diag.category, message: diag.message }, 'Reconnect attempt')
      try { await sleepWithAbort(delayMs, signal) } catch { return { kind: 'aborted', responseMessages: [], executedTools, askedUser } }
      continue
    }

    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-delta': {
          const step: AgentStep = { type: 'text_delta', iteration: i, delta: part.text }
          hasProgress = true
          streamedText += part.text
          yield step; onStep?.(step)
          break
        }
        case 'reasoning-delta': {
          streamedReasoning += part.text
          hasProgress = true
          const step: AgentStep = { type: 'reasoning', iteration: i, content: part.text }
          yield step; onStep?.(step)
          break
        }
        case 'tool-call': {
          const step: AgentStep = { type: 'tool_call', iteration: i, toolCallId: part.toolCallId, toolName: part.toolName, args: (part.input ?? {}) as Record<string, unknown> }
          hasProgress = true
          yield step; onStep?.(step)
          break
        }
        case 'tool-result': {
          executedTools.push(part.toolName)
          if (part.toolName === 'ask_user') askedUser = true
          hasProgress = true
          const step: AgentStep = { type: 'tool_result', iteration: i, toolCallId: part.toolCallId, toolName: part.toolName, result: part.output, durationMs: toolDurations.get(part.toolCallId) }
          yield step; onStep?.(step)
          break
        }
        case 'tool-error': {
          const errText = part.error instanceof Error ? part.error.message : String(part.error)
          hasProgress = true
          const step: AgentStep = { type: 'tool_error', iteration: i, toolCallId: part.toolCallId, toolName: part.toolName, error: errText, durationMs: toolDurations.get(part.toolCallId) }
          yield step; onStep?.(step)
          break
        }
        case 'tool-approval-request': {
          const tc = part.toolCall
          pending.push({
            approvalId: part.approvalId,
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            args: (tc.input ?? {}) as Record<string, unknown>,
            reason: `需要确认: ${tc.toolName}`,
          })
          break
        }
        case 'error':
          // ark-code-latest and similar third-party Anthropic-compatible
          // providers may emit tool-approval-request chunks referencing
          // toolCallIds that were never registered as tool-calls. The SDK
          // cannot pair them, so it raises ToolCallNotFoundForApprovalError.
          // Treat this as a non-fatal noise event rather than a stream error.
          if (isToolCallNotFoundForApproval(part.error)) {
            log.warn(`[AgentLoop][Iter ${i}] skipping phantom approval request (${(part.error as { toolCallId?: string }).toolCallId ?? '?'}) — non-native provider quirk`)
            break
          }
          streamError = part.error
          break
        case 'abort':
          streamAborted = true
          break
      }
      if (streamError !== undefined || streamAborted) break
    }

    // 流被错误终止 + 尚未产出任何进度 + 错误可重连 + 还有重试预算 → 退避后重连
    if (streamError !== undefined && !hasProgress && !streamAborted && !signal?.aborted) {
      if (isReconnectable(streamError) && attempt <= RECONNECT_MAX_RETRIES) {
        const delayMs = computeBackoffMs(attempt, streamError)
        const diag = diagnoseError(streamError)
        const nudge: AgentStep = { type: 'system_nudge', iteration: i, message: `[模型连接] ${diag.message} — ${Math.round(delayMs / 1000)}s 后重试 (${attempt}/${RECONNECT_MAX_RETRIES})` }
        yield nudge; onStep?.(nudge)
        log.warn(`[AgentLoop][Iter ${i}] reconnect attempt ${attempt}/${RECONNECT_MAX_RETRIES} after ${delayMs}ms — ${diag.category}: ${diag.message}`)
        try { await sleepWithAbort(delayMs, signal) } catch { return { kind: 'aborted', responseMessages: [], executedTools, askedUser } }
        continue
      }
    }
    // 走到这里：流正常结束 / 已有进度 / 不可重连 / 重试用尽 / 被 abort
    break
  }

  // Collect the messages the SDK accumulated (assistant text/tool-calls + tool
  // results), regardless of how the stream ended, so partial progress persists.
  // If result.response rejected (mid-stream ECONNRESET), fall back to the text
  // we streamed live so the already-visible assistant output isn't lost.
  const responseMessages = await collectResponseMessages(result, streamedText)

  if (streamAborted || signal?.aborted) {
    return { kind: 'aborted', responseMessages, executedTools, askedUser }
  }
  if (streamError !== undefined) {
    const diag = diagnoseError(streamError)
    return { kind: 'error', error: diag.message, isPtl: diag.category === 'context_overflow', reconnectable: isReconnectable(streamError), responseMessages, executedTools, askedUser }
  }

  // Emit reasoning as a fallback for models that embed it in text rather than
  // a structured reasoning stream (only if nothing was streamed live).
  if (!streamedReasoning) {
    const reasoning = await Promise.resolve(result.reasoningText).catch(() => undefined)
    if (reasoning) {
      const step: AgentStep = { type: 'reasoning', iteration: i, content: reasoning }
      yield step; onStep?.(step)
    }
  }

  // Surface token usage.
  const usage = await Promise.resolve(result.usage).catch(() => undefined)
  if (usage) {
    const u = usage as { inputTokens?: number; outputTokens?: number; totalTokens?: number; outputTokenDetails?: { reasoningTokens?: number }; inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number } }
    const usageData = {
      inputTokens: u.inputTokens, outputTokens: u.outputTokens, totalTokens: u.totalTokens,
      reasoningTokens: u.outputTokenDetails?.reasoningTokens,
      cacheReadTokens: u.inputTokenDetails?.cacheReadTokens,
      cacheWriteTokens: u.inputTokenDetails?.cacheWriteTokens,
    }
    const step: AgentStep = { type: 'usage', iteration: i, usage: usageData }
    yield step; onStep?.(step)
  }

  if (pending.length > 0) {
    return { kind: 'approval', pending, responseMessages, executedTools, askedUser }
  }

  const finishReason = await Promise.resolve(result.finishReason).catch(() => 'unknown')
  // 'tool-calls' here means the step budget was hit mid-work → keep going.
  if (finishReason === 'tool-calls') {
    return { kind: 'continue', responseMessages, executedTools, askedUser }
  }
  return { kind: 'stop', finishReason: String(finishReason), responseMessages, executedTools, askedUser }
}

/**
 * Pull the run's response messages, tolerating a rejected promise.
 *
 * On a mid-stream transport failure `result.response` rejects and the SDK gives
 * us nothing — but the user already saw text stream in. `fallbackText` is that
 * live-accumulated assistant text; we wrap it in a minimal assistant message so
 * the partial turn is persisted (and survives a refresh) instead of vanishing.
 */
async function collectResponseMessages(
  result: ReturnType<typeof streamText>,
  fallbackText = '',
): Promise<ModelMessage[]> {
  try {
    const response = await result.response
    const msgs = (response.messages ?? []) as ModelMessage[]
    if (msgs.length > 0) return msgs
    // Stream resolved but produced no structured messages — use the fallback.
    return fallbackText.trim()
      ? [{ role: 'assistant', content: fallbackText } as ModelMessage]
      : []
  } catch {
    return fallbackText.trim()
      ? [{ role: 'assistant', content: fallbackText } as ModelMessage]
      : []
  }
}

export async function* runAgentLoop(options: AgentLoopOptions): AsyncGenerator<AgentStep> {
  const {
    model, getSystem, store, tools, observationStore, planNotes,
    maxIterations = 1000, signal, onStep: rawOnStep, permissionChecker, parentThreadId,
    sessionId, observer, largeContext, capability, providerOptions, resumeApprovals,
    tokenBudget, telemetry, getActiveTools, traceContext, getContextBreakdown,
  } = options

  // Bind the resolved model capability so compression / water-line calculations
  // use model-specific thresholds. Safe to rebind: subsequent calls overwrite.
  if (capability) store.bindCapability(capability)

  // Wrap onStep so we can capture provider-reported `usage` into the store —
  // this is what makes estimateTokens() return real numbers instead of the
  // char-based heuristic, which under-counts tool-call payloads. The original
  // onStep is preserved so callers (SSE pipeline, telemetry) still receive it.
  // Plan two: also stamps a `tool_started` interruption marker for every
  // tool-call seen on the stream — these markers let `analyzeInterruption()`
  // distinguish "tool ran to completion" from "tool started but never returned"
  // when the process restarts.
  const onStep = (step: AgentStep) => {
    if (step.type === 'usage') {
      store.recordObservedUsage({
        ...(step.usage.inputTokens != null ? { inputTokens: step.usage.inputTokens } : {}),
        ...(step.usage.cacheReadTokens != null ? { cacheReadTokens: step.usage.cacheReadTokens } : {}),
      })
    } else if (step.type === 'tool_call') {
      const argsStr = (() => {
        try { return JSON.stringify(step.args ?? {}) } catch { return '' }
      })()
      store.appendInterruptionMarker({
        kind: 'tool_started',
        iteration: step.iteration,
        ts: Date.now(),
        toolName: step.toolName,
        toolCallId: step.toolCallId,
        argsPreview: argsStr.slice(0, 200),
      })
    }
    rawOnStep?.(step)
  }

  const gatedTools = batchConcurrentTools(applyApprovalGates(tools, permissionChecker))

  // Anti-stagnation: if the model calls the same tool 3 times in a row within
  // a single streamText run, temporarily exclude it to force exploration.
  // Skill contract: when an active skill declares allowed_tools, narrow the
  // visible set to that list plus a fixed escape-hatch set. Both layers compose.
  const toolNames = Object.keys(gatedTools)
  const CONTRACT_ESCAPE_HATCH = ['load_skill', 'ask_user', 'add_finding', 'list_endpoints']
  const prepareStep: PrepareStepFunction<ToolSet> = ({ steps }) => {
    const contract = getActiveTools?.()
    let pool = contract && contract.length > 0
      ? toolNames.filter(n => contract.includes(n) || CONTRACT_ESCAPE_HATCH.includes(n))
      : toolNames

    const recent = steps.slice(-3).flatMap(s =>
      (s.toolCalls ?? []).map(tc => tc.toolName)
    )
    if (recent.length >= 3 && new Set(recent).size === 1) {
      pool = pool.filter(n => n !== recent[0])
    }

    return pool.length < toolNames.length ? { activeTools: pool } : {}
  }

  // Compression gating: only re-check when context has grown meaningfully.
  let lastCompressTokens = 0
  const COMPRESS_INTERVAL = 5
  const COMPRESS_TOKEN_DELTA = 10_000

  // Stagnation detection: nudge when the loop is spinning without progress.
  const stagnation = new StagnationDetector()

  // Session memory: incremental extraction for compression fast-path.
  const sessionMemory = new SessionMemoryExtractor()

  // Memory curator — merges Observer + SessionMemoryExtractor LLM calls to
  // avoid redundant fast-model invocations. Runs BEFORE compress so a fresh
  // sessionMemory lets compress take the fast-path (no LLM call).
  const memoryCurator = observer ? new MemoryCurator(observer, sessionMemory) : null

  // Output token dynamic cap: start low, escalate on truncation.
  const ESCALATION_TIERS = [8192, 32768, 65536]
  let currentMaxTokensTier = 0
  let lengthRetries = 0
  const MAX_LENGTH_RETRIES = 2
  // Skip output token cap for thinking/reasoning models (they need large outputs)
  const isReasoningModel = Boolean(providerOptions?.anthropic && (providerOptions.anthropic as Record<string, unknown>).thinking)

  // Token budget tracking
  let budgetOutputTokens = 0
  let budgetTotalTokens = 0
  let budgetNudged = false

  // ── Resume from a tool-approval pause ──
  // Inject the user's decisions as native tool-approval-response parts into the
  // stored messages. The SDK reads these on the next run: approved calls
  // execute, denied calls are skipped (the model sees a denial tool-result).
  if (resumeApprovals && resumeApprovals.length > 0) {
    store.applyApprovalResponses(resumeApprovals)
  }

  // Plan two — interruption recovery. If the previous run died mid-tool /
  // mid-stream / mid-abort, the analyzer staged a state on the store at
  // deserialize time. Inject the matching recovery prose now (once), so the
  // model wakes up with concrete coaching instead of the legacy generic
  // "Execution interrupted" synthetic error.
  store.injectRecoveryPrompt()

  // PLACEHOLDER_LOOP
  // Counter for outer-loop reconnect on mid-stream transport errors. Resets to
  // 1 every successful iteration; bounded by RECONNECT_MAX_RETRIES so a
  // permanently broken provider eventually surfaces as a terminal error.
  let outerReconnectAttempt = 1

  // Emit a context-occupation snapshot for the telemetry ring. Called at the
  // top of each iteration AND right before terminal returns so the gauge
  // reflects the final post-response state (not the pre-last-model-call state)
  // the moment the run goes idle, instead of lagging until the next user turn.
  const emitContextSnapshot = (iteration: number): { contextTokens: number; effectiveTokens: number; contextPct: number | undefined } => {
    const contextTokens = store.estimateTokens()
    const thresholds = capability ? resolveThresholds(capability) : undefined
    const effectiveTokens = thresholds?.effectiveTokens ?? 0
    const contextPct = effectiveTokens > 0 ? contextTokens / effectiveTokens : undefined
    // Compute warning level so the frontend ring can color-code without
    // duplicating the threshold logic.
    let warningLevel: 'ok' | 'warn' | 'critical' | null = null
    if (thresholds) {
      warningLevel = contextTokens >= thresholds.ptlBlock
        ? 'critical'
        : contextTokens >= thresholds.llmSummary
          ? 'warn'
          : 'ok'
    }
    if (telemetry && effectiveTokens > 0) {
      const sections = getContextBreakdown?.()
      telemetry.emit({
        type: 'context_snapshot',
        sessionId,
        ...(traceContext?.threadId ? { threadId: traceContext.threadId } : {}),
        iteration,
        data: {
          contextTokens,
          effectiveTokens,
          contextWindowTokens: capability?.contextWindowTokens ?? null,
          pct: contextPct != null ? contextPct * 100 : undefined,
          llmSummaryWatermark: thresholds?.llmSummary ?? null,
          ptlBlockWatermark: thresholds?.ptlBlock ?? null,
          warningLevel,
          modelId: (model as { modelId?: string }).modelId ?? null,
          kind: traceContext?.kind ?? 'main',
          ...(sections ? { sections } : {}),
        },
      })
    }
    return { contextTokens, effectiveTokens, contextPct }
  }

  for (let i = 1; i <= maxIterations; i++) {
    if (signal?.aborted) {
      store.appendInterruptionMarker({ kind: 'turn_aborted', iteration: i, ts: Date.now(), cause: 'pre_model' })
      yield { type: 'finish', iteration: i, reason: 'aborted' }
      onStep?.({ type: 'finish', iteration: i, reason: 'aborted' })
      return
    }

    store.appendInterruptionMarker({ kind: 'turn_start', iteration: i, ts: Date.now() })

    stagnation.startRound()

    // Drain completed async sub-agent notifications into the conversation.
    if (parentThreadId) {
      const notes = subagentRegistry.flushPendingMessages(parentThreadId)
      for (const note of notes) store.appendSystem(note)
      if (notes.length > 0) log.info({ iteration: i, flushedCount: notes.length }, 'Flushed subagent notifications')
    }

    // Plan five — microCompact runs before compress(). On Anthropic-family
    // models with cache-edit support, it scrubs the bodies of old tool-results
    // (preserving the prefix the cache is keyed on) so we can defer or avoid
    // a heavyweight 70%-cut compress(). On other providers it short-circuits
    // out via capability.supportsCacheEdit, so this call is free.
    if (capability) {
      try {
        const microThreadId = parentThreadId ?? sessionId ?? 'thread'
        store.applyMicroCompact(microThreadId, msgs => microCompactInPlace(microThreadId, msgs, { capability }))
      } catch (e) {
        log.warn({ iteration: i, err: errObj(e) }, 'microCompact failed')
      }
    }

    // Memory curation (Observer + SessionMemoryExtractor merged) — runs BEFORE
    // compress so a fresh sessionMemory lets compress take the fast-path.
    // When both systems would fire on this iteration, MemoryCurator merges them
    // into a single LLM call. When compress subsequently runs the slow-path, it
    // refreshes sessionMemory internally (see message-store.ts).
    if (memoryCurator) {
      try {
        await memoryCurator.curate(i, store, getFastModel())
      } catch (e) {
        log.warn({ iteration: i, err: errObj(e) }, 'Memory curation failed')
      }
    } else {
      // No observer — run sessionMemory extraction standalone.
      if (sessionMemory.shouldExtract(i, store.estimateTokens())) {
        try { await sessionMemory.extract(store, getFastModel(), i) } catch (e) {
          log.warn({ iteration: i, err: errObj(e) }, 'Session memory extraction failed')
        }
      }
    }

    // Gated compression: only when context grew meaningfully.
    const currentTokens = store.estimateTokens()
    const tokenGrowth = currentTokens - lastCompressTokens
    if (i === 1 || i % COMPRESS_INTERVAL === 0 || tokenGrowth >= COMPRESS_TOKEN_DELTA) {
      try {
        await store.compress({
          fastModel: getFastModel(),
          largeContext,
          capability,
          sessionMemory,
          currentIteration: i,
          // Plan four: build the high-density reattach message lazily so a
          // compress() that no-ops (sub-threshold / circuit-broken) pays nothing.
          reattachBuilder: () => buildReattachMessage({
            threadId: parentThreadId ?? '',
            observationStore: observationStore ?? null,
            planNotes: planNotes?.get() ?? null,
            loadedSkillNames: store.getLoadedSkillNames(),
          }),
        })
      } catch (e) {
        log.warn({ iteration: i, err: errObj(e) }, 'Compression failed')
      }
      lastCompressTokens = store.estimateTokens()
    }

    const messages = store.toModelMessages()
    const systemText = getSystem()
    log.info({ iteration: i, systemChars: systemText.length, messageCount: messages.length, estimatedTokens: store.estimateTokens() }, 'Begin iteration')

    // ── Context occupation snapshot ──
    // store.estimateTokens() returns provider-reported input tokens once the
    // first round completes (else a char heuristic), which already accounts for
    // the system prompt + full message history. Dividing by the model's
    // effective window (context minus reserved output) gives the live "how full
    // is the context" gauge surfaced in the dashboard and on the Langfuse trace.
    const { contextTokens, effectiveTokens, contextPct } = emitContextSnapshot(i)

    // Pre-flight: validate the prompt locally so a malformed message is pinned
    // to an exact location and dumped to disk BEFORE streamText throws its
    // opaque "do not match ModelMessage[] schema" error. Non-fatal — we still
    // hand the prompt to the SDK (it may tolerate more than we check), but now
    // there's a breadcrumb if it doesn't.
    const validation = validateModelMessages(messages)
    if (!validation.ok) {
      const dumpPath = dumpInvalidPrompt({
        sessionId, iteration: i, messages, issues: validation.issues, systemText,
        modelId: (model as { modelId?: string }).modelId,
      })
      log.error(
        { iteration: i, issueCount: validation.issues.length, issues: summarizeIssues(validation.issues), dumpPath: dumpPath ? `workspace/${sessionId ?? 'unknown'}/${dumpPath}` : null },
        'Prompt validation failed (possible model message schema issues)',
      )
    }

    if (observationStore) {
      const s = observationStore.summary()
      log.info(`[ObservationStore] facts=${s.facts}`)
    }

    // Clear any stale draft from a prior iteration (e.g. if runSingleStream
    // threw before appendResponse could clear it). The draft is accumulated
    // by PersistenceCoordinator from text_delta steps and surfaced via
    // /messages so a page refresh mid-stream shows in-progress text.
    store.clearDraft()

    const outcome = yield* runSingleStream({
      iteration: i,
      messages,
      systemText,
      model,
      tools: gatedTools,
      maxTokens: isReasoningModel ? undefined : ESCALATION_TIERS[currentMaxTokensTier],
      providerOptions,
      signal,
      onStep,
      telemetry,
      sessionId,
      prepareStep,
      ...(traceContext ? { traceContext } : {}),
      ...(contextPct != null ? { contextPct } : {}),
      ...(contextTokens != null ? { contextTokens } : {}),
      ...(effectiveTokens > 0 ? { effectiveTokens } : {}),
    })

    // Persist whatever the model produced this run (assistant + tool messages).
    store.appendResponse(outcome.responseMessages, sessionId)

    // write_plan updates PlanNotes in-memory; emit a plan_notes step so the
    // stream formatter forwards it to the frontend as a data-plan-notes part.
    // Without this the plan panel never renders (plan_notes step was defined
    // but never yielded).
    if (outcome.executedTools.includes('write_plan') && planNotes) {
      const notes = planNotes.get()
      if (notes) {
        const planStep: AgentStep = { type: 'plan_notes', iteration: i, notes }
        yield planStep; onStep(planStep)
      }
    }

    // ── Output token truncation handling ──
    if (outcome.kind === 'stop' && outcome.finishReason === 'length' && !isReasoningModel) {
      if (lengthRetries < MAX_LENGTH_RETRIES && currentMaxTokensTier < ESCALATION_TIERS.length - 1) {
        currentMaxTokensTier++
        lengthRetries++
        log.info({ iteration: i, escalatedMaxTokens: ESCALATION_TIERS[currentMaxTokensTier] }, 'Output truncated (length), escalating maxTokens')
        continue
      }
      // Exhausted retries, let it stop naturally
      log.info({ iteration: i }, 'Output truncated but max retries reached, stopping')
    } else if (outcome.kind !== 'error') {
      // Reset on successful non-truncated completion
      if (currentMaxTokensTier > 0) {
        currentMaxTokensTier = 0
        lengthRetries = 0
      }
    }

    // ── Token budget enforcement ──
    if (tokenBudget) {
      // Extract usage from response messages (the usage step was already emitted)
      for (const msg of outcome.responseMessages) {
        if (msg.role === 'assistant' && typeof msg.content !== 'string') {
          // Rough estimate: count text parts as output tokens
          for (const part of msg.content) {
            if (part.type === 'text') budgetOutputTokens += Math.ceil(part.text.length * 0.55)
          }
        }
      }
      budgetTotalTokens = store.estimateTokens()

      const maxOut = tokenBudget.maxOutputTokens
      const maxTotal = tokenBudget.maxTotalTokens
      const outputRatio = maxOut ? budgetOutputTokens / maxOut : 0
      const totalRatio = maxTotal ? budgetTotalTokens / maxTotal : 0
      const ratio = Math.max(outputRatio, totalRatio)

      if (ratio >= 0.95) {
        const budgetStep: AgentStep = { type: 'finish', iteration: i, reason: 'budget_exhausted' }
        yield budgetStep; onStep?.(budgetStep)
        log.info({ iteration: i, outputRatio: Math.round(outputRatio * 100), totalRatio: Math.round(totalRatio * 100) }, 'Token budget exhausted')
        return
      }
      if (ratio >= 0.8 && !budgetNudged) {
        budgetNudged = true
        const msg = '[系统提示] Token 预算即将耗尽（已用 ' + Math.round(ratio * 100) + '%）。请总结当前发现并尽快收尾。'
        store.appendSystem(msg)
        const nudgeStep: AgentStep = { type: 'system_nudge', iteration: i, message: msg }
        yield nudgeStep; onStep?.(nudgeStep)
        log.info({ iteration: i, budgetPct: Math.round(ratio * 100) }, 'Token budget nudge')
      }
    }

    // ── Terminal stream outcomes ──
    if (outcome.kind === 'aborted') {
      store.appendInterruptionMarker({ kind: 'turn_aborted', iteration: i, ts: Date.now(), cause: 'streaming' })
      yield { type: 'finish', iteration: i, reason: 'aborted' }
      onStep?.({ type: 'finish', iteration: i, reason: 'aborted' })
      return
    }
    if (outcome.kind === 'error') {
      const errStr = String(outcome.error ?? 'unknown')
      const reconnectable = outcome.reconnectable
      store.appendInterruptionMarker({ kind: 'transport_error', iteration: i, ts: Date.now(), error: errStr.slice(0, 400), reconnectable })
      // PTL recovery: provider rejected the request as oversized.
      if (outcome.isPtl) {
        log.warn({ iteration: i }, 'PTL detected (context_overflow), attempting recoverFromPTL()')
        if (store.recoverFromPTL()) {
          const note: AgentStep = { type: 'system_nudge', iteration: i, message: '检测到上下文超限，已自动裁剪最旧的对话轮次并重试本轮。' }
          yield note; onStep?.(note)
          continue
        }
        log.error({ iteration: i }, 'PTL recovery failed — context cannot be further reduced')
      }
      // Outer-loop reconnect: when the inner stream errored AFTER producing
      // some progress (so runSingleStream's own retry guard refused), we keep
      // the partial messages, sleep with backoff, and continue to the next
      // iteration. This recovers from mid-stream ECONNRESET / 5xx without
      // losing the work already done.
      if (reconnectable && outerReconnectAttempt <= RECONNECT_MAX_RETRIES) {
        // Partial response (incl. any text recovered from a mid-stream drop) was
        // already persisted via store.appendResponse() right after runSingleStream
        // returned, so the recovery iteration sees the assistant's progress and
        // the model won't re-think from scratch.
        const delayMs = computeBackoffMs(outerReconnectAttempt, outcome.error as unknown)
        const nudge: AgentStep = { type: 'system_nudge', iteration: i, message: `[模型连接] ${errStr.slice(0, 120)} — ${Math.round(delayMs / 1000)}s 后重试 (${outerReconnectAttempt}/${RECONNECT_MAX_RETRIES})` }
        yield nudge; onStep?.(nudge)
        log.warn({ iteration: i, attempt: outerReconnectAttempt, maxRetries: RECONNECT_MAX_RETRIES, delayMs, error: errStr.slice(0, 200) }, 'Outer reconnect attempt')
        try { await sleepWithAbort(delayMs, signal) } catch {
          yield { type: 'finish', iteration: i, reason: 'aborted' }
          return
        }
        outerReconnectAttempt += 1
        continue
      }
      log.error({ iteration: i, error: outcome.error }, 'Terminal error, stopping loop')
      const errStep: AgentStep = { type: 'tool_error', iteration: i, toolCallId: `err_${i}`, toolName: 'streamText', error: outcome.error }
      yield errStep; onStep?.(errStep)
      yield { type: 'finish', iteration: i, reason: 'error' }
      onStep?.({ type: 'finish', iteration: i, reason: 'error' })
      return
    }
    // Stream succeeded — reset the outer reconnect counter.
    outerReconnectAttempt = 1

    // Persist observation store if dirty.
    if (observationStore?.dirty) {
      try { observationStore.persist() } catch { /* ignore */ }
    }

    // ── Stagnation detection ──
    // Feed tool execution info to the detector from the response messages.
    for (const msg of outcome.responseMessages) {
      if (msg.role === 'assistant' && typeof msg.content !== 'string') {
        for (const part of msg.content) {
          if (part.type === 'tool-call') {
            stagnation.recordToolCall(part.toolName, part.input)
          }
        }
      }
      if (msg.role === 'tool' && typeof msg.content !== 'string') {
        for (const part of msg.content) {
          if (part.type === 'tool-result') {
            const o = part.output
            const isError = o?.type === 'error-text' || o?.type === 'error-json'
            // Detect HTTP 404 from tool output for http_request
            let statusCode: number | undefined
            if (part.toolName === 'http_request' && o && 'value' in o) {
              const v = typeof o.value === 'string' ? o.value : JSON.stringify(o.value)
              const match = v.match(/(?:status|statusCode|HTTP)\s*[:=]\s*404|"status"\s*:\s*404/)
              if (match) statusCode = 404
            }
            stagnation.recordToolResult(part.toolName, isError, statusCode)
          }
        }
      }
    }
    const hasNewFacts = outcome.executedTools.some(t => t === 'add_endpoint' || t === 'add_finding')
    if (hasNewFacts) stagnation.recordProgress()
    const nudge = stagnation.check(hasNewFacts)
    if (nudge) {
      store.appendSystem(nudge.message)
      const nudgeStep: AgentStep = { type: 'system_nudge', iteration: i, message: nudge.message }
      yield nudgeStep; onStep?.(nudgeStep)
      log.info({ iteration: i, nudgeType: nudge.type, escalated: nudge.escalated }, 'Stagnation nudge')
      if (nudge.escalated) {
        yield { type: 'finish', iteration: i, reason: 'stagnation_escalated' }
        onStep?.({ type: 'finish', iteration: i, reason: 'stagnation_escalated' })
        return
      }
    }

    // ── Approval pause: stop and wait for the user's decision ──
    if (outcome.kind === 'approval') {
      log.info({ iteration: i, pendingCount: outcome.pending.length }, 'Tool calls require approval, pausing')
      const approvalStep: AgentStep = { type: 'tool_approval', iteration: i, pending: outcome.pending }
      yield approvalStep; onStep?.(approvalStep)
      emitContextSnapshot(i)
      yield { type: 'finish', iteration: i, reason: 'tool_approval' }
      onStep?.({ type: 'finish', iteration: i, reason: 'tool_approval' })
      return
    }

    // ── ask_user pause: stop and wait for user input ──
    if (outcome.askedUser) {
      log.info({ iteration: i }, 'ask_user called, stopping to await user response')
      emitContextSnapshot(i)
      yield { type: 'finish', iteration: i, reason: 'ask_user' }
      onStep?.({ type: 'finish', iteration: i, reason: 'ask_user' })
      return
    }

    // ── Natural stop: the run ended with no further tool calls ──
    if (outcome.kind === 'stop') {
      // Wait for async sub-agents to finish before terminating the session.
      if (parentThreadId && subagentRegistry.hasRunningTasks(parentThreadId)) {
        log.info({ iteration: i }, 'Model wants to stop but async sub-agents still running, waiting')
        const waitNote: AgentStep = { type: 'system_nudge', iteration: i, message: '等待子 Agent 完成中...' }
        yield waitNote; onStep?.(waitNote)
        await subagentRegistry.waitForThread(parentThreadId, signal)
        const notes = subagentRegistry.flushPendingMessages(parentThreadId)
        for (const note of notes) store.appendSystem(note)
        if (notes.length > 0) {
          log.info({ iteration: i, flushedCount: notes.length }, 'Flushed subagent notifications after wait')
          continue
        }
      }

      log.info({ iteration: i, finishReason: outcome.finishReason }, 'Model stopped')
      store.appendInterruptionMarker({ kind: 'turn_committed', iteration: i, ts: Date.now() })
      // Final snapshot: the model's last response is already committed to the
      // store, so the ring reflects the true end-of-turn occupation the instant
      // the run goes idle, rather than the pre-last-call value until next turn.
      emitContextSnapshot(i)
      yield { type: 'finish', iteration: i, reason: 'stop' }
      onStep?.({ type: 'finish', iteration: i, reason: 'stop' })
      return
    }

    // outcome.kind === 'continue' → the run exhausted its step budget while
    // still working; loop again with the accumulated messages.
    store.appendInterruptionMarker({ kind: 'turn_committed', iteration: i, ts: Date.now() })
  }

  yield { type: 'finish', iteration: maxIterations, reason: 'max_iterations' }
  onStep?.({ type: 'finish', iteration: maxIterations, reason: 'max_iterations' })
}
