/**
 * Spawn Agent Tool — True sub-agent fork with proper isolation.
 *
 * Modes:
 *   - sync (default): blocks until child finishes, returns full summary
 *   - async: registers the task, kicks off background execution, returns
 *     `{ status: 'started', taskId }` immediately. Parent can use
 *     `query_subagent` / `abort_subagent` to interact with it later, and
 *     a `<task-notification>` is auto-injected into the parent's timeline
 *     when the child completes.
 *
 * Other guarantees:
 *   1. Child gets its own SkillRegistry + PromptBuilder — loading a skill in
 *      the child no longer pollutes the parent's system prompt.
 *   2. Parent context seed uses the TAIL of the parent dump (most recent
 *      context), not the head (oldest/stale items).
 *   3. Child steps are forwarded to the parent onStep callback so the UI
 *      can show sub-agent activity in real time (sync mode only).
 *   4. spawn_agent is stripped from child tools to prevent recursive forks.
 *      `create_plan` is also stripped. Optional `tool_whitelist` further
 *      restricts the child's available tools.
 */

import { nanoid } from 'nanoid'
import { tool, type Tool, type LanguageModel } from 'ai'
import { z } from 'zod'
import { MessageStore } from '../message-store.js'
import { runAgentLoop, type AgentStep } from '../agent-loop.js'
import type { TelemetryCollector } from '../telemetry.js'
import type { ModelCapability } from '../model-capabilities.js'
import { createTraceId, type TraceContext } from '../langfuse-trace.js'
import { PermissionChecker, createSubagentChecker, type SubagentPermissionMode } from '../permissions.js'
import { SkillRegistry } from '../skill-registry.js'
import { PromptBuilder } from '../prompt-builder.js'
import { createLoadSkillTool } from './load-skill.js'
import { subagentRegistry } from '../subagent-registry.js'
import { resolveAgentType } from '../agent-loader.js'
import { createWorktree, checkWorktreeChanges, removeWorktree, type WorktreeInfo } from '../worktree.js'
import { logger } from '../../logger/index.js'

function buildProgressSnapshot(toolCallCount: number, endpointsFound: number, findingsFound: number, lastToolName: string): string {
  return JSON.stringify({
    toolCallCount,
    endpointsFound,
    findingsFound,
    lastToolName,
    updatedAt: Date.now(),
  })
}

/**
 * Build a structured seed of the parent's recent context for a child agent.
 * Prefers the tail of recent tool activity (concrete: what was called, what
 * came back) over a raw prose dump, then falls back to the prose tail. Capped
 * so it stays a lightweight orientation aid, not a context-budget sink.
 */
function buildParentContextSeed(parentStore: MessageStore): string {
  const total = parentStore.length
  // Pull tool-call/result activity from roughly the last ~30 messages.
  const cursor = Math.max(0, total - 30)
  const { lines } = parentStore.getToolActivitySince(cursor)
  // Drop ingestion-tool activity (入库成功记录). If a sub-agent's task IS to
  // ingest data, seeing "父已大量 add_endpoints_batch 成功" in its context
  // makes it conclude the work is already done and stop without acting. The
  // seed is meant as orientation, not a signal that the task is complete.
  const INGESTION_TOOLS = ['add_endpoints_batch', 'import_endpoints', 'add_endpoint']
  const filtered = lines.filter(l => {
    const m = /^(?:调用|结果|错误)\s+(\S+):/.exec(l)
    return !(m && INGESTION_TOOLS.includes(m[1]))
  })
  if (filtered.length > 0) {
    const recent = filtered.slice(-20).map(l => `- ${l}`).join('\n')
    return `最近的工具活动（调用与结果）：\n${recent}`.slice(-2400)
  }
  // No (non-ingestion) tool activity yet — fall back to the prose transcript tail.
  return parentStore.toProseTranscript().slice(-2000)
}

interface SpawnAgentToolDeps {
  model: LanguageModel
  getSystem: () => string
  parentStore: MessageStore
  /** Parent thread id — needed so async tasks can inject notifications back. */
  parentThreadId: string
  tools: Record<string, Tool>
  signal?: AbortSignal
  permissionChecker?: PermissionChecker
  /** Forward child steps to parent stream for UI visibility (sync mode only). */
  onParentStep?: (step: AgentStep) => void
  /** Parent endpoint context (for child PromptBuilder). */
  endpointContext?: string
  /** Parent MCP instruction context (for child PromptBuilder). */
  mcpInstructionContext?: string
  /** Pre-rendered parent system prompt. Child inherits to maximize prompt cache hits. */
  parentRenderedPrompt?: string
  /** Tool-call protocol of the active model (inherited by child agents). */
  toolProtocol?: 'native' | 'text'
  /** Provider options of the active model (inherited by child agents). */
  providerOptions?: Record<string, Record<string, unknown>>
  /** Parent telemetry collector — sub-agents emit usage/context under it,
   *  tagged with their own task id so each sub-session stays attributable. */
  telemetry?: TelemetryCollector
  /** Session id — lets sub-agent telemetry roll up to the same session. */
  sessionId?: string
  /** Resolved model capability — lets sub-agents compute context occupation. */
  capability?: ModelCapability
}

export function createSpawnAgentTool(deps: SpawnAgentToolDeps) {
  return tool({
    description:
      '创建一个子 Agent 来独立执行子任务。' +
      '模式：sync（阻塞）、async（轻量后台）、fork（继承完整上下文的后台执行）。' +
      '可指定 agentType 使用专门角色（explore/exploit-verify/recon），子 Agent 将使用该角色的系统提示和受限工具集。' +
      'async/fork 完成后通过 <task-notification> 通知父 Agent。可用 continue_subagent 续接已完成的子 Agent，send_message 向运行中的子 Agent 发消息。',
    inputSchema: z.object({
      description: z.string().describe('子任务的简短描述（3-5个词）'),
      prompt: z.string().describe('子任务的具体指令。应包含：目标、约束、期望输出格式。'),
      maxIterations: z.number().int().min(1).default(50).describe('子 Agent 最大迭代次数（无硬上限，按任务规模由父 Agent 设定）'),
      includeHistory: z.boolean().default(true).describe('是否将父 Agent 的近期上下文传递给子 Agent（verifier 角色强制为 false，确保独立验证）'),
      mode: z.enum(['sync', 'async', 'fork']).default('sync').describe(
        'sync: 阻塞等待子完成；async: 后台并行（轻量上下文）；fork: 后台并行（继承父完整上下文 + 系统提示，最大化 cache）',
      ),
      agentType: z.string().optional().describe(
        '指定子 Agent 的角色类型（explore/exploit-verify/verifier/recon）。指定后子 Agent 使用该角色专属的系统提示和受限工具集。',
      ),
      permissionMode: z.enum(['inherit', 'auto_readonly', 'permissive']).optional().describe(
        '权限模式。inherit: 继承父权限（sync默认）；auto_readonly: 需确认的操作自动拒绝（async/fork默认）；permissive: 全部放行',
      ),
      isolation: z.enum(['none', 'worktree']).optional().describe(
        '文件隔离模式。none（默认）：共享工作目录；worktree: 创建 git worktree 隔离（适合并发写文件的子 agent）',
      ),
      toolWhitelist: z.array(z.string()).optional().describe(
        '可选的工具白名单。提供时子 Agent 仅能用这些工具（spawn_agent / create_plan 总是被排除）。' +
        '示例：["http_request", "add_endpoint"] 表示只让子 Agent 做 HTTP 探测和接口记录。',
      ),
    }),
    execute: async ({ description, prompt, maxIterations, includeHistory, mode, agentType, permissionMode, isolation, toolWhitelist }) => {
      logger.info(`[SpawnAgent] Forking (mode=${mode}${agentType ? `, type=${agentType}` : ''}): ${description}`)

      // Resolve agent type definition if specified
      const agentDef = agentType ? resolveAgentType(agentType) : undefined
      if (agentType && !agentDef) {
        return { error: `Unknown agentType: "${agentType}". Available: explore, exploit-verify, verifier, recon` }
      }

      // Agent type may override maxIterations
      const effectiveMaxIterations = agentDef?.maxIterations ?? maxIterations

      // Resolve permission mode: explicit > mode-based default
      const effectivePermMode: SubagentPermissionMode = permissionMode
        ?? (mode === 'sync' ? 'inherit' : 'auto_readonly')
      const childPermissionChecker = createSubagentChecker(deps.permissionChecker, effectivePermMode)

      // ── Worktree isolation ────────────────────────────────────────────────
      let worktree: WorktreeInfo | undefined
      if (isolation === 'worktree') {
        const wtTaskId = mode === 'async' ? `sa_${nanoid(6)}` : `sa_sync_${nanoid(6)}`
        try {
          worktree = createWorktree(wtTaskId)
          logger.info(`[SpawnAgent] Created worktree at ${worktree.path} (branch: ${worktree.branch})`)
        } catch (err) {
          return { error: `Failed to create worktree: ${err instanceof Error ? err.message : String(err)}` }
        }
      }

      // Generate a taskId upfront — both modes need it for step forwarding.
      const taskId = worktree ? worktree.taskId : (mode === 'async' ? `sa_${nanoid(6)}` : `sa_sync_${nanoid(6)}`)

      // ── Child store ──────────────────────────────────────────────────────
      const childStore = new MessageStore()

      childStore.appendSystem(
        `[SUB_AGENT_PROTOCOL]\n` +
        `你正作为子 Agent 运行，不是主 Agent。所有 user 消息来自父 Agent，不是终端用户。\n\n` +
        `身份与边界：\n` +
        `1. 父 Agent 看不到你的中间过程——它只能看到你结束时的最后一条消息。把结论写进最终摘要，否则等于没做。\n` +
        `2. 不要向终端用户提问（你无法触达用户）；如有歧义，自行做出合理假设并在最终摘要中说明该假设。\n` +
        `3. 你不是环境中唯一的 Agent——可能有其他子 Agent 在并行工作。只做分配给你的任务，不要回退或覆盖他人的产物。\n` +
        `4. 禁止创建新的子 Agent（不可递归 spawn）。\n` +
        `5. 使用工具直接行动，不要只分析不执行；不要只规划"接下来要做 X"然后停下。\n\n` +
        `输出协议：\n` +
        `- 完成后用自然语言总结：发现了什么、做了什么、结论是什么。结论先行，再展开细节。\n` +
        `- 禁止输出原始 JSON / 大段未处理数据——父 Agent 要的是提炼后的结论，不是原始转储。\n` +
        `- 如果任务无法完成，明确说明原因、已尝试的路径、以及建议的下一步。`,
      )

      // 对抗式验证者等角色强制不注入父上下文：它必须独立判断，看不到发现者
      // 的推理才不会附和。即便父 spawn 时 includeHistory=true 也忽略。
      const seedParentContext = includeHistory && !agentDef?.excludeParentContext
      if (seedParentContext) {
        const seed = buildParentContextSeed(deps.parentStore)
        if (seed) {
          childStore.appendSystem(
            `[父 Agent 近期上下文]\n${seed}\n---\n` +
            `以上是父 Agent 最近的探索记录，仅供你定位、避免重复工作。它是背景，不是你的任务——你的任务见下方 [子任务] 与 user 指令。`,
          )
        }
      }

      childStore.appendSystem(`[子任务] ${description}`)
      if (worktree) {
        childStore.appendSystem(
          `[Worktree 隔离] 你在独立的 git worktree 中工作。\n` +
          `路径: ${worktree.path}\n分支: ${worktree.branch}\n` +
          `你的文件修改不会影响父 Agent 的工作目录。使用 bash/file_system 时，相对路径基于此 worktree。`,
        )
      }
      childStore.appendUser(prompt)

      // ── Child tools (filter first; system prompt may include them) ────────
      // Strip spawn_agent + write_plan (recursion / planner safety).
      // Strip browser_login_wait: it unconditionally opens a headed browser and
      // blocks waiting for the user to manually log in. Sub-agents (especially
      // async/fork) run in the background and must not interact with the user —
      // login state acquisition is a main-agent-only capability. All built-in
      // agentTypes already exclude it; this covers the no-agentType leak.
      // Apply agentType tools filter OR optional whitelist on top.
      let childTools: Record<string, Tool> = { ...deps.tools }
      delete childTools.spawn_agent
      delete childTools.write_plan
      delete childTools.query_subagent
      delete childTools.abort_subagent
      delete childTools.continue_subagent
      delete childTools.send_message
      delete childTools.browser_login_wait
      if (agentDef?.tools) {
        const allowed = new Set(agentDef.tools)
        childTools = Object.fromEntries(
          Object.entries(childTools).filter(([name]) => allowed.has(name)),
        )
      } else if (toolWhitelist && toolWhitelist.length > 0) {
        childTools = Object.fromEntries(
          Object.entries(childTools).filter(([name]) => toolWhitelist.includes(name)),
        )
      }

      // ── Child system prompt ────────────────────────────────────────────────
      // Priority: agentType (role + dynamic tool catalog) > parent prompt > isolated PromptBuilder
      const childSkillRegistry = new SkillRegistry()
      // Replace load_skill with one bound to the child's isolated registry + store
      childTools.load_skill = createLoadSkillTool(childSkillRegistry, childStore)

      let getChildSystem: () => string
      let getChildBreakdown: (() => Record<string, number>) | undefined
      if (agentDef) {
        // Role prompt as static prefix + dynamic tool catalog appended live.
        const rolePrompt = agentDef.systemPrompt
        const childPromptBuilder = new PromptBuilder({
          endpointContext: deps.endpointContext,
          skillRegistry: childSkillRegistry,
          mcpInstructionContext: deps.mcpInstructionContext,
          toolMap: () => childTools,
          includeAgentTypeCatalog: false,
        })
        getChildSystem = () => `${rolePrompt}\n\n---\n\n${childPromptBuilder.build()}`
        getChildBreakdown = () => childPromptBuilder.tokenEstimate()
      } else if (deps.parentRenderedPrompt) {
        const inherited = deps.parentRenderedPrompt
        getChildSystem = () => inherited
      } else {
        const childPromptBuilder = new PromptBuilder({
          endpointContext: deps.endpointContext,
          skillRegistry: childSkillRegistry,
          mcpInstructionContext: deps.mcpInstructionContext,
          toolMap: () => childTools,
          includeAgentTypeCatalog: false,
        })
        getChildSystem = () => childPromptBuilder.build()
        getChildBreakdown = () => childPromptBuilder.tokenEstimate()
      }

      // ── Child tools already constructed above (before system prompt) ──────

      // ── Stats accumulators ─────────────────────────────────────────────────
      let finalReason = ''
      let finalThought = ''
      let toolCallCount = 0
      let toolErrorCount = 0
      let endpointsFound = 0
      let findingsFound = 0
      /** Optional callback invoked on each tool_call for real-time progress updates. */
      let onToolCallProgress: ((toolName: string) => void) | undefined
      /** Optional callback to drain pending messages from parent (send_message). */
      let drainPendingMessages: (() => void) | undefined

      const runChildAndCollect = async (childSignal?: AbortSignal): Promise<void> => {
        // Each sub-agent run is its own Langfuse trace (distinct lane), but
        // shares the session so it nests under the same Session view, and
        // carries the parent thread id as a tag for lineage.
        const childTrace: TraceContext = {
          traceId: await createTraceId(`${taskId}:${Date.now()}`),
          sessionId: deps.sessionId,
          threadId: taskId,
          parentThreadId: deps.parentThreadId,
          kind: 'subagent',
        }
        const steps = runAgentLoop({
          model: deps.model,
          getSystem: getChildSystem,
          store: childStore,
          tools: childTools,
          maxIterations: effectiveMaxIterations,
          signal: childSignal,
          permissionChecker: childPermissionChecker,
          toolProtocol: deps.toolProtocol,
          providerOptions: deps.providerOptions,
          getActiveTools: () => childSkillRegistry.getActiveTools(),
          ...(deps.telemetry ? { telemetry: deps.telemetry } : {}),
          ...(deps.sessionId ? { sessionId: deps.sessionId } : {}),
          ...(deps.capability ? { capability: deps.capability } : {}),
          traceContext: childTrace,
          ...(getChildBreakdown ? { getContextBreakdown: getChildBreakdown } : {}),
          onStep: (step) => {
            // Forward meaningful child steps to parent stream (skip noise)
            if (deps.onParentStep && step.type !== 'text_delta' && step.type !== 'usage' && step.type !== 'reasoning') {
              deps.onParentStep({
                type: 'subagent_step',
                iteration: step.iteration,
                taskId,
                description,
                childStep: step,
              } as AgentStep)
            }

            if (step.type === 'finish') finalReason = step.reason
            if (step.type === 'thinking') finalThought = step.content
            if (step.type === 'tool_call') {
              toolCallCount++
              if (step.toolName === 'add_endpoint') endpointsFound++
              if (step.toolName === 'add_finding') findingsFound++
              onToolCallProgress?.(step.toolName)
            }
            if (step.type === 'tool_error') toolErrorCount++
            // Drain pending messages at iteration boundaries (after tool results)
            if (step.type === 'tool_result') drainPendingMessages?.()
          },
        })
        for await (const _step of steps) {
          // Drain (steps already consumed via onStep above)
        }
      }

      // ── Async mode: register + fire-and-forget, return immediately ─────────
      if (mode === 'async') {
        const childAbort = new AbortController()
        // Async children are independent — NOT tied to parent's request signal.
        // They can only be killed via abort_subagent or clearTimeline.

        const task = subagentRegistry.register({
          taskId,
          parentThreadId: deps.parentThreadId,
          description,
          status: 'running',
          startedAt: Date.now(),
          toolCallCount: 0,
          toolErrorCount: 0,
          endpointsFound: 0,
          findingsFound: 0,
          abortController: childAbort,
          pendingMessages: [],
        })

        // Real-time progress: update task on each tool_call, persist every 5
        onToolCallProgress = (toolName) => {
          task.toolCallCount = toolCallCount
          task.endpointsFound = endpointsFound
          task.findingsFound = findingsFound
          if (toolCallCount % 5 === 0) {
            task.progress = buildProgressSnapshot(toolCallCount, endpointsFound, findingsFound, toolName)
            subagentRegistry.save(task)
          }
        }

        // Drain messages from send_message tool into child store
        drainPendingMessages = () => {
          const msgs = task.pendingMessages.splice(0)
          for (const msg of msgs) {
            childStore.appendSystem(`[来自父 Agent 的消息] ${msg}`)
          }
        }

        // Fire-and-forget background execution. Updates registry as it runs.
        void (async () => {
          try {
            await runChildAndCollect(childAbort.signal)
            task.status = childAbort.signal.aborted ? 'aborted' : 'completed'
            task.summary = (finalThought || `[子 Agent ${description} 已完成] 工具调用 ${toolCallCount} 次，发现 ${endpointsFound} 个接口，${findingsFound} 个漏洞。`).slice(0, 800)
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
            // Persist store for continue_subagent resumption
            void subagentRegistry.saveStore(taskId, childStore.serialize(), getChildSystem(), agentType)
            // Worktree cleanup: remove if no changes, keep if modified
            if (worktree) {
              const hasChanges = checkWorktreeChanges(worktree.path)
              if (!hasChanges) {
                removeWorktree(worktree.taskId)
                logger.info(`[SpawnAgent] Removed clean worktree for ${taskId}`)
              } else {
                logger.info(`[SpawnAgent] Worktree preserved (has changes): ${worktree.path}`)
              }
            }
            logger.info(
              `[SpawnAgent] async ${taskId} done: status=${task.status} ` +
              `calls=${toolCallCount} endpoints=${endpointsFound} findings=${findingsFound}`,
            )
          }
        })()

        return {
          status: 'started',
          taskId,
          description,
          mode: 'async',
          ...(worktree ? { worktree: { path: worktree.path, branch: worktree.branch } } : {}),
          message: `子 Agent 已在后台启动。可调用 query_subagent({ taskId: "${taskId}" }) 查进度，或继续主任务等子完成时会以 <task-notification> 出现。`,
        }
      }

      // ── Fork mode: full context inheritance, always async ────────────────
      if (mode === 'fork') {
        const forkAbort = new AbortController()
        const forkTaskId = `sa_fork_${nanoid(6)}`

        // Fork store: clone parent's FULL model messages + append directive
        const forkStore = new MessageStore()
        for (const msg of deps.parentStore.toModelMessages()) {
          forkStore.append(msg)
        }
        forkStore.appendUser(
          `<fork_directive>\n任务: ${description}\n\n${prompt}\n</fork_directive>`,
        )

        // System prompt: call getSystem() NOW for the freshest cache-matchable prompt.
        // Captured once so the entire child run uses identical bytes → cache hit.
        const forkSystemPrompt = deps.getSystem()
        const getForkSystem = () => forkSystemPrompt

        // Tools: same stripping as sync/async
        let forkTools: Record<string, Tool> = { ...deps.tools }
        delete forkTools.spawn_agent
        delete forkTools.write_plan
        delete forkTools.query_subagent
        delete forkTools.abort_subagent
        if (toolWhitelist && toolWhitelist.length > 0) {
          forkTools = Object.fromEntries(
            Object.entries(forkTools).filter(([name]) => toolWhitelist.includes(name)),
          )
        }
        const forkSkillRegistry = new SkillRegistry()
        forkTools.load_skill = createLoadSkillTool(forkSkillRegistry, forkStore)

        // Register in subagent registry
        const forkTask = subagentRegistry.register({
          taskId: forkTaskId,
          parentThreadId: deps.parentThreadId,
          description,
          status: 'running',
          startedAt: Date.now(),
          toolCallCount: 0,
          toolErrorCount: 0,
          endpointsFound: 0,
          findingsFound: 0,
          abortController: forkAbort,
          pendingMessages: [],
        })

        // Fork-specific accumulators (independent of shared closure vars)
        let forkFinalThought = ''
        let forkToolCallCount = 0
        let forkToolErrorCount = 0
        let forkEndpointsFound = 0
        let forkFindingsFound = 0

        // Fire-and-forget background execution
        void (async () => {
          try {
            const forkTrace: TraceContext = {
              traceId: await createTraceId(`${forkTaskId}:${Date.now()}`),
              sessionId: deps.sessionId,
              threadId: forkTaskId,
              parentThreadId: deps.parentThreadId,
              kind: 'subagent',
            }
            const steps = runAgentLoop({
              model: deps.model,
              getSystem: getForkSystem,
              store: forkStore,
              tools: forkTools,
              maxIterations: effectiveMaxIterations,
              signal: forkAbort.signal,
              permissionChecker: childPermissionChecker,
              toolProtocol: deps.toolProtocol,
              providerOptions: deps.providerOptions,
              getActiveTools: () => forkSkillRegistry.getActiveTools(),
              ...(deps.telemetry ? { telemetry: deps.telemetry } : {}),
              ...(deps.sessionId ? { sessionId: deps.sessionId } : {}),
              ...(deps.capability ? { capability: deps.capability } : {}),
              traceContext: forkTrace,
              onStep: (step) => {
                if (deps.onParentStep && step.type !== 'text_delta' && step.type !== 'usage' && step.type !== 'reasoning') {
                  deps.onParentStep({
                    type: 'subagent_step',
                    iteration: step.iteration,
                    taskId: forkTaskId,
                    description,
                    childStep: step,
                  } as AgentStep)
                }
                if (step.type === 'thinking') forkFinalThought = step.content
                if (step.type === 'tool_call') {
                  forkToolCallCount++
                  if (step.toolName === 'add_endpoint') forkEndpointsFound++
                  if (step.toolName === 'add_finding') forkFindingsFound++
                  forkTask.toolCallCount = forkToolCallCount
                  forkTask.endpointsFound = forkEndpointsFound
                  forkTask.findingsFound = forkFindingsFound
                  if (forkToolCallCount % 5 === 0) {
                    forkTask.progress = buildProgressSnapshot(forkToolCallCount, forkEndpointsFound, forkFindingsFound, step.toolName)
                    subagentRegistry.save(forkTask)
                  }
                }
                if (step.type === 'tool_error') forkToolErrorCount++
                // Drain pending messages from send_message
                if (step.type === 'tool_result') {
                  const msgs = forkTask.pendingMessages.splice(0)
                  for (const msg of msgs) {
                    forkStore.appendSystem(`[来自父 Agent 的消息] ${msg}`)
                  }
                }
              },
            })
            for await (const _ of steps) { /* drain */ }
            forkTask.status = forkAbort.signal.aborted ? 'aborted' : 'completed'
            forkTask.summary = (forkFinalThought || `[Fork ${description} 完成] 工具调用 ${forkToolCallCount} 次，发现 ${forkEndpointsFound} 个接口，${forkFindingsFound} 个漏洞。`).slice(0, 800)
          } catch (err) {
            forkTask.status = 'failed'
            forkTask.error = err instanceof Error ? err.message : String(err)
          } finally {
            forkTask.finishedAt = Date.now()
            forkTask.toolCallCount = forkToolCallCount
            forkTask.toolErrorCount = forkToolErrorCount
            forkTask.endpointsFound = forkEndpointsFound
            forkTask.findingsFound = forkFindingsFound
            subagentRegistry.save(forkTask)
            // Persist store for continue_subagent resumption
            void subagentRegistry.saveStore(forkTaskId, forkStore.serialize(), getForkSystem(), agentType)
            // Worktree cleanup
            if (worktree) {
              const hasChanges = checkWorktreeChanges(worktree.path)
              if (!hasChanges) {
                removeWorktree(worktree.taskId)
              } else {
                logger.info(`[SpawnAgent] Fork worktree preserved (has changes): ${worktree.path}`)
              }
            }
            logger.info(
              `[SpawnAgent] fork ${forkTaskId} done: status=${forkTask.status} ` +
              `calls=${forkToolCallCount} endpoints=${forkEndpointsFound} findings=${forkFindingsFound}`,
            )
          }
        })()

        return {
          status: 'started',
          taskId: forkTaskId,
          description,
          mode: 'fork',
          ...(worktree ? { worktree: { path: worktree.path, branch: worktree.branch } } : {}),
          message: `Fork 子 Agent 已启动（继承完整上下文，最大化 cache）。taskId: "${forkTaskId}"`,
        }
      }

      // ── Sync mode: original blocking behavior ──────────────────────────────
      await runChildAndCollect(deps.signal)

      const summary =
        finalThought ||
        `[子 Agent ${description} 已完成] 工具调用 ${toolCallCount} 次，发现 ${endpointsFound} 个接口，${findingsFound} 个漏洞。`

      logger.info(
        `[SpawnAgent] sync done: ${description} | reason=${finalReason} | ` +
        `calls=${toolCallCount} | endpoints=${endpointsFound} | findings=${findingsFound}`,
      )

      return {
        status: 'completed',
        description,
        mode: 'sync',
        iterations: toolCallCount,
        endpointsFound,
        findingsFound,
        toolErrors: toolErrorCount,
        summary: summary.slice(0, 800),
        finishReason: finalReason,
      }
    },
  })
}
