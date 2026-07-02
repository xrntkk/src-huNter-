import { useState, useRef, useEffect, useCallback } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'react-hot-toast'
import { Plus, History, Clock, Pencil, Trash2, Check, X } from 'lucide-react'
import { cn } from '~/lib/utils'

export interface ThreadOption {
  id: string
  title: string | null
  createdAt: number
}

interface ChatHeaderProps {
  sessionId: string
  threads?: ThreadOption[]
  currentThreadId?: string
  onSelectThread?: (threadId: string) => void
  onCreateThread?: () => void
}

function formatRelativeTime(timestamp: number): string {
  if (!timestamp) return ''
  const diff = Date.now() - timestamp
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时前`
  const days = Math.floor(hours / 24)
  return `${days}天前`
}

export function ChatHeader({ sessionId, threads = [], currentThreadId, onSelectThread, onCreateThread }: ChatHeaderProps) {
  const queryClient = useQueryClient()
  const [showThreads, setShowThreads] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const threadsRef = useRef<HTMLDivElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (threadsRef.current && !threadsRef.current.contains(e.target as Node)) {
        setShowThreads(false)
        setRenamingId(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [renamingId])

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
    onError: (err: Error) => toast.error(err.message),
  })

  const deleteThread = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/threads/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`删除失败 (HTTP ${res.status})`)
    },
    onSuccess: (_, deletedId) => {
      queryClient.invalidateQueries({ queryKey: ['threads', sessionId] })
      toast.success('会话已删除')
      if (deletedId === currentThreadId) {
        onSelectThread?.('')
      }
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const startRename = useCallback((t: ThreadOption, e: React.MouseEvent) => {
    e.stopPropagation()
    setRenamingId(t.id)
    setRenameValue(t.title || '')
  }, [])

  const submitRename = useCallback(() => {
    const title = renameValue.trim()
    if (renamingId && title) {
      renameThread.mutate({ id: renamingId, title })
    } else {
      setRenamingId(null)
      setRenameValue('')
    }
  }, [renamingId, renameValue, renameThread])

  const cancelRename = useCallback(() => {
    setRenamingId(null)
    setRenameValue('')
  }, [])

  const requestDelete = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (confirm('确定要删除这个会话吗？此操作不可恢复。')) {
      deleteThread.mutate(id)
    }
  }, [deleteThread])

  if (!onSelectThread && !onCreateThread) return null

  return (
    <div className="flex items-center justify-end gap-1 px-3 py-1.5 border-b border-[var(--border)] bg-[var(--bg-base)]">
      {onCreateThread && (
        <button
          type="button"
          onClick={onCreateThread}
          className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-all"
          title="新增会话"
        >
          <Plus size={14} />
          <span>新增会话</span>
        </button>
      )}
      {onSelectThread && (
        <div ref={threadsRef} className="relative">
          <button
            type="button"
            onClick={() => setShowThreads(!showThreads)}
            className={cn(
              'flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs transition-all',
              'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
              showThreads && 'bg-[var(--bg-hover)] text-[var(--text-secondary)]',
            )}
            title="历史会话"
          >
            <History size={14} />
            <span>历史会话</span>
          </button>
          {showThreads && (
            <div className="absolute top-full right-0 mt-2 w-[280px] rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] shadow-xl z-50 animate-in fade-in slide-in-from-top-2 duration-150">
              <div className="px-3 py-2 border-b border-[var(--border)]">
                <span className="text-[11px] font-medium text-[var(--text-muted)] uppercase tracking-wider">历史会话</span>
              </div>
              <div className="max-h-[280px] overflow-y-auto py-1">
                {threads.length === 0 ? (
                  <div className="px-3 py-4 text-center text-[11px] text-[var(--text-muted)]">
                    暂无历史会话
                  </div>
                ) : threads.map(t => {
                  const isActive = t.id === currentThreadId
                  const isRenaming = t.id === renamingId
                  return (
                    <div
                      key={t.id}
                      className={cn(
                        'group flex items-center gap-2 px-3 py-2 transition-colors',
                        !isRenaming && 'hover:bg-[var(--bg-hover)] cursor-pointer',
                        isActive && !isRenaming && 'bg-[var(--accent)]/8',
                      )}
                      onClick={() => {
                        if (isRenaming) return
                        onSelectThread(t.id)
                        setShowThreads(false)
                      }}
                    >
                      <Clock size={12} className={cn(
                        'flex-shrink-0',
                        isActive ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]',
                      )} />
                      {isRenaming ? (
                        <>
                          <input
                            ref={renameInputRef}
                            type="text"
                            value={renameValue}
                            onChange={e => setRenameValue(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') { e.preventDefault(); submitRename() }
                              else if (e.key === 'Escape') { e.preventDefault(); cancelRename() }
                            }}
                            onClick={e => e.stopPropagation()}
                            className="flex-1 min-w-0 bg-[var(--bg-base)] border border-[var(--border)] rounded px-2 py-0.5 text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
                            placeholder="会话标题"
                          />
                          <button
                            type="button"
                            onClick={e => { e.stopPropagation(); submitRename() }}
                            className="p-0.5 rounded text-[var(--accent)] hover:bg-[var(--bg-hover)]"
                            title="保存"
                          >
                            <Check size={12} />
                          </button>
                          <button
                            type="button"
                            onClick={e => { e.stopPropagation(); cancelRename() }}
                            className="p-0.5 rounded text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
                            title="取消"
                          >
                            <X size={12} />
                          </button>
                        </>
                      ) : (
                        <>
                          <div className="min-w-0 flex-1">
                            <div className={cn(
                              'text-xs truncate',
                              isActive ? 'text-[var(--text-primary)] font-medium' : 'text-[var(--text-secondary)]',
                            )}>
                              {t.title || '未命名会话'}
                            </div>
                            {t.createdAt > 0 && (
                              <div className="text-[10px] text-[var(--text-muted)] mt-0.5">
                                {formatRelativeTime(t.createdAt)}
                              </div>
                            )}
                          </div>
                          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                            <button
                              type="button"
                              onClick={e => startRename(t, e)}
                              className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                              title="重命名"
                            >
                              <Pencil size={11} />
                            </button>
                            <button
                              type="button"
                              onClick={e => requestDelete(t.id, e)}
                              className="p-1 rounded text-[var(--text-muted)] hover:text-red-400 hover:bg-[var(--bg-hover)]"
                              title="删除"
                            >
                              <Trash2 size={11} />
                            </button>
                          </div>
                          {isActive && (
                            <div className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] flex-shrink-0" />
                          )}
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
