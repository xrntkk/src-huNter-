import { logger } from '../logger/index.js'

/**
 * MessageStore — native ModelMessage[] context store (replaces Timeline).
 *
 * The conversation is held as the AI SDK's provider-agnostic `ModelMessage[]`,
 * the exact shape `streamText({ messages })` consumes and the SDK's multi-step
 * runs produce (`result.response.messages`). This removes the bespoke
 * TimelineItem format and its prose-rendering layer.
 *
 * Responsibilities retained from Timeline (they are context-overflow protection
 * and persistence, not the removed nudge heuristics):
 *   - LLM summary compression + rule-based fallback (compress)
 *   - prompt-too-long recovery (recoverFromPTL)
 *   - token estimation, skill-load tracking, large-result spillover
 *   - serialize/deserialize, UI history view for frontend reload
 */

import { generateText, type LanguageModel, type ModelMessage } from 'ai'
import { spillIfLarge } from './result-spillover.js'
import { resolveThresholds, type ModelCapability, type CompressionThresholds } from './model-capabilities.js'
import { analyzeInterruption, recoveryPromptFor, type InterruptionMarker, type TurnInterruptionState } from './interruption.js'

interface CompressionState {
  summary: string
}

/**
 * One ordered entry in a reconstructed history message. `text` carries a run of
 * assistant/user prose; `tool` carries a completed tool call paired with its
 * result — interleaved in true chronological order (no position markers).
 */
export type HistoryPart =
  | { type: 'text'; text: string }
  | {
      type: 'tool'
      state: 'result'
      toolCallId: string
      toolName: string
      args: unknown
      result: unknown
    }

/**
 * One entry from a pre-D-1 Timeline blob (`{items:[...]}`). Only the fields the
 * converter reads are typed; the rest are ignored.
 */
interface LegacyTimelineItem {
  type: 'user' | 'assistant_thought' | 'tool_call' | 'tool_result' | 'skill_loaded' | string
  role?: string
  content?: string
  metadata?: {
    toolName?: string
    toolArgs?: Record<string, unknown>
    toolCallId?: string
    skillName?: string
    nonce?: string
  }
}

/**
 * Derive compression water-lines from a model capability. Falls back to the
 * legacy `largeContext` boolean signal when no capability is supplied (older
 * call sites). Env overrides (TIMELINE_COMPRESS_TOKENS / TIMELINE_MICRO_COMPACT_TOKENS)
 * still win and are read inside `resolveThresholds`.
 */
function thresholdsForCompression(
  capability?: ModelCapability,
  largeContext?: boolean,
): CompressionThresholds {
  if (capability) return resolveThresholds(capability)
  // Fallback for callers that haven't been threaded through yet — keep the
  // pre-plan-three behaviour: 1M window when largeContext, otherwise 200k.
  const fallback: ModelCapability = largeContext
    ? { modelId: '__legacy_large__', contextWindowTokens: 1_000_000, maxOutputTokens: 32_000 }
    : { modelId: '__legacy_standard__', contextWindowTokens: 200_000, maxOutputTokens: 16_000 }
  return resolveThresholds(fallback)
}

/** Strip legacy model-only nonce wrapping tags that may sit in restored text. */
function stripNonceTags(text: string): string {
  return text
    .replace(/<\|TAG_[A-Z0-9]+\|>\n?/g, '')
    .replace(/\n?<\|TAG_END_[A-Z0-9]+\|>/g, '')
    .trim()
}

/**
 * Slash-command display marker. A user turn produced by `/<cmd>` stores the
 * real (hidden) prompt as its body, prefixed with `<|CMD:label|>`. The model
 * never sees the marker — it's stripped in toModelMessages/summary so the model
 * reads only the injected prompt. The UI history view extracts the label so the
 * chat bubble shows the friendly command name instead of the full prompt.
 */
const CMD_MARKER_RE = /^<\|CMD:([^|]*)\|>/

/** Extract the command label from a user turn, or null if it isn't a command. */
function extractCmdLabel(text: string): string | null {
  const m = CMD_MARKER_RE.exec(text)
  return m ? m[1] : null
}

/** Remove the `<|CMD:label|>` prefix, leaving the injected prompt body. */
function stripCmdMarker(text: string): string {
  return text.replace(CMD_MARKER_RE, '')
}

export class MessageStore {
  private messages: ModelMessage[] = []
  private skills: string[] = []
  private compression?: CompressionState
  private compressionFailures = 0
  private ptlRecoveries = 0
  private _recentlyCompressed = false
  /**
   * Latest provider-reported input token count, captured from streamText
   * `usage.inputTokens` (plus cache_read tokens when present, since those
   * still consume window space). When non-null, `estimateTokens()` returns
   * this directly — it is dramatically more accurate than the char×0.55
   * heuristic, which under-counts JSON tool-call payloads. Reset only when
   * the provider stops reporting (e.g. fallback path).
   */
  /**
   * In-progress streaming text accumulated from text_delta steps. Exposed via
   * toHistoryMessages() as a trailing partial assistant message so a page
   * refresh mid-stream can show what the model has produced so far. Cleared
   * by appendResponse() once the real assistant message is committed.
   */
  private draftText = ''
  private observedInputTokens: number | null = null
  /**
   * Optional model capability (context window + output budget). When set,
   * compression thresholds scale with the model. Mutable so the store can
   * be rebound at runtime if the user switches the active model mid-session.
   */
  private capability: ModelCapability | null = null

  /**
   * Lifecycle markers for the interruption state machine (plan two). The
   * agent loop appends these via `appendInterruptionMarker()` at every
   * transition (turn start / tool start / abort / commit). Persisted with
   * the v3 serialization. Bounded — the latest 200 are kept in memory; older
   * markers are pruned on append since only the post-last-commit tail
   * matters for recovery analysis.
   */
  private markers: InterruptionMarker[] = []

  /**
   * The state inferred at the most recent deserialize. Surfaced via
   * `getLastInterruption()` so the routes layer can ship it to the UI as
   * a banner payload, and the agent loop can decide whether to inject the
   * recovery system prompt.
   */
  private lastInterruption: TurnInterruptionState = { kind: 'none' }

  /**
   * Cached result of toModelMessages(). Invalidated by every method that
   * mutates `messages` or `compression`. Without this, each iteration's
   * toModelMessages() re-runs sanitizeToolPairing (O(n) full scan) even when
   * the message list hasn't changed since the last call — a hot spot in long
   * sessions with 1000+ iterations.
   */
  private modelMessagesCache: ModelMessage[] | null = null

  /** Invalidate the toModelMessages cache. Call from every message/compression mutation. */
  private invalidateModelMessagesCache(): void {
    this.modelMessagesCache = null
  }

  /**
   * Bind a model capability so subsequent compress()/estimateTokens calls use
   * model-specific water-lines. Safe to call repeatedly (e.g. when the user
   * switches the active model). Pass null to clear.
   *
   * Resets `observedInputTokens` so the next estimateTokens() falls back to
   * the char heuristic until the new model reports its own usage. Without
   * this, switching from a model that reports usage to one that doesn't
   * leaves a stale value that misleads the context gauge.
   */
  bindCapability(capability: ModelCapability | null): void {
    this.capability = capability
    this.observedInputTokens = null
  }

  /** Read the bound capability (mostly for telemetry / UI water-line). */
  getCapability(): ModelCapability | null {
    return this.capability
  }

  /**
   * Record provider-reported input token usage from a streamText call.
   * Pass `inputTokens` from the SDK's usage event; cache-read tokens are
   * included since they still occupy window space at request time.
   */
  recordObservedUsage(usage: { inputTokens?: number; cacheReadTokens?: number }): void {
    const total = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0)
    if (total > 0) this.observedInputTokens = total
  }

  /**
   * Compute a percent-of-window snapshot for the UI water-line. Returns null
   * when no capability is bound. Uses observed usage when available, else the
   * char-based estimate.
   */
  contextWaterLine(): {
    used: number
    effective: number
    contextWindow: number
    percent: number
    warningLevel: 'ok' | 'warn' | 'critical'
  } | null {
    if (!this.capability) return null
    const thresholds = thresholdsForCompression(this.capability)
    const used = this.estimateTokens()
    const effective = thresholds.effectiveTokens
    const percent = effective > 0 ? Math.min(100, Math.round((used / effective) * 100)) : 0
    const level = used >= thresholds.ptlBlock
      ? 'critical'
      : used >= thresholds.llmSummary
        ? 'warn'
        : 'ok'
    return {
      used,
      effective,
      contextWindow: this.capability.contextWindowTokens,
      percent,
      warningLevel: level,
    }
  }

  /** Number of stored messages (excludes the synthetic compression summary). */
  get length(): number {
    return this.messages.length
  }

  /**
   * Append a lifecycle marker for interruption tracking. Agent loop should
   * call this at: turn_start (before streamText), tool_started (before
   * calling each tool), turn_aborted (on signal abort), turn_committed
   * (after a clean iteration). Markers are persisted with the v3 schema.
   *
   * Auto-prune: once the buffer exceeds 200 entries we drop everything
   * before the latest `turn_committed`, since only post-commit markers
   * matter for recovery analysis.
   */
  appendInterruptionMarker(marker: InterruptionMarker): void {
    this.markers.push(marker)
    if (this.markers.length > 200) {
      let lastCommit = -1
      for (let i = this.markers.length - 1; i >= 0; i--) {
        if (this.markers[i].kind === 'turn_committed') { lastCommit = i; break }
      }
      if (lastCommit > 50) {
        this.markers = this.markers.slice(lastCommit)
      }
    }
  }

  /** State inferred at last deserialize — `{kind:'none'}` for fresh stores. */
  getLastInterruption(): TurnInterruptionState {
    return this.lastInterruption
  }

  /** Clear the interruption state once the recovery prose has been injected. */
  clearLastInterruption(): void {
    this.lastInterruption = { kind: 'none' }
  }

  /**
   * Plan five — invoke microCompact against this store's in-memory message
   * list. Wraps the standalone helper so callers don't need to reach into
   * private state. Returns the result for telemetry/logging.
   */
  applyMicroCompact(_threadId: string, fn: (msgs: ModelMessage[]) => unknown): unknown {
    const result = fn(this.messages)
    this.invalidateModelMessagesCache()
    return result
  }

  getMarkers(): readonly InterruptionMarker[] {
    return this.markers
  }

  /** Read the compression summary, if any (cold-path metadata). */
  getCompressionSummary(): string | null {
    return this.compression?.summary ?? null
  }

  /**
   * Restore a MessageStore from a JSONL snapshot loaded by ThreadJsonlStore.
   * Mirrors `deserialize()`: applies markers, runs the interruption analyzer,
   * and patches the message chain accordingly. Compression summary, if any
   * was persisted as a meta entry, is replayed onto the store.
   */
  static fromJsonl(loaded: {
    messages: ModelMessage[]
    meta: Array<{ kind: string; payload: unknown }>
    markers: InterruptionMarker[]
  }, compressedSummaryFallback?: string | null): MessageStore {
    const store = new MessageStore()
    store.messages = loaded.messages
    store.markers = Array.isArray(loaded.markers) ? loaded.markers : []
    // Compression summaries are kept out-of-band — prefer the cold-path SQLite
    // column when present, otherwise replay from the JSONL meta stream.
    if (compressedSummaryFallback) {
      store.compression = { summary: compressedSummaryFallback }
    } else {
      const lastCompression = [...loaded.meta].reverse().find(m => m.kind === 'compression')
      if (lastCompression && typeof lastCompression.payload === 'string') {
        store.compression = { summary: lastCompression.payload }
      }
    }
    // Replay loaded skills.
    for (const m of loaded.meta) {
      if (m.kind === 'skill_loaded' && typeof m.payload === 'string') {
        store.addSkillLoaded(m.payload)
      }
    }
    store.lastInterruption = analyzeInterruption({ markers: store.markers, messages: store.messages })
    if (store.lastInterruption.kind === 'none') store.repairHangingToolCalls()
    else store.repairHangingToolCallsForState(store.lastInterruption)
    return store
  }

  isEmpty(): boolean {
    return this.messages.length === 0
  }

  /** True if compression occurred since last check. Resets after reading. */
  wasRecentlyCompressed(): boolean {
    const val = this._recentlyCompressed
    this._recentlyCompressed = false
    return val
  }

  /**
   * Append a user turn. `nonce` wraps the content in model-only marker tags.
   * `displayLabel` (set for slash commands) prefixes a `<|CMD:label|>` marker so
   * the UI bubble renders the label while the model reads only `content` (the
   * injected prompt). The marker sits outside the nonce wrapping and is stripped
   * from every model-facing view.
   */
  /** Accumulate streaming text delta into the in-progress draft. */
  appendDraft(delta: string): void {
    this.draftText += delta
  }

  /** Clear the in-progress draft (called when the real message is committed). */
  clearDraft(): void {
    this.draftText = ''
  }

  /** Current in-progress draft text (empty string if none). */
  getDraftText(): string {
    return this.draftText
  }

  appendUser(content: string, nonce?: string, displayLabel?: string): void {
    const wrapped = nonce ? `<|TAG_${nonce}|>\n${content}\n<|TAG_END_${nonce}|>` : content
    // The CMD marker is `|`-delimited, so strip any pipes (and newlines) the
    // user-supplied label may contain to keep the marker parseable.
    const safeLabel = displayLabel?.replace(/[|\r\n]/g, ' ').trim()
    const body = safeLabel ? `<|CMD:${safeLabel}|>${wrapped}` : wrapped
    this.messages.push({ role: 'user', content: body })
    this.invalidateModelMessagesCache()
  }

  /** Append a standalone system note (nudges, recovery notices, sub-task seeds). */
  appendSystem(content: string): void {
    this.messages.push({ role: 'system', content })
    this.invalidateModelMessagesCache()
  }

  /**
   * Append the messages produced by an SDK run (`result.response.messages` —
   * assistant + tool messages). Large tool outputs are spilled to the workspace
   * so the context keeps a short pointer instead of replaying full payloads.
   */
  appendResponse(messages: ModelMessage[], sessionId?: string): void {
    for (const msg of messages) {
      this.messages.push(sessionId ? this.spillLargeToolOutputs(msg, sessionId) : msg)
    }
    this.draftText = ''
    this.invalidateModelMessagesCache()
  }

  /** Direct append (used when restoring or seeding child agents). */
  append(message: ModelMessage): void {
    this.messages.push(message)
    this.invalidateModelMessagesCache()
  }

  /**
   * Inject the user's approval decisions as native `tool-approval-response`
   * parts so the next streamText run executes approved calls and skips denied
   * ones. The parts are added as a trailing tool message (the SDK pairs them
   * back to the assistant's tool-approval-request by approvalId).
   */
  applyApprovalResponses(decisions: Array<{ approvalId: string; approved: boolean; note?: string }>): void {
    if (decisions.length === 0) return
    const content = decisions.map(d => ({
      type: 'tool-approval-response' as const,
      approvalId: d.approvalId,
      approved: d.approved,
      ...(d.note ? { reason: d.note } : {}),
    }))
    // ToolModelMessage content is ToolResultPart | ToolApprovalResponse[].
    this.messages.push({ role: 'tool', content } as unknown as ModelMessage)
    this.invalidateModelMessagesCache()
  }


  /** Track a loaded skill — persisted metadata, not part of the model context. */
  addSkillLoaded(name: string): void {
    if (!this.skills.includes(name)) this.skills.push(name)
  }

  /**
   * Remove a skill and its sub-documents from the loaded-skills tracking list.
   * Accepts a bare skill name — removes both `"name"` and `"name#subPath"`
   * entries. Returns the number of entries removed.
   */
  removeSkillLoaded(name: string): number {
    const before = this.skills.length
    this.skills = this.skills.filter(s => s !== name && !s.startsWith(`${name}#`))
    const removed = before - this.skills.length
    if (removed > 0) this.invalidateModelMessagesCache()
    return removed
  }

  getLoadedSkillNames(): string[] {
    return [...this.skills]
  }

  /** True if the conversation contains an assistant tool-call to `toolName`. */
  hasToolCall(toolName: string): boolean {
    for (const m of this.messages) {
      if (m.role !== 'assistant' || typeof m.content === 'string') continue
      for (const part of m.content) {
        if (part.type === 'tool-call' && part.toolName === toolName) return true
      }
    }
    return false
  }

  /** Count successful (non-error) tool-results for `toolName`. */
  countToolResults(toolName: string): number {
    let n = 0
    for (const m of this.messages) {
      if (m.role !== 'tool' || typeof m.content === 'string') continue
      for (const part of m.content) {
        if (part.type === 'tool-result' && part.toolName === toolName) {
          const o = part.output
          if (o?.type !== 'error-text' && o?.type !== 'error-json') n++
        }
      }
    }
    return n
  }


  // ─── Model view ─────────────────────────────────────────────────────────────

  /**
   * Messages for `streamText({ messages })`. Prepends the compression summary
   * as a leading system message and guarantees a leading user turn (a prior
   * recovery/compression may have dropped the original).
   */
  toModelMessages(): ModelMessage[] {
    if (this.modelMessagesCache) return this.modelMessagesCache
    const out: ModelMessage[] = []
    if (this.compression) {
      out.push({ role: 'system', content: `## 历史摘要\n${this.compression.summary}` })
    }
    // Strip the slash-command display marker so the model reads only the
    // injected prompt body, never the UI label.
    const cleaned = this.messages.map(m =>
      m.role === 'user' && typeof m.content === 'string' && CMD_MARKER_RE.test(m.content)
        ? { ...m, content: stripCmdMarker(m.content) }
        : m,
    )
    out.push(...sanitizeToolPairing(cleaned))
    if (out.length === 0 || out.every(m => m.role !== 'user')) {
      out.push({ role: 'user', content: '继续。' })
    }
    this.modelMessagesCache = out
    return out
  }

  /** Raw stored messages (no compression prefix) — for persistence/inspection. */
  getMessages(): readonly ModelMessage[] {
    return this.messages
  }

  /**
   * Prose transcript of the whole conversation (used by the memory extractor,
   * replacing Timeline.toModelPrompt). Tool calls/results render as compact
   * labelled lines.
   */
  toProseTranscript(): string {
    const lines: string[] = []
    if (this.compression) lines.push(`## 历史摘要\n${this.compression.summary}`)
    for (const m of this.messages) lines.push(renderMessageForSummary(m))
    return lines.join('\n')
  }

  /**
   * Render tool-call/result/error activity that appears at or after `cursor`
   * (a message index), for the Observer's rolling curation. Returns the lines
   * plus the next cursor (message count) so the caller advances past consumed
   * activity.
   */
  getToolActivitySince(cursor: number): { lines: string[]; nextCursor: number } {
    const lines: string[] = []
    for (let idx = Math.max(0, cursor); idx < this.messages.length; idx++) {
      const m = this.messages[idx]
      if (typeof m.content === 'string') continue
      for (const part of m.content) {
        if (part.type === 'tool-call') {
          lines.push(`调用 ${part.toolName}: ${JSON.stringify(part.input ?? {}).slice(0, 300)}`)
        } else if (part.type === 'tool-result') {
          const o = part.output
          const v = o && 'value' in o ? (typeof o.value === 'string' ? o.value : JSON.stringify(o.value)) : ''
          const isError = o?.type === 'error-text' || o?.type === 'error-json'
          lines.push(`${isError ? '错误' : '结果'} ${part.toolName}: ${String(v).slice(0, 400)}`)
        }
      }
    }
    return { lines, nextCursor: this.messages.length }
  }


  // ─── Token estimation ─────────────────────────────────────────────────────

  /**
   * Estimate the conversation's token cost. When the provider has reported
   * a real `inputTokens` value via `recordObservedUsage()` we trust that
   * directly — it accounts for tool-call JSON, cache reads, and provider
   * tokenization quirks that the char heuristic misses. Otherwise fall back
   * to the legacy `chars × 0.55` estimate (sufficient for compression gating
   * before the first round completes).
   */
  estimateTokens(): number {
    if (this.observedInputTokens != null) return this.observedInputTokens
    let chars = this.compression ? this.compression.summary.length : 0
    for (const m of this.messages) chars += this.messageChars(m)
    return Math.ceil(chars * 0.55)
  }

  // ─── Large tool-output spillover ──────────────────────────────────────────

  private messageChars(m: ModelMessage): number {
    if (typeof m.content === 'string') return m.content.length
    let n = 0
    for (const part of m.content) {
      if (part.type === 'text') n += part.text.length
      else if (part.type === 'tool-call') n += JSON.stringify(part.input ?? {}).length
      else if (part.type === 'tool-result') n += JSON.stringify(part.output ?? {}).length
      else n += 80 // reasoning / file / other parts: rough fixed cost
    }
    return n
  }

  /**
   * Replace oversized tool-result outputs in a tool message with a short
   * preview + a workspace pointer. Mirrors Timeline.addToolResult's spill: the
   * full payload is written to disk and the model reads it back on demand.
   */
  private spillLargeToolOutputs(msg: ModelMessage, sessionId: string): ModelMessage {
    if (msg.role !== 'tool' || typeof msg.content === 'string') return msg
    const content = msg.content.map(part => {
      if (part.type !== 'tool-result') return part
      const out = part.output
      // Only text/json outputs carry replayable bulk; error-text stays inline.
      if (!out || (out.type !== 'text' && out.type !== 'json')) return part
      const raw = out.type === 'text' ? out.value : JSON.stringify(out.value)
      const spill = spillIfLarge(sessionId, part.toolCallId, raw)
      if (!spill) return part
      const preview = String(raw).slice(0, 500)
      return {
        ...part,
        output: {
          type: 'text' as const,
          value: `${preview}\n[完整结果已落盘: ${spill.relPath}（约 ${spill.sizeKB}KB）。如需完整内容，用 file_system 工具 read 读取该路径]`,
        },
      }
    })
    return { ...msg, content }
  }

  // ─── Frontend history view ────────────────────────────────────────────────

  /**
   * Reconstruct frontend-compatible messages for a page reload. Each message
   * carries an ordered `parts` array — text and tool entries interleaved in the
   * exact order they appear in the underlying ModelMessage — so the frontend
   * renders them natively without position markers. (The live stream produces
   * the same ordering via agentLoopToDataStreamResponse's text-block splitting.)
   */
  toHistoryMessages(): Array<{
    role: 'user' | 'assistant'
    parts: HistoryPart[]
  }> {
    const out: Array<{ role: 'user' | 'assistant'; parts: HistoryPart[] }> = []

    // Index tool-result outputs by toolCallId so assistant tool-calls can be
    // paired with their results regardless of message ordering.
    const resultsById = new Map<string, { isError: boolean; value: unknown }>()
    for (const m of this.messages) {
      if (m.role !== 'tool' || typeof m.content === 'string') continue
      for (const part of m.content) {
        if (part.type !== 'tool-result') continue
        const o = part.output
        const isError = o?.type === 'error-text' || o?.type === 'error-json'
        const value = o && 'value' in o ? o.value : undefined
        resultsById.set(part.toolCallId, { isError, value })
      }
    }

    for (const m of this.messages) {
      if (m.role === 'user') {
        const text = typeof m.content === 'string'
          ? m.content
          : m.content.filter(p => p.type === 'text').map(p => (p as { text: string }).text).join('')
        // Slash-command turns render as their label, not the injected prompt.
        const cmdLabel = extractCmdLabel(text)
        const display = cmdLabel ?? stripNonceTags(text)
        out.push({ role: 'user', parts: [{ type: 'text', text: display }] })
        continue
      }
      if (m.role !== 'assistant') continue

      // Walk the assistant message in order, emitting a text part for each
      // text run and a tool part at the exact point its tool-call appears.
      // Consecutive text fragments are coalesced into one part.
      const outParts: HistoryPart[] = []
      const parts = typeof m.content === 'string' ? [{ type: 'text' as const, text: m.content }] : m.content
      let textBuf = ''
      const flushText = () => {
        const t = textBuf.trim()
        if (t) outParts.push({ type: 'text', text: t })
        textBuf = ''
      }
      for (const part of parts) {
        if (part.type === 'text') {
          textBuf += part.text
        } else if (part.type === 'tool-call') {
          flushText()
          const res = resultsById.get(part.toolCallId)
          outParts.push({
            type: 'tool',
            state: 'result',
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            args: part.input ?? {},
            result: res?.isError ? { error: res.value } : { success: true, summary: res?.value ?? '' },
          })
        }
      }
      flushText()
      if (outParts.length > 0) {
        out.push({ role: 'assistant', parts: outParts })
      }
    }
    // Append the in-progress streaming draft as a trailing partial assistant
    // message so a page refresh mid-stream shows what the model has produced
    // so far. Once the iteration completes, appendResponse() clears draftText
    // and the real committed message takes its place.
    if (this.draftText) {
      out.push({ role: 'assistant', parts: [{ type: 'text', text: this.draftText }] })
    }
    return out
  }


  serialize(observerState?: { rounds: string[]; curationCursor: number }): string {
    return JSON.stringify({
      version: 3,
      messages: this.messages,
      skills: this.skills,
      compression: this.compression,
      markers: this.markers,
      ...(observerState ? { observer: observerState } : {}),
    })
  }

  /**
   * Restore from serialized state. Schemas, in priority order:
   *   - v3 (current): `{version:3, messages, markers, ...}`. Loads markers,
   *     runs the interruption analyzer, and stages the result on
   *     `lastInterruption` for the agent loop to consume.
   *   - v2: `{version:2, messages, ...}`. Same as v3 minus markers; falls
   *     back to the legacy `repairHangingToolCalls` for compatibility.
   *   - legacy `{items:[...]}`: pre-D-1 Timeline JSON, converted in place.
   *   - corrupt / unknown: empty store.
   */
  static deserialize(raw: string): MessageStore {
    const store = new MessageStore()
    try {
      const data = JSON.parse(raw) as {
        version?: number
        messages?: ModelMessage[]
        skills?: string[]
        compression?: CompressionState
        markers?: InterruptionMarker[]
        observer?: { rounds?: string[]; curationCursor?: number }
        items?: LegacyTimelineItem[]
      }
      if ((data.version === 2 || data.version === 3) && Array.isArray(data.messages)) {
        store.messages = data.messages
        store.skills = data.skills ?? []
        store.compression = data.compression
        store.markers = Array.isArray(data.markers) ? data.markers : []
      } else if (Array.isArray(data.items)) {
        // Legacy Timeline → ModelMessages (display + continuation).
        const { messages, skills } = convertLegacyTimeline(data.items)
        store.messages = messages
        store.skills = skills
      }
      // else: unknown format → empty store.
    } catch {
      // Corrupt row → empty store.
    }
    // Plan two: try the marker-based analyzer first. When markers are
    // unavailable (v2 / legacy / fresh), fall back to the scalar repair so
    // existing sessions still get their hanging tool-calls patched.
    store.lastInterruption = analyzeInterruption({ markers: store.markers, messages: store.messages })
    if (store.lastInterruption.kind === 'none') {
      store.repairHangingToolCalls()
    } else {
      store.repairHangingToolCallsForState(store.lastInterruption)
    }
    return store
  }

  /** Extract observer state from serialized data (for restoration after deserialize). */
  static extractObserverState(raw: string): { rounds: string[]; curationCursor: number } | null {
    try {
      const data = JSON.parse(raw) as { observer?: { rounds?: string[]; curationCursor?: number } }
      if (data.observer && Array.isArray(data.observer.rounds)) {
        return { rounds: data.observer.rounds, curationCursor: data.observer.curationCursor ?? 0 }
      }
    } catch { /* ignore */ }
    return null
  }

  // ─── Compression ──────────────────────────────────────────────────────────

  /**
   * Compress old messages into an LLM summary when the context grows past the
   * configured threshold. The oldest ~70% of messages are summarized and
   * dropped; the summary is prepended as a system message via toModelMessages().
   * A 3-failure circuit breaker prevents retry storms. recoverFromPTL() remains
   * the hard net for actual provider overflow.
   *
   * Fast path: if a SessionMemoryExtractor is provided and its memory is fresh,
   * use it directly as the summary without calling the LLM.
   */
  async compress(opts: { fastModel: LanguageModel; largeContext?: boolean; capability?: ModelCapability; sessionMemory?: { isFreshEnough: (iter: number, threshold?: number) => boolean; getLatestMemory: () => string | null; setMemory?: (summary: string, iteration: number, currentTokens: number) => void }; currentIteration?: number; reattachBuilder?: () => ModelMessage | null } | LanguageModel): Promise<void> {
    const fastModel: LanguageModel = (opts as { fastModel?: LanguageModel }).fastModel ?? (opts as LanguageModel)
    const explicitCap = (opts as { capability?: ModelCapability }).capability
    const largeContext = Boolean((opts as { largeContext?: boolean }).largeContext)
    const sessionMemory = (opts as { sessionMemory?: { isFreshEnough: (iter: number, threshold?: number) => boolean; getLatestMemory: () => string | null; setMemory?: (summary: string, iteration: number, currentTokens: number) => void } }).sessionMemory
    const currentIteration = (opts as { currentIteration?: number }).currentIteration ?? 0
    const reattachBuilder = (opts as { reattachBuilder?: () => ModelMessage | null }).reattachBuilder
    const cap = explicitCap ?? this.capability ?? undefined
    const { llmSummary: summaryThreshold } = thresholdsForCompression(cap, largeContext)

    if (this.estimateTokens() < summaryThreshold) return
    if (this.compressionFailures >= 3) {
      logger.info('[MessageStore] Compression circuit breaker triggered, skipping')
      return
    }

    const cutoff = Math.floor(this.messages.length * 0.7)
    if (cutoff < 3) return
    const toCompress = this.messages.slice(0, cutoff)

    // Fast path: use session memory if fresh enough
    if (sessionMemory?.isFreshEnough(currentIteration) && sessionMemory.getLatestMemory()) {
      const summary = sessionMemory.getLatestMemory()!
      this.compression = {
        summary: this.compression ? `${this.compression.summary}\n\n${summary}` : summary,
      }
      this.messages = this.messages.slice(cutoff)
      this.invalidateModelMessagesCache()
      this.repairLeadingOrphans()
      this.compressionFailures = 0
      this._recentlyCompressed = true
      this.applyReattach(reattachBuilder)
      logger.info(`[MessageStore] Compressed ${toCompress.length} messages via session memory fast-path (${this.estimateTokens()} tokens est.)`)
      return
    }

    const prompt = `请将以下对话历史压缩为简洁的摘要，保留关键信息（已发现的接口、确认的漏洞类型、关键决策、用户偏好），丢弃执行细节和临时状态。

历史记录：
${toCompress.map(m => renderMessageForSummary(m)).join('\n')}

请只输出纯摘要文本，不要解释。用中文输出。`

    try {
      const { text } = await generateText({ model: fastModel, system: '你是一个专业的对话历史压缩助手。', prompt })
      const summary = text.trim()
      this.compression = {
        summary: this.compression ? `${this.compression.summary}\n\n${summary}` : summary,
      }
      this.messages = this.messages.slice(cutoff)
      this.invalidateModelMessagesCache()
      this.repairLeadingOrphans()
      this.compressionFailures = 0
      this._recentlyCompressed = true
      this.applyReattach(reattachBuilder)
      // Refresh sessionMemory with the compress summary so the next compress
      // can take the fast-path (and the standalone SessionMemoryExtractor
      // extraction on this iteration is skipped — one LLM call, not two).
      if (sessionMemory?.setMemory) {
        sessionMemory.setMemory(summary, currentIteration, this.estimateTokens())
      }
      logger.info(`[MessageStore] Compressed ${toCompress.length} messages → summary (${this.estimateTokens()} tokens est.)`)
    } catch (err) {
      this.compressionFailures++
      logger.error(`[MessageStore] Compression failed (attempt ${this.compressionFailures}/3):`, err)
    }
  }

  /**
   * Plan four — re-attach high-density context after a successful compression.
   * The agent loop hands us a builder that closes over its ObservationStore / PlanNotes
   * / SkillRegistry; we call it lazily so a disabled feature pays no cost.
   * The resulting system message is unshifted onto the message list so it
   * sits immediately after the compression summary in `toModelMessages()`.
   */
  private applyReattach(builder: (() => ModelMessage | null) | undefined): void {
    if (!builder) return
    let reattach: ModelMessage | null
    try { reattach = builder() } catch (err) {
      logger.warn('[MessageStore] Reattach builder threw:', err)
      return
    }
    if (!reattach) return
    this.messages.unshift(reattach)
    this.invalidateModelMessagesCache()
  }

  /**
   * Prompt-too-long recovery: drop the oldest ~30% of conversation rounds (a
   * round starts at each user message) and fold a note into the summary. System
   * messages are preserved. Returns false once the recovery budget is spent so
   * the caller surfaces a hard failure instead of looping.
   */
  recoverFromPTL(): boolean {
    const MAX_RECOVERIES = 2
    if (this.ptlRecoveries >= MAX_RECOVERIES) return false

    const roundStarts: number[] = []
    this.messages.forEach((m, idx) => { if (m.role === 'user') roundStarts.push(idx) })
    if (roundStarts.length < 2) return false

    const dropRounds = Math.max(1, Math.floor(roundStarts.length * 0.3))
    const cutAt = roundStarts[dropRounds]
    if (cutAt == null) return false

    const dropped = this.messages.slice(0, cutAt).filter(m => m.role !== 'system')
    if (dropped.length === 0) return false
    const systems = this.messages.slice(0, cutAt).filter(m => m.role === 'system')
    this.messages = [...systems, ...this.messages.slice(cutAt)]
    this.invalidateModelMessagesCache()
    this.repairLeadingOrphans()

    const note = `[PTL 恢复 #${this.ptlRecoveries + 1}：因上下文超限，裁剪了 ${dropped.length} 条最旧消息]`
    this.compression = { summary: this.compression ? `${this.compression.summary}\n\n${note}` : note }
    this.ptlRecoveries++
    logger.info(`[MessageStore] PTL recovery #${this.ptlRecoveries}: dropped ${dropped.length} messages (${dropRounds} rounds)`)
    return true
  }

  /**
   * After dropping a prefix, the new leading messages may be an orphan tool
   * message (tool-results whose assistant tool-call was dropped) — providers
   * reject that. Drop any leading tool messages until the first non-tool.
   */
  private repairLeadingOrphans(): void {
    let changed = false
    while (this.messages.length > 0 && this.messages[0].role === 'tool') {
      this.messages.shift()
      changed = true
    }
    if (changed) this.invalidateModelMessagesCache()
  }

  /**
   * Repair message chain integrity after deserialization. If the conversation
   * was interrupted mid-execution (server crash, abort), there may be assistant
   * tool-call parts with no matching tool-result in a subsequent tool message.
   * Providers reject such sequences. We inject synthetic error results for any
   * unmatched tool-calls so the chain is always valid.
   */
  private repairHangingToolCalls(): void {
    // Collect all tool-call IDs from assistant messages
    const pendingCalls = new Map<string, { toolName: string }>()
    for (const m of this.messages) {
      if (m.role === 'assistant' && typeof m.content !== 'string') {
        for (const part of m.content) {
          if (part.type === 'tool-call') {
            pendingCalls.set(part.toolCallId, { toolName: part.toolName })
          }
        }
      }
      if (m.role === 'tool' && typeof m.content !== 'string') {
        for (const part of m.content) {
          if (part.type === 'tool-result') {
            pendingCalls.delete(part.toolCallId)
          }
        }
      }
    }

    if (pendingCalls.size === 0) return

    // Inject synthetic error results for unmatched calls
    const syntheticParts = Array.from(pendingCalls.entries()).map(([toolCallId, { toolName }]) => ({
      type: 'tool-result' as const,
      toolCallId,
      toolName,
      output: { type: 'error-text' as const, value: 'Execution interrupted. Please retry if needed.' },
    }))

    this.messages.push({ role: 'tool', content: syntheticParts } as unknown as ModelMessage)
    this.invalidateModelMessagesCache()
    logger.info(`[MessageStore] Repaired ${pendingCalls.size} hanging tool-call(s) without results`)
  }

  /**
   * State-aware variant: only patches hanging tool-calls when the analyzer
   * concluded a tool was genuinely in flight, and uses a more informative
   * error string. The other states (user abort / stream truncation /
   * transport error) do NOT need synthetic tool-results — see plan two for
   * the rationale.
   */
  private repairHangingToolCallsForState(state: TurnInterruptionState): void {
    if (state.kind !== 'tool_in_flight') {
      // For aborted_by_user / model_stream_truncated / transport_error the
      // model cannot benefit from a synthetic error, but we still need a
      // valid message chain — drop unanswered tool-calls instead of
      // injecting fake results.
      this.dropUnansweredToolCalls()
      return
    }
    const pendingCalls = new Map<string, { toolName: string }>()
    for (const m of this.messages) {
      if (m.role === 'assistant' && typeof m.content !== 'string') {
        for (const part of m.content) {
          if (part.type === 'tool-call') pendingCalls.set(part.toolCallId, { toolName: part.toolName })
        }
      }
      if (m.role === 'tool' && typeof m.content !== 'string') {
        for (const part of m.content) {
          if (part.type === 'tool-result') pendingCalls.delete(part.toolCallId)
        }
      }
    }
    if (pendingCalls.size === 0) return
    const synthetic = Array.from(pendingCalls.entries()).map(([toolCallId, { toolName }]) => ({
      type: 'tool-result' as const,
      toolCallId,
      toolName,
      output: { type: 'error-text' as const, value: `工具 ${toolName} 在上一轮执行中断（call id ${toolCallId}），结果未持久化。请先核查再决定是否重试。` },
    }))
    this.messages.push({ role: 'tool', content: synthetic } as unknown as ModelMessage)
    this.invalidateModelMessagesCache()
    logger.info(`[MessageStore] Repaired ${pendingCalls.size} hanging tool-call(s) for tool_in_flight state`)
  }

  /**
   * Drop any assistant tool-call parts that have no matching tool-result.
   * Used for non-tool-in-flight interruption states where we'd rather just
   * remove the orphan than inject a synthetic result. Provider message
   * validators reject the orphan otherwise.
   */
  private dropUnansweredToolCalls(): void {
    const answered = new Set<string>()
    for (const m of this.messages) {
      if (m.role === 'tool' && typeof m.content !== 'string') {
        for (const part of m.content) {
          if (part.type === 'tool-result') answered.add(part.toolCallId)
        }
      }
    }
    let dropped = 0
    this.messages = this.messages.map(m => {
      if (m.role !== 'assistant' || typeof m.content === 'string') return m
      const filtered = m.content.filter(part => {
        if (part.type !== 'tool-call') return true
        if (answered.has(part.toolCallId)) return true
        dropped++
        return false
      })
      return { ...m, content: filtered }
    }).filter(m => {
      // Drop assistant messages whose content is now empty.
      if (m.role !== 'assistant' || typeof m.content === 'string') return true
      return m.content.length > 0
    })
    if (dropped > 0) {
      this.invalidateModelMessagesCache()
      logger.info(`[MessageStore] Dropped ${dropped} orphan tool-call(s) (non-tool_in_flight interruption)`)
    }
  }

  /**
   * Inject the recovery system prose for the analyzed interruption state and
   * clear the state so the prose is only injected once. No-op when the state
   * is `{kind:'none'}`.
   */
  injectRecoveryPrompt(): void {
    const state = this.lastInterruption
    if (state.kind === 'none') return
    const prompt = recoveryPromptFor(state)
    if (prompt) this.appendSystem(prompt)
    this.clearLastInterruption()
  }
}

/** Flatten a ModelMessage to a compact line for the compression prompt. */
function renderMessageForSummary(m: ModelMessage): string {
  if (typeof m.content === 'string') return `${m.role}: ${stripCmdMarker(m.content)}`
  const segs: string[] = []
  for (const part of m.content) {
    if (part.type === 'text') segs.push(part.text)
    else if (part.type === 'tool-call') segs.push(`tool_call(${part.toolName}): ${JSON.stringify(part.input ?? {})}`)
    else if (part.type === 'tool-result') {
      const o = part.output
      const v = o && 'value' in o ? (typeof o.value === 'string' ? o.value : JSON.stringify(o.value)) : ''
      segs.push(`tool_result(${part.toolName}): ${String(v).slice(0, 500)}`)
    }
  }
  return `${m.role}: ${segs.join(' ')}`
}

/**
 * Convert a pre-D-1 Timeline (`items[]`) into ModelMessages equivalent to what
 * the v2 store records. Grouping rules, walking items in order:
 *   - `user`                       → flush any open assistant/tool turn, emit a user message
 *   - `assistant_thought`          → text part of the current assistant turn
 *   - `tool_call`                  → tool-call part of the current assistant turn
 *   - `tool_result`                → tool-result, paired by toolCallId into the
 *                                    tool message that follows the assistant turn
 *   - `skill_loaded`               → recorded as a loaded skill (no message)
 * Each assistant turn that issued tool-calls is followed by its tool message so
 * the call/result pairing stays provider-valid. tool_results with no matching
 * call (and unanswered calls) are tolerated — the existing toModelMessages
 * orphan repair handles edge cases.
 */
function convertLegacyTimeline(items: LegacyTimelineItem[]): { messages: ModelMessage[]; skills: string[] } {
  const messages: ModelMessage[] = []
  const skills: string[] = []

  // Parts accumulating for the in-progress assistant turn and its tool replies.
  let asstParts: Array<{ type: 'text'; text: string } | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }> = []
  let toolParts: Array<{ type: 'tool-result'; toolCallId: string; toolName: string; output: { type: 'text'; value: string } }> = []

  const flushTurn = () => {
    if (asstParts.length > 0) {
      // Drop tool-calls with no matching result in this turn — providers reject
      // an assistant tool-call that is never answered. Text-only turns survive.
      const answered = new Set(toolParts.map(t => t.toolCallId))
      const kept = asstParts.filter(p => p.type !== 'tool-call' || answered.has(p.toolCallId))
      if (kept.length > 0) messages.push({ role: 'assistant', content: kept })
      asstParts = []
    }
    if (toolParts.length > 0) {
      messages.push({ role: 'tool', content: toolParts })
      toolParts = []
    }
  }

  for (const it of items) {
    switch (it.type) {
      case 'user':
        flushTurn()
        messages.push({ role: 'user', content: stripNonceTags(it.content ?? '') })
        break
      case 'assistant_thought':
        if (it.content) asstParts.push({ type: 'text', text: it.content })
        break
      case 'tool_call': {
        const id = it.metadata?.toolCallId ?? `legacy_${messages.length}_${asstParts.length}`
        asstParts.push({
          type: 'tool-call',
          toolCallId: id,
          toolName: it.metadata?.toolName ?? 'unknown',
          input: it.metadata?.toolArgs ?? {},
        })
        break
      }
      case 'tool_result': {
        const id = it.metadata?.toolCallId
        // Only pair results that reference a call in the current turn; loose
        // results (no id / no matching call) are dropped to keep pairing valid.
        if (id && asstParts.some(p => p.type === 'tool-call' && p.toolCallId === id)) {
          toolParts.push({
            type: 'tool-result',
            toolCallId: id,
            toolName: it.metadata?.toolName ?? 'unknown',
            output: { type: 'text', value: it.content ?? '' },
          })
        }
        break
      }
      case 'skill_loaded': {
        const name = it.metadata?.skillName ?? it.content
        if (name && !skills.includes(name)) skills.push(name)
        break
      }
      // Unknown legacy types are ignored.
    }
  }
  flushTurn()

  return { messages, skills }
}

/**
 * Runtime safety net: drop any assistant tool-call without a matching
 * tool-result in some later tool message, AND drop any tool-result that has
 * no preceding tool-call. Provider validators (Anthropic in particular) will
 * reject the prompt with `Invalid prompt: messages do not match the
 * ModelMessage[] schema` if a single orphan slips through. This function is
 * intentionally cheap (single forward pass + filter) so we can run it on
 * every `toModelMessages()` call instead of relying on deserialize-time
 * repair alone — the repair path can still leak orphans when an iteration
 * gets aborted between assistant emit and tool execute.
 *
 * Returns a new array; never mutates input.
 */
function sanitizeToolPairing(messages: readonly ModelMessage[]): ModelMessage[] {
  // First pass: collect tool-result ids that exist somewhere in the trace.
  const resultIds = new Set<string>()
  // And collect tool-call ids ordered by appearance, so we can pair-check.
  const callIds = new Set<string>()
  for (const m of messages) {
    if (m.role === 'tool' && Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === 'tool-result') resultIds.add(part.toolCallId)
      }
    }
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === 'tool-call') callIds.add(part.toolCallId)
      }
    }
  }

  const out: ModelMessage[] = []
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const filtered = m.content.filter(part => {
        if (part.type !== 'tool-call') return true
        return resultIds.has(part.toolCallId)
      })
      if (filtered.length > 0) out.push({ ...m, content: filtered } as ModelMessage)
      continue
    }
    if (m.role === 'tool' && Array.isArray(m.content)) {
      const filtered = m.content.filter(part => {
        if (part.type !== 'tool-result') return true
        return callIds.has(part.toolCallId)
      })
      if (filtered.length > 0) out.push({ ...m, content: filtered } as ModelMessage)
      continue
    }
    out.push(m)
  }
  return out
}





