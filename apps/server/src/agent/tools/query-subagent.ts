import { tool } from 'ai'
import { z } from 'zod'
import { subagentRegistry } from '../subagent-registry.js'

/**
 * Read-only progress / result query for an async sub-agent task.
 *
 * Use this after spawning with `mode: 'async'` to poll for completion or
 * inspect partial progress. When status === 'completed' or 'failed', the
 * returned summary is what the sub-agent ultimately produced.
 *
 * Note: the same summary is also auto-injected into the parent's
 * conversation as a <task-notification> system message before the next
 * agent iteration — so you don't strictly NEED to call this tool to see
 * the result; it just lets you check earlier.
 */
export const querySubagentTool = tool({
  description:
    '查询异步子 Agent 的执行进度或结果。适用于 spawn_agent({ mode: "async" }) 或 spawn_agent({ mode: "fork" }) 派发的任务。' +
    '返回 status (running/completed/failed/aborted)、工具调用数、发现数、实时进度和最终总结。',
  inputSchema: z.object({
    taskId: z.string().describe('spawn_agent 返回的 taskId，形如 "sa_abc123"'),
  }),
  execute: async ({ taskId }) => {
    const task = subagentRegistry.get(taskId)
    if (!task) return { error: `task ${taskId} not found` }
    return {
      taskId: task.taskId,
      status: task.status,
      description: task.description,
      toolCallCount: task.toolCallCount,
      toolErrorCount: task.toolErrorCount,
      endpointsFound: task.endpointsFound,
      findingsFound: task.findingsFound,
      summary: task.summary,
      error: task.error,
      progress: task.progress ? JSON.parse(task.progress) : undefined,
      durationMs: (task.finishedAt ?? Date.now()) - task.startedAt,
    }
  },
})
