import { useState } from 'react'
import { ChevronDown, ChevronUp, Wrench, Loader2, CheckCircle2, XCircle } from 'lucide-react'
import { cn } from '~/lib/utils'

interface ToolCallCardProps {
  toolName: string
  state: 'call' | 'result'
  args?: Record<string, unknown>
  result?: unknown
  error?: string
}

export function ToolCallCard({ toolName, state, args, result, error }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false)

  const status: 'running' | 'success' | 'error' = error
    ? 'error'
    : state === 'call'
      ? 'running'
      : 'success'

  const statusConfig = {
    running: {
      icon: <Loader2 size={13} className="animate-spin text-[var(--warning)]" />,
      label: '执行中',
      border: 'border-[var(--warning)]/20',
      bg: 'bg-[var(--warning)]/5',
      text: 'text-[var(--warning)]',
    },
    success: {
      icon: <CheckCircle2 size={13} className="text-[var(--success)]" />,
      label: '已完成',
      border: 'border-[var(--success)]/20',
      bg: 'bg-[var(--success)]/5',
      text: 'text-[var(--success)]',
    },
    error: {
      icon: <XCircle size={13} className="text-[var(--danger)]" />,
      label: '失败',
      border: 'border-[var(--danger)]/20',
      bg: 'bg-[var(--danger)]/5',
      text: 'text-[var(--danger)]',
    },
  }

  const cfg = statusConfig[status]

  const formatValue = (val: unknown): string => {
    if (val === null) return 'null'
    if (val === undefined) return 'undefined'
    if (typeof val === 'string') return val
    if (typeof val === 'number' || typeof val === 'boolean') return String(val)
    try {
      return JSON.stringify(val, null, 2)
    } catch {
      return String(val)
    }
  }

  const hasDetails = args || result !== undefined || error

  return (
    <div className={cn('rounded-lg border text-sm', cfg.border, cfg.bg)}>
      {/* Header */}
      <button
        type="button"
        onClick={() => hasDetails && setExpanded(!expanded)}
        className={cn(
          'flex items-center justify-between w-full px-3 py-2',
          hasDetails && 'cursor-pointer hover:bg-white/5',
        )}
      >
        <div className="flex items-center gap-2 min-w-0">
          <Wrench size={12} className="text-[var(--text-muted)] flex-shrink-0" />
          <span className="font-medium text-[var(--text-secondary)] text-xs truncate">{toolName}</span>
          {status === 'running' && (
            <span className="flex items-center gap-1 text-[10px] text-[var(--warning)]">
              <span className="w-1.5 h-1.5 rounded-full animate-pulse bg-[var(--warning)]" />
              执行中
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <span className={cn('text-[10px]', cfg.text)}>{cfg.label}</span>
          {cfg.icon}
          {hasDetails && (
            <span className="text-[var(--text-muted)]">
              {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            </span>
          )}
        </div>
      </button>

      {/* Expanded details */}
      {expanded && hasDetails && (
        <div className="px-3 pb-3 border-t border-white/5">
          {args && Object.keys(args).length > 0 && (
            <div className="mt-2">
              <div className="text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-1">
                参数
              </div>
              <div className="bg-[var(--bg-base)] rounded-md p-2.5 font-mono text-xs text-[var(--text-secondary)] overflow-x-auto">
                <pre className="whitespace-pre-wrap break-all">
                  {JSON.stringify(args, null, 2)}
                </pre>
              </div>
            </div>
          )}

          {error && (
            <div className="mt-2">
              <div className="text-[11px] font-semibold text-[var(--danger)] uppercase tracking-wider mb-1">
                错误
              </div>
              <div className="bg-[var(--danger)]/10 rounded-md p-2.5 font-mono text-xs text-[var(--danger)] overflow-x-auto">
                <pre className="whitespace-pre-wrap break-all">{error}</pre>
              </div>
            </div>
          )}

          {result !== undefined && !error && (
            <div className="mt-2">
              <div className="text-[11px] font-semibold text-[var(--success)] uppercase tracking-wider mb-1">
                结果
              </div>
              <div className="bg-[var(--bg-base)] rounded-md p-2.5 font-mono text-xs text-[var(--text-secondary)] overflow-x-auto max-h-[300px] overflow-y-auto custom-scrollbar">
                <pre className="whitespace-pre-wrap break-all">
                  {formatValue(result)}
                </pre>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
