/**
 * Stream formatter — converts the agent loop's AgentStep stream into an AI
 * SDK v6 UIMessageStream Response for the frontend.
 *
 * Extracted from agent-loop.ts to keep that file focused on the loop control
 * flow. This module is pure serialization: it consumes an AsyncGenerator<AgentStep>
 * (+ optional side channel for sub-agent steps) and produces a streaming HTTP
 * Response.
 *
 * REASONING / ASK_USER / TOOL_APPROVAL / SUBAGENT_STEP ride as embedded HTML
 * comment markers inside the text stream. The SDK's UIMessage stream protocol
 * does not support non-transient custom `data-*` part types — writing them
 * breaks the stream. PLAN_NOTES uses a transient data part (consumed via
 * onData, not persisted) which IS supported.
 */
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai'
import type { AgentStep } from './agent-loop.js'
import { LOG_FILE_PATH } from '../logger/index.js'

/**
 * Simple push-based async queue for forwarding sub-agent steps into the
 * SSE stream while the main generator is blocked (e.g. during sync tool execution).
 */
export class StepChannel {
  private queue: AgentStep[] = []
  private resolve: (() => void) | null = null
  private done = false

  push(step: AgentStep): void {
    if (this.done) return
    this.queue.push(step)
    if (this.resolve) {
      this.resolve()
      this.resolve = null
    }
  }

  close(): void {
    this.done = true
    if (this.resolve) { this.resolve(); this.resolve = null }
  }

  /** Drain all queued steps (non-blocking). */
  drain(): AgentStep[] {
    const items = this.queue.splice(0)
    return items
  }

  /** Wait until at least one item is available or closed. */
  wait(): Promise<void> {
    if (this.queue.length > 0 || this.done) return Promise.resolve()
    return new Promise(r => { this.resolve = r })
  }
}

/**
 * Convert an AgentStep generator into a streaming HTTP Response.
 *
 * v6 streams text as a text-start / text-delta* / text-end triple keyed by a
 * block id. Tool calls split the text into separate blocks: we close the
 * current text block before emitting a tool part and open a fresh one for
 * subsequent text, so the UIMessage `parts` array carries text and tool parts
 * in true chronological order — no position markers needed.
 * REASONING/ASK_USER/TOOL_APPROVAL/SUBAGENT_STEP ride as embedded markers
 * (HTML comments) inside the text stream — the frontend extracts them via
 * regex in parseTextSegment. PLAN_NOTES uses a transient data part (consumed
 * via onData, not persisted).
 */
export function agentLoopToDataStreamResponse(
  steps: AsyncGenerator<AgentStep>,
  sideChannel?: StepChannel,
): Response {
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      let textBlockSeq = 0
      let textId = `assistant_text_0`
      let textStarted = false
      const writeText = (delta: string) => {
        if (!delta) return
        if (!textStarted) {
          writer.write({ type: 'text-start', id: textId })
          textStarted = true
        }
        writer.write({ type: 'text-delta', id: textId, delta })
      }
      // Close the open text block (if any) so a following tool part lands
      // *after* the text already streamed, then arm a fresh block id.
      const breakTextBlock = () => {
        if (textStarted) {
          writer.write({ type: 'text-end', id: textId })
          textStarted = false
        }
        textBlockSeq += 1
        textId = `assistant_text_${textBlockSeq}`
      }

      writer.write({ type: 'start' })

      // Track iterations that emitted text_delta so we don't double-emit
      // the full thinking content for the same iteration.
      const streamedIterations = new Set<number>()
      // Buffer reasoning tokens per iteration and flush as a single marker
      // when a non-reasoning step arrives. This prevents creating hundreds
      // of tiny <!--REASONING:--> markers (one per token) that the frontend
      // would otherwise render as separate blocks.
      let pendingReasoning = ''
      let pendingReasoningIteration = -1

      function flushReasoning() {
        if (pendingReasoning) {
          const marker = '<!--REASONING:' + JSON.stringify({ content: pendingReasoning, iteration: pendingReasoningIteration }) + '-->'
          writeText(marker)
          pendingReasoning = ''
          pendingReasoningIteration = -1
        }
      }

      // Helper to process a single step and write to stream
      function processStep(step: AgentStep) {
        switch (step.type) {
          case 'text_delta':
            flushReasoning()
            streamedIterations.add(step.iteration)
            writeText(step.delta)
            break
          case 'reasoning':
            // Accumulate tokens; emit one marker when reasoning ends
            if (pendingReasoningIteration !== -1 && pendingReasoningIteration !== step.iteration) {
              flushReasoning()
            }
            pendingReasoning += step.content
            pendingReasoningIteration = step.iteration
            break
          case 'thinking':
            flushReasoning()
            // Only emit full thinking text if no text_delta was streamed
            // for this iteration (fallback for non-streaming providers).
            if (!streamedIterations.has(step.iteration)) {
              writeText(step.content)
            }
            break
          case 'tool_call':
            flushReasoning()
            // ask_user renders as a dedicated interactive card (driven by the
            // ASK_USER marker emitted with its result), so suppress its generic
            // tool card entirely — don't open an input-available part for it.
            if (step.toolName === 'ask_user') break
            // Close the current text block so the tool part orders after the
            // text streamed so far; the tool-input-available chunk carries the
            // structured call. MCP tools (name contains "__") are runtime
            // dynamic tools, so flag them → the SDK emits `dynamic-tool` parts.
            breakTextBlock()
            writer.write({
              type: 'tool-input-available',
              toolCallId: step.toolCallId,
              toolName: step.toolName,
              input: step.args,
              ...(step.toolName.includes('__') ? { dynamic: true } : {}),
            })
            break
          case 'tool_result':
            flushReasoning()
            // ask_user is shown via its own interactive card (the ASK_USER
            // marker below); its generic tool card is suppressed in 'tool_call',
            // so emit only the marker and skip tool-output-available here.
            if (step.toolName === 'ask_user' && step.result && typeof step.result === 'object') {
              const askData = step.result as Record<string, unknown>
              if (askData.type === 'ask_user') {
                writeText('<!--ASK_USER:' + JSON.stringify(askData) + '-->')
                break
              }
            }
            writer.write({
              type: 'tool-output-available',
              toolCallId: step.toolCallId,
              output: step.result,
              ...(step.toolName.includes('__') ? { dynamic: true } : {}),
            })
            break
          case 'tool_error':
            flushReasoning()
            if (step.toolName === 'streamText' || step.toolName === 'generateText') {
              writeText(`\n\n[streamText 错误: ${step.error}]\n\n`)
            } else {
              writer.write({
                type: 'tool-output-error',
                toolCallId: step.toolCallId,
                errorText: step.error,
                ...(step.toolName.includes('__') ? { dynamic: true } : {}),
              })
            }
            break
          case 'system_nudge':
            flushReasoning()
            writeText('\n> ' + step.message + '\n')
            break
          case 'tool_approval': {
            flushReasoning()
            // Hidden marker carrying the pending calls; the frontend renders
            // approve/deny controls and echoes the decision back on resume.
            writeText('<!--TOOL_APPROVAL:' + JSON.stringify({ type: 'tool_approval', pending: step.pending }) + '-->')
            break
          }
          case 'plan_notes': {
            flushReasoning()
            writer.write({
              type: 'data-plan-notes',
              id: 'plan-latest',
              data: { notes: step.notes },
              transient: true,
            } as any)
            break
          }
          case 'subagent_step': {
            flushReasoning()
            const cs = step.childStep
            const childPayload: Record<string, unknown> = { type: cs.type }
            if (cs.type === 'tool_call') { childPayload.toolName = cs.toolName; childPayload.args = cs.args; childPayload.toolCallId = cs.toolCallId }
            if (cs.type === 'tool_result') { childPayload.toolName = cs.toolName; childPayload.result = cs.result; childPayload.toolCallId = cs.toolCallId }
            if (cs.type === 'tool_error') { childPayload.toolName = cs.toolName; childPayload.error = cs.error; childPayload.toolCallId = cs.toolCallId }
            if (cs.type === 'thinking') { childPayload.content = cs.content }
            if (cs.type === 'finish') { childPayload.reason = cs.reason }
            // Base64-encode the payload: a child tool_result may carry raw HTML
            // containing `-->`, which would prematurely close the HTML comment
            // and leak the remainder as plain assistant text. The base64 alphabet
            // has no `-`/`>`, so the `-->` delimiter can never appear inside.
            const json = JSON.stringify({ taskId: step.taskId, description: step.description, childStep: childPayload })
            const b64 = Buffer.from(json, 'utf8').toString('base64')
            writeText('<!--SUBAGENT_STEP_B64:' + b64 + '-->')
            break
          }
          case 'finish':
            flushReasoning()
            if (step.reason === 'error') {
              writeText('\n\n[任务异常终止，详细信息请查看日志: ' + LOG_FILE_PATH + ']')
            } else {
              writeText('\n\n[任务完成: ' + step.reason + ']')
            }
            break
        }
      }

      // Consume main generator steps + side channel (sub-agent steps) concurrently.
      // The sideChannel pushes steps from child agents running during tool execution.
      if (sideChannel) {
        // Manual iteration: race between main generator and side channel
        let mainDone = false
        let pendingNext: Promise<IteratorResult<AgentStep>> = steps.next()

        while (!mainDone) {
          // Drain any queued side-channel steps first
          for (const s of sideChannel.drain()) processStep(s)

          // Wait for the next main step or side-channel activity
          const sideWait = sideChannel.wait()
          const result = await Promise.race([
            pendingNext.then(r => ({ source: 'main' as const, result: r })),
            sideWait.then(() => ({ source: 'side' as const, result: null })),
          ])

          if (result.source === 'side') {
            // Side channel woke us — drain and continue waiting for main
            for (const s of sideChannel.drain()) processStep(s)
            continue
          }

          // Main generator produced a value
          const { result: iterResult } = result
          if (iterResult!.done) {
            mainDone = true
          } else {
            processStep(iterResult!.value)
            pendingNext = steps.next()
          }
        }
        // Final drain
        for (const s of sideChannel.drain()) processStep(s)
        sideChannel.close()
      } else {
        // Simple path: no side channel
        for await (const step of steps) {
          processStep(step)
        }
      }

      // Flush any remaining buffered reasoning at stream end
      flushReasoning()
      if (textStarted) writer.write({ type: 'text-end', id: textId })
      writer.write({ type: 'finish' })
    },
  })
  return createUIMessageStreamResponse({ stream })
}
