import { useState, useMemo, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'react-hot-toast'
import { isToolUIPart, getToolName } from 'ai'
import { useSessionStore } from '~/stores/session-store'
import { useSessionChat } from '~/hooks/use-session-chat'
import { MessageList } from './message-list'
import { ChatInput, type AttachmentFile } from './chat-input'
import { ChatHeader } from './chat-header'
import { EndpointBadgeBar } from './endpoint-badge'
import { ChatStatusBar } from './chat-status-bar'
import { api } from '~/lib/api'
import type { Endpoint, GraphUpdateEvent } from '@src-agent/types'


interface ChatPanelProps {
  sessionId: string
  threadId?: string
  threads?: Array<{ id: string; title: string | null; createdAt: number }>
  currentThreadId?: string
  onSelectThread?: (threadId: string) => void
  onCreateThread?: () => void
  onGraphUpdate: (event: GraphUpdateEvent) => void
}

export function ChatPanel({ sessionId, threadId, threads, currentThreadId, onSelectThread, onCreateThread, onGraphUpdate }: ChatPanelProps) {
  const { selectedEndpointIds, clearSelection, currentSession } = useSessionStore()

  const { data: allEndpoints = [] } = useQuery({
    queryKey: ['endpoints', sessionId],
    queryFn: () => api.endpoints.list(sessionId),
    refetchInterval: false,
  })

  // Load available models
  const { data: modelsConfig } = useQuery({
    queryKey: ['settings-models'],
    queryFn: api.settings.getModels,
    staleTime: 60_000,
  })

  // Load available skills
  const { data: skillsData } = useQuery({
    queryKey: ['settings-skills'],
    queryFn: api.settings.getSkills,
    staleTime: 60_000,
  })

  // Load available MCP servers
  const { data: mcpData } = useQuery({
    queryKey: ['settings-mcp'],
    queryFn: api.settings.getMcp,
    staleTime: 60_000,
  })

  const queryClient = useQueryClient()

  const [selectedModelId, setSelectedModelId] = useState<string>('')
  const [selectedSkills, setSelectedSkills] = useState<string[]>([])
  const [selectedMcpServers, setSelectedMcpServers] = useState<string[]>([])

  // 全局启用/禁用 skill（与设置页同一持久化逻辑）
  const toggleSkillEnabled = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) =>
      api.settings.setSkillEnabled(name, enabled),
    onSuccess: (_d, v) => {
      toast.success(v.enabled ? `已启用 Skill：${v.name}` : `已禁用 Skill：${v.name}`)
      queryClient.invalidateQueries({ queryKey: ['settings-skills'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  // 全局启用/禁用 MCP server：PATCH 整份配置，仅翻转目标 server 的 enabled
  const toggleMcpEnabled = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) => {
      const servers = { ...(mcpData?.mcpServers as Record<string, Record<string, unknown>> | undefined ?? {}) }
      const cur = servers[name] ?? {}
      servers[name] = { ...cur, enabled }
      return api.settings.updateMcp({ mcpServers: servers })
    },
    onSuccess: (_d, v) => {
      toast.success(v.enabled ? `已启用 MCP：${v.name}` : `已禁用 MCP：${v.name}`)
      queryClient.invalidateQueries({ queryKey: ['settings-mcp'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  // Models
  const models = modelsConfig?.models || []
  const activeModelId = modelsConfig?.activeModelId || ''
  const effectiveModelId = selectedModelId || activeModelId || models[0]?.id || undefined

  // Skills（带全局 enabled 状态）
  const skillOptions = (skillsData?.skills || []).map(s => ({ name: s.name, description: s.description, enabled: s.enabled }))

  // MCP servers（带全局 enabled 状态；config 未写 enabled 时默认视为启用）
  const mcpServerOptions = Object.entries(mcpData?.mcpServers || {}).map(([name, cfg]) => ({
    name,
    enabled: (cfg as { enabled?: boolean })?.enabled !== false,
  }))

  const selectedEndpoints = (allEndpoints as Endpoint[]).filter(ep =>
    selectedEndpointIds.includes(ep.id),
  )

  const { messages, isLoading, sendMessage, approve, stop, error, planState } = useSessionChat({
    sessionId,
    threadId,
    selectedEndpointIds,
    modelId: effectiveModelId,
    selectedSkills,
    selectedMcpServers,
    onGraphUpdate,
  })

  // Derive agent status from session status + chat status
  const agentStatus = useMemo(() => {
    const lastMsg = messages[messages.length - 1]
    if (lastMsg?.role === 'assistant' && lastMsg.parts) {
      const hasRunningTool = lastMsg.parts.some(
        p => isToolUIPart(p) && (p.state === 'input-streaming' || p.state === 'input-available'),
      )
      if (hasRunningTool) return 'tool_calling'
    }

    if (error) return 'error'
    if (isLoading) return 'thinking'

    const sessionStatus = currentSession?.status
    if (sessionStatus === 'crawling') return 'crawling'
    if (sessionStatus === 'testing') return 'testing'
    if (sessionStatus === 'analyzing') return 'analyzing'
    if (sessionStatus === 'completed') return 'completed'
    if (sessionStatus === 'error') return 'error'

    return 'idle'
  }, [messages, isLoading, currentSession?.status, error])

  const statusMessage = useMemo(() => {
    if (error) return `错误: ${error.message}`
    if (agentStatus === 'tool_calling') {
      const lastMsg = messages[messages.length - 1]
      const toolPart = lastMsg?.parts?.find(p => isToolUIPart(p))
      if (toolPart) {
        return `正在调用工具: ${getToolName(toolPart as never)}`
      }
      return '正在调用工具…'
    }
    if (agentStatus === 'thinking') return '正在思考…'
    if (agentStatus === 'crawling') return '正在爬取接口…'
    if (agentStatus === 'testing') return '正在测试漏洞…'
    if (agentStatus === 'analyzing') return '正在分析结果…'
    return undefined
  }, [agentStatus, messages, error])

  const handleSend = useCallback(async (text: string, files?: AttachmentFile[]) => {
    if (!files || files.length === 0) {
      sendMessage(text)
      return
    }
    // Read files and append their content to the message
    const fileParts: string[] = []
    for (const f of files) {
      try {
        const content = await f.file.text()
        fileParts.push(`\n\n--- 附件: ${f.name} (${f.size} bytes) ---\n${content}`)
      } catch {
        fileParts.push(`\n\n--- 附件: ${f.name} (无法读取) ---`)
      }
    }
    sendMessage(text + fileParts.join(''))
  }, [sendMessage])

  return (
    <div className="flex h-full flex-col bg-[var(--bg-base)]">
      {/* Header — thread controls (new / history) */}
      <ChatHeader
        sessionId={sessionId}
        threads={threads}
        currentThreadId={currentThreadId}
        onSelectThread={onSelectThread}
        onCreateThread={onCreateThread}
      />

      {/* Selected endpoint context bar */}
      <EndpointBadgeBar endpoints={selectedEndpoints} onClear={clearSelection} />

      {/* Status bar */}
      <ChatStatusBar status={agentStatus} statusMessage={statusMessage} />

      {/* Messages */}
      <MessageList
        messages={messages}
        isLoading={isLoading}
        error={error}
        agentStatus={agentStatus}
        statusMessage={statusMessage}
        onApprove={approve}
        onSendChoice={sendMessage}
      />

      {/* Input */}
      <ChatInput
        onSend={handleSend}
        onStop={stop}
        isLoading={isLoading}
        sessionId={sessionId}
        models={models.map(m => ({ id: m.id, name: m.name, provider: m.provider }))}
        selectedModelId={effectiveModelId}
        onModelChange={setSelectedModelId}
        skills={skillOptions}
        selectedSkills={selectedSkills}
        onSkillsChange={setSelectedSkills}
        onToggleSkillEnabled={(name, enabled) => toggleSkillEnabled.mutate({ name, enabled })}
        mcpServers={mcpServerOptions}
        selectedMcpServers={selectedMcpServers}
        onMcpServersChange={setSelectedMcpServers}
        onToggleMcpEnabled={(name, enabled) => toggleMcpEnabled.mutate({ name, enabled })}
        plan={planState}
      />
    </div>
  )
}
