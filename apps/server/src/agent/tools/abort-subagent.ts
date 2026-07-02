import { tool } from 'ai'
import { z } from 'zod'
import { subagentRegistry } from '../subagent-registry.js'

/**
 * Cancel a still-running async sub-agent task by its taskId.
 *
 * No-op (returns ok: true) if the task is already in a terminal state.
 * Aborting a running task signals its AbortController, which cascades to
 * the in-flight generateText call inside the child agent loop.
 */
export const abortSubagentTool = tool({
  description:
    '取消一个正在运行的异步子 Agent。当判断子任务方向错误或已不再需要时调用。' +
    '已经完成或失败的任务会被忽略并返回成功。',
  inputSchema: z.object({
    taskId: z.string().describe('spawn_agent 返回的 taskId'),
  }),
  execute: async ({ taskId }) => {
    const ok = subagentRegistry.abort(taskId)
    return ok ? { ok: true, taskId } : { ok: false, error: `task ${taskId} not found` }
  },
})
