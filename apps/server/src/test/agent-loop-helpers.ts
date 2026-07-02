/**
 * Test helpers for driving runAgentLoop with a scripted mock model.
 *
 * The agent loop calls `streamText({ model, ... })` once per iteration. We feed
 * it a MockLanguageModelV3 whose `doStream` returns a different scripted
 * response each call, so a single test can script a whole multi-iteration
 * conversation (e.g. "iter 1: call http_request, iter 2: stop").
 */
import { MockLanguageModelV3 } from 'ai/test'
import type { LanguageModelV3StreamPart, LanguageModelV3FinishReason, LanguageModelV3Usage } from '@ai-sdk/provider'
import { tool, type Tool } from 'ai'
import { z } from 'zod'
import type { AgentStep } from '../agent/agent-loop.js'

/** A scripted assistant turn: either tool calls, or a plain text/stop turn. */
export interface ScriptedTurn {
  /** Tool calls the model "emits" this iteration. */
  toolCalls?: Array<{ toolName: string; args: Record<string, unknown>; id?: string }>
  /** Assistant text for this iteration. */
  text?: string
  /** finishReason — defaults to 'tool-calls' when toolCalls present, else 'stop'. */
  finishReason?: LanguageModelV3FinishReason['unified']
}

/** V3 usage with all-unknown token counts except the supplied totals. */
function usage(input = 10, output = 10): LanguageModelV3Usage {
  return {
    inputTokens: { total: input, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: output, text: output, reasoning: undefined },
  }
}

/** Build the stream parts for one scripted turn (AI SDK V3 stream protocol). */
function turnToStreamParts(turn: ScriptedTurn, callIndex: number): LanguageModelV3StreamPart[] {
  const parts: LanguageModelV3StreamPart[] = [{ type: 'stream-start', warnings: [] }]

  if (turn.text) {
    const id = `txt_${callIndex}`
    parts.push({ type: 'text-start', id })
    parts.push({ type: 'text-delta', id, delta: turn.text })
    parts.push({ type: 'text-end', id })
  }

  const toolCalls = turn.toolCalls ?? []
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i]
    parts.push({
      type: 'tool-call',
      toolCallId: tc.id ?? `tc_${callIndex}_${i}`,
      toolName: tc.toolName,
      input: JSON.stringify(tc.args),
    })
  }

  const unified = turn.finishReason ?? (toolCalls.length > 0 ? 'tool-calls' : 'stop')
  parts.push({
    type: 'finish',
    finishReason: { unified, raw: undefined },
    usage: usage(),
  })

  return parts
}

/**
 * Build a MockLanguageModelV3 that replays `turns` one per streamText call.
 * After the script is exhausted it returns a bare 'stop' turn, so a loop that
 * over-runs terminates instead of hanging.
 */
export function scriptedModel(turns: ScriptedTurn[]): MockLanguageModelV3 {
  let call = 0
  return new MockLanguageModelV3({
    doStream: async () => {
      const turn = turns[call] ?? { text: '', finishReason: 'stop' as const }
      const parts = turnToStreamParts(turn, call)
      call++
      return { stream: streamFromParts(parts) }
    },
  })
}

/** Wrap an array of stream parts in a ReadableStream. */
function streamFromParts(parts: LanguageModelV3StreamPart[]): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(p)
      controller.close()
    },
  })
}

/**
 * A model that emits a single tool call on EVERY doStream call with
 * finishReason 'tool-calls' — it never stops. The SDK keeps stepping within a
 * run until its step budget, then streamText reports finishReason 'tool-calls'
 * (→ the loop's 'continue'). Used to exercise the outer maxIterations cap.
 */
export function alwaysCallsModel(toolName: string, args: Record<string, unknown>): MockLanguageModelV3 {
  let call = 0
  return new MockLanguageModelV3({
    doStream: async () => {
      const parts: LanguageModelV3StreamPart[] = [
        { type: 'stream-start', warnings: [] },
        { type: 'tool-call', toolCallId: `tc_${call++}`, toolName, input: JSON.stringify(args) },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: usage() },
      ]
      return { stream: streamFromParts(parts) }
    },
  })
}

/**
 * A trivial model whose `doGenerate` (used by generateText) always returns the
 * same text. Used to stub out the fast model behind store.compress() so tests
 * never touch the network.
 */
export function staticModel(text: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: text ? [{ type: 'text', text }] : [],
      finishReason: { unified: 'stop', raw: undefined },
      usage: usage(1, 1),
      warnings: [],
    }),
  })
}

/**
 * Drain an AgentStep async generator into an array, ignoring text_delta noise
 * by default (most assertions care about tool_call/tool_result/finish/etc.).
 */
export async function collectSteps(
  gen: AsyncGenerator<AgentStep>,
  opts: { keepDeltas?: boolean } = {},
): Promise<AgentStep[]> {
  const steps: AgentStep[] = []
  for await (const s of gen) {
    if (!opts.keepDeltas && s.type === 'text_delta') continue
    steps.push(s)
  }
  return steps
}

/** Convenience: build a fake tool whose execute() returns a fixed value. */
export function fakeTool(opts: {
  description?: string
  result?: unknown
  /** If set, execute() throws this message instead of returning. */
  throws?: string
  /** Records every args object the tool was called with. */
  calls?: Array<Record<string, unknown>>
}): Tool {
  return tool({
    description: opts.description ?? 'test tool',
    inputSchema: z.object({}).passthrough(),
    execute: async (args: Record<string, unknown>) => {
      opts.calls?.push(args)
      if (opts.throws) throw new Error(opts.throws)
      return opts.result ?? { ok: true }
    },
  })
}

/** Filter helper: collect all steps of a given type. */
export function stepsOfType<T extends AgentStep['type']>(
  steps: AgentStep[],
  type: T,
): Array<Extract<AgentStep, { type: T }>> {
  return steps.filter(s => s.type === type) as Array<Extract<AgentStep, { type: T }>>
}

