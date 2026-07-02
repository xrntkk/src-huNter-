import { tool } from 'ai'
import { z } from 'zod'
import { subagentRegistry } from '../subagent-registry.js'

/**
 * Send a message to a running async/fork sub-agent. The message is queued
 * and injected into the child's MessageStore as a system message at the
 * next iteration boundary.
 *
 * Use this to steer a running sub-agent without aborting it — e.g. to
 * reprioritize targets, provide new information, or request early stop.
 *
 * For completed/failed agents, use continue_subagent instead.
 */
export const sendMessageTool = tool({
  description:
    '向正在运行的子 Agent 发送消息（指令、新信息、优先级调整）。' +
    '消息会在子 Agent 下一轮迭代时注入其上下文。' +
    '仅对 status="running" 的子 Agent 有效，已完成的子 Agent 请用 continue_subagent。',
  inputSchema: z.object({
    taskId: z.string().describe('目标子 Agent 的 taskId'),
    message: z.string().describe('要发送的消息内容'),
  }),
  execute: async ({ taskId, message }) => {
    const task = subagentRegistry.get(taskId)
    if (!task) return { error: `Task ${taskId} not found` }
    if (task.status !== 'running') {
      return { error: `Task ${taskId} is not running (status: ${task.status}). Use continue_subagent for completed tasks.` }
    }
    task.pendingMessages.push(message)
    return {
      status: 'sent',
      taskId,
      description: task.description,
      message: `消息已发送给子 Agent "${task.description}"，将在其下一轮迭代时生效。`,
    }
  },
})
