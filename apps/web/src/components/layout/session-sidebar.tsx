import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, PanelLeftClose, PanelLeftOpen, Trash2, Check, X, Pencil, Clock } from 'lucide-react'
import { cn } from '~/lib/utils'
import { toast } from 'react-hot-toast'
import { SessionTelemetryCard } from '~/components/features/session-telemetry-card'

interface Thread {
  id: string
  sessionId: string
  title: string | null
  createdAt: number
}

interface SessionSidebarProps {
  sessionId: string
  currentThreadId: string
  onSelectThread: (threadId: string) => void
}

// ── 相对时间格式化 (ChatGPT风格) ──
function formatRelativeTime(timestamp: number): string {
  if (!timestamp) return ''
  const now = Date.now()
  const diff = now - timestamp
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (seconds < 60) return '刚刚'
  if (minutes < 60) return `${minutes}分钟前`
  if (hours < 24) return `${hours}小时前`
  if (days < 7) return `${days}天前`
  return new Date(timestamp).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

export function SessionSidebar({ sessionId, currentThreadId, onSelectThread }: SessionSidebarProps) {
  const [collapsed, setCollapsed] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const queryClient = useQueryClient()

  // ── 点击外部关闭菜单 ──
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setActiveMenuId(null)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const { data: threads } = useQuery({
    queryKey: ['threads', sessionId],
    queryFn: async () => {
      const res = await fetch(`/api/sessions/${sessionId}/threads`)
      return res.json() as Promise<Thread[]>
    },
    refetchInterval: 10000,
  })

  // ── Create thread mutation ──
  const createThread = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/sessions/${sessionId}/threads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: '创建失败' }))
        throw new Error(err.message || `HTTP ${res.status}`)
      }
      return res.json() as Promise<Thread>
    },
    onSuccess: (thread) => {
      queryClient.invalidateQueries({ queryKey: ['threads', sessionId] })
      onSelectThread(thread.id)
    },
    onError: (err: Error) => {
      toast.error(`创建会话失败: ${err.message}`)
    },
  })

  // ── Delete thread mutation ──
  const deleteThread = useMutation({
    mutationFn: async (threadId: string) => {
      const res = await fetch(`/api/threads/${threadId}`, {
        method: 'DELETE',
      })
      if (!res.ok) throw new Error(`删除失败 (HTTP ${res.status})`)
    },
    onSuccess: (_, deletedId) => {
      queryClient.invalidateQueries({ queryKey: ['threads', sessionId] })
      toast.success('会话已删除')
      setActiveMenuId(null)
      if (deletedId === currentThreadId) {
        onSelectThread('')
      }
    },
    onError: (err: Error) => {
      toast.error(err.message)
    },
  })

  // ── Rename thread mutation ──
  const renameThread = useMutation({
    mutationFn: async ({ id, title }: { id: string; title: string }) => {
      const res = await fetch(`/api/sessions/${sessionId}/threads/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      })
      if (!res.ok) throw new Error(`重命名失败 (HTTP ${res.status})`)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['threads', sessionId] })
      setRenamingId(null)
      setRenameValue('')
    },
    onError: (err: Error) => {
      toast.error(err.message)
    },
  })

  // ── 快捷创建 ──
  const handleQuickCreate = useCallback(() => {
    createThread.mutate()
  }, [createThread])

  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [renamingId])

  // ── Rename handlers ──
  const handleStartRename = useCallback((threadId: string, currentTitle: string) => {
    setRenamingId(threadId)
    setRenameValue(currentTitle || '')
    setActiveMenuId(null)
  }, [])

  const handleConfirmRename = useCallback(() => {
    if (renamingId && renameValue.trim()) {
      renameThread.mutate({ id: renamingId, title: renameValue.trim() })
    } else {
      setRenamingId(null)
      setRenameValue('')
    }
  }, [renamingId, renameValue, renameThread])

  const handleCancelRename = useCallback(() => {
    setRenamingId(null)
    setRenameValue('')
  }, [])

  // ── Delete handler ──
  const handleDeleteThread = useCallback((threadId: string, threadName: string) => {
    if (window.confirm(`确定要删除会话「${threadName}」吗？`)) {
      deleteThread.mutate(threadId)
    } else {
      setActiveMenuId(null)
    }
  }, [deleteThread])

  // ── Keyboard navigation ──
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (renamingId) { handleCancelRename() }
      if (activeMenuId) { setActiveMenuId(null) }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
      e.preventDefault()
      handleQuickCreate()
    }
  }, [renamingId, activeMenuId, handleQuickCreate, handleCancelRename])

  // ── 按时间排序（最新在前）──
  const allThreads = useMemo(() => {
    const list = threads ?? []
    return [...list].sort((a, b) => b.createdAt - a.createdAt)
  }, [threads])

  // ── 自动选中最新会话 ──
  useEffect(() => {
    if (allThreads.length > 0 && !allThreads.some(t => t.id === currentThreadId)) {
      onSelectThread(allThreads[0].id)
    }
  }, [allThreads, currentThreadId, onSelectThread])

  if (collapsed) {
    return (
      <div className="flex flex-col items-center border-r border-[var(--border)] bg-[var(--bg-base)] py-2 w-10">
        <button
          onClick={() => setCollapsed(false)}
          className="p-1.5 rounded-md hover:bg-[var(--bg-hover)] text-[var(--text-muted)] transition-colors"
          title="展开会话列表 (Ctrl+N 新建)"
        >
          <PanelLeftOpen size={16} />
        </button>
      </div>
    )
  }

  return (
    <div
      className="flex flex-col w-[220px] border-r border-[var(--border)] bg-[var(--bg-base)]"
      onKeyDown={handleKeyDown}
    >
      {/* ── Header ── */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-[var(--border)]">
        <span className="text-[11px] font-medium text-[var(--text-muted)] uppercase tracking-wider">会话</span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={handleQuickCreate}
            disabled={createThread.isPending}
            className="p-1.5 rounded-lg hover:bg-[var(--bg-hover)] text-[var(--text-muted)] transition-all disabled:opacity-50"
            title="新建会话 (Ctrl+N)"
          >
            <Plus size={14} />
          </button>
          <button
            onClick={() => setCollapsed(true)}
            className="p-1.5 rounded-lg hover:bg-[var(--bg-hover)] text-[var(--text-muted)] transition-colors"
            title="收起侧栏"
          >
            <PanelLeftClose size={14} />
          </button>
        </div>
      </div>

      {/* ── Thread List ── */}
      <div className="flex-1 overflow-y-auto py-1 px-2" ref={menuRef}>
        {allThreads.length === 0 && (
          <div className="text-center text-[10px] text-[var(--text-muted)] py-6">
            暂无会话，点击 + 新建
          </div>
        )}
        {allThreads.map(t => {
          const isCurrent = t.id === currentThreadId
          const isRenaming = t.id === renamingId
          const displayName = t.title || '未命名会话'
          const relativeTime = formatRelativeTime(t.createdAt)

          if (isRenaming) {
            return (
              <div
                key={t.id}
                className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg mb-0.5 bg-[var(--accent)]/8 ring-1 ring-[var(--accent)]/25 animate-in fade-in duration-100"
                onClick={e => e.stopPropagation()}
              >
                <input
                  ref={renameInputRef}
                  value={renameValue}
                  onChange={e => setRenameValue(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') handleConfirmRename()
                    else if (e.key === 'Escape') handleCancelRename()
                  }}
                  onBlur={handleConfirmRename}
                  className="flex-1 bg-transparent border border-[var(--border)] rounded-md px-2 py-1 text-[11px] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] min-w-0"
                  placeholder="会话名称..."
                />
                <button
                  onClick={handleConfirmRename}
                  className="p-1 rounded-md hover:bg-[var(--accent)]/15 text-[var(--accent)] shrink-0"
                  title="确认 (Enter)"
                >
                  <Check size={12} />
                </button>
                <button
                  onClick={handleCancelRename}
                  className="p-1 rounded-md hover:bg-red-500/10 text-red-400 shrink-0"
                  title="取消 (Esc)"
                >
                  <X size={12} />
                </button>
              </div>
            )
          }

          return (
            <div
              key={t.id}
              className={cn(
                "group relative flex items-center w-full rounded-lg mb-0.5 transition-all duration-150",
                isCurrent
                  ? "bg-[var(--accent)]/10 shadow-sm"
                  : "hover:bg-[var(--bg-hover)]",
                isCurrent && "ring-1 ring-[var(--accent)]/20"
              )}
            >
              {isCurrent && (
                <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-[60%] rounded-r-full bg-[var(--accent)]" />
              )}

              <button
                onClick={() => onSelectThread(t.id)}
                onDoubleClick={() => handleStartRename(t.id, displayName)}
                className={cn(
                  "flex flex-col items-start gap-0.5 flex-1 min-w-0 text-left pl-2.5 pr-7 py-2",
                  isCurrent ? "cursor-default" : ""
                )}
                title={`${displayName}${relativeTime ? ` · ${relativeTime}` : ''}\n双击重命名`}
              >
                <span className={cn(
                  "text-[11px] truncate w-full leading-tight",
                  isCurrent ? "text-[var(--text-primary)] font-medium" : "text-[var(--text-secondary)]"
                )}>
                  {displayName}
                </span>
                {relativeTime && (
                  <span className="flex items-center gap-1 text-[9px] text-[var(--text-muted)]/60">
                    <Clock size={8} />
                    {relativeTime}
                  </span>
                )}
              </button>

              {/* Hover actions */}
              <div
                className={cn(
                  "absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity",
                  isCurrent && "opacity-100"
                )}
              >
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    handleStartRename(t.id, displayName)
                  }}
                  className="p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface)] transition-colors"
                  title="重命名"
                >
                  <Pencil size={11} />
                </button>

                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setActiveMenuId(activeMenuId === t.id ? null : t.id)
                  }}
                  className={cn(
                    "p-1 rounded-md transition-colors",
                    activeMenuId === t.id
                      ? "text-red-400 bg-red-500/10"
                      : "text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface)]"
                  )}
                  title="删除"
                >
                  <Trash2 size={11} />
                </button>

                {activeMenuId === t.id && (
                  <div className="absolute right-full top-1/2 -translate-y-1/2 mr-1.5 z-30 animate-in fade-in slide-in-from-right-2 duration-150">
                    <div className="flex items-center gap-1 bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg shadow-lg px-2 py-1.5 whitespace-nowrap">
                      <span className="text-[10px] text-[var(--text-secondary)]">确认删除?</span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          handleDeleteThread(t.id, displayName)
                        }}
                        className="px-2 py-0.5 rounded text-[10px] font-medium text-red-400 hover:bg-red-500/10 transition-colors"
                      >
                        确定
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          setActiveMenuId(null)
                        }}
                        className="px-2 py-0.5 rounded text-[10px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] transition-colors"
                      >
                        取消
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* ── Telemetry 概要 ── */}
      <SessionTelemetryCard sessionId={sessionId} />

      {/* ── 底部提示 ── */}
      <div className="px-3 py-1.5 border-t border-[var(--border)]">
        <p className="text-[9px] text-[var(--text-muted)]/40 text-center">
          Ctrl+N 新建 · 双击重命名
        </p>
      </div>
    </div>
  )
}
