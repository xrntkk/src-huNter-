import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Bug } from 'lucide-react'
import { cn } from '~/lib/utils'

const SEVERITY_COLOR: Record<string, string> = {
  critical: 'bg-[#fde8e6] border-[#f5c2bc] text-[#c4392b] dark:bg-[#2d1515] dark:border-[#7f1d1d] dark:text-[#fca5a5]',
  high:     'bg-[#fdecdd] border-[#f3cda3] text-[#c2570f] dark:bg-[#2d1a0a] dark:border-[#9a3412] dark:text-[#fdba74]',
  medium:   'bg-[#fdf6dd] border-[#ecd99e] text-[#9a7209] dark:bg-[#2d2515] dark:border-[#a16207] dark:text-[#fde047]',
  low:      'bg-[#e6f2fd] border-[#b3d6f0] text-[#1f6cb0] dark:bg-[#0a1d3d] dark:border-[#0c4a6e] dark:text-[#7dd3fc]',
  info:     'bg-[var(--bg-surface)] border-[var(--border)] text-[var(--text-muted)]',
}

export const FindingNode = memo(({ data }: NodeProps) => {
  const d = data as {
    severity?: string
    title?: string
    type?: string
    status?: string
  }

  const severity = d.severity ?? 'info'
  const colorClass = SEVERITY_COLOR[severity] ?? SEVERITY_COLOR.info

  return (
    <div className={cn(
      'rounded-lg border px-3 py-2 text-xs shadow-md min-w-[200px] max-w-[260px]',
      colorClass,
    )}>
      <Handle type="target" position={Position.Top} className="!bg-[#9ca3af] dark:!bg-[#4a4a5a]" />
      <div className="flex items-center gap-2">
        <Bug size={14} className="opacity-70" />
        <span className="font-semibold uppercase text-[10px] opacity-80">{severity}</span>
        <span className="ml-auto text-[10px] opacity-60">{d.type}</span>
      </div>
      <div className="mt-1 text-[11px] leading-snug line-clamp-2">
        {String(d.title ?? '')}
      </div>
    </div>
  )
})
FindingNode.displayName = 'FindingNode'
