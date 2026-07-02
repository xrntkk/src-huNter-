/**
 * Unit tests for runAgentLoop — the thin outer driver around SDK multi-step
 * streamText. The SDK auto-executes tools (with native needsApproval gating);
 * the loop handles persistence, approval pauses, ask_user pauses, abort, PTL
 * recovery and termination.
 *
 * These drive the loop with a scripted mock model (no network). Each scripted
 * "turn" maps to one streamText run; within a run the SDK executes any tool the
 * model calls, so fakeTool.execute is invoked by the SDK, not the loop.
 */
import { describe, it, expect, vi } from 'vitest'
import { MessageStore } from '../agent/message-store.js'
import { runAgentLoop } from '../agent/agent-loop.js'
import { PermissionChecker } from '../agent/permissions.js'
import { scriptedModel, collectSteps, fakeTool, stepsOfType, staticModel, alwaysCallsModel } from '../test/agent-loop-helpers.js'

// Cut the network: getFastModel() drives store.compress(), which would
// otherwise hit the real API. Replace it with an offline model.
vi.mock('../agent/model-router.js', () => ({
  getFastModel: () => staticModel(''),
}))

function baseStore(userMsg = '探测 example.com 的接口'): MessageStore {
  const s = new MessageStore()
  s.appendUser(userMsg)
  return s
}

describe('runAgentLoop — tool execution', () => {
  it('runs a single tool call then stops', async () => {
    const store = baseStore()
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'http_request', args: { url: 'https://example.com' } }] },
      { text: '任务已完成，未发现更多接口。' },
    ])
    const steps = await collectSteps(
      runAgentLoop({
        model,
        getSystem: () => 'system',
        store,
        tools: { http_request: fakeTool({ result: { status: 200 } }) },
        maxIterations: 5,
      }),
    )

    expect(stepsOfType(steps, 'tool_call')).toHaveLength(1)
    expect(stepsOfType(steps, 'tool_call')[0].toolName).toBe('http_request')
    expect(stepsOfType(steps, 'tool_result')).toHaveLength(1)
    expect(stepsOfType(steps, 'finish').at(-1)?.reason).toBe('stop')

    // The store recorded the assistant tool-call + tool result.
    expect(store.hasToolCall('http_request')).toBe(true)
    expect(store.countToolResults('http_request')).toBe(1)
  })

  it('executes multiple tool calls emitted in one turn', async () => {
    const store = baseStore()
    const seenA: Array<Record<string, unknown>> = []
    const seenB: Array<Record<string, unknown>> = []
    const model = scriptedModel([
      { toolCalls: [
        { toolName: 'probe_a', args: { path: '/a' } },
        { toolName: 'probe_b', args: { path: '/b' } },
      ] },
      { text: 'done' },
    ])
    const steps = await collectSteps(
      runAgentLoop({
        model,
        getSystem: () => 'system',
        store,
        tools: {
          probe_a: fakeTool({ result: { ok: 'a' }, calls: seenA }),
          probe_b: fakeTool({ result: { ok: 'b' }, calls: seenB }),
        },
        maxIterations: 5,
      }),
    )

    expect(stepsOfType(steps, 'tool_call')).toHaveLength(2)
    expect(stepsOfType(steps, 'tool_result')).toHaveLength(2)
    expect(seenA).toHaveLength(1)
    expect(seenB).toHaveLength(1)
  })

  it('emits tool_error and keeps looping when a tool throws', async () => {
    const store = baseStore()
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'boom', args: {} }] },
      { text: 'done' },
    ])
    const steps = await collectSteps(
      runAgentLoop({
        model,
        getSystem: () => 'system',
        store,
        tools: { boom: fakeTool({ throws: 'kaboom' }) },
        maxIterations: 5,
      }),
    )

    const errors = stepsOfType(steps, 'tool_error')
    expect(errors).toHaveLength(1)
    expect(errors[0].error).toContain('kaboom')
    expect(stepsOfType(steps, 'finish').at(-1)?.reason).toBe('stop')
  })

  it('executes each tool exactly once', async () => {
    const store = baseStore()
    const calls: Array<Record<string, unknown>> = []
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'http_request', args: { url: 'https://x' } }] },
      { text: 'done' },
    ])
    await collectSteps(
      runAgentLoop({
        model,
        getSystem: () => 'system',
        store,
        tools: { http_request: fakeTool({ result: { status: 200 }, calls }) },
        maxIterations: 5,
      }),
    )
    expect(calls).toHaveLength(1)
  })
})

describe('runAgentLoop — control flow', () => {
  it('short-circuits to finish=ask_user when ask_user is called', async () => {
    const store = baseStore()
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'ask_user', args: { question: '选哪个目标?' } }] },
      { text: 'should never reach here' },
    ])
    const steps = await collectSteps(
      runAgentLoop({
        model,
        getSystem: () => 'system',
        store,
        tools: { ask_user: fakeTool({ result: { asked: true } }) },
        maxIterations: 5,
      }),
    )
    expect(stepsOfType(steps, 'finish').at(-1)?.reason).toBe('ask_user')
  })

  it('pauses with finish=tool_approval when a tool needs approval, without executing it', async () => {
    const store = baseStore()
    const calls: Array<Record<string, unknown>> = []
    // file_system delete resolves to 'ask' under DEFAULT_RULES.
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'file_system', args: { action: 'delete', path: '/tmp/x' } }] },
      { text: 'should never reach here' },
    ])
    const steps = await collectSteps(
      runAgentLoop({
        model,
        getSystem: () => 'system',
        store,
        tools: { file_system: fakeTool({ result: { deleted: true }, calls }) },
        permissionChecker: new PermissionChecker(),
        maxIterations: 5,
      }),
    )

    const approval = stepsOfType(steps, 'tool_approval')
    expect(approval).toHaveLength(1)
    expect(approval[0].pending[0].toolName).toBe('file_system')
    expect(approval[0].pending[0].approvalId).toBeTruthy()
    expect(stepsOfType(steps, 'finish').at(-1)?.reason).toBe('tool_approval')
    // The tool must NOT have run while waiting for approval.
    expect(calls).toHaveLength(0)
  })

  it('finishes with reason=aborted when the signal is already aborted', async () => {
    const store = baseStore()
    const controller = new AbortController()
    controller.abort()
    const model = scriptedModel([{ toolCalls: [{ toolName: 'noop', args: {} }] }])
    const steps = await collectSteps(
      runAgentLoop({
        model,
        getSystem: () => 'system',
        store,
        tools: { noop: fakeTool({}) },
        maxIterations: 5,
        signal: controller.signal,
      }),
    )
    expect(stepsOfType(steps, 'finish').at(-1)?.reason).toBe('aborted')
    expect(stepsOfType(steps, 'tool_call')).toHaveLength(0)
  })

  it('stops at max_iterations when the model never stops calling tools', async () => {
    const store = baseStore()
    // A model that ALWAYS emits a tool call, never stops. Each streamText run
    // hits the internal step budget and returns finishReason 'tool-calls' →
    // the outer loop treats it as 'continue' and runs until maxIterations.
    const model = alwaysCallsModel('spin', { n: 1 })
    const steps = await collectSteps(
      runAgentLoop({
        model,
        getSystem: () => 'system',
        store,
        tools: { spin: fakeTool({ result: { ok: true } }) },
        maxIterations: 2,
      }),
    )
    expect(stepsOfType(steps, 'finish').at(-1)?.reason).toBe('max_iterations')
  })

  it('accepts a plain text stop immediately (no nudge loop)', async () => {
    const store = baseStore()
    const model = scriptedModel([
      { text: '你好，我可以帮你做安全测试。', finishReason: 'stop' },
    ])
    const steps = await collectSteps(
      runAgentLoop({
        model,
        getSystem: () => 'system',
        store,
        tools: { http_request: fakeTool({ result: { status: 200 } }) },
        maxIterations: 20,
      }),
    )
    // No nudge machinery anymore — a stop is a stop.
    expect(stepsOfType(steps, 'finish')).toHaveLength(1)
    expect(stepsOfType(steps, 'finish')[0].reason).toBe('stop')
    expect(stepsOfType(steps, 'tool_call')).toHaveLength(0)
  })
})
