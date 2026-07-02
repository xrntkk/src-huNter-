import { useQuery } from '@tanstack/react-query'
import { Coins, Wrench, Activity } from 'lucide-react'

interface Summary {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  cacheHitRate: number
  modelCalls: number
  toolCalls: number
  toolErrors: number
  events: number
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

interface Props { sessionId: string }

export function SessionTelemetryCard({ sessionId }: Props) {
  const { data } = useQuery({
    queryKey: ['telemetry-session', sessionId],
    queryFn: async () => {
      const res = await fetch(`/api/telemetry/session/${sessionId}/summary`)
      if (!res.ok) throw new Error('failed')
      return res.json() as Promise<Summary>
    },
    enabled: !!sessionId,
    refetchInterval: 5_000,
  })

  if (!data || data.events === 0) {
    return (
      <div className="border-t border-[var(--border)] px-3 py-3 text-[10px] text-[var(--text-muted)]">
        暂无 telemetry 数据
      </div>
    )
  }

  const totalTokens = data.inputTokens + data.outputTokens + data.cacheReadTokens
  const hit = (data.cacheHitRate * 100).toFixed(0)

  return (
    <div className="border-t border-[var(--border)] px-3 py-3 space-y-2">
      <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
        <span>本会话用量</span>
        <span className="text-[var(--text-secondary)]">{data.modelCalls} 次调用</span>
      </div>

      <div className="flex items-center gap-1.5 text-xs">
        <Coins size={11} className="text-[var(--info)] shrink-0" />
        <span className="text-[var(--text-primary)] font-medium tabular-nums">{formatNum(totalTokens)}</span>
        <span className="text-[10px] text-[var(--text-muted)] ml-auto">tokens</span>
      </div>

      <div className="flex items-center gap-1.5 text-xs">
        <Activity size={11} className="text-[var(--chart-2)] shrink-0" />
        <span className="text-[var(--text-primary)] tabular-nums">{hit}%</span>
        <span className="text-[10px] text-[var(--text-muted)] ml-auto">cache 命中</span>
      </div>

      <div className="flex items-center gap-1.5 text-xs">
        <Wrench size={11} className="text-[var(--warning)] shrink-0" />
        <span className="text-[var(--text-primary)] tabular-nums">{data.toolCalls}</span>
        {data.toolErrors > 0 && (
          <span className="text-[10px] text-[var(--danger)] tabular-nums">({data.toolErrors} err)</span>
        )}
        <span className="text-[10px] text-[var(--text-muted)] ml-auto">tool 调用</span>
      </div>

      <div className="grid grid-cols-3 gap-1 pt-1 text-[10px] text-[var(--text-muted)]">
        <div className="text-center">
          <div className="text-[var(--text-secondary)] tabular-nums">{formatNum(data.inputTokens)}</div>
          <div>输入</div>
        </div>
        <div className="text-center">
          <div className="text-[var(--text-secondary)] tabular-nums">{formatNum(data.outputTokens)}</div>
          <div>输出</div>
        </div>
        <div className="text-center">
          <div className="text-[var(--text-secondary)] tabular-nums">{formatNum(data.cacheReadTokens)}</div>
          <div>cache</div>
        </div>
      </div>
    </div>
  )
}
