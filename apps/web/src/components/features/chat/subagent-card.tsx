import { useState } from 'react'
import { Bot, ChevronDown, Wrench, Check, X, Loader2 } from 'lucide-react'

interface SubagentChildStep {
  type: string
  toolName?: string
  toolCallId?: string
  args?: unknown
  result?: unknown
  error?: string
  content?: string
  reason?: string
}

interface SubagentCardProps {
  taskId: string
  description: string
  steps: SubagentChildStep[]
}

export function SubagentCard({ taskId, description, steps }: SubagentCardProps) {
  const [expanded, setExpanded] = useState(false)

  const toolCalls = steps.filter(s => s.type === 'tool_call').length
  const toolErrors = steps.filter(s => s.type === 'tool_error').length
  const isFinished = steps.some(s => s.type === 'finish')
  const finishStep = steps.find(s => s.type === 'finish')

  return (
    <div className="rounded-lg border border-[var(--accent)]/20 bg-[var(--accent)]/5 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
      >
        <Bot size={12} className="text-[var(--accent)]" />
        <span className="font-medium text-[var(--text-secondary)]">{description}</span>
        <span className="text-[10px] opacity-60 ml-1">{taskId}</span>
        <span className="ml-auto flex items-center gap-1.5">
          {!isFinished && (
            <span className="flex items-center gap-1 text-[var(--accent)]">
              <Loader2 size={10} className="animate-spin" />
              <span className="text-[10px]">运行中</span>
            </span>
          )}
          {isFinished && (
            <span className="flex items-center gap-1 text-[#3b9e6a]">
              <Check size={10} />
              <span className="text-[10px]">{finishStep?.reason ?? '完成'}</span>
            </span>
          )}
          {toolCalls > 0 && (
            <span className="text-[10px] opacity-60">
              <Wrench size={9} className="inline mr-0.5" />{toolCalls}
            </span>
          )}
          {toolErrors > 0 && (
            <span className="text-[10px] text-[#e76a5e]">
              <X size={9} className="inline mr-0.5" />{toolErrors}
            </span>
          )}
        </span>
        <ChevronDown
          size={12}
          className={`transition-transform ${expanded ? 'rotate-180' : ''}`}
        />
      </button>
      {expanded && (
        <div className="px-3 pb-2 space-y-1 border-t border-[var(--accent)]/10 pt-2 max-h-64 overflow-y-auto">
          {steps.map((step, idx) => (
            <SubagentStepRow key={idx} step={step} />
          ))}
          {steps.length === 0 && (
            <div className="text-[10px] text-[var(--text-muted)] italic">等待子 Agent 活动...</div>
          )}
        </div>
      )}
    </div>
  )
}

function SubagentStepRow({ step }: { step: SubagentChildStep }) {
  if (step.type === 'tool_call') {
    const argsStr = step.args ? JSON.stringify(step.args).slice(0, 80) : ''
    return (
      <div className="flex items-start gap-1.5 text-[11px]">
        <Wrench size={10} className="text-[var(--accent)] mt-0.5 flex-shrink-0" />
        <span className="font-mono font-medium text-[var(--text-primary)]">{step.toolName}</span>
        {argsStr && (
          <span className="text-[var(--text-muted)] truncate max-w-[200px]">
            {argsStr}
          </span>
        )}
      </div>
    )
  }

  if (step.type === 'tool_result') {
    const resultStr = typeof step.result === 'string'
      ? step.result.slice(0, 100)
      : JSON.stringify(step.result ?? '').slice(0, 100)
    return (
      <div className="flex items-start gap-1.5 text-[11px]">
        <Check size={10} className="text-[#3b9e6a] mt-0.5 flex-shrink-0" />
        <span className="font-mono text-[var(--text-muted)]">{step.toolName}</span>
        <span className="text-[var(--text-muted)] truncate max-w-[250px]">{resultStr}</span>
      </div>
    )
  }

  if (step.type === 'tool_error') {
    return (
      <div className="flex items-start gap-1.5 text-[11px]">
        <X size={10} className="text-[#e76a5e] mt-0.5 flex-shrink-0" />
        <span className="font-mono text-[#e76a5e]">{step.toolName}</span>
        <span className="text-[#e76a5e] truncate max-w-[250px]">{step.error?.slice(0, 80)}</span>
      </div>
    )
  }

  if (step.type === 'thinking') {
    return (
      <div className="text-[10px] text-[var(--text-muted)] italic truncate">
        {step.content?.slice(0, 120)}
      </div>
    )
  }

  if (step.type === 'finish') {
    return (
      <div className="flex items-center gap-1.5 text-[11px] text-[#3b9e6a]">
        <Check size={10} />
        <span>子 Agent 完成: {step.reason}</span>
      </div>
    )
  }

  return null
}
