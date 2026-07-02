import React from 'react'
import { cn } from '~/lib/utils'
import { Loader2, CheckCircle2, AlertCircle, Sparkles, Search, Zap } from 'lucide-react'

export type AgentStatus = 'idle' | 'crawling' | 'testing' | 'analyzing' | 'thinking' | 'tool_calling' | 'completed' | 'error'

interface ChatStatusBarProps {
  status: AgentStatus
  statusMessage?: string
}

export function ChatStatusBar({ status, statusMessage }: ChatStatusBarProps) {
  if (status === 'idle') return null

  const config: Record<AgentStatus, { icon: React.ReactNode; label: string; color: string; pulse: boolean }> = {
    idle: { icon: null, label: '', color: '', pulse: false },
    crawling: {
      icon: <Search size={12} className="text-[var(--info)]" />,
      label: statusMessage || '正在爬取接口…',
      color: 'text-[var(--info)]',
      pulse: true,
    },
    testing: {
      icon: <Zap size={12} className="text-[var(--warning)]" />,
      label: statusMessage || '正在测试漏洞…',
      color: 'text-[var(--warning)]',
      pulse: true,
    },
    analyzing: {
      icon: <Sparkles size={12} className="text-[var(--chart-2)]" />,
      label: statusMessage || '正在分析结果…',
      color: 'text-[var(--chart-2)]',
      pulse: true,
    },
    thinking: {
      icon: <Sparkles size={12} className="text-[var(--accent)]" />,
      label: statusMessage || '正在思考…',
      color: 'text-[var(--accent)]',
      pulse: true,
    },
    tool_calling: {
      icon: <Loader2 size={12} className="animate-spin text-[var(--success)]" />,
      label: statusMessage || '正在调用工具…',
      color: 'text-[var(--success)]',
      pulse: false,
    },
    completed: {
      icon: <CheckCircle2 size={12} className="text-[var(--success)]" />,
      label: statusMessage || '任务完成',
      color: 'text-[var(--success)]',
      pulse: false,
    },
    error: {
      icon: <AlertCircle size={12} className="text-[var(--danger)]" />,
      label: statusMessage || '发生错误',
      color: 'text-[var(--danger)]',
      pulse: false,
    },
  }

  const cfg = config[status]
  if (!cfg) return null

  return (
    <div className="w-full px-4 pt-3 pb-1">
      <div className="min-h-[28px] w-full rounded-full px-3 py-1 bg-[var(--bg-surface)] border border-[var(--border)] flex items-center gap-2">
        <span
          className={cn(
            'flex-shrink-0 w-2 h-2 rounded-full',
            cfg.pulse && 'animate-pulse',
            status === 'crawling' && 'bg-[var(--info)]',
            status === 'testing' && 'bg-[var(--warning)]',
            status === 'analyzing' && 'bg-[var(--chart-2)]',
            status === 'thinking' && 'bg-[var(--accent)]',
            status === 'tool_calling' && 'bg-[var(--success)]',
            status === 'completed' && 'bg-[var(--success)]',
            status === 'error' && 'bg-[var(--danger)]',
          )}
        />
        <span className="flex-shrink-0">{cfg.icon}</span>
        <span className={cn('text-[11px] font-normal leading-[16px] break-words', cfg.color)}>
          {cfg.label}
        </span>
      </div>
    </div>
  )
}
