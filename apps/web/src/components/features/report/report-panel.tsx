import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Download, FileText, Shield } from 'lucide-react'
import { api } from '~/lib/api'
import type { Finding } from '@src-agent/types'
import { cn } from '~/lib/utils'

const SEVERITY_COLOR: Record<string, string> = {
  critical: 'text-[var(--danger)] bg-[var(--danger)]/10 border-[var(--danger)]/30',
  high:     'text-[var(--warning)] bg-[var(--warning)]/10 border-[var(--warning)]/30',
  medium:   'text-[var(--chart-2)] bg-[var(--chart-2)]/10 border-[var(--chart-2)]/30',
  low:      'text-[var(--info)] bg-[var(--info)]/10 border-[var(--info)]/30',
  info:     'text-[var(--text-muted)] bg-[var(--bg-surface)] border-[var(--border)]',
}

interface ReportPanelProps {
  sessionId: string
  refreshKey: number
}

export function ReportPanel({ sessionId, refreshKey }: ReportPanelProps) {
  const [downloading, setDownloading] = useState(false)

  const { data: graph } = useQuery({
    queryKey: ['endpoint-graph', sessionId, refreshKey],
    queryFn: () => api.endpoints.graph(sessionId),
    refetchInterval: false,
  })

  const findings = (graph?.nodes ?? [])
    .filter(n => n.type === 'finding')
    .map(n => n.data as Finding)

  const sorted = [...findings].sort((a, b) => {
    const order: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
    return (order[a.severity] ?? 5) - (order[b.severity] ?? 5)
  })

  const handleDownload = async () => {
    setDownloading(true)
    try {
      const res = await api.reports.download(sessionId)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `report-${sessionId}.md`
      a.click()
      URL.revokeObjectURL(url)
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="flex h-full flex-col bg-[var(--bg-base)]">
      <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
          <FileText size={14} />
          <span>漏洞报告</span>
          <span className="ml-1 rounded bg-[var(--bg-surface)] px-1.5 text-xs text-[var(--text-muted)] border border-[var(--border)]">
            {sorted.length}
          </span>
        </div>
        <button
          onClick={handleDownload}
          disabled={downloading || sorted.length === 0}
          className={cn(
            'flex items-center gap-1 rounded-lg border px-3 py-1.5 text-xs transition-colors',
            'border-[var(--border)] bg-[var(--bg-surface)] text-[var(--text-secondary)]',
            'hover:bg-[var(--bg-hover)] disabled:opacity-40',
          )}
        >
          <Download size={12} />
          {downloading ? '导出中...' : '导出 Markdown'}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 custom-scrollbar">
        {sorted.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[var(--text-muted)] text-sm text-center">
            <div>
              <Shield size={32} className="mx-auto mb-2 text-[var(--text-muted)]" />
              <div>尚未发现漏洞</div>
              <div className="text-xs mt-1 text-[var(--text-placeholder)]">选择接口并让 Agent 进行漏洞测试</div>
            </div>
          </div>
        ) : (
          sorted.map((f: Finding) => {
            const isFalsePositive = f.status === 'false_positive'
            const isConfirmed = f.status === 'confirmed'
            return (
              <div
                key={f.id}
                className={cn(
                  'rounded-lg border p-3 text-xs transition-all',
                  SEVERITY_COLOR[f.severity] ?? SEVERITY_COLOR.info,
                  isFalsePositive && 'opacity-50 saturate-50',
                )}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className={cn('font-bold uppercase', isFalsePositive && 'line-through')}>{f.severity}</span>
                  <span className="opacity-60">{f.type}</span>
                  <span
                    className={cn(
                      'ml-auto text-[10px] px-1.5 py-0.5 rounded border',
                      isFalsePositive
                        ? 'border-[var(--border)] text-[var(--text-muted)] bg-[var(--bg-surface)]'
                        : isConfirmed
                          ? 'border-[var(--success)] text-[var(--success)] bg-[var(--bg-surface)]'
                          : 'border-[var(--border)] text-[var(--text-muted)] bg-[var(--bg-surface)]',
                    )}
                  >
                    {isFalsePositive ? '误报' : isConfirmed ? '已确认' : '待确认'}
                  </span>
                </div>
                <div className={cn('font-medium text-[11px] leading-snug', isFalsePositive && 'line-through')}>{f.title}</div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
