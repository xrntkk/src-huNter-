import { useState } from 'react'
import { ChevronDown, ChevronUp, FileText } from 'lucide-react'
import { cn } from '~/lib/utils'
import type { PlanState } from '~/hooks/use-session-chat'

interface TaskListProps {
  plan: PlanState | null
}

export function TaskList({ plan }: TaskListProps) {
  const [expanded, setExpanded] = useState(true)

  if (!plan?.notes) return null

  return (
    <div className="mx-3 mt-3 rounded-lg border border-[var(--border)] bg-[var(--bg-surface)]/50 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)] transition-colors"
      >
        <FileText className="w-3.5 h-3.5" />
        <span>Agent 计划笔记</span>
        <span className="flex-1" />
        {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
      </button>

      {expanded && (
        <div className={cn('px-3 pb-3 text-xs text-[var(--text-secondary)] whitespace-pre-wrap font-mono leading-relaxed')}>
          {plan.notes}
        </div>
      )}
    </div>
  )
}
