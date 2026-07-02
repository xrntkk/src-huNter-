import { useMemo, useState } from 'react'
import { Search, X, PanelLeftClose, PanelLeftOpen, AlertTriangle, ChevronRight, ChevronDown, CheckCircle2, XCircle, Download, Globe } from 'lucide-react'
import { cn } from '~/lib/utils'
import { api } from '~/lib/api'
import { downloadEndpointsJson } from '~/lib/export-endpoints'
import type { GraphNode } from './endpoint-graph'

const METHOD_COLOR: Record<string, string> = {
  GET:    'text-[#1e5fce] dark:text-[#6b9fff]',
  POST:   'text-[#2f8f2f] dark:text-[#a5e75e]',
  PUT:    'text-[#a96f0a] dark:text-[#d4a843]',
  DELETE: 'text-[#c4392b] dark:text-[#e76a5e]',
  PATCH:  'text-[#8b2fc9] dark:text-[#c084fc]',
  UNKNOWN:'text-[var(--text-muted)]',
}

interface GraphSidebarProps {
  sessionId: string
  nodes: GraphNode[]
  selectedIds: string[]
  collapsed: boolean
  onToggleCollapse: () => void
  onSelect: (id: string, multi: boolean) => void
  onFocus: (id: string) => void
}

interface ListItem {
  id: string
  method: string
  path: string
  url: string
  host: string
  description: string
  findingCount: number
  riskHints: string[]
  techStack: string[]
  hasRisk: boolean
  verificationStatus: 'unverified' | 'verified_safe' | 'verified_vulnerable'
}

export function GraphSidebar({
  sessionId,
  nodes,
  selectedIds,
  collapsed,
  onToggleCollapse,
  onSelect,
  onFocus,
}: GraphSidebarProps) {
  const [query, setQuery] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  // Per-host section collapsed state. Hosts with >=1 selected endpoint stay
  // expanded by default so the user can see what they picked.
  const [collapsedHosts, setCollapsedHosts] = useState<Set<string>>(new Set())
  const [statusFilter, setStatusFilter] = useState<'all' | 'unverified' | 'verified_safe' | 'verified_vulnerable'>('all')
  const [exporting, setExporting] = useState(false)

  async function handleExport() {
    if (exporting) return
    setExporting(true)
    try {
      const eps = await api.endpoints.list(sessionId)
      const stamp = new Date().toISOString().slice(0, 10)
      downloadEndpointsJson(eps, `endpoints-${sessionId.slice(0, 8)}-${stamp}.json`)
    } catch (err) {
      console.error('导出接口失败', err)
    } finally {
      setExporting(false)
    }
  }

  const items: ListItem[] = useMemo(() => {
    return nodes
      .filter(n => n.type === 'endpoint')
      .map(n => {
        const d = n.data as {
          method?: string
          pathTemplate?: string
          label?: string
          url?: string
          host?: string
          description?: string
          findingCount?: number
          riskHints?: string[]
          techStack?: string[]
          verificationStatus?: 'unverified' | 'verified_safe' | 'verified_vulnerable'
        }
        const riskHints = d.riskHints ?? []
        return {
          id: n.id,
          method: String(d.method ?? 'UNKNOWN').toUpperCase(),
          path: String(d.pathTemplate ?? d.label ?? n.id),
          url: String(d.url ?? ''),
          host: String(d.host ?? ''),
          description: String(d.description ?? ''),
          findingCount: d.findingCount ?? 0,
          riskHints,
          techStack: d.techStack ?? [],
          hasRisk: riskHints.length > 0,
          verificationStatus: d.verificationStatus ?? 'unverified',
        }
      })
  }, [nodes])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return items.filter(it => {
      if (statusFilter !== 'all' && it.verificationStatus !== statusFilter) return false
      if (!q) return true
      return it.path.toLowerCase().includes(q) || it.method.toLowerCase().includes(q) || it.host.toLowerCase().includes(q)
    })
  }, [items, query, statusFilter])

  // Group filtered items by host. Single-host sessions render the same flat
  // list as before; multi-host sessions (subdomain enumeration) get a
  // collapsible section per host with a count badge.
  const grouped = useMemo(() => {
    const map = new Map<string, ListItem[]>()
    for (const it of filtered) {
      const h = it.host || '其他'
      const list = map.get(h) ?? []
      list.push(it)
      map.set(h, list)
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [filtered])

  const hasMultipleHosts = grouped.length > 1

  function toggleHost(h: string) {
    setCollapsedHosts(prev => {
      const next = new Set(prev)
      if (next.has(h)) next.delete(h)
      else next.add(h)
      return next
    })
  }

  if (collapsed) {
    return (
      <div className="flex flex-col items-center border-r border-[var(--border)] bg-[var(--bg-base)] py-2">
        <button
          onClick={onToggleCollapse}
          className="p-1.5 rounded-md hover:bg-[var(--bg-hover)] text-[var(--text-muted)] transition-colors"
          title="展开接口列表"
        >
          <PanelLeftOpen size={16} />
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col w-[240px] min-w-[200px] max-w-[300px] border-r border-[var(--border)] bg-[var(--bg-base)]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)]">
        <span className="text-[11px] font-medium text-[var(--text-muted)] uppercase tracking-wider">
          接口列表 ({items.length})
        </span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={handleExport}
            disabled={exporting || items.length === 0}
            className="p-1 rounded-md hover:bg-[var(--bg-hover)] text-[var(--text-muted)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title={items.length === 0 ? '暂无接口可导出' : '导出接口为 JSON'}
          >
            <Download size={14} className={cn(exporting && 'animate-pulse')} />
          </button>
          <button
            onClick={onToggleCollapse}
            className="p-1 rounded-md hover:bg-[var(--bg-hover)] text-[var(--text-muted)] transition-colors"
            title="收起"
          >
            <PanelLeftClose size={14} />
          </button>
        </div>
      </div>

      <div className="px-2 py-2 border-b border-[var(--border)]">
        <div className="relative">
          <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="搜索路径、方法或域名..."
            className={cn(
              'w-full rounded-md bg-[var(--bg-surface)] border border-[var(--border)]',
              'pl-7 pr-7 py-1.5 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)]',
              'focus:outline-none focus:border-[var(--accent)]/50 transition-colors',
            )}
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
            >
              <X size={13} />
            </button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-[var(--border)]">
        {(['all', 'unverified', 'verified_safe', 'verified_vulnerable'] as const).map(s => {
          const labels: Record<string, string> = { all: '全部', unverified: '未验证', verified_safe: '安全', verified_vulnerable: '有漏洞' }
          const colors: Record<string, string> = { all: '', unverified: 'text-[var(--text-muted)]', verified_safe: 'text-[#4ade80]', verified_vulnerable: 'text-[#e76a5e]' }
          return (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={cn(
                'px-1.5 py-0.5 rounded text-[9px] transition-colors',
                statusFilter === s
                  ? 'bg-[var(--accent)]/15 text-[var(--accent)] font-medium'
                  : cn('hover:bg-[var(--bg-hover)]', colors[s]),
              )}
            >
              {labels[s]}
            </button>
          )
        })}
      </div>

      <div className="flex-1 overflow-y-auto p-1">
        {filtered.length === 0 ? (
          <div className="flex items-center justify-center h-20 text-[var(--text-muted)] text-xs">
            {items.length === 0 ? '暂无接口' : '无匹配结果'}
          </div>
        ) : (
          grouped.map(([host, hostItems]) => {
            const isHostCollapsed = collapsedHosts.has(host)
            const hostSelectedCount = hostItems.filter(it => selectedIds.includes(it.id)).length
            return (
              <div key={host} className="mb-1">
                {hasMultipleHosts && (
                  <button
                    onClick={() => toggleHost(host)}
                    className={cn(
                      'w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md transition-colors',
                      'hover:bg-[var(--bg-hover)] text-[var(--text-primary)]',
                    )}
                    title={host}
                  >
                    {isHostCollapsed ? <ChevronRight size={11} className="text-[var(--text-muted)]" /> : <ChevronDown size={11} className="text-[var(--text-muted)]" />}
                    <Globe size={11} className="text-[#6b9fff] shrink-0" />
                    <span className="font-mono text-[11px] font-medium truncate flex-1 text-left">{host}</span>
                    <span className="text-[9px] text-[var(--text-muted)] shrink-0">{hostItems.length}</span>
                    {hostSelectedCount > 0 && (
                      <span className="rounded bg-[var(--accent)]/20 px-1 text-[9px] text-[var(--accent)] font-medium shrink-0">
                        {hostSelectedCount}
                      </span>
                    )}
                  </button>
                )}
                {!isHostCollapsed && (
                  <div className={hasMultipleHosts ? 'ml-1' : ''}>
                    {hostItems.map(it => {
                      const isSelected = selectedIds.includes(it.id)
                      const isExpanded = expandedId === it.id
                      return (
                        <div key={it.id} className="mb-0.5">
                          <div
                            className={cn(
                              'flex items-center gap-1 w-full rounded-md transition-colors',
                              isSelected
                                ? 'bg-[var(--accent)]/10 ring-1 ring-[var(--accent)]/40'
                                : 'hover:bg-[var(--bg-hover)]',
                            )}
                          >
                            <button
                              onClick={() => setExpandedId(isExpanded ? null : it.id)}
                              className="p-1 text-[var(--text-muted)] hover:text-[var(--text-secondary)] shrink-0"
                              title={isExpanded ? '收起详情' : '展开详情'}
                            >
                              {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                            </button>
                            <button
                              onClick={e => {
                                onSelect(it.id, e.ctrlKey || e.metaKey || e.shiftKey)
                                onFocus(it.id)
                              }}
                              className="flex items-center gap-1.5 flex-1 min-w-0 text-left py-1.5 pr-2"
                              title={it.description || it.path}
                            >
                              <span className={cn('font-mono font-bold text-[9px] shrink-0 w-9', METHOD_COLOR[it.method] ?? METHOD_COLOR.UNKNOWN)}>
                                {it.method}
                              </span>
                              {it.verificationStatus === 'verified_safe' && <CheckCircle2 size={10} className="text-[#4ade80] shrink-0" />}
                              {it.verificationStatus === 'verified_vulnerable' && <XCircle size={10} className="text-[#e76a5e] shrink-0" />}
                              <span className="font-mono text-[11px] text-[var(--text-secondary)] truncate flex-1">
                                {it.path}
                              </span>
                              {it.findingCount > 0 && (
                                <span className="rounded bg-[#fde8e6] border border-[#f5c2bc] px-1 text-[9px] text-[#c4392b] shrink-0 dark:bg-[#2d1515] dark:border-[#7f1d1d] dark:text-[#fca5a5]">
                                  {it.findingCount}
                                </span>
                              )}
                              {it.hasRisk && it.findingCount === 0 && (
                                <AlertTriangle size={10} className="text-[#d4a843] shrink-0" />
                              )}
                            </button>
                          </div>
                          {isExpanded && (
                            <div className="ml-5 mr-1 mt-1 mb-1 px-2.5 py-2 rounded-md bg-[var(--bg-surface)] border border-[var(--border)] space-y-2">
                              <div>
                                <div className="text-[9px] uppercase tracking-wider text-[var(--text-muted)] mb-0.5">用途</div>
                                <div className="text-[11px] text-[var(--text-secondary)] leading-relaxed">
                                  {it.description || <span className="text-[var(--text-muted)] italic">Agent 未提供描述</span>}
                                </div>
                              </div>
                              {it.url && (
                                <div>
                                  <div className="text-[9px] uppercase tracking-wider text-[var(--text-muted)] mb-0.5">URL</div>
                                  <div className="text-[10px] font-mono text-[var(--text-muted)] break-all">{it.url}</div>
                                </div>
                              )}
                              {it.riskHints.length > 0 && (
                                <div>
                                  <div className="text-[9px] uppercase tracking-wider text-[var(--text-muted)] mb-1">风险提示</div>
                                  <div className="flex flex-wrap gap-1">
                                    {it.riskHints.map((r, i) => (
                                      <span key={i} className="rounded bg-[#fdf2dd] border border-[#f0dba8] px-1.5 py-0.5 text-[9px] text-[#a96f0a] dark:bg-[#2d2515] dark:border-[#78350f] dark:text-[#d4a843]">
                                        {r}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              )}
                              {it.techStack.length > 0 && (
                                <div>
                                  <div className="text-[9px] uppercase tracking-wider text-[var(--text-muted)] mb-1">技术栈</div>
                                  <div className="flex flex-wrap gap-1">
                                    {it.techStack.map((t, i) => (
                                      <span key={i} className="rounded bg-[var(--bg-base)] border border-[var(--border)] px-1.5 py-0.5 text-[9px] text-[var(--text-muted)]">
                                        {t}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
