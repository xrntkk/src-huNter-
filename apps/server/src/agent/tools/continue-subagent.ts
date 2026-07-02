import { tool, type Tool, type LanguageModel } from 'ai'
import { z } from 'zod'
import { MessageStore } from '../message-store.js'
import { runAgentLoop, type AgentStep } from '../agent-loop.js'
import { PermissionChecker } from '../permissions.js'
import { SkillRegistry } from '../skill-registry.js'
import { subagentRegistry } from '../subagent-registry.js'
import { resolveAgentType } from '../agent-loader.js'
import { createLoadSkillTool } from './load-skill.js'
import { logger } from '../../logger/index.js'

interface ContinueSubagentDeps {
  model: LanguageModel
  tools: Record<string, Tool>
  parentThreadId: string
  permissionChecker?: PermissionChecker
  onParentStep?: (step: AgentStep) => void
  toolProtocol?: 'native' | 'text'
  providerOptions?: Record<string, Record<string, unknown>>
}

export function createContinueSubagentTool(deps: ContinueSubagentDeps) {
  return tool({
    description:
      '续接已完成/失败的子 Agent，追加新指令让其继续执行。' +
      '适用于：子 Agent 报告了初步结果需要深入、子 Agent 遗漏了某些方向需要补充、需要基于子 Agent 已有上下文做进一步操作。' +
      '续接的子 Agent 保留其之前的完整对话历史。',
    inputSchema: z.object({
      taskId: z.string().describe('要续接的子 Agent 的 taskId'),
      message: z.string().describe('追加给子 Agent 的新指令'),
    }),
    execute: async ({ taskId, message }) => {
      const task = subagentRegistry.get(taskId)
      if (!task) return { error: `Task ${taskId} not found` }
      if (task.status === 'running') return { error: `Task ${taskId} is still running. Use send_message to communicate with running agents.` }

      // Restore saved store
      const saved = subagentRegistry.restoreStore(taskId)
      if (!saved) return { error: `Cannot restore state for task ${taskId}. Store may have expired (1 hour TTL).` }

      // Reconstruct MessageStore
      const childStore = MessageStore.deserialize(saved.storeData)
      childStore.appendUser(message)

      // Reconstruct system prompt
      let getChildSystem: () => string
      if (saved.systemPrompt) {
        const sys = saved.systemPrompt
        getChildSystem = () => sys
      } else {
        getChildSystem = () => ''
      }

      // Reconstruct tools (same stripping as spawn_agent)
      let childTools: Record<string, Tool> = { ...deps.tools }
      delete childTools.spawn_agent
      delete childTools.create_plan
      delete childTools.add_intent
      delete childTools.conclude_intent
      delete childTools.query_subagent
      delete childTools.abort_subagent
      delete childTools.continue_subagent
      delete childTools.send_message

      // Apply agent type tool filter if the original agent had a type
      if (saved.agentType) {
        const agentDef = resolveAgentType(saved.agentType)
        if (agentDef?.tools) {
          const allowed = new Set(agentDef.tools)
          childTools = Object.fromEntries(
            Object.entries(childTools).filter(([name]) => allowed.has(name)),
          )
        }
      }

      const childSkillRegistry = new SkillRegistry()
      childTools.load_skill = createLoadSkillTool(childSkillRegistry, childStore)

      // Re-register as running
      const childAbort = new AbortController()
      task.status = 'running'
      task.abortController = childAbort
      task.finishedAt = undefined
      task.notificationInjected = false
      subagentRegistry.save(task)

      // Accumulators (continue from where we left off)
      let toolCallCount = task.toolCallCount
      let toolErrorCount = task.toolErrorCount
      let endpointsFound = task.endpointsFound
      let findingsFound = task.findingsFound
      let finalThought = ''

      // Fire background execution
      void (async () => {
        try {
          const steps = runAgentLoop({
            model: deps.model,
            getSystem: getChildSystem,
            store: childStore,
            tools: childTools,
            maxIterations: 10,
            signal: childAbort.signal,
            permissionChecker: deps.permissionChecker,
            toolProtocol: deps.toolProtocol,
            providerOptions: deps.providerOptions,
            onStep: (step) => {
              if (deps.onParentStep && step.type !== 'text_delta' && step.type !== 'usage' && step.type !== 'reasoning') {
                deps.onParentStep({
                  type: 'subagent_step',
                  iteration: step.iteration,
                  taskId,
                  description: `[续接] ${task.description}`,
                  childStep: step,
                } as AgentStep)
              }
              if (step.type === 'thinking') finalThought = step.content
              if (step.type === 'tool_call') {
                toolCallCount++
                if (step.toolName === 'add_endpoint') endpointsFound++
                if (step.toolName === 'add_finding') findingsFound++
              }
              if (step.type === 'tool_error') toolErrorCount++
            },
          })
          for await (const _ of steps) { /* drain */ }
          task.status = childAbort.signal.aborted ? 'aborted' : 'completed'
          task.summary = (finalThought || `[续接完成] 额外工具调用 ${toolCallCount - task.toolCallCount} 次`).slice(0, 800)
        } catch (err) {
          task.status = 'failed'
          task.error = err instanceof Error ? err.message : String(err)
        } finally {
          task.finishedAt = Date.now()
          task.toolCallCount = toolCallCount
          task.toolErrorCount = toolErrorCount
          task.endpointsFound = endpointsFound
          task.findingsFound = findingsFound
          subagentRegistry.save(task)
          void subagentRegistry.saveStore(taskId, childStore.serialize(), getChildSystem(), saved.agentType)
          logger.info(`[ContinueSubagent] ${taskId} resumed and completed: status=${task.status}`)
        }
      })()

      return {
        status: 'resumed',
        taskId,
        description: task.description,
        message: `子 Agent "${task.description}" 已续接执行。完成后 <task-notification> 会出现在历史中。`,
      }
    },
  })
}
