/**
 * Local ModelMessage[] structure validator.
 *
 * The Vercel AI SDK validates `messages` synchronously inside streamText() and,
 * on failure, throws a generic "The messages do not match the ModelMessage[]
 * schema" with NO pointer to which message or part is malformed. That makes
 * provider-specific shape bugs (e.g. DeepSeek emitting an empty text part, or a
 * tool-call missing toolCallId) nearly impossible to triage from logs alone.
 *
 * This validator runs the SAME prompt locally BEFORE handing it to streamText,
 * pinpointing the exact messageIndex / partIndex / reason so the agent loop can
 * log it and dump the offending payload to disk. It is intentionally permissive
 * about fields the SDK tolerates and strict only about what the SDK rejects.
 */

import type { ModelMessage } from 'ai'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface MessageIssue {
  /** Index into the messages array. */
  messageIndex: number
  /** Role of the offending message. */
  role: string
  /** Index into the message's content parts, when the problem is part-level. */
  partIndex?: number
  /** Part type, when applicable. */
  partType?: string
  /** Human-readable reason the SDK would reject this. */
  reason: string
}

export interface ValidationResult {
  ok: boolean
  issues: MessageIssue[]
}

const VALID_ROLES = new Set(['system', 'user', 'assistant', 'tool'])

function isNonEmptyString(v: unknown): boolean {
  return typeof v === 'string' && v.length > 0
}

/**
 * Scan a ModelMessage[] for structural problems that would make streamText
 * reject the prompt. Returns every issue found (not just the first) so a single
 * dump captures the full picture.
 */
export function validateModelMessages(messages: readonly ModelMessage[]): ValidationResult {
  const issues: MessageIssue[] = []

  if (!Array.isArray(messages)) {
    return { ok: false, issues: [{ messageIndex: -1, role: 'n/a', reason: 'messages is not an array' }] }
  }

  messages.forEach((m, messageIndex) => {
    const role = (m as { role?: string })?.role ?? 'undefined'

    if (!m || typeof m !== 'object') {
      issues.push({ messageIndex, role, reason: 'message is null or not an object' })
      return
    }
    if (!VALID_ROLES.has(role)) {
      issues.push({ messageIndex, role, reason: `invalid role "${role}" (expected system/user/assistant/tool)` })
    }

    const content = (m as { content?: unknown }).content

    // String content is valid for system/user/assistant.
    if (typeof content === 'string') {
      if (role === 'tool') {
        issues.push({ messageIndex, role, reason: 'tool message content must be an array of tool-result parts, not a string' })
      }
      return
    }

    if (!Array.isArray(content)) {
      issues.push({ messageIndex, role, reason: `content is neither string nor array (got ${content === null ? 'null' : typeof content})` })
      return
    }

    // The SDK rejects assistant/tool messages with an empty content array.
    if (content.length === 0 && role !== 'user') {
      issues.push({ messageIndex, role, reason: 'content array is empty (provider returned a message with no parts)' })
      return
    }

    content.forEach((part, partIndex) => {
      const partType = (part as { type?: string })?.type
      if (!part || typeof part !== 'object' || !partType) {
        issues.push({ messageIndex, role, partIndex, partType: String(partType), reason: 'part is missing a "type" field' })
        return
      }

      switch (partType) {
        case 'text':
          if (typeof (part as { text?: unknown }).text !== 'string') {
            issues.push({ messageIndex, role, partIndex, partType, reason: 'text part missing string "text" field' })
          }
          break
        case 'tool-call':
          if (!isNonEmptyString((part as { toolCallId?: unknown }).toolCallId)) {
            issues.push({ messageIndex, role, partIndex, partType, reason: 'tool-call part missing "toolCallId"' })
          }
          if (!isNonEmptyString((part as { toolName?: unknown }).toolName)) {
            issues.push({ messageIndex, role, partIndex, partType, reason: 'tool-call part missing "toolName"' })
          }
          break
        case 'tool-result':
          if (!isNonEmptyString((part as { toolCallId?: unknown }).toolCallId)) {
            issues.push({ messageIndex, role, partIndex, partType, reason: 'tool-result part missing "toolCallId"' })
          }
          if ((part as { output?: unknown }).output == null) {
            issues.push({ messageIndex, role, partIndex, partType, reason: 'tool-result part missing "output"' })
          }
          break
        // reasoning, file, image, tool-approval-request/response and other parts
        // are passed through — the SDK accepts a broad set and we don't want
        // false positives. Add stricter checks here only when a real shape bug
        // is observed.
      }
    })
  })

  return { ok: issues.length === 0, issues }
}

/** One-line summary of the issues for console logs. */
export function summarizeIssues(issues: MessageIssue[]): string {
  return issues
    .map(i => {
      const loc = i.partIndex != null ? `msg[${i.messageIndex}].content[${i.partIndex}]` : `msg[${i.messageIndex}]`
      const pt = i.partType ? ` (${i.partType})` : ''
      return `${loc}${pt} ${i.role}: ${i.reason}`
    })
    .join(' | ')
}

/** Truncate long string fields so the dump stays readable and bounded. */
function redactLongStrings(value: unknown, maxLen = 2000): unknown {
  if (typeof value === 'string') {
    return value.length > maxLen ? `${value.slice(0, maxLen)}…[+${value.length - maxLen} chars]` : value
  }
  if (Array.isArray(value)) return value.map(v => redactLongStrings(v, maxLen))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = redactLongStrings(v, maxLen)
    return out
  }
  return value
}

/**
 * Dump the offending prompt to the session workspace for post-mortem. Mirrors
 * result-spillover's layout (`workspace/{sessionId}/tool-results/`). Long text
 * is truncated so the file stays inspectable. Returns the relative path written,
 * or null on failure (logging degrades gracefully).
 */
export function dumpInvalidPrompt(args: {
  sessionId: string | undefined
  iteration: number
  messages: readonly ModelMessage[]
  issues?: MessageIssue[]
  systemText?: string
  sdkError?: string
  modelId?: string
}): string | null {
  const { sessionId, iteration, messages, issues, systemText, sdkError, modelId } = args
  try {
    const dir = join(process.cwd(), 'workspace', sessionId ?? 'unknown', 'tool-results')
    mkdirSync(dir, { recursive: true })
    const fname = `invalid-prompt-iter${iteration}-${Date.now()}.json`
    const payload = {
      capturedAt: new Date().toISOString(),
      iteration,
      modelId,
      sdkError,
      issueCount: issues?.length ?? 0,
      issues: issues ?? [],
      issueSummary: issues ? summarizeIssues(issues) : undefined,
      systemTextLength: systemText?.length,
      messageCount: messages.length,
      messages: redactLongStrings(messages),
    }
    writeFileSync(join(dir, fname), JSON.stringify(payload, null, 2), 'utf-8')
    return `tool-results/${fname}`
  } catch {
    return null
  }
}
