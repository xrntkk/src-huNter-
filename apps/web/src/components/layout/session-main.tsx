import { useState, useCallback, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Network, FileText, FolderOpen, Brain, BarChart3, PanelRightClose, PanelRightOpen } from 'lucide-react'
import { ReactFlowProvider } from '@xyflow/react'
import { useResizablePanels } from '~/hooks/use-resizable-panels'
import { ResizeHandle } from '~/components/ui/resize-handle'
import { EndpointGraph } from '~/components/features/endpoint-graph/endpoint-graph'
import { MemoryGraph } from '~/components/features/memory-graph/memory-graph'
import { ChatPanel } from '~/components/features/chat/chat-panel'
import { ReportPanel } from '~/components/features/report/report-panel'
import { WorkspacePanel } from '~/components/features/workspace/workspace-panel'
import { SessionDashboardPanel } from '~/components/features/session-dashboard-panel'
import { useSessionStore } from '~/stores/session-store'
import { api } from '~/lib/api'
import { cn } from '~/lib/utils'
import type { GraphUpdateEvent } from '@src-agent/types'

type LeftTab = 'graph' | 'report' | 'workspace' | 'memory' | 'dashboard'

interface SessionMainProps {
  sessionId: string
  threadId?: string
  threads?: Array<{ id: string; title: string | null; createdAt: number }>
  currentThreadId?: string
  onSelectThread?: (threadId: string) => void
  onCreateThread?: () => void
}

const CHAT_COLLAPSED_KEY = 'src-agent-chat-collapsed'

export function SessionMain({ sessionId, threadId, threads, currentThreadId, onSelectThread, onCreateThread }: SessionMainProps) {
  const [leftTab, setLeftTab] = useState<LeftTab>('graph')
  const [graphRefreshKey, setGraphRefreshKey] = useState(0)
  // Chat panel collapsed state — persists across reloads so the user's
  // preference for "graph-focused" vs "chat-focused" workflow sticks.
  const [chatCollapsed, setChatCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(CHAT_COLLAPSED_KEY) === '1' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem(CHAT_COLLAPSED_KEY, chatCollapsed ? '1' : '0') } catch { /* ignore */ }
  }, [chatCollapsed])

  const { selectedEndpointIds, setSelectedEndpointIds } = useSessionStore()
  const queryClient = useQueryClient()

  const { leftWidth, rightWidth, containerRef, handleMouseDown } = useResizablePanels({
    defaultLeftWidth: 45,
    minLeftWidth: 30,
    maxLeftWidth: 70,
    storageKey: 'src-agent-layout-width',
  })

  const { data: graph } = useQuery({
    queryKey: ['endpoint-graph', sessionId, graphRefreshKey],
    queryFn: () => api.endpoints.graph(sessionId),
    refetchInterval: false,
  })

  const { data: memoryGraph } = useQuery({
    queryKey: ['memory-graph', sessionId, graphRefreshKey],
    queryFn: () => api.endpoints.memoryGraph(sessionId),
    refetchInterval: false,
  })

  const handleGraphUpdate = useCallback(
    (event: GraphUpdateEvent) => {
      if (event.type === 'endpoint_added' || event.type === 'finding_added' || event.type === 'finding_deleted' || event.type === 'finding_updated') {
        setGraphRefreshKey(k => k + 1)
        queryClient.invalidateQueries({ queryKey: ['endpoints', sessionId] })
        queryClient.invalidateQueries({ queryKey: ['endpoint-graph', sessionId] })
      } else if (event.type === 'memory_added') {
        setGraphRefreshKey(k => k + 1)
        queryClient.invalidateQueries({ queryKey: ['memory-graph', sessionId] })
      }
    },
    [sessionId, queryClient],
  )

  const nodes = (graph?.nodes ?? []) as Array<{
    id: string; type: 'domain' | 'endpoint' | 'finding'; data: Record<string, unknown>
  }>
  const edges = (graph?.edges ?? []) as Array<{ id: string; source: string; target: string }>

  const endpointCount = nodes.filter(n => n.type === 'endpoint').length
  const findingCount = nodes.filter(n => n.type === 'finding').length

  const memoryNodes = (memoryGraph?.nodes ?? []) as Array<{
    id: string; type: string; data: Record<string, unknown>
  }>
  const memoryEdges = (memoryGraph?.edges ?? []) as Array<{
    id: string; source: string; target: string; label?: string
  }>
  const memoryCount = memoryNodes.length

  return (
    <div
      ref={containerRef}
      className="flex h-full min-h-0 w-full overflow-hidden"
    >
      <div
        style={{ width: chatCollapsed ? 'calc(100% - 44px)' : `${leftWidth}%` }}
        className="flex min-w-0 flex-col border-r border-[var(--border)]"
      >
        <div className="flex border-b border-[var(--border)] bg-[var(--bg-base)]">
          {([
            ['graph', '接口图谱', Network, endpointCount],
            ['report', '漏洞报告', FileText, findingCount],
            ['memory', '记忆图谱', Brain, memoryCount],
            ['workspace', '工作目录', FolderOpen, 0],
            ['dashboard', 'Dashboard', BarChart3, 0],
          ] as const).map(
            ([tab, label, Icon, count]) => (
              <button
                key={tab}
                onClick={() => setLeftTab(tab)}
                className={cn(
                  'flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium transition-all relative',
                  leftTab === tab
                    ? 'text-[var(--accent)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]',
                )}
              >
                <Icon size={12} />
                {label}
                {count > 0 && (
                  <span className="rounded-md bg-[var(--bg-badge)] px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)] border border-[var(--border)]">
                    {count}
                  </span>
                )}
                {leftTab === tab && (
                  <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-[var(--accent)] rounded-t-full" />
                )}
              </button>
            ),
          )}
          {/* Only show the collapse toggle when the chat panel is expanded.
              When collapsed, the only expand affordance is the slim rail on
              the right edge (below) — showing two expand buttons confused users. */}
          {!chatCollapsed && (
            <button
              onClick={() => setChatCollapsed(true)}
              className={cn(
                'ml-auto flex items-center gap-1 px-3 py-2.5 text-xs font-medium transition-all',
                'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
              )}
              title="收起对话框"
            >
              <PanelRightClose size={14} />
              <span className="hidden md:inline">收起</span>
            </button>
          )}
        </div>

        <div className="flex-1 min-h-0">
          {leftTab === 'graph' ? (
            <ReactFlowProvider>
              <EndpointGraph
                sessionId={sessionId}
                nodes={nodes}
                edges={edges}
                selectedIds={selectedEndpointIds}
                onSelectEndpoints={setSelectedEndpointIds}
              />
            </ReactFlowProvider>
          ) : leftTab === 'report' ? (
            <ReportPanel sessionId={sessionId} refreshKey={graphRefreshKey} />
          ) : leftTab === 'memory' ? (
            <ReactFlowProvider>
              <MemoryGraph nodes={memoryNodes} edges={memoryEdges} />
            </ReactFlowProvider>
          ) : leftTab === 'dashboard' ? (
            <SessionDashboardPanel sessionId={sessionId} />
          ) : (
            <WorkspacePanel sessionId={sessionId} />
          )}
        </div>
      </div>

      {!chatCollapsed && (
        <ResizeHandle
          onMouseDown={handleMouseDown}
          className="bg-[var(--bg-base)] hover:bg-[var(--accent)]/30 transition-colors"
        />
      )}

      {chatCollapsed ? (
        <button
          onClick={() => setChatCollapsed(false)}
          className="flex flex-col items-center gap-2 px-2 py-3 border-l border-[var(--border)] bg-[var(--bg-base)] text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-all w-[44px] shrink-0"
          title="展开对话框"
        >
          <PanelRightOpen size={16} />
          {/* vertical-rl alone lays CJK characters out top-to-bottom,
              which reads naturally. The previous rotate-180 flipped them
              upside down. */}
          <span className="text-[10px] [writing-mode:vertical-rl] whitespace-nowrap">对话</span>
        </button>
      ) : (
        <div style={{ width: `${rightWidth}%` }} className="flex min-w-0 flex-col">
          <ChatPanel sessionId={sessionId} threadId={threadId} threads={threads} currentThreadId={currentThreadId} onSelectThread={onSelectThread} onCreateThread={onCreateThread} onGraphUpdate={handleGraphUpdate} />
        </div>
      )}
    </div>
  )
}
