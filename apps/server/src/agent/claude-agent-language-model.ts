/**
 * Claude Agent SDK ↔ Vercel AI SDK (LanguageModelV3) bridge.
 *
 * Mirrors the architectural choices of `claude-code-openai-wrapper`:
 *   - disallowedTools = ['*']  → let src-agent's own agent loop drive tool calls.
 *   - maxTurns = 1             → we want one LLM round-trip per call,
 *                                 not Claude's nested agent loop.
 *   - systemPrompt is extracted from the Vercel prompt and forwarded verbatim,
 *     so the cache-aware system prompt assembled by `prompt-builder.ts` still applies.
 *
 * Authentication is handled entirely by the SDK: it reuses the local
 * `~/.claude/` OAuth credentials established by `claude auth login`.
 *
 * The SDK ships with its own bundled `claude` binary, independent of any
 * system-installed CLI — `apps/server/src/utils/claude-cli-detect.ts`
 * still detects the user-installed CLI for UI hints, but is not used at
 * runtime inside this file.
 */

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from '@ai-sdk/provider'
import { query, type Options as ClaudeQueryOptions } from '@anthropic-ai/claude-agent-sdk'

/* ------------------------------------------------------------------ */
/* Public configuration                                                */
/* ------------------------------------------------------------------ */

export interface ClaudeAgentModelConfig {
  /** Model id forwarded to the Claude Agent SDK, e.g. `claude-sonnet-4-5`. */
  modelId: string
  /**
   * Forwarded to SDK. Default `'bypassPermissions'` is fine because we
   * disable all tools anyway — but kept configurable in case future work
   * wants to delegate tool execution back to the SDK.
   */
  permissionMode?: ClaudeQueryOptions['permissionMode']
  /**
   * If set, use a Claude Code preset as the base system prompt and append
   * src-agent's own system prompt to it. Default `null` — use only the
   * caller's system prompt verbatim, which is what we want for src-agent
   * because `prompt-builder.ts` already provides a fully-formed prompt.
   */
  preset?: 'claude_code' | null
  /**
   * Absolute path to the Claude Code CLI executable. Forwarded to the SDK
   * as `pathToClaudeCodeExecutable`. When unset, the SDK uses its bundled
   * default (`cli.js` shipped with `@anthropic-ai/claude-agent-sdk`). Use
   * this to point at an internally distributed CLI such as `claude-internal`
   * instead of the public `claude` binary. Must be an absolute path — the
   * SDK calls `fs.existsSync` on it.
   */
  pathToClaudeCodeExecutable?: string
}

/* ------------------------------------------------------------------ */
/* The LanguageModelV3 implementation                                  */
/* ------------------------------------------------------------------ */

export class ClaudeAgentLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = 'v3' as const
  readonly provider = 'claude-cli'
  /** No native URL support — all content is forwarded as text. */
  readonly supportedUrls: Record<string, RegExp[]> = {}

  constructor(private readonly config: ClaudeAgentModelConfig) {}

  get modelId(): string {
    return this.config.modelId
  }

  async doGenerate(
    options: LanguageModelV3CallOptions,
  ): Promise<Awaited<ReturnType<LanguageModelV3['doGenerate']>>> {
    const { promptText, systemPrompt } = convertPromptToClaudeInput(options.prompt)
    const aggregated = await consumeQueryToFinal(
      query({
        prompt: promptText,
        options: this.buildClaudeOptions(systemPrompt, false),
      }),
    )

    const content: LanguageModelV3Content[] = aggregated.text
      ? [{ type: 'text', text: aggregated.text }]
      : []

    return {
      content,
      finishReason: aggregated.finishReason,
      usage: aggregated.usage,
      warnings: [],
    }
  }

  async doStream(
    options: LanguageModelV3CallOptions,
  ): Promise<Awaited<ReturnType<LanguageModelV3['doStream']>>> {
    const { promptText, systemPrompt } = convertPromptToClaudeInput(options.prompt)
    const iter = query({
      prompt: promptText,
      options: this.buildClaudeOptions(systemPrompt, true),
    })

    // V3 streams text via a start/delta/end triple keyed by a block id.
    const textBlockId = 'txt_0'

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      async start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] })
        // Track whether the SDK is delivering text via fine-grained
        // `stream_event` deltas. If yes, ignore the trailing `assistant`
        // message (which mirrors the full text) to avoid double-emit.
        let sawStreamEventDelta = false
        let textStarted = false
        const ensureTextStart = () => {
          if (!textStarted) {
            controller.enqueue({ type: 'text-start', id: textBlockId })
            textStarted = true
          }
        }
        try {
          for await (const msg of iter) {
            const mapped = mapClaudeMessageToStreamParts(msg, sawStreamEventDelta)
            for (const part of mapped) {
              if (part.kind === 'text-delta') {
                if ((msg as { type?: string })?.type === 'stream_event') sawStreamEventDelta = true
                ensureTextStart()
                controller.enqueue({ type: 'text-delta', id: textBlockId, delta: part.delta })
              } else {
                // finish
                if (textStarted) controller.enqueue({ type: 'text-end', id: textBlockId })
                controller.enqueue({ type: 'finish', finishReason: part.finishReason, usage: part.usage })
                controller.close()
                return
              }
            }
          }
          // Iterator finished without an explicit `result` message — emit a synthetic finish.
          if (textStarted) controller.enqueue({ type: 'text-end', id: textBlockId })
          controller.enqueue({ type: 'finish', finishReason: makeFinishReason('stop'), usage: emptyUsage() })
          controller.close()
        } catch (err) {
          controller.enqueue({ type: 'error', error: err })
          controller.close()
        }
      },
    })

    return { stream }
  }

  private buildClaudeOptions(
    systemPrompt: string | undefined,
    streaming: boolean,
  ): ClaudeQueryOptions {
    const opts: ClaudeQueryOptions = {
      // Tools are owned by src-agent's outer loop; the SDK itself must not act.
      disallowedTools: ['*'],
      // maxTurns must be > 1. With maxTurns=1, if the model attempts a built-in
      // tool call (Bash/Read/etc.), disallowedTools blocks execution but the
      // attempt still consumes the single turn → the SDK returns
      // subtype="error_max_turns" and the CLI process exits with code 1.
      // This is non-deterministic (depends on whether the model reaches for a
      // tool), which is why large agentic prompts intermittently failed while
      // "say hello" always worked. Giving several turns lets the model recover
      // after a blocked attempt and still emit its text. Mirrors the reference
      // claude-code-openai-wrapper which defaults max_turns=10.
      maxTurns: 10,
      permissionMode: this.config.permissionMode ?? 'bypassPermissions',
      includePartialMessages: streaming,
    }

    // Only forward `model` when explicitly configured. Some Claude CLI
    // deployments (e.g. internal proxies) only accept aliases like 'sonnet'
    // / 'opus' and reject full version IDs — when modelId is empty we let
    // the CLI fall back to its configured default model.
    if (this.config.modelId) {
      opts.model = this.config.modelId
    }

    // Point the SDK at a specific CLI binary (e.g. `claude-internal`) when
    // configured. Without this the SDK runs its bundled `cli.js`.
    if (this.config.pathToClaudeCodeExecutable) {
      opts.pathToClaudeCodeExecutable = this.config.pathToClaudeCodeExecutable
    }

    if (systemPrompt) {
      opts.systemPrompt = this.config.preset
        ? { type: 'preset', preset: this.config.preset, append: systemPrompt }
        : systemPrompt
    } else if (this.config.preset) {
      opts.systemPrompt = { type: 'preset', preset: this.config.preset }
    }

    return opts
  }
}

/* ------------------------------------------------------------------ */
/* Prompt conversion (Vercel AI SDK → Claude Agent SDK)                */
/* ------------------------------------------------------------------ */

/**
 * Flatten a Vercel `LanguageModelV3Prompt` into:
 *   - `systemPrompt`: concatenation of every `role: 'system'` message.
 *   - `promptText`:    a User/Assistant transcript of the remaining messages.
 *
 * Tool calls and tool results are inlined as text annotations because
 * src-agent's agent loop reads tool I/O from its own Timeline, and we
 * just need Claude to see the *narrative* of what already happened.
 */
export function convertPromptToClaudeInput(prompt: LanguageModelV3Prompt): {
  promptText: string
  systemPrompt: string | undefined
} {
  const systemParts: string[] = []
  const transcript: string[] = []

  for (const msg of prompt) {
    if (msg.role === 'system') {
      systemParts.push(msg.content)
      continue
    }

    if (msg.role === 'user') {
      transcript.push(`User: ${stringifyContent(msg.content)}`)
      continue
    }

    if (msg.role === 'assistant') {
      transcript.push(`Assistant: ${stringifyContent(msg.content)}`)
      continue
    }

    if (msg.role === 'tool') {
      // Tool result message — render as a synthetic User turn so Claude
      // sees the result of the previous tool call. V3 tool-result parts
      // carry the payload under `output` (was `result` in V1). Skip
      // tool-approval-response parts (no toolName / output to narrate).
      const rendered = msg.content
        .filter((part): part is Extract<typeof part, { type: 'tool-result' }> => part.type === 'tool-result')
        .map(part => `[tool ${part.toolName} → ${safeJson(part.output)}]`)
        .join('\n')
      transcript.push(`User: ${rendered}`)
      continue
    }
  }

  return {
    promptText: transcript.join('\n\n'),
    systemPrompt: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
  }
}

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return safeJson(content)

  return content
    .map((part: any) => {
      if (!part || typeof part !== 'object') return String(part)
      switch (part.type) {
        case 'text':
          return part.text ?? ''
        case 'file':
          return '[file]'
        case 'reasoning':
          return part.text ?? ''
        case 'tool-call':
          // V3 tool-call parts carry args under `input` (was `args` in V1).
          return `[tool-call ${part.toolName}(${safeJson(part.input)})]`
        case 'tool-result':
          return `[tool-result ${part.toolName} → ${safeJson(part.output)}]`
        default:
          return safeJson(part)
      }
    })
    .filter(Boolean)
    .join(' ')
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/* ------------------------------------------------------------------ */
/* Claude SDK message → intermediate parts                             */
/* ------------------------------------------------------------------ */

/** V3 usage with all-unknown token counts. */
function emptyUsage(): LanguageModelV3Usage {
  return {
    inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
  }
}

/** Build a V3 finish reason from a unified value. */
function makeFinishReason(
  unified: LanguageModelV3FinishReason['unified'],
  raw?: string,
): LanguageModelV3FinishReason {
  return { unified, raw: raw ?? undefined }
}

/**
 * Intermediate, spec-agnostic representation of a mapped SDK message.
 * `doStream` turns these into V3 `text-delta` / `finish` stream parts, and
 * `consumeQueryToFinal` aggregates them for `doGenerate`.
 */
type MappedPart =
  | { kind: 'text-delta'; delta: string }
  | { kind: 'finish'; finishReason: LanguageModelV3FinishReason; usage: LanguageModelV3Usage }

interface AggregatedResult {
  text: string
  finishReason: LanguageModelV3FinishReason
  usage: LanguageModelV3Usage
}

/**
 * Drains the SDK async iterator (non-streaming case) and assembles the
 * `doGenerate` return shape.
 */
async function consumeQueryToFinal(iter: AsyncIterable<any>): Promise<AggregatedResult> {
  let text = ''
  let finishReason: LanguageModelV3FinishReason = makeFinishReason('stop')
  let usage: LanguageModelV3Usage = emptyUsage()

  for await (const msg of iter) {
    if (msg?.type === 'assistant' && msg.message) {
      text += extractAssistantText(msg.message)
    } else if (msg?.type === 'result') {
      finishReason = mapFinishReason(msg.subtype, msg.is_error)
      usage = extractUsage(msg)
      // Surface CLI-level error detail (auth failures, rate limits, etc.) that
      // would otherwise be lost — the result message carries it in `result`
      // or `error` even when no assistant text was produced.
      if (finishReason.unified === 'error' && !text) {
        const detail = extractResultError(msg)
        if (detail) text = detail
      }
      break
    }
  }

  return { text, finishReason, usage }
}

/** Pull a human-readable error string out of a Claude SDK `result` message. */
function extractResultError(resultMsg: any): string {
  const candidate =
    resultMsg?.error ??
    resultMsg?.result ??
    resultMsg?.message ??
    resultMsg?.subtype
  if (typeof candidate === 'string') return candidate
  if (candidate && typeof candidate === 'object') {
    return safeJson(candidate)
  }
  return resultMsg?.subtype ? `Claude CLI error: ${resultMsg.subtype}` : ''
}

/**
 * Translate a single SDK message into zero-or-more intermediate parts.
 *
 * Known SDK message shapes (from claude-agent-sdk docs / wrapper source):
 *   - { type: 'system', subtype: 'init', ... }                  → ignore
 *   - { type: 'assistant', message: { content: [...] } }        → text-delta
 *                                                                  (skip if partial-stream already covered the text)
 *   - { type: 'stream_event', event: {...} }                    → fine-grained delta
 *   - { type: 'result', subtype, total_cost_usd, usage, ... }   → finish
 */
function mapClaudeMessageToStreamParts(
  msg: any,
  partialStreamActive: boolean,
): MappedPart[] {
  if (!msg || typeof msg !== 'object') return []

  switch (msg.type) {
    case 'system':
      return []

    case 'stream_event': {
      const event = msg.event
      if (
        event?.type === 'content_block_delta' &&
        event.delta?.type === 'text_delta' &&
        typeof event.delta.text === 'string'
      ) {
        return [{ kind: 'text-delta', delta: event.delta.text }]
      }
      return []
    }

    case 'assistant': {
      // The trailing `assistant` message mirrors the full text. Skip it
      // when fine-grained deltas already covered the text — otherwise
      // we would double-emit the entire response at the end of the stream.
      if (partialStreamActive) return []
      const text = extractAssistantText(msg.message)
      return text ? [{ kind: 'text-delta', delta: text }] : []
    }

    case 'result':
      return [
        {
          kind: 'finish',
          finishReason: mapFinishReason(msg.subtype, msg.is_error),
          usage: extractUsage(msg),
        },
      ]

    default:
      return []
  }
}

function extractAssistantText(message: any): string {
  if (!message) return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text)
    .join('')
}

function extractUsage(resultMsg: any): LanguageModelV3Usage {
  const u = resultMsg?.usage ?? resultMsg?.message?.usage ?? {}
  const inputTotal = Number(u.input_tokens ?? u.inputTokens ?? 0) || 0
  const outputTotal = Number(u.output_tokens ?? u.outputTokens ?? 0) || 0
  return {
    inputTokens: { total: inputTotal, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: outputTotal, text: outputTotal, reasoning: undefined },
  }
}

function mapFinishReason(subtype: unknown, isError = false): LanguageModelV3FinishReason {
  const raw = typeof subtype === 'string' ? subtype : undefined
  if (isError) return makeFinishReason('error', raw)
  switch (subtype) {
    case 'success':
      return makeFinishReason('stop', raw)
    case 'error_max_turns':
      return makeFinishReason('length', raw)
    case 'error_during_execution':
    case 'error':
      return makeFinishReason('error', raw)
    default:
      return makeFinishReason('other', raw)
  }
}

