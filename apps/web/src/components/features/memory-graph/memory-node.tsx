import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Lightbulb, BookOpen, FlaskConical, ListTodo, StickyNote } from 'lucide-react'
import { cn } from '~/lib/utils'

const KIND_META: Record<string, { Icon: typeof StickyNote; cls: string }> = {
  note:       { Icon: StickyNote,   cls: 'text-[#6b7280] border-[#d4d4d8] dark:text-[#9ca3af] dark:border-[#3c3c4a]' },
  lesson:     { Icon: BookOpen,     cls: 'text-[#2f8f2f] border-[#bfe6bf] dark:text-[#a5e75e] dark:border-[#14532d]' },
  hypothesis: { Icon: FlaskConical, cls: 'text-[#8b2fc9] border-[#e3c5f5] dark:text-[#c084fc] dark:border-[#581c87]' },
  todo:       { Icon: ListTodo,     cls: 'text-[#a96f0a] border-[#f0dba8] dark:text-[#d4a843] dark:border-[#78350f]' },
}

export const MemoryNode = memo(({ data }: NodeProps) => {
  const d = data as {
    kind?: string
    title?: string
    content?: string
    selected?: boolean
  }

  const meta = KIND_META[d.kind ?? 'note'] ?? { Icon: Lightbulb, cls: 'text-[var(--text-muted)] border-[var(--border)]' }
  const { Icon } = meta
  const title = String(d.title ?? '')
  const content = String(d.content ?? '')

  return (
    <div
      className={cn(
        'rounded-lg border px-3 py-2 text-xs shadow-md min-w-[200px] max-w-[260px] cursor-pointer',
        'bg-[var(--bg-surface)] text-[var(--text-secondary)] transition-all',
        'hover:shadow-lg hover:-translate-y-0.5 hover:border-[#6366f1]/60 dark:hover:border-[#818cf8]/60',
        meta.cls,
        d.selected && 'ring-2 ring-[#6366f1] border-[#6366f1] dark:ring-[#818cf8]',
      )}
    >
      <Handle type="target" position={Position.Top} className="!bg-[#9ca3af] dark:!bg-[#4a4a5a]" />
      <div className="flex items-center gap-2">
        <Icon size={13} />
        <span className="rounded border border-current/30 px-1.5 py-0.5 font-mono text-[10px] uppercase opacity-80">
          {String(d.kind ?? 'note')}
        </span>
      </div>
      <div className="mt-1.5 font-medium text-[11px] text-[var(--text-primary)] truncate">
        {title}
      </div>
      {content && (
        <div className="mt-1 text-[10px] text-[var(--text-muted)] line-clamp-3 leading-snug">
          {content}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className="!bg-[#9ca3af] dark:!bg-[#4a4a5a]" />
    </div>
  )
})
MemoryNode.displayName = 'MemoryNode'
