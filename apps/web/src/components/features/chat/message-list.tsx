import { useEffect, useRef, useState, useCallback, useMemo, memo } from 'react'
import type { UIMessage } from '@ai-sdk/react'
import { isToolUIPart, getToolName } from 'ai'
import { Bot, User, Copy, Check, AlertCircle, Sparkles, Wrench, Brain, ChevronDown, ShieldAlert, HelpCircle } from 'lucide-react'
import { ToolCallCard } from './tool-call-card'
import { SubagentCard } from './subagent-card'
import { TypingIndicator } from './typing-indicator'
import { MarkdownRenderer } from './markdown-renderer'
import type { AgentStatus } from './chat-status-bar'

/* ─── Tool invocation (normalized from v6 tool UI parts) ─── */

/**
 * A flattened view of a v6 tool UI part (`tool-${name}` / `dynamic-tool`).
 * v6 spreads tool state across the part itself (state/input/output) rather
 * than the v4 `{ toolInvocation: {...} }` wrapper, so we normalize once here
 * and the rest of the component renders from this stable shape.
 */
interface ToolInvocation {
  toolCallId: string
  toolName: string
  state: string
  args: unknown
  result?: unknown
}

/** Concatenate all text parts of a UIMessage into a single string. */
function messageText(msg: UIMessage): string {
  if (!msg.parts) return ''
  return msg.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map(p => p.text)
    .join('')
}

/** Normalize any v6 tool UI part into a ToolInvocation. Returns null otherwise. */
function toToolInvocation(part: UIMessage['parts'][number]): ToolInvocation | null {
  // isToolUIPart covers both `tool-${name}` and `dynamic-tool` parts.
  if (!isToolUIPart(part)) return null
  const p = part as {
    type: string
    toolCallId: string
    toolName?: string
    state: string
    input?: unknown
    output?: unknown
  }
  return {
    toolCallId: p.toolCallId,
    toolName: p.type === 'dynamic-tool' ? (p.toolName ?? 'unknown') : getToolName(part as never),
    state: p.state,
    args: p.input,
    result: p.output,
  }
}

/* ─── Incremental buildGroups cache ─── */

interface GroupsCache {
  messagesLen: number
  lastContent: string
  groups: MsgGroup[]
}

/**
 * Reconstruct an ask_user interactive Part from a persisted tool invocation.
 * On a history reload the streaming ASK_USER marker is gone (markers aren't
 * persisted), so ask_user comes back as a paired tool call/result. We turn it
 * back into an `ask_user` Part so the interactive card renders instead of a
 * generic tool card. The payload sits at result.summary (toHistoryMessages
 * wraps successful outputs as { success, summary }) or directly on the result.
 * Returns null if the shape doesn't carry a usable ask_user payload.
 */
function askUserPartFromTool(ti: ToolInvocation): Extract<Part, { type: 'ask_user' }> | null {
  const r = ti.result as Record<string, unknown> | undefined
  const payload = (r && typeof r === 'object' && 'summary' in r ? r.summary : r) as
    | { type?: string; question?: string; options?: AskUserOption[]; context?: string }
    | undefined
  if (!payload || payload.type !== 'ask_user' || !payload.question || !Array.isArray(payload.options)) {
    return null
  }
  return { type: 'ask_user', question: payload.question, options: payload.options, context: payload.context }
}

/**
 * Parse a single message into renderable parts. Walks `msg.parts` in native
 * order. REASONING / ASK_USER / TOOL_APPROVAL / SUBAGENT_STEP arrive as
 * dedicated `data-*` UI parts (non-transient) — read directly, no regex
 * extraction. Legacy embedded markers in text are still parsed as a fallback
 * for messages streamed before the migration.
 */
function parseMessageParts(msg: UIMessage): Part[] {
  const msgParts: Part[] = []
  if (!msg.parts) return msgParts

  for (const p of msg.parts) {
    // Dedicated data parts (current format) — structured, no regex needed.
    if (p.type === 'data-reasoning') {
      const d = (p as { data: { content?: string; iteration?: number } }).data
      if (d.content) msgParts.push({ type: 'reasoning', text: d.content, iteration: d.iteration })
      continue
    }
    if (p.type === 'data-tool-approval') {
      const d = (p as { data: { pending?: PendingApproval[] } }).data
      if (d.pending && d.pending.length > 0) msgParts.push({ type: 'approval', pending: d.pending })
      continue
    }
    if (p.type === 'data-subagent-step') {
      const d = (p as { data: { taskId?: string; description?: string; childStep?: SubagentChildStep } }).data
      if (d.taskId && d.description && d.childStep) {
        msgParts.push({ type: 'subagent_step', taskId: d.taskId, description: d.description, childStep: d.childStep })
      }
      continue
    }
    if (p.type === 'data-ask-user') {
      const d = (p as { data: { question?: string; options?: AskUserOption[]; context?: string } }).data
      if (d.question && d.options && d.options.length > 0) {
        msgParts.push({ type: 'ask_user', question: d.question, options: d.options, context: d.context })
      }
      continue
    }
    if (p.type === 'text') {
      if (p.text) {
        for (const seg of parseTextSegment(p.text)) pushSegment(msgParts, seg)
      }
      continue
    }
    const ti = toToolInvocation(p)
    if (!ti) continue
    // ask_user is rendered as an interactive card, never a generic tool card.
    // Live, it arrives via the data-ask-user part (the tool part is suppressed
    // server-side); on reload it comes back as a tool part — reconstruct the
    // card from it here.
    if (ti.toolName === 'ask_user') {
      const askPart = askUserPartFromTool(ti)
      if (askPart) msgParts.push(askPart)
      continue
    }
    msgParts.push({ type: 'tool', invocation: ti })
  }

  return msgParts
}

/**
 * Incremental version of buildGroups:
 * - Full recompute only when message count changes
 * - During streaming (same count), only re-parse the last message
 */
function useIncrementalGroups(messages: UIMessage[]): MsgGroup[] {
  const cacheRef = useRef<GroupsCache>({ messagesLen: 0, lastContent: '', groups: [] })

  return useMemo(() => {
    const len = messages.length
    const lastMsg = messages[len - 1]
    const lastContent = lastMsg ? messageText(lastMsg) : ''

    // Full recompute: message count changed or cache empty
    if (len !== cacheRef.current.messagesLen) {
      const groups = buildGroups(messages)
      cacheRef.current = { messagesLen: len, lastContent, groups }
      return groups
    }

    // Streaming: only last message content may have changed
    if (lastContent !== cacheRef.current.lastContent) {
      const cached = [...cacheRef.current.groups]
      if (cached.length > 0 && lastMsg) {
        const lastGroupIdx = cached.length - 1
        // Rebuild the last group from the last message
        const visibleMessages = messages.filter(m => m.role === 'user' || m.role === 'assistant')
        const lastVisibleIdx = visibleMessages.length - 1
        if (lastVisibleIdx >= 0) {
          const newParts = parseMessageParts(lastMsg)

          // Determine if we need a new group or should merge into existing last group
          const lastGroup = cached[lastGroupIdx]
          // Check if last message's role matches last group's role
          // Simple approach: always replace the last group's parts if it matches
          // For streaming, the last group should be assistant (the one being streamed)
          if (lastGroup && lastGroup.role === lastMsg.role) {
            // Replace parts in the last group (keep the group structure)
            cached[lastGroupIdx] = { ...lastGroup, id: lastMsg.id, parts: newParts }
          } else {
            // Role changed — append new group
            cached.push({ role: lastMsg.role as 'user' | 'assistant', id: lastMsg.id, parts: newParts })
          }
        }
      }
      cacheRef.current = { messagesLen: len, lastContent, groups: cached }
      return cached
    }

    // No change at all
    return cacheRef.current.groups
  }, [messages])
}

interface MessageListProps {
  messages: UIMessage[]
  isLoading: boolean
  error?: Error | null
  agentStatus?: AgentStatus
  statusMessage?: string
  /**
   * Submit tool-approval decisions for a paused HITL run. Resolves once the
   * resume request has been dispatched. Absent ⇒ approval controls render
   * disabled (e.g. read-only history view).
   */
  onApprove?: (decisions: Array<{ toolCallId: string; approved: boolean }>) => void
  /**
   * Send a user message in response to an ask_user prompt. Used by AskUserCard
   * when the user clicks an option. Falls back to disabled buttons if absent
   * (e.g. read-only history view).
   */
  onSendChoice?: (text: string) => void
}

/* ─── Types ─── */

type Part =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string; iteration?: number }
  | { type: 'tool'; invocation: ToolInvocation }
  | { type: 'approval'; pending: PendingApproval[] }
  | { type: 'subagent_step'; taskId: string; description: string; childStep: SubagentChildStep }
  | { type: 'ask_user'; question: string; options: AskUserOption[]; context?: string }

/** Single option in an ask_user prompt. */
export interface AskUserOption {
  label: string
  description: string
}

/** A single step from a sub-agent forwarded to the parent stream. */
interface SubagentChildStep {
  type: string
  toolName?: string
  toolCallId?: string
  args?: unknown
  result?: unknown
  error?: string
  content?: string
  reason?: string
}

/** A tool call paused awaiting user approval (HITL). */
export interface PendingApproval {
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  reason: string
}

interface MsgGroup {
  role: 'user' | 'assistant'
  id: string
  parts: Part[]
}

/** Regex to find reasoning markers embedded in text. */
const REASONING_REGEX = /<!--REASONING:({.*?})-->/g
/** Regex to find tool-approval markers embedded in text. */
const TOOL_APPROVAL_REGEX = /<!--TOOL_APPROVAL:([\s\S]*?)-->/g
/** Regex to find sub-agent step markers embedded in text. */
const SUBAGENT_STEP_REGEX = /<!--SUBAGENT_STEP:([\s\S]*?)-->/g
/**
 * Base64-encoded sub-agent step marker. Backend encodes the payload so that a
 * child tool_result carrying raw HTML (which can contain `-->`) cannot
 * prematurely close the comment and leak its tail as plain text. The base64
 * alphabet contains no `-`/`>`, so `[^-]` safely runs to the real delimiter.
 */
const SUBAGENT_STEP_B64_REGEX = /<!--SUBAGENT_STEP_B64:([A-Za-z0-9+/=]*?)-->/g
/** Regex to find ask-user markers embedded in text. */
const ASK_USER_REGEX = /<!--ASK_USER:([\s\S]*?)-->/g

/** UTF-8-safe base64 decode (atob yields latin1 bytes; re-decode as UTF-8). */
function decodeB64Utf8(b64: string): string {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

type ParsedSegment =
  | { type: 'text'; text: string; iteration?: number }
  | { type: 'reasoning'; text: string; iteration?: number }
  | { type: 'approval'; pending: PendingApproval[] }
  | { type: 'subagent_step'; taskId: string; description: string; childStep: SubagentChildStep }
  | { type: 'ask_user'; question: string; options: AskUserOption[]; context?: string }

function parseTextSegment(text: string): ParsedSegment[] {
  const segments: ParsedSegment[] = []
  // Collect every marker (reasoning + approval) with its position, then walk
  // the text once emitting plain-text gaps and the decoded markers in order.
  type Marker = { start: number; end: number; seg: ParsedSegment | null }
  const markers: Marker[] = []

  REASONING_REGEX.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = REASONING_REGEX.exec(text)) !== null) {
    let seg: ParsedSegment | null = null
    try {
      const data = JSON.parse(m[1]) as { content?: string; iteration?: number }
      if (data.content) seg = { type: 'reasoning', text: data.content, iteration: data.iteration }
    } catch { /* malformed — drop */ }
    markers.push({ start: m.index, end: REASONING_REGEX.lastIndex, seg })
  }

  TOOL_APPROVAL_REGEX.lastIndex = 0
  while ((m = TOOL_APPROVAL_REGEX.exec(text)) !== null) {
    let seg: ParsedSegment | null = null
    try {
      const data = JSON.parse(m[1]) as { pending?: PendingApproval[] }
      if (data.pending && data.pending.length > 0) seg = { type: 'approval', pending: data.pending }
    } catch { /* malformed — drop */ }
    markers.push({ start: m.index, end: TOOL_APPROVAL_REGEX.lastIndex, seg })
  }

  SUBAGENT_STEP_REGEX.lastIndex = 0
  while ((m = SUBAGENT_STEP_REGEX.exec(text)) !== null) {
    let seg: ParsedSegment | null = null
    try {
      const data = JSON.parse(m[1]) as { taskId?: string; description?: string; childStep?: SubagentChildStep }
      if (data.taskId && data.description && data.childStep) {
        seg = { type: 'subagent_step', taskId: data.taskId, description: data.description, childStep: data.childStep }
      }
    } catch { /* malformed — drop */ }
    markers.push({ start: m.index, end: SUBAGENT_STEP_REGEX.lastIndex, seg })
  }

  // Base64 variant (current format). Decoded payload is identical shape.
  SUBAGENT_STEP_B64_REGEX.lastIndex = 0
  while ((m = SUBAGENT_STEP_B64_REGEX.exec(text)) !== null) {
    let seg: ParsedSegment | null = null
    try {
      const data = JSON.parse(decodeB64Utf8(m[1])) as { taskId?: string; description?: string; childStep?: SubagentChildStep }
      if (data.taskId && data.description && data.childStep) {
        seg = { type: 'subagent_step', taskId: data.taskId, description: data.description, childStep: data.childStep }
      }
    } catch { /* malformed — drop */ }
    markers.push({ start: m.index, end: SUBAGENT_STEP_B64_REGEX.lastIndex, seg })
  }

  ASK_USER_REGEX.lastIndex = 0
  while ((m = ASK_USER_REGEX.exec(text)) !== null) {
    let seg: ParsedSegment | null = null
    try {
      const data = JSON.parse(m[1]) as { question?: string; options?: AskUserOption[]; context?: string }
      if (data.question && data.options && data.options.length > 0) {
        seg = { type: 'ask_user', question: data.question, options: data.options, context: data.context }
      }
    } catch { /* malformed — drop */ }
    markers.push({ start: m.index, end: ASK_USER_REGEX.lastIndex, seg })
  }

  markers.sort((a, b) => a.start - b.start)

  let lastIndex = 0
  for (const mk of markers) {
    const before = text.slice(lastIndex, mk.start)
    if (before.trim()) segments.push({ type: 'text', text: before })
    if (mk.seg) segments.push(mk.seg)
    lastIndex = mk.end
  }
  const after = text.slice(lastIndex)
  if (after.trim()) segments.push({ type: 'text', text: after })
  return segments
}

/** Push a parsed segment as a renderable Part (shared by all parse paths). */
function pushSegment(msgParts: Part[], seg: ParsedSegment): void {
  if (seg.type === 'text') {
    if (seg.text.trim()) msgParts.push({ type: 'text', text: sanitizeArtifacts(seg.text) })
  } else if (seg.type === 'reasoning') {
    msgParts.push({ type: 'reasoning', text: seg.text, iteration: seg.iteration })
  } else if (seg.type === 'subagent_step') {
    msgParts.push({ type: 'subagent_step', taskId: seg.taskId, description: seg.description, childStep: seg.childStep })
  } else if (seg.type === 'ask_user') {
    msgParts.push({ type: 'ask_user', question: seg.question, options: seg.options, context: seg.context })
  } else {
    msgParts.push({ type: 'approval', pending: seg.pending })
  }
}

/* ─── Artifact tag sanitizer (frontend defense layer) ─── */
function sanitizeArtifacts(text: string): string {
  let cleaned = text
    .replace(/<\/?ｐｐDSMLｐｐ[^>]*>/g, '')
    .replace(/<\/?\|\|DSML\|\|[^>]*>/g, '')
    .replace(/<\/?previous[^>]*>/gi, '')
    .replace(/<\/?assistant[^>]*>/gi, '')
    .replace(/<\/?invoke[^>]*>/gi, '')
    .replace(/<\/?function[^>]*>/gi, '')
    .replace(/<\|TAG_[A-Z0-9]+\|>/g, '')
    .replace(/<\|TAG_END_[A-Z0-9]+\|>/g, '')
    .replace(/<\/(user|system|think|analysis)[^>]*>/gi, '')
    .replace(/<\s*(user|system|think|analysis)\s*>/gi, '')
    .replace(/\|\|tool_calls\|\|/g, '')

  // Strip tool_call / tool_result dumps that the model mimicked in plain text.
  // These appear when the model copies Timeline formatting into its response.
  cleaned = cleaned.replace(/tool_call\([^)]+\):\s*/g, '')
  cleaned = cleaned.replace(/tool_result\([^)]+\):\s*/g, '')

  // Strip standalone JSON blobs that look like http_request arg dumps.
  cleaned = cleaned.replace(/\{"method"\s*:\s*"(GET|POST|PUT|DELETE|PATCH)"\s*,\s*"url"\s*:\s*"[^"]*"[^}]*\}/g, '')

  // Collapse large JSON blobs that the model accidentally dumped into text
  cleaned = collapseJsonBlocks(cleaned, 150)

  // Deduplicate repeated stagnation nudges (e.g. "连续 X 轮无新发现")
  const seenNudges = new Set<string>()
  cleaned = cleaned.split('\n').map(line => {
    const trimmed = line.trim()
    if (/连续 \d+ 轮无新发现/.test(trimmed) || /连续 \d+ 次 404/.test(trimmed)) {
      if (seenNudges.has(trimmed)) return ''
      seenNudges.add(trimmed)
    }
    return line
  }).join('\n')

  return cleaned.trim()
}

/**
 * Replace large JSON blocks with a compact placeholder.
 * Uses bracket counting so nested structures are handled correctly.
 */
function collapseJsonBlocks(text: string, minLen: number): string {
  let result = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch !== '{' && ch !== '[') {
      result += ch
      i++
      continue
    }
    const start = i
    const open = ch
    const close = open === '{' ? '}' : ']'
    let depth = 1
    let inString = false
    let escape = false
    i++
    while (i < text.length && depth > 0) {
      const c = text[i]
      if (escape) {
        escape = false
      } else if (c === '\\') {
        escape = true
      } else if (c === '"' && inString) {
        inString = false
      } else if (c === '"' && !inString) {
        inString = true
      } else if (!inString) {
        if (c === open) depth++
        else if (c === close) depth--
      }
      i++
    }
    const block = text.slice(start, i)
    if (block.length >= minLen) {
      try {
        JSON.parse(block)
        const hint =
          block.includes('"status"') || block.includes('"error"')
            ? '工具返回数据'
            : 'JSON 数据块'
        result += `[${hint} ${block.length} 字符 — 已折叠]`
        continue
      } catch {
        // not valid JSON — fall through to append raw
      }
    }
    result += block
  }
  return result
}

/* ─── Tool error parser ─── */

interface ToolErrorInfo {
  toolName: string
  message: string
}

function parseToolError(error: Error | null | undefined): ToolErrorInfo | null {
  if (!error) return null
  const msg = error.message || ''
  // Pattern 1: [TOOL_ERROR|toolName] message
  const m1 = msg.match(/\[TOOL_ERROR\|([^\]]+)\]\s*(.+)/)
  if (m1) {
    return { toolName: m1[1], message: m1[2] }
  }
  // Pattern 2: Model tried to call unavailable tool 'xxx'
  const m2 = msg.match(/unavailable tool ['"]([^'"]+)['"]/)
  if (m2) {
    return {
      toolName: m2[1],
      message: `工具 "${m2[1]}" 不可用。可用工具: http_request, add_endpoint, add_finding, query_knowledge。请改用 http_request 继续。`,
    }
  }
  // Pattern 3: NoSuchToolError
  const m3 = msg.match(/NoSuchToolError.*tool\s+['"]?([^'"\s]+)['"]?/)
  if (m3) {
    return {
      toolName: m3[1],
      message: `工具 "${m3[1]}" 不可用。请改用 http_request 继续。`,
    }
  }
  return null
}

/* ─── Utilities ─── */

function buildGroups(msgs: UIMessage[]): MsgGroup[] {
  const groups: MsgGroup[] = []

  for (const msg of msgs) {
    // Only render user / assistant turns. AI SDK's UIMessage also carries
    // `system` role which is not part of the visible chat UI.
    if (msg.role !== 'user' && msg.role !== 'assistant') continue

    const last = groups[groups.length - 1]
    // Parts arrive in native chronological order (text / tool interleaved);
    // parseMessageParts decodes embedded reasoning/approval markers per text run.
    const msgParts = parseMessageParts(msg)

    if (last && last.role === msg.role) {
      last.parts.push(...msgParts)
    } else {
      groups.push({ role: msg.role, id: msg.id, parts: msgParts })
    }
  }

  return groups
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* ignore */ }
  }, [text])

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="rounded-md p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors opacity-0 group-hover:opacity-100"
      aria-label={copied ? '已复制' : '复制'}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  )
}

/* ─── User message ─── */

const UserMessage = memo(function UserMessage({ group }: { group: MsgGroup }) {
  const text = group.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map(p => p.text)
    .join('')

  return (
    <div className="flex gap-3 flex-row-reverse group">
      <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-[var(--accent)] text-[var(--accent-foreground)] flex items-center justify-center text-xs mt-0.5">
        <User size={14} />
      </div>
      <div className="flex flex-col gap-1 max-w-[85%] min-w-0 items-end">
        <div className="text-[10px] text-[var(--text-muted)] font-medium px-1">你</div>
        {text && (
          <div className="relative rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-all overflow-hidden bg-[var(--accent)]/90 text-[var(--accent-foreground)] rounded-tr-sm">
            {text}
          </div>
        )}
      </div>
    </div>
  )
})

/* ─── Inline tool error card ─── */

function InlineToolError({ toolName, message }: ToolErrorInfo) {
  return (
    <div className="rounded-lg border border-[#e76a5e]/20 bg-[#e76a5e]/5 text-sm overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <Wrench size={12} className="text-[#e76a5e] flex-shrink-0" />
          <span className="font-medium text-[#e76a5e] text-xs truncate">{toolName}</span>
          <span className="flex items-center gap-1 text-[10px] text-[#e76a5e]">
            <span className="w-1.5 h-1.5 rounded-full bg-[#e76a5e]" />
            失败
          </span>
        </div>
      </div>
      <div className="px-3 pb-2 text-xs text-[#e76a5e] leading-relaxed border-t border-[#e76a5e]/10 pt-2">
        {message}
      </div>
    </div>
  )
}

/* ─── Reasoning section (collapsible, below message bubble) ─── */

function ReasoningSection({
  blocks,
  streaming,
}: {
  blocks: Array<{ text: string; iteration?: number }>
  streaming: boolean
}) {
  // During streaming, show ONLY the latest iteration as a typewriter — collapsed
  // by default; click the header to expand. When the round finishes, fall back to
  // a collapsible panel containing every reasoning block from this assistant turn.
  const latest = blocks[blocks.length - 1]
  const [expanded, setExpanded] = useState(false)
  if (blocks.length === 0) return null

  if (streaming && latest) {
    return (
      <div className="mb-1.5 rounded-lg border border-[var(--accent)]/30 bg-[var(--accent)]/5 overflow-hidden">
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          className="w-full flex items-center gap-2 px-3 py-2 text-[11px] text-[var(--accent)] hover:bg-[var(--accent)]/10 transition-colors"
        >
          <Brain size={12} className="animate-pulse" />
          <span className="font-medium">正在思考…</span>
          {latest.iteration !== undefined && (
            <span className="text-[10px] opacity-60">第 {latest.iteration} 轮</span>
          )}
          <ChevronDown
            size={12}
            className={`ml-auto transition-transform ${expanded ? 'rotate-180' : ''}`}
          />
        </button>
        {expanded && (
          <div className="px-3 pb-3 border-t border-[var(--accent)]/15">
            <div className="text-xs text-[var(--text-muted)] leading-relaxed whitespace-pre-wrap break-all pt-2">
              {latest.text}
              <span className="inline-block w-1.5 h-3 ml-0.5 bg-[var(--accent)] align-middle animate-pulse" />
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="mb-1.5 rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
      >
        <Brain size={12} />
        <span className="font-medium">深度思考</span>
        <span className="text-[10px] opacity-60">({blocks.length})</span>
        <ChevronDown
          size={12}
          className={`ml-auto transition-transform ${expanded ? 'rotate-180' : ''}`}
        />
      </button>
      {expanded && (
        <div className="px-3 pb-3 space-y-2 border-t border-[var(--border)]">
          {blocks.map((b, i) => (
            <div key={i} className="text-xs text-[var(--text-muted)] leading-relaxed">
              {b.iteration !== undefined && (
                <div className="text-[10px] font-medium opacity-50 mb-0.5">
                  第 {b.iteration} 轮
                </div>
              )}
              <div className="whitespace-pre-wrap break-all">{b.text}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* ─── Tool-approval card (HITL) ─── */

function ApprovalCard({
  pending,
  onApprove,
  resolved,
}: {
  pending: PendingApproval[]
  onApprove?: (decisions: Array<{ toolCallId: string; approved: boolean }>) => void
  resolved: boolean
}) {
  const [submitted, setSubmitted] = useState(false)
  const disabled = submitted || resolved || !onApprove

  const decide = (approved: boolean) => {
    if (disabled) return
    setSubmitted(true)
    onApprove?.(pending.map(p => ({ toolCallId: p.toolCallId, approved })))
  }

  return (
    <div className="py-1">
      <div className="rounded-lg border border-[#e0a23b]/30 bg-[#e0a23b]/5 px-4 py-3">
        <div className="flex items-center gap-2 text-[#e0a23b] mb-2">
          <ShieldAlert size={14} />
          <span className="text-xs font-medium">需要确认操作</span>
        </div>
        <div className="space-y-1.5 mb-3">
          {pending.map(p => (
            <div key={p.toolCallId} className="text-xs text-[var(--text-secondary)]">
              <span className="font-mono font-medium text-[var(--text-primary)]">{p.toolName}</span>
              <span className="opacity-60"> — {p.reason}</span>
              <pre className="mt-1 whitespace-pre-wrap break-all text-[11px] text-[var(--text-muted)] bg-[var(--bg-surface)] rounded px-2 py-1 border border-[var(--border)]">
                {JSON.stringify(p.args, null, 2)}
              </pre>
            </div>
          ))}
        </div>
        {disabled ? (
          <div className="text-[11px] text-[var(--text-muted)]">
            {submitted ? '已提交决定' : '此操作已处理'}
          </div>
        ) : (
          <div className="flex gap-2">
            <button
              onClick={() => decide(true)}
              className="px-3 py-1.5 rounded-md bg-[#3b9e6a] text-white text-xs font-medium hover:opacity-90 transition-opacity"
            >
              批准执行
            </button>
            <button
              onClick={() => decide(false)}
              className="px-3 py-1.5 rounded-md bg-[var(--bg-surface)] text-[var(--text-secondary)] text-xs font-medium border border-[var(--border)] hover:opacity-90 transition-opacity"
            >
              拒绝
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/* ─── Ask-user card (model asks user for input) ─── */

function AskUserCard({
  question,
  options,
  context,
  onSendChoice,
  resolved,
}: {
  question: string
  options: AskUserOption[]
  context?: string
  onSendChoice?: (text: string) => void
  resolved: boolean
}) {
  const [submitted, setSubmitted] = useState(false)
  const disabled = submitted || resolved || !onSendChoice

  const choose = (label: string) => {
    if (disabled) return
    setSubmitted(true)
    onSendChoice?.(label)
  }

  return (
    <div className="py-1">
      <div className="rounded-lg border border-[var(--accent)]/30 bg-[var(--accent)]/5 px-4 py-3">
        <div className="flex items-center gap-2 text-[var(--accent)] mb-2">
          <HelpCircle size={14} />
          <span className="text-xs font-medium">需要你的回应</span>
        </div>
        <div className="text-sm text-[var(--text-primary)] mb-2 leading-relaxed">{question}</div>
        {context && (
          <div className="text-[11px] text-[var(--text-muted)] mb-3 leading-relaxed">{context}</div>
        )}
        {disabled ? (
          <div className="text-[11px] text-[var(--text-muted)]">
            {submitted ? '已发送选择' : '此提问已结束'}
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {options.map((opt, i) => (
              <button
                key={i}
                onClick={() => choose(opt.label)}
                className="text-left px-3 py-2 rounded-md bg-[var(--bg-surface)] border border-[var(--border)] hover:border-[var(--accent)]/50 hover:bg-[var(--bg-hover)] transition-colors"
              >
                <div className="text-xs font-medium text-[var(--text-primary)]">{opt.label}</div>
                {opt.description && (
                  <div className="text-[11px] text-[var(--text-muted)] mt-0.5">{opt.description}</div>
                )}
              </button>
            ))}
            <div className="text-[11px] text-[var(--text-muted)] mt-1">或在下方直接输入自定义回答</div>
          </div>
        )}
      </div>
    </div>
  )
}

/* ─── Assistant message ─── */
function AssistantMessageImpl({
  group,
  isLast,
  isLoading,
  toolError,
  onApprove,
  onSendChoice,
}: {
  group: MsgGroup
  isLast: boolean
  isLoading: boolean
  toolError?: ToolErrorInfo
  onApprove?: (decisions: Array<{ toolCallId: string; approved: boolean }>) => void
  onSendChoice?: (text: string) => void
}) {
  const allText = group.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map(p => p.text)
    .join('')

  const reasoningBlocks = group.parts
    .filter((p): p is { type: 'reasoning'; text: string; iteration?: number } => p.type === 'reasoning')
    .reduce<Array<{ text: string; iteration?: number }>>((acc, p) => {
      // Merge consecutive reasoning blocks with the same iteration number
      // to avoid rendering dozens of tiny blocks (each token = 1 block
      // when backend sends per-token REASONING markers).
      const last = acc[acc.length - 1]
      if (last && last.iteration === p.iteration) {
        last.text += p.text
      } else {
        acc.push({ text: p.text, iteration: p.iteration })
      }
      return acc
    }, [])

  // Aggregate subagent steps by taskId for collapsible cards
  const subagentGroups = useMemo(() => {
    const map = new Map<string, { description: string; steps: SubagentChildStep[] }>()
    for (const part of group.parts) {
      if (part.type !== 'subagent_step') continue
      let entry = map.get(part.taskId)
      if (!entry) {
        entry = { description: part.description, steps: [] }
        map.set(part.taskId, entry)
      }
      entry.steps.push(part.childStep)
    }
    return map
  }, [group.parts])

  return (
    <div className="flex gap-3 group">
      {/* Avatar */}
      <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-[var(--bg-surface)] text-[var(--text-muted)] border border-[var(--border)] flex items-center justify-center text-xs mt-0.5">
        <Bot size={14} />
      </div>

      {/* Content container */}
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        {/* Header */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-[var(--text-muted)] font-medium">src-huNter-</span>
          {allText && (
            <div className="opacity-0 group-hover:opacity-100 transition-opacity">
              <CopyButton text={allText} />
            </div>
          )}
        </div>

        {/* Reasoning blocks above the message bubble */}
        {reasoningBlocks.length > 0 && (
          <ReasoningSection blocks={reasoningBlocks} streaming={isLast && isLoading} />
        )}

        {/* Body card */}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] overflow-hidden">
          {/* Render parts in chronological order */}
          <div className="px-4 py-3">
            {group.parts.map((part, i) => {
              const prevPart = group.parts[i - 1]
              const showDivider = prevPart && prevPart.type !== part.type

              if (part.type === 'text') {
                if (!part.text.trim()) return null
                return (
                  <div key={`text-${i}`} className="text-sm text-[var(--text-secondary)] leading-relaxed py-1">
                    {showDivider && (
                      <div className="border-t border-[var(--border)] mb-2 -mx-4 px-4 pt-2 opacity-50" />
                    )}
                    <MarkdownRenderer content={part.text} />
                  </div>
                )
              }

              if (part.type === 'tool') {
                const ti = part.invocation
                // v6 tool states: input-streaming / input-available (in
                // progress) → 'call'; output-available / output-error → 'result'.
                const hasResult = ti.state === 'output-available' || ti.state === 'output-error'
                const cardState: 'call' | 'result' = hasResult ? 'result' : 'call'
                const cardResult = hasResult ? ti.result : undefined
                return (
                  <div key={`tool-${i}-${ti.toolName}`} className="py-1">
                    {showDivider && (
                      <div className="border-t border-[var(--border)] mb-2 -mx-4 px-4 pt-2 opacity-50" />
                    )}
                    <ToolCallCard
                      toolName={ti.toolName}
                      state={cardState}
                      args={(ti.args ?? {}) as Record<string, unknown>}
                      result={cardResult}
                      error={cardState === 'result' && cardResult && typeof cardResult === 'object' && 'error' in cardResult
                        ? String((cardResult as Record<string, unknown>).error)
                        : undefined}
                    />
                  </div>
                )
              }

              if (part.type === 'approval') {
                return (
                  <div key={`approval-${i}`} className="py-1">
                    {showDivider && (
                      <div className="border-t border-[var(--border)] mb-2 -mx-4 px-4 pt-2 opacity-50" />
                    )}
                    {/* Only the last assistant turn can still be awaiting a
                        decision; earlier ones were already resolved by a
                        subsequent turn, so render them read-only. */}
                    <ApprovalCard pending={part.pending} onApprove={onApprove} resolved={!isLast} />
                  </div>
                )
              }

              if (part.type === 'ask_user') {
                return (
                  <div key={`ask-user-${i}`} className="py-1">
                    {showDivider && (
                      <div className="border-t border-[var(--border)] mb-2 -mx-4 px-4 pt-2 opacity-50" />
                    )}
                    <AskUserCard
                      question={part.question}
                      options={part.options}
                      context={part.context}
                      onSendChoice={onSendChoice}
                      resolved={!isLast}
                    />
                  </div>
                )
              }

              if (part.type === 'subagent_step') {
                // Render the SubagentCard only on the first occurrence of this taskId
                const isFirst = group.parts.findIndex(
                  p => p.type === 'subagent_step' && p.taskId === part.taskId
                ) === i
                if (!isFirst) return null
                const grouped = subagentGroups.get(part.taskId)
                if (!grouped) return null
                return (
                  <div key={`subagent-${part.taskId}`} className="py-1">
                    {showDivider && (
                      <div className="border-t border-[var(--border)] mb-2 -mx-4 px-4 pt-2 opacity-50" />
                    )}
                    <SubagentCard
                      taskId={part.taskId}
                      description={grouped.description}
                      steps={grouped.steps}
                    />
                  </div>
                )
              }

              return null
            })}

            {/* Tool error appended inline */}
            {toolError && (
              <div className="pt-1">
                <div className="border-t border-[var(--border)] mb-2 -mx-4 px-4 pt-2 opacity-50" />
                <InlineToolError toolName={toolError.toolName} message={toolError.message} />
              </div>
            )}
          </div>

          {/* Loading indicator inside the card */}
          {isLast && isLoading && !toolError && (
            <div className="px-4 pb-3 pt-1 border-t border-[var(--border)]">
              <TypingIndicator />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// memo with default shallow prop comparison. useIncrementalGroups keeps the
// `group` reference stable for every non-streaming message (only the last,
// actively-streaming group gets a fresh reference per throttled tick), and the
// callback props are stabilized in useSessionChat — so during streaming only
// the last AssistantMessage re-renders, not the whole history.
const AssistantMessage = memo(AssistantMessageImpl)

/* ─── Generic error display (non-tool errors) ─── */

function ErrorDisplay({ error }: { error: Error }) {
  return (
    <div className="flex gap-3">
      <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-[#e76a5e]/10 border border-[#e76a5e]/20 flex items-center justify-center text-[#e76a5e] mt-0.5">
        <AlertCircle size={14} />
      </div>
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        <div className="text-[10px] text-[#e76a5e]/60 font-medium">错误</div>
        <div className="bg-[#e76a5e]/5 text-[#e76a5e] border border-[#e76a5e]/20 rounded-lg px-4 py-2.5 text-sm leading-relaxed break-all">
          {error.message || '发送消息失败，请稍后重试'}
        </div>
      </div>
    </div>
  )
}

/* ─── Main component ─── */

export function MessageList({ messages, isLoading, error, onApprove, onSendChoice }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const [hitBottom, setHitBottom] = useState(true)
  // rAF-based scroll throttling: prevents multiple smooth animations from conflicting
  const scrollRafRef = useRef<number>(0)

  const groups = useIncrementalGroups(messages)
  const toolError = useMemo(() => parseToolError(error), [error])

  // Auto-scroll: throttled to once per animation frame to avoid jitter
  useEffect(() => {
    if (!autoScroll || !bottomRef.current) return

    if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current)
    scrollRafRef.current = requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({ behavior: 'instant' })
      scrollRafRef.current = 0
    })
  }, [messages, autoScroll])

  const handleScroll = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30
    setHitBottom(atBottom)
    setAutoScroll(atBottom)
  }, [])

  const scrollToBottom = useCallback(() => {
    setAutoScroll(true)
    // User-initiated scroll: use smooth for nice visual feedback
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  // Determine if tool error should be attached to last assistant message
  const lastGroup = groups[groups.length - 1]
  const attachToolError = toolError && lastGroup?.role === 'assistant'

  return (
    <div className="flex-1 min-h-0 relative">
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto overflow-x-hidden px-4 py-4 space-y-6 custom-scrollbar"
      >
        {messages.length === 0 && (
          <div className="flex h-full items-center justify-center">
            <div className="text-center space-y-3">
              <div className="w-16 h-16 mx-auto rounded-2xl bg-[var(--accent)]/10 border border-[var(--accent)]/20 flex items-center justify-center">
                <Sparkles size={28} className="text-[var(--accent)]" />
              </div>
              <div className="font-semibold text-[var(--text-primary)] text-base">src-huNter- 已就绪</div>
              <div className="text-xs text-[var(--text-muted)] max-w-[280px] leading-relaxed">
                输入目标域名开始接口发现，或在左侧图谱中选择接口进行漏洞测试
              </div>
              <div className="flex gap-2 justify-center pt-2">
                <span className="px-2.5 py-1 rounded-md bg-[var(--bg-surface)] text-[11px] text-[var(--text-muted)] border border-[var(--border)]">
                  发现接口
                </span>
                <span className="px-2.5 py-1 rounded-md bg-[var(--bg-surface)] text-[11px] text-[var(--text-muted)] border border-[var(--border)]">
                  测试漏洞
                </span>
                <span className="px-2.5 py-1 rounded-md bg-[var(--bg-surface)] text-[11px] text-[var(--text-muted)] border border-[var(--border)]">
                  生成报告
                </span>
              </div>
            </div>
          </div>
        )}

        {groups.map((group, idx) => {
          const isLast = idx === groups.length - 1
          if (group.role === 'user') {
            return <UserMessage key={group.id} group={group} />
          }
          return (
            <AssistantMessage
              key={group.id}
              group={group}
              isLast={isLast}
              isLoading={isLast && isLoading}
              toolError={attachToolError && isLast ? toolError : undefined}
              onApprove={onApprove}
              onSendChoice={onSendChoice}
            />
          )
        })}

        {/* Generic error (non-tool errors) */}
        {error && !toolError && <ErrorDisplay error={error} />}

        {/* Standalone typing indicator when assistant hasn't started yet */}
        {isLoading && groups.length > 0 && groups[groups.length - 1].role === 'user' && (
          <div className="flex gap-3">
            <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-[var(--bg-surface)] border border-[var(--border)] flex items-center justify-center text-[var(--text-muted)] mt-0.5">
              <Bot size={14} />
            </div>
            <div className="flex-1 min-w-0 flex flex-col gap-1">
              <div className="text-[10px] text-[var(--text-muted)] font-medium">src-huNter-</div>
              <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] px-4 py-3">
                <TypingIndicator />
              </div>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Scroll to bottom button */}
      {!hitBottom && messages.length > 0 && (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 rounded-full bg-[var(--bg-surface)] border border-[var(--border)] px-3 py-1.5 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--border-strong)] transition-colors shadow-lg"
        >
          <span>最新消息</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 5v14M5 12l7 7 7-7" />
          </svg>
        </button>
      )}
    </div>
  )
}
