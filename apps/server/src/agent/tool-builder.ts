/**
 * Tool map builder — extracted from runSRCAgent.
 *
 * Constructs the complete tool set for a turn: core tools (http, bash,
 * endpoints, findings, etc.), MCP tools, skill/plan/sub-agent tools.
 * The returned map is consumed by both runAgentLoop (as the tool set)
 * and PromptBuilder (via a getter for the dynamic tool catalog).
 */
import type { Tool, LanguageModel } from 'ai'
import { addEndpointTool } from './tools/add-endpoint.js'
import { addEndpointsBatchTool } from './tools/add-endpoints-batch.js'
import { importEndpointsTool } from './tools/import-endpoints.js'
import { exportEndpointsTool } from './tools/export-endpoints.js'
import { memoryTool } from './tools/memory.js'
import { addFindingTool } from './tools/add-finding.js'
import { deleteFindingTool } from './tools/delete-finding.js'
import { updateFindingTool } from './tools/update-finding.js'
import { httpRequestTool } from './tools/http-request.js'
import { webSearchTool } from './tools/web-search.js'
import { gatherIntelTool } from './tools/gather-intel.js'
import { bashTool } from './tools/bash.js'
import { queryKnowledgeTool } from './tools/query-knowledge.js'
import { getPlaywrightTools } from './tools/playwright.js'
import { pythonTool, fileSystemTool } from './tools/python.js'
import { createLoadSkillTool } from './tools/load-skill.js'
import { createSpawnAgentTool } from './tools/spawn-agent.js'
import { querySubagentTool } from './tools/query-subagent.js'
import { abortSubagentTool } from './tools/abort-subagent.js'
import { createContinueSubagentTool } from './tools/continue-subagent.js'
import { sendMessageTool } from './tools/send-message.js'
import { createWritePlanTool } from './tools/write-plan.js'
import { listEndpointsTool } from './tools/list-endpoints.js'
import { updateEndpointStatusTool } from './tools/update-endpoint-status.js'
import { askUserTool } from './tools/ask-user.js'
import { getToolProtocol, getProviderOptions, getModelCapability } from './model-router.js'
import type { MessageStore } from './message-store.js'
import type { ObservationStore } from './observation-store.js'
import type { SkillRegistry } from './skill-registry.js'
import type { PlanNotes } from './plan-notes.js'
import type { PermissionChecker } from './permissions.js'
import type { TelemetryCollector } from './telemetry.js'
import type { AgentStep } from './agent-loop.js'

export interface ToolBuilderOptions {
  sessionId: string
  threadId: string
  observationStore: ObservationStore
  skillRegistry: SkillRegistry
  store: MessageStore
  visibleSkillNames: string[] | undefined
  planNotes: PlanNotes
  mcpTools: Record<string, Tool>
  mcpInstructionContext: string
  model: LanguageModel
  modelId?: string
  permissionChecker: PermissionChecker
  endpointCtx: string
  getSystem: () => string
  onStep: (step: AgentStep) => void
  signal: AbortSignal
  telemetry: TelemetryCollector
}

export function buildToolMap(opts: ToolBuilderOptions): Record<string, Tool> {
  const {
    sessionId, threadId, observationStore, skillRegistry, store,
    visibleSkillNames, planNotes, mcpTools, mcpInstructionContext,
    model, modelId, permissionChecker, endpointCtx, getSystem, onStep,
    signal, telemetry,
  } = opts

  const coreTools: Record<string, Tool> = {
    http_request: httpRequestTool(sessionId),
    web_search: webSearchTool(sessionId),
    gather_intel: gatherIntelTool(sessionId),
    bash: bashTool(sessionId),
    add_endpoint: addEndpointTool(sessionId, threadId, observationStore),
    add_endpoints_batch: addEndpointsBatchTool(sessionId, threadId, observationStore),
    import_endpoints: importEndpointsTool(sessionId, threadId, observationStore),
    export_endpoints: exportEndpointsTool(sessionId),
    memory: memoryTool(sessionId),
    add_finding: addFindingTool(sessionId, threadId, observationStore),
    delete_finding: deleteFindingTool(sessionId, threadId, observationStore),
    update_finding: updateFindingTool(sessionId, threadId, observationStore),
    list_endpoints: listEndpointsTool(sessionId),
    update_endpoint_status: updateEndpointStatusTool(sessionId),
    query_knowledge: queryKnowledgeTool,
    load_skill: createLoadSkillTool(skillRegistry, store, {
      getVisibleSkillNames: () => visibleSkillNames,
    }),
    ask_user: askUserTool,
    ...getPlaywrightTools(sessionId),
    python_exec: pythonTool(sessionId),
    file_system: fileSystemTool(sessionId),
    ...mcpTools,
  }

  coreTools.write_plan = createWritePlanTool(planNotes)
  coreTools.query_subagent = querySubagentTool
  coreTools.abort_subagent = abortSubagentTool
  coreTools.send_message = sendMessageTool

  coreTools.spawn_agent = createSpawnAgentTool({
    model,
    getSystem,
    parentStore: store,
    parentThreadId: threadId,
    tools: coreTools,
    signal,
    permissionChecker,
    endpointContext: endpointCtx,
    mcpInstructionContext,
    parentRenderedPrompt: getSystem(),
    toolProtocol: getToolProtocol(modelId),
    providerOptions: getProviderOptions(modelId),
    onParentStep: onStep,
    telemetry,
    sessionId,
    capability: getModelCapability(modelId),
  })

  coreTools.continue_subagent = createContinueSubagentTool({
    model,
    tools: coreTools,
    parentThreadId: threadId,
    permissionChecker,
    onParentStep: onStep,
    toolProtocol: getToolProtocol(modelId),
    providerOptions: getProviderOptions(modelId),
  })

  return coreTools
}
