import { useState, useEffect, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Globe, Trash2, Shield,
  FileText, Settings, Zap, Sparkles, Network, AlertTriangle, BarChart3,
} from 'lucide-react'
import { GetStartedButton } from '~/components/ui/get-started-button'
import { ThemeToggle } from '~/components/ui/theme-toggle'
import { LimelightNav, type NavItem } from '~/components/ui/limelight-nav'
import { toast } from 'react-hot-toast'
import { api } from '~/lib/api'
import type { Session } from '@src-agent/types'
import { cn } from '~/lib/utils'
import { AgentDashboard } from '~/components/features/dashboard/agent-dashboard'

type HomeView = 'sessions' | 'dashboard'

const STATUS_CONFIG: Record<string, { label: string; color: string; dot: string }> = {
  idle:      { label: '空闲',   color: 'text-[var(--text-muted)]', dot: 'bg-[var(--text-muted)]' },
  crawling:  { label: '爬取中', color: 'text-[var(--info)]',       dot: 'bg-[var(--info)]' },
  ready:     { label: '就绪',   color: 'text-[var(--success)]',    dot: 'bg-[var(--success)]' },
  testing:   { label: '测试中', color: 'text-[var(--warning)]',    dot: 'bg-[var(--warning)]' },
  analyzing: { label: '分析中', color: 'text-[var(--chart-2)]',    dot: 'bg-[var(--chart-2)]' },
  completed: { label: '已完成', color: 'text-[var(--success)]',    dot: 'bg-[var(--success)]' },
  error:     { label: '错误',   color: 'text-[var(--danger)]',     dot: 'bg-[var(--danger)]' },
}

function Sidebar({ view, onView }: {
  view: HomeView; onView: (v: HomeView) => void
}) {
  const navigate = useNavigate()
  const navItems: NavItem[] = [
    { id: 'sessions', icon: <Shield />, label: '首页', onClick: () => onView('sessions') },
    { id: 'dashboard', icon: <BarChart3 />, label: 'Agent Dashboard', onClick: () => onView('dashboard') },
  ]
  const activeIndex = view === 'dashboard' ? 1 : 0

  return (
    <aside className="w-[60px] min-w-[60px] flex flex-col items-center py-4 border-r border-[var(--border)] bg-[var(--bg-base)]">
      <LimelightNav
        items={navItems}
        activeIndex={activeIndex}
        orientation="vertical"
        className="border-none bg-transparent w-auto"
      />
      <div className="flex-1" />
      <ThemeToggle className="w-[52px] h-[52px] mb-1" size={24} />
      <button
        onClick={() => navigate('/settings')}
        className="w-[52px] h-[52px] rounded-lg flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-all"
        title="设置"
      >
        <Settings size={24} />
      </button>
    </aside>
  )
}

function StatCard({ icon, label, value, accent }: {
  icon: React.ReactNode; label: string; value: number | string; accent?: string
}) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] px-4 py-3.5">
      <div className="flex items-center gap-2 mb-1.5">
        <span className={cn('text-[var(--text-muted)]', accent)}>{icon}</span>
        <span className="text-[11px] font-medium text-[var(--text-muted)] uppercase tracking-wider">{label}</span>
      </div>
      <div className={cn('text-2xl font-bold tabular-nums leading-none', accent ?? 'text-[var(--text-primary)]')}>
        {value}
      </div>
    </div>
  )
}

function SessionCard({ session, onOpen, onDelete }: {
  session: Session; onOpen: () => void; onDelete: (e: React.MouseEvent) => void
}) {
  const cfg = STATUS_CONFIG[session.status] ?? STATUS_CONFIG.idle
  const active = session.status !== 'completed' && session.status !== 'idle'
  return (
    <div
      onClick={onOpen}
      className="group relative rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-4 cursor-pointer card-lift hover:border-[var(--border-strong)]"
    >
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <Globe size={14} className="text-[var(--text-muted)] shrink-0" />
          <span className="text-sm font-medium text-[var(--text-primary)] truncate">
            {session.title ?? session.domain}
          </span>
        </div>
        <span className={cn(
          'flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium border shrink-0',
          'bg-[var(--bg-badge)] border-[var(--border)]', cfg.color,
        )}>
          <span className={cn('w-1 h-1 rounded-full', cfg.dot, active && 'animate-pulse')} />
          {cfg.label}
        </span>
      </div>
      <div className="text-[11px] text-[var(--text-muted)] truncate mb-3">{session.domain}</div>
      <div className="flex items-center gap-4 text-[11px] text-[var(--text-secondary)]">
        <span className="flex items-center gap-1">
          <Network size={11} className="text-[var(--text-muted)]" />
          {session.endpointCount ?? 0} 接口
        </span>
        <span className="flex items-center gap-1">
          <AlertTriangle size={11} className={(session.findingCount ?? 0) > 0 ? 'text-[var(--danger)]' : 'text-[var(--text-muted)]'} />
          {session.findingCount ?? 0} 漏洞
        </span>
        <span className="ml-auto text-[var(--text-muted)]">
          {new Date(session.createdAt).toLocaleDateString('zh-CN')}
        </span>
      </div>
      <button
        onClick={onDelete}
        className="absolute top-3 right-3 rounded-md p-1 bg-[var(--bg-surface)] text-[var(--text-muted)] opacity-0 group-hover:opacity-100 hover:text-[var(--danger)] hover:bg-[var(--danger)]/10 transition-all"
        title="删除会话"
      >
        <Trash2 size={13} />
      </button>
    </div>
  )
}

export function HomePage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [domain, setDomain] = useState('')
  const [title, setTitle] = useState('')
  const [view, setView] = useState<HomeView>('sessions')

  const { data: sessions = [] } = useQuery({
    queryKey: ['sessions'],
    queryFn: api.sessions.list,
    refetchInterval: 5000,
  })

  const createMutation = useMutation({
    mutationFn: (target: string) => api.sessions.create(target, title || undefined),
    onSuccess: session => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
      setDomain('')
      setTitle('')
      navigate(`/session/${session.id}`)
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.sessions.delete(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sessions'] }),
  })

  const normalizeUrl = useCallback((raw: string): string => {
    const trimmed = raw.trim()
    if (!trimmed) return ''
    // 已带协议则原样，否则一律补 https://（裸域名/带端口/带路径都适用）
    return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  }, [])

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault()
    const normalized = normalizeUrl(domain)
    if (!normalized) return
    createMutation.mutate(normalized)
  }

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
        e.preventDefault()
        document.getElementById('home-domain-input')?.focus()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const handleDelete = useCallback((e: React.MouseEvent, id: string, name: string) => {
    e.stopPropagation()
    if (window.confirm(`确定要删除会话「${name}」吗？此操作不可撤销。`)) {
      deleteMutation.mutate(id)
    }
  }, [deleteMutation])

  const list = sessions as Session[]
  const activeSessions = list.filter(s => s.status !== 'completed' && s.status !== 'idle')
  const historySessions = list.filter(s => s.status === 'completed' || s.status === 'idle')

  const stats = useMemo(() => ({
    active: activeSessions.length,
    endpoints: list.reduce((sum, s) => sum + (s.endpointCount ?? 0), 0),
    findings: list.reduce((sum, s) => sum + (s.findingCount ?? 0), 0),
    completed: list.filter(s => s.status === 'completed').length,
  }), [list, activeSessions.length])

  return (
    <div className="flex h-screen bg-[var(--bg-base)] text-[var(--text-primary)]">
      <Sidebar
        view={view}
        onView={setView}
      />

      <main className="flex-1 min-w-0 overflow-y-auto custom-scrollbar">
        {view === 'dashboard' ? (
          <div className="max-w-5xl mx-auto px-8 py-10">
            <AgentDashboard />
          </div>
        ) : (
        <div className="max-w-4xl mx-auto px-8 py-10">
          {/* Header + launcher */}
          <div className="mb-8">
            <h1 className="text-xl font-semibold tracking-tight mb-1">开始一次安全测试</h1>
            <p className="text-sm text-[var(--text-muted)] mb-5">
              输入目标域名，自动发现接口并挖掘漏洞。
            </p>
            <form onSubmit={handleCreate} className="flex flex-col sm:flex-row gap-2">
              <div className="relative flex-1">
                <Globe size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
                <input
                  id="home-domain-input"
                  type="text"
                  value={domain}
                  onChange={e => setDomain(e.target.value)}
                  onBlur={e => {
                    const n = normalizeUrl(e.target.value)
                    if (n && n !== e.target.value) setDomain(n)
                  }}
                  placeholder="example.com（自动补全 https://）"
                  className={cn(
                    'w-full rounded-lg border border-[var(--border-strong)] bg-[var(--bg-input)] pl-9 pr-3 py-2.5 text-sm',
                    'text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)]',
                    'focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/20 focus:border-[var(--accent)]/40 transition-all',
                  )}
                />
              </div>
              <input
                type="text"
                value={title}
                onChange={e => setTitle(e.target.value)}
                placeholder="会话名称（可选）"
                className={cn(
                  'sm:w-44 rounded-lg border border-[var(--border-strong)] bg-[var(--bg-input)] px-3 py-2.5 text-sm',
                  'text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)]',
                  'focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/20 focus:border-[var(--accent)]/40 transition-all',
                )}
              />
              <GetStartedButton
                type="submit"
                label={createMutation.isPending ? '启动中…' : '启动测试'}
                disabled={!domain.trim() || createMutation.isPending}
                className="shrink-0"
              />
            </form>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-9">
            <StatCard icon={<Zap size={13} />} label="活跃会话" value={stats.active} />
            <StatCard icon={<Network size={13} />} label="累计接口" value={stats.endpoints} />
            <StatCard icon={<AlertTriangle size={13} />} label="累计漏洞" value={stats.findings}
              accent={stats.findings > 0 ? 'text-[var(--danger)]' : undefined} />
            <StatCard icon={<FileText size={13} />} label="已完成" value={stats.completed} />
          </div>

          {/* Active */}
          {activeSessions.length > 0 && (
            <section className="mb-9">
              <h2 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider mb-3 flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--success)] animate-pulse" />
                进行中 · {activeSessions.length}
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {activeSessions.map(s => (
                  <SessionCard key={s.id} session={s}
                    onOpen={() => navigate(`/session/${s.id}`)}
                    onDelete={e => handleDelete(e, s.id, s.title ?? s.domain)} />
                ))}
              </div>
            </section>
          )}

          {/* History */}
          {historySessions.length > 0 && (
            <section>
              <h2 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider mb-3">
                历史会话 · {historySessions.length}
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {historySessions.map(s => (
                  <SessionCard key={s.id} session={s}
                    onOpen={() => navigate(`/session/${s.id}`)}
                    onDelete={e => handleDelete(e, s.id, s.title ?? s.domain)} />
                ))}
              </div>
            </section>
          )}

          {list.length === 0 && (
            <div className="text-center py-16 rounded-xl border border-dashed border-[var(--border)]">
              <Sparkles size={22} className="mx-auto mb-2 text-[var(--text-muted)]" />
              <div className="text-sm text-[var(--text-secondary)]">还没有任何会话</div>
              <div className="text-xs text-[var(--text-placeholder)] mt-1">在上方输入目标域名开始测试</div>
            </div>
          )}
        </div>
        )}
      </main>
    </div>
  )
}
