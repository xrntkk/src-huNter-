import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Globe, AlertTriangle, CheckCircle2, XCircle, HelpCircle, ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '~/lib/utils'

const METHOD_COLOR: Record<string, string> = {
  GET:    'bg-[#e8f1ff] text-[#1e5fce] border-[#bcd6ff] dark:bg-[#1a2d3d] dark:text-[#6b9fff] dark:border-[#1e3a5f]',
  POST:   'bg-[#e8f7e8] text-[#2f8f2f] border-[#bfe6bf] dark:bg-[#1a2d1d] dark:text-[#a5e75e] dark:border-[#14532d]',
  PUT:    'bg-[#fdf2dd] text-[#a96f0a] border-[#f0dba8] dark:bg-[#2d2515] dark:text-[#d4a843] dark:border-[#78350f]',
  DELETE: 'bg-[#fde8e6] text-[#c4392b] border-[#f5c2bc] dark:bg-[#2d1515] dark:text-[#e76a5e] dark:border-[#7f1d1d]',
  PATCH:  'bg-[#f5e9fd] text-[#8b2fc9] border-[#e3c5f5] dark:bg-[#25152d] dark:text-[#c084fc] dark:border-[#581c87]',
  UNKNOWN:'bg-[var(--bg-surface)] text-[var(--text-muted)] border-[var(--border)]',
}

export const EndpointNode = memo(({ data }: NodeProps) => {
  const d = data as {
    nodeType?: string
    method?: string
    pathTemplate?: string
    label?: string
    selected?: boolean
    findingCount?: number
    riskHints?: string[]
    description?: string
    verificationStatus?: 'unverified' | 'verified_safe' | 'verified_vulnerable'
    collapsed?: boolean
    collapsedEndpointCount?: number
    collapsedFindingCount?: number
  }

  const isDomain = d.nodeType === 'domain'
  const isSelected = d.selected

  if (isDomain) {
    // Host-domain nodes that have collapsed their endpoint cluster show a
    // count badge + chevron so the user knows clicking expands the cluster.
    // The session-root domain (no collapsed flag, no count) renders as before.
    const isHostDomain = d.collapsedEndpointCount !== undefined || d.collapsed === true
    return (
      <div className={cn(
        'rounded-xl border px-4 py-2 text-sm font-semibold shadow-lg',
        'bg-[#eef0ff] border-[#c7cbf5] text-[#3730a3] dark:bg-[#1a1a3e] dark:border-[#4f46a0] dark:text-[#c7d2fe]',
        'cursor-pointer hover:border-[#818cf8] dark:hover:border-[#818cf8] transition-colors',
        isSelected && 'ring-2 ring-[#818cf8]',
        isHostDomain && (d.collapsed ? 'border-dashed' : ''),
      )} title={isHostDomain ? '点击展开/收起接口' : undefined}>
        <div className="flex items-center gap-2">
          {isHostDomain && (
            d.collapsed ? <ChevronRight size={14} className="text-[#6366f1] dark:text-[#818cf8]" /> : <ChevronDown size={14} className="text-[#6366f1] dark:text-[#818cf8]" />
          )}
          <Globe size={16} className="text-[#6366f1] dark:text-[#818cf8]" />
          <span>{String(d.label ?? 'Domain')}</span>
          {isHostDomain && d.collapsedEndpointCount !== undefined && d.collapsedEndpointCount > 0 && (
            <span className="ml-1 rounded-full bg-[#6366f1]/15 text-[#3730a3] dark:text-[#c7d2fe] border border-[#6366f1]/30 px-1.5 py-0.5 text-[10px] font-mono">
              {d.collapsedEndpointCount} 接口
            </span>
          )}
          {isHostDomain && d.collapsedFindingCount !== undefined && d.collapsedFindingCount > 0 && (
            <span className="rounded-full bg-[#fde8e6] text-[#c4392b] dark:bg-[#2d1515] dark:text-[#fca5a5] border border-[#f5c2bc] dark:border-[#7f1d1d] px-1.5 py-0.5 text-[10px] font-mono">
              {d.collapsedFindingCount} 漏洞
            </span>
          )}
        </div>
        {!d.collapsed && <Handle type="source" position={Position.Bottom} className="!bg-[#6366f1]" />}
      </div>
    )
  }

  const method = String(d.method ?? 'UNKNOWN')
  const methodClass = METHOD_COLOR[method] ?? METHOD_COLOR.UNKNOWN
  const hasHighRisk = (d.riskHints ?? []).length > 0
  const findingCount = d.findingCount ?? 0
  const description = String(d.description ?? '')
  const path = String(d.pathTemplate ?? d.label ?? '')
  const vStatus = d.verificationStatus ?? 'unverified'

  const statusBorder =
    vStatus === 'verified_vulnerable' ? 'border-[#e76a5e]/70' :
    vStatus === 'verified_safe' ? 'border-[#4ade80]/50' :
    hasHighRisk && !isSelected ? 'border-[#d4a843]/50' : ''

  return (
    <div
      title={description ? `${path}\n\n${description}` : path}
      className={cn(
      'rounded-lg border px-3 py-2 text-xs shadow-md min-w-[200px] max-w-[260px]',
      'bg-[var(--bg-surface)] border-[var(--border)] text-[var(--text-secondary)] cursor-pointer transition-all',
      isSelected && 'ring-2 ring-[#6366f1] border-[#6366f1] dark:ring-[#818cf8]',
      !isSelected && statusBorder,
    )}>
      <Handle type="target" position={Position.Top} className="!bg-[#9ca3af] dark:!bg-[#4a4a5a]" />
      <div className="flex items-center gap-2">
        <span className={cn('rounded border px-1.5 py-0.5 font-mono font-bold text-[10px]', methodClass)}>
          {method}
        </span>
        {vStatus === 'verified_safe' && (
          <CheckCircle2 size={12} className="text-[#4ade80]" />
        )}
        {vStatus === 'verified_vulnerable' && (
          <XCircle size={12} className="text-[#e76a5e]" />
        )}
        {vStatus === 'unverified' && (
          <HelpCircle size={10} className="text-[var(--text-muted)] opacity-50" />
        )}
        {findingCount > 0 && (
          <span className="ml-auto rounded bg-[#fde8e6] border border-[#f5c2bc] px-1.5 text-[#c4392b] text-[10px] dark:bg-[#2d1515] dark:border-[#7f1d1d] dark:text-[#fca5a5]">
            {findingCount} 漏洞
          </span>
        )}
        {hasHighRisk && findingCount === 0 && (
          <AlertTriangle size={12} className="ml-auto text-[#d4a843]" />
        )}
      </div>
      <div className="mt-1.5 font-mono text-[11px] text-[var(--text-muted)] truncate">
        {path}
      </div>
      {description && (
        <div className="mt-1 text-[10px] text-[var(--text-secondary)] line-clamp-2 leading-snug">
          {description}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className="!bg-[#9ca3af] dark:!bg-[#4a4a5a]" />
    </div>
  )
})
EndpointNode.displayName = 'EndpointNode'
