/**
 * Turn-interruption state machine.
 *
 * `MessageStore.repairHangingToolCalls()` previously injected a single
 * "Execution interrupted. Please retry if needed." synthetic error for any
 * hanging tool call after deserialization. That collapsed three very
 * different events — user abort / tool-in-flight / model-stream truncation —
 * into the same generic message, leaving the model with no signal about
 * whether it should retry, resume, or treat the work as already done.
 *
 * This module replaces that scalar repair with an explicit four-state
 * machine. The agent loop writes lightweight "marker" entries via
 * `MessageStore.appendInterruptionMarker()` at every state transition (turn
 * start, tool start, abort, commit). On restore, `analyzeInterruption()`
 * walks the markers + messages and decides which `TurnInterruptionState` we
 * actually woke up in. The store then injects state-specific recovery prose,
 * and the routes layer can surface the same state to the UI as a banner.
 *
 * Markers live alongside messages in the serialized store (`v3` schema —
 * keyed under `interruptionMarkers`). Older `v2` blobs without markers
 * degrade gracefully: `analyzeInterruption()` returns `{kind:'none'}` and
 * the legacy hang-repair logic still runs as a fallback.
 */
import type { ModelMessage } from 'ai'

export type TurnInterruptionState =
  | { kind: 'none' }
  | { kind: 'aborted_by_user'; at: 'pre_model' | 'streaming' | 'tool_call'; toolName?: string }
  | { kind: 'tool_in_flight'; toolName: string; toolCallId: string; argsPreview: string }
  | { kind: 'model_stream_truncated'; partialText: string; reason?: string }
  | { kind: 'transport_error'; error: string; reconnectable: boolean }

/**
 * Markers are append-only lifecycle breadcrumbs. They are NOT model messages —
 * the model never sees them. `analyzeInterruption()` walks the latest run of
 * markers (since the last `turn_committed`) to infer the kind of wake-up.
 */
export type InterruptionMarker =
  | { kind: 'turn_start'; iteration: number; ts: number }
  | { kind: 'turn_committed'; iteration: number; ts: number }
  | { kind: 'turn_aborted'; iteration: number; ts: number; cause?: string }
  | { kind: 'tool_started'; iteration: number; ts: number; toolName: string; toolCallId: string; argsPreview: string }
  | { kind: 'transport_error'; iteration: number; ts: number; error: string; reconnectable: boolean }
  | { kind: 'stream_truncated'; iteration: number; ts: number; reason?: string }

export interface AnalysisInput {
  markers: readonly InterruptionMarker[]
  messages: readonly ModelMessage[]
}

/**
 * Walk the markers in reverse and decide which terminal state we are in.
 * Decisions, in priority order:
 *   1. Last `turn_committed` at the tail → `none` (clean shutdown).
 *   2. Last marker is `turn_aborted` → `aborted_by_user`. The "at" field
 *      is derived from whether a `tool_started` was active at the time.
 *   3. There is a `tool_started` after the last `turn_committed` and no
 *      matching `tool-result` was persisted → `tool_in_flight`.
 *   4. Last marker is `transport_error` → `transport_error`.
 *   5. Last marker is `stream_truncated` → `model_stream_truncated`.
 *   6. None of the above → `none` (best-effort).
 *
 * The function never throws; on malformed marker arrays it returns `{none}`.
 */
export function analyzeInterruption(input: AnalysisInput): TurnInterruptionState {
  const { markers, messages } = input
  if (!Array.isArray(markers) || markers.length === 0) return { kind: 'none' }

  // Walk back to the last committed boundary.
  let cutoff = -1
  for (let i = markers.length - 1; i >= 0; i--) {
    if (markers[i].kind === 'turn_committed') { cutoff = i; break }
  }
  const recent = cutoff >= 0 ? markers.slice(cutoff + 1) : markers
  if (recent.length === 0) return { kind: 'none' }

  const last = recent[recent.length - 1]

  // Find the most recent tool_started in this run, paired against persisted
  // tool-results in the messages list. If a tool started but no result was
  // ever recorded, that's a tool_in_flight (highest-information state).
  let lastToolStart: Extract<InterruptionMarker, { kind: 'tool_started' }> | null = null
  for (let i = recent.length - 1; i >= 0; i--) {
    const m = recent[i]
    if (m.kind === 'tool_started') { lastToolStart = m; break }
  }

  const completedToolCallIds = collectCompletedToolCallIds(messages)
  const toolStillRunning = lastToolStart != null && !completedToolCallIds.has(lastToolStart.toolCallId)

  if (last.kind === 'turn_aborted') {
    return {
      kind: 'aborted_by_user',
      at: toolStillRunning ? 'tool_call' : (last.cause === 'pre_model' ? 'pre_model' : 'streaming'),
      ...(lastToolStart && toolStillRunning ? { toolName: lastToolStart.toolName } : {}),
    }
  }

  if (toolStillRunning) {
    return {
      kind: 'tool_in_flight',
      toolName: lastToolStart!.toolName,
      toolCallId: lastToolStart!.toolCallId,
      argsPreview: lastToolStart!.argsPreview,
    }
  }

  if (last.kind === 'transport_error') {
    return { kind: 'transport_error', error: last.error, reconnectable: last.reconnectable }
  }

  if (last.kind === 'stream_truncated') {
    return {
      kind: 'model_stream_truncated',
      partialText: extractTrailingAssistantText(messages),
      ...(last.reason ? { reason: last.reason } : {}),
    }
  }

  return { kind: 'none' }
}

function collectCompletedToolCallIds(messages: readonly ModelMessage[]): Set<string> {
  const ids = new Set<string>()
  for (const m of messages) {
    if (m.role !== 'tool' || typeof m.content === 'string') continue
    for (const part of m.content) {
      if (part.type === 'tool-result') ids.add(part.toolCallId)
    }
  }
  return ids
}

function extractTrailingAssistantText(messages: readonly ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'assistant') continue
    if (typeof m.content === 'string') return m.content
    const buf: string[] = []
    for (const part of m.content) if (part.type === 'text') buf.push(part.text)
    return buf.join('')
  }
  return ''
}

/**
 * Produce a one-line human description of the state — used for the UI banner
 * payload and for the system message we inject into the store on restore.
 */
export function describeInterruption(state: TurnInterruptionState): string {
  switch (state.kind) {
    case 'none': return ''
    case 'aborted_by_user':
      return state.at === 'tool_call' && state.toolName
        ? `上一轮在执行工具 ${state.toolName} 时被用户取消。`
        : state.at === 'streaming'
          ? '上一轮模型正在输出时被用户取消。'
          : '上一轮在模型开始前被用户取消。'
    case 'tool_in_flight':
      return `工具 ${state.toolName}（id ${state.toolCallId}）执行中断，结果未持久化。`
    case 'model_stream_truncated':
      return `上一轮模型回复被截断${state.reason ? `（${state.reason}）` : ''}，已保留部分文本。`
    case 'transport_error':
      return `上一轮因网络/传输错误中断${state.reconnectable ? '（可恢复）' : '（不可恢复）'}：${state.error}`
  }
}

/**
 * The recovery system message injected into the store. Distinct from the
 * description because it must coach the model on what to do next, not just
 * report the fact. Empty string ⇒ no injection (state.kind === 'none').
 */
export function recoveryPromptFor(state: TurnInterruptionState): string {
  switch (state.kind) {
    case 'none': return ''
    case 'aborted_by_user':
      return [
        '【上一轮被用户取消】',
        state.at === 'tool_call' && state.toolName
          ? `具体地，工具 ${state.toolName} 的执行未完成。请勿盲目重试——先核对当前世界状态（已发现端点/Plan 进度），再决定是否需要重新发起。`
          : '不需要补充任何虚拟错误，请基于当前消息历史继续工作。',
      ].join('\n')
    case 'tool_in_flight':
      return [
        '【中断恢复：工具未完成】',
        `工具 ${state.toolName}（call id ${state.toolCallId}）在上一轮启动后中断，未知是否产生副作用（写入/外发请求等）。`,
        '请先核查（list_endpoints / 直接读取数据等）确认状态，避免重复触发非幂等操作；只有在确实需要时才重新调用同一工具。',
      ].join('\n')
    case 'model_stream_truncated':
      return [
        '【中断恢复：模型回复被截断】',
        '上一轮你的回复被截断（已保留部分文本作为 assistant 消息的开头），无需从头复述，请在此基础上续写。',
      ].join('\n')
    case 'transport_error':
      return [
        '【中断恢复：网络/传输错误】',
        state.reconnectable
          ? '链路已重连，请基于当前进展继续，不要重新执行已完成的步骤。'
          : `链路上次以 ${state.error} 终止；如果对应工具具有幂等性可重试，否则先核对结果再决定。`,
      ].join('\n')
  }
}
