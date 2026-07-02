import { useEffect, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Globe, Loader2, AlertTriangle, Settings } from 'lucide-react'
import { ThemeToggle } from '~/components/ui/theme-toggle'
import { SessionMain } from '~/components/layout/session-main'
import { SettingsModal } from '~/components/features/settings/settings-modal'
import { useSessionStore } from '~/stores/session-store'
import { api } from '~/lib/api'
import { cn } from '~/lib/utils'

interface Thread {
  id: string
  sessionId: string
  title: string | null
  createdAt: number
}

export function SessionPage() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { setCurrentSession, clearSelection } = useSessionStore()
  const [currentThreadId, setCurrentThreadId] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const { data: session, isError } = useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => api.sessions.get(sessionId!),
    enabled: !!sessionId,
    refetchInterval: 5000,
    staleTime: 3000,
  })

  const { data: threads = [] } = useQuery({
    queryKey: ['threads', sessionId],
    queryFn: async () => {
      const res = await fetch(`/api/sessions/${sessionId}/threads`)
      return res.json() as Promise<Thread[]>
    },
    enabled: !!sessionId,
    refetchInterval: 10000,
  })

  // Sort threads by time (newest first)
  const sortedThreads = [...threads].sort((a, b) => b.createdAt - a.createdAt)

  // Auto-select newest thread when current is missing (initial load, or
  // current thread was deleted). Note: createThread.onSuccess writes the
  // new thread into the query cache before setting currentThreadId, so this
  // effect won't race against creation.
  useEffect(() => {
    if (sortedThreads.length > 0 && !sortedThreads.some(t => t.id === currentThreadId)) {
      setCurrentThreadId(sortedThreads[0].id)
    }
  }, [sortedThreads, currentThreadId])

  // Create thread mutation
  const createThread = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/sessions/${sessionId}/threads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (!res.ok) throw new Error('创建失败')
      return res.json() as Promise<Thread>
    },
    onSuccess: (thread) => {
      // Inject the new thread into the cached list synchronously so the
      // auto-select effect doesn't see currentThreadId as missing during the
      // refetch window. Without this, the first click feels like a no-op
      // because the effect resets currentThreadId to the previous newest.
      queryClient.setQueryData<Thread[]>(['threads', sessionId], (prev) => {
        const list = prev ?? []
        return list.some(t => t.id === thread.id) ? list : [thread, ...list]
      })
      setCurrentThreadId(thread.id)
      // Background revalidation to pick up server-side fields (e.g. title).
      queryClient.invalidateQueries({ queryKey: ['threads', sessionId] })
    },
  })

  const handleCreateThread = useCallback(() => {
    createThread.mutate()
  }, [createThread])

  useEffect(() => {
    if (session) setCurrentSession(session)
    return () => { setCurrentSession(null); clearSelection() }
  }, [session, setCurrentSession, clearSelection])

  if (isError) {
    return (
      <div className="flex h-screen items-center justify-center bg-[var(--bg-base)]">
        <div className="text-center space-y-3">
          <AlertTriangle size={40} className="mx-auto text-[var(--danger)]" />
          <div className="font-medium text-[var(--text-primary)]">会话不存在</div>
          <button
            onClick={() => navigate('/')}
            className="mt-4 text-[var(--accent)] hover:underline text-sm transition-colors"
          >
            返回首页
          </button>
        </div>
      </div>
    )
  }

  if (!session || !sessionId) {
    return (
      <div className="flex h-screen items-center justify-center bg-[var(--bg-base)]">
        <Loader2 size={24} className="animate-spin text-[var(--accent)]" />
      </div>
    )
  }

  const statusConfig: Record<string, { label: string; color: string; dot: string; animate: boolean }> = {
    idle: { label: '空闲', color: 'text-[var(--text-muted)]', dot: 'bg-[var(--text-muted)]', animate: false },
    crawling: { label: '爬取中', color: 'text-[var(--info)]', dot: 'bg-[var(--info)]', animate: true },
    ready: { label: '就绪', color: 'text-[var(--success)]', dot: 'bg-[var(--success)]', animate: false },
    testing: { label: '测试中', color: 'text-[var(--warning)]', dot: 'bg-[var(--warning)]', animate: true },
    analyzing: { label: '分析中', color: 'text-[var(--chart-2)]', dot: 'bg-[var(--chart-2)]', animate: true },
    completed: { label: '已完成', color: 'text-[var(--success)]', dot: 'bg-[var(--success)]', animate: false },
    error: { label: '错误', color: 'text-[var(--danger)]', dot: 'bg-[var(--danger)]', animate: false },
  }

  const cfg = statusConfig[session.status] ?? statusConfig.idle

  return (
    <div className="flex h-screen flex-col bg-[var(--bg-base)]">
      {/* Top bar */}
      <header className="flex items-center gap-3 border-b border-[var(--border)] bg-[var(--bg-base)] px-4 py-2.5 shrink-0">
        <button
          onClick={() => navigate('/')}
          className="rounded-lg p-2 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-all"
          title="返回首页"
        >
          <ArrowLeft size={18} />
        </button>

        <Globe size={16} className="text-[var(--text-muted)]" />

        <div className="flex items-baseline gap-2 min-w-0">
          <span className="text-sm font-semibold text-[var(--text-primary)] truncate">
            {session.title ?? session.domain}
          </span>
          <span className="text-xs text-[var(--text-muted)] truncate">{session.domain}</span>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {/* Status badge — aligned with home page SessionCard badge style */}
          <div className={cn(
            'flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium border',
            'bg-[var(--bg-badge)] border-[var(--border)]', cfg.color,
          )}>
            <span className={cn('w-1 h-1 rounded-full', cfg.dot, cfg.animate && 'animate-pulse')} />
            {cfg.label}
          </div>

          {/* Endpoint count */}
          {session.endpointCount != null && session.endpointCount > 0 && (
            <div className="hidden sm:flex items-center gap-1 text-[11px] text-[var(--text-muted)]">
              <span className="font-medium text-[var(--text-secondary)]">{session.endpointCount}</span> 个接口
            </div>
          )}

          <ThemeToggle className="w-9 h-9 rounded-lg" size={18} />

          <button
            onClick={() => setSettingsOpen(true)}
            className="rounded-lg w-9 h-9 flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-all"
            title="设置"
          >
            <Settings size={18} />
          </button>
        </div>
      </header>

      {/* Main content */}
      <div className="flex-1 min-h-0">
        <SessionMain
          sessionId={sessionId}
          threadId={currentThreadId ?? sessionId}
          threads={sortedThreads}
          currentThreadId={currentThreadId ?? sessionId}
          onSelectThread={setCurrentThreadId}
          onCreateThread={handleCreateThread}
        />
      </div>

      <SettingsModal open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  )
}
