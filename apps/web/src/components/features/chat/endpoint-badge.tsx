import { X, Link2 } from 'lucide-react'
import { cn } from '~/lib/utils'

interface EndpointBadgeProps {
  endpoints: Array<{ id: string; method: string; pathTemplate: string }>
  onClear: () => void
}

const METHOD_COLORS: Record<string, string> = {
  GET: 'text-[var(--success)] border-[var(--success)]/20 bg-[var(--success)]/5',
  POST: 'text-[var(--info)] border-[var(--info)]/20 bg-[var(--info)]/5',
  PUT: 'text-[var(--warning)] border-[var(--warning)]/20 bg-[var(--warning)]/5',
  PATCH: 'text-[var(--warning)] border-[var(--warning)]/20 bg-[var(--warning)]/5',
  DELETE: 'text-[var(--danger)] border-[var(--danger)]/20 bg-[var(--danger)]/5',
}

export function EndpointBadgeBar({ endpoints, onClear }: EndpointBadgeProps) {
  if (!endpoints.length) return null

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-[var(--border)] bg-[var(--bg-base)] px-3 py-2"
    >
      <Link2 size={12} className="text-[var(--text-muted)] shrink-0" />
      <span className="text-[11px] text-[var(--text-muted)] shrink-0 font-medium"
      >已选接口</span>
      {endpoints.slice(0, 6).map(ep => (
        <span
          key={ep.id}
          className={cn(
            'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-mono',
            METHOD_COLORS[ep.method] ?? 'text-[var(--text-muted)] border-[var(--border)] bg-[var(--bg-surface)]',
          )}
        >
          <span className="font-bold"
          >{ep.method}</span>
          <span className="text-[var(--text-muted)] truncate max-w-[120px]"
          >{ep.pathTemplate}</span>
        </span>
      ))}
      {endpoints.length > 6 && (
        <span className="text-[10px] text-[var(--text-muted)]"
        >+{endpoints.length - 6}</span>
      )}
      <button
        onClick={onClear}
        className="ml-auto rounded-md p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
        title="清除选择"
      >
        <X size={12} />
      </button>
    </div>
  )
}
