import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Activity, Coins, Wrench, AlertTriangle, DollarSign, GitBranch, ExternalLink } from 'lucide-react'
import { api } from '~/lib/api'
import { SessionTracePanel } from './session-trace-panel'
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from 'recharts'

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
  costUsd: number
  errorRate: number
  events: number
}

interface SubagentTask {
  task_id: string
  description: string
  status: string
  started_at: number
  finished_at: number | null
  tool_call_count: number
  tool_error_count: number
  endpoints_found: number
  findings_found: number
  summary: string | null
  error: string | null
}

interface RecentEvent {
  id: string
  sessionId: string | null
  iteration: number | null
  type: string
  toolName: string | null
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  durationMs: number | null
  createdAt: number
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function StatCard({ icon: Icon, label, value, hint, accent }: {
  icon: typeof Activity; label: string; value: string; hint?: string; accent: string
}) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-4">
      <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
        <Icon size={14} className={accent} />
        {label}
      </div>
      <div className="mt-2 text-2xl font-semibold text-[var(--text-primary)]">{value}</div>
      {hint && <div className="mt-1 text-xs text-[var(--text-muted)]">{hint}</div>}
    </div>
  )
}

interface Props { sessionId: string }

export function SessionDashboardPanel({ sessionId }: Props) {
  const { data: summary } = useQuery({
    queryKey: ['telemetry-session', sessionId],
    queryFn: async () => {
      const res = await fetch(`/api/telemetry/session/${sessionId}/summary`)
      if (!res.ok) throw new Error('failed')
      return res.json() as Promise<Summary>
    },
    enabled: !!sessionId,
    refetchInterval: 5_000,
  })

  const { data: events } = useQuery({
    queryKey: ['telemetry-session-events', sessionId],
    queryFn: async () => {
      const res = await fetch(`/api/telemetry/recent?sessionId=${sessionId}&limit=200`)
      if (!res.ok) throw new Error('failed')
      return res.json() as Promise<RecentEvent[]>
    },
    enabled: !!sessionId,
    refetchInterval: 5_000,
  })

  const { data: subagents } = useQuery({
    queryKey: ['telemetry-session-subagents', sessionId],
    queryFn: async () => {
      const res = await fetch(`/api/telemetry/session/${sessionId}/subagents`)
      if (!res.ok) throw new Error('failed')
      return res.json() as Promise<SubagentTask[]>
    },
    enabled: !!sessionId,
    refetchInterval: 5_000,
  })

  const { data: systemInfo } = useQuery({
    queryKey: ['system-info'],
    queryFn: api.system.getInfo,
    staleTime: Infinity,
  })

  // 按 iteration 聚合 token 趋势 + 统计 top tools
  const { iterationChart, topTools } = useMemo(() => {
    const list = events ?? []
    const perIter = new Map<number, { input: number; output: number; cacheRead: number }>()
    const toolCount = new Map<string, number>()
    for (const ev of list) {
      if (ev.type === 'model_usage' && ev.iteration != null) {
        const cur = perIter.get(ev.iteration) ?? { input: 0, output: 0, cacheRead: 0 }
        cur.input += ev.inputTokens ?? 0
        cur.output += ev.outputTokens ?? 0
        cur.cacheRead += ev.cacheReadTokens ?? 0
        perIter.set(ev.iteration, cur)
      }
      if (ev.type === 'tool_call' && ev.toolName) {
        toolCount.set(ev.toolName, (toolCount.get(ev.toolName) ?? 0) + 1)
      }
    }
    const sorted = [...perIter.entries()].sort((a, b) => a[0] - b[0])
    return {
      iterationChart: sorted.map(([iter, v]) => ({ label: `#${iter}`, ...v })),
      topTools: [...toolCount.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([name, count]) => ({ name, count })),
    }
  }, [events])

  if (!summary || summary.events === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--text-muted)]">
        暂无 telemetry 数据，开始对话后会自动收集
      </div>
    )
  }

  const hit = (summary.cacheHitRate * 100).toFixed(1)

  return (
    <div className="h-full overflow-y-auto custom-scrollbar p-4 space-y-4">
      {systemInfo?.langfuse?.enabled && systemInfo.langfuse.baseURL && (
        <div className="flex items-center justify-end">
          <a
            href={`${systemInfo.langfuse.baseURL}/project/src-agent/traces?filter=${encodeURIComponent(JSON.stringify([{ column: 'metadata', operator: 'contains', type: 'stringObject', value: sessionId, key: 'sessionId' }]))}`}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] px-2.5 py-1.5 rounded-md border border-[var(--border)] hover:bg-[var(--bg-hover)] transition-colors"
          >
            <ExternalLink size={12} />
            在 Langfuse 中查看 trace
          </a>
        </div>
      )}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <StatCard icon={DollarSign} label="估算成本" value={`$${summary.costUsd.toFixed(4)}`}
          hint="按公开价目估算" accent="text-[var(--success)]" />
        <StatCard icon={Coins} label="输入 Tokens" value={formatNum(summary.inputTokens)}
          hint={`Cache 读 ${formatNum(summary.cacheReadTokens)}`} accent="text-[var(--info)]" />
        <StatCard icon={Coins} label="输出 Tokens" value={formatNum(summary.outputTokens)} accent="text-[var(--success)]" />
        <StatCard icon={Activity} label="模型调用" value={formatNum(summary.modelCalls)}
          hint={`Cache 命中 ${hit}%`} accent="text-[var(--chart-2)]" />
        <StatCard icon={Wrench} label="工具调用" value={formatNum(summary.toolCalls)}
          hint={summary.toolErrors > 0 ? `${summary.toolErrors} 个错误 · ${(summary.errorRate * 100).toFixed(1)}%` : '无错误'}
          accent="text-[var(--warning)]" />
      </div>

      <SessionTracePanel sessionId={sessionId} />

      <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-medium text-[var(--text-primary)]">每轮 Token 消耗</h3>
          <span className="text-xs text-[var(--text-muted)]">按 iteration 聚合</span>
        </div>
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={iterationChart}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
              <YAxis tick={{ fontSize: 11, fill: 'var(--text-muted)' }} tickFormatter={formatNum} />
              <Tooltip contentStyle={{
                background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12,
              }} />
              <Area type="monotone" dataKey="cacheRead" stackId="1" stroke="#8b5cf6" fill="#8b5cf6" fillOpacity={0.3} name="Cache 读" />
              <Area type="monotone" dataKey="input" stackId="1" stroke="#6b9fff" fill="#6b9fff" fillOpacity={0.4} name="输入" />
              <Area type="monotone" dataKey="output" stackId="1" stroke="#a5e75e" fill="#a5e75e" fillOpacity={0.4} name="输出" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-4">
        <h3 className="mb-3 text-sm font-medium text-[var(--text-primary)]">Top 10 工具调用</h3>
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={topTools} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis type="number" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} width={120} />
              <Tooltip contentStyle={{
                background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12,
              }} />
              <Bar dataKey="count" fill="#d4a843" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-surface)]">
        <div className="border-b border-[var(--border)] px-4 py-3 flex items-center gap-2">
          <AlertTriangle size={14} className="text-[var(--text-muted)]" />
          <h3 className="text-sm font-medium text-[var(--text-primary)]">最近事件</h3>
          <span className="ml-auto text-[10px] text-[var(--text-muted)]">{events?.length ?? 0} 条</span>
        </div>
        <div className="max-h-[360px] overflow-y-auto custom-scrollbar">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-[var(--bg-surface)] text-[var(--text-muted)]">
              <tr className="border-b border-[var(--border)]">
                <th className="text-left px-4 py-2 font-medium">时间</th>
                <th className="text-left px-4 py-2 font-medium">类型</th>
                <th className="text-left px-4 py-2 font-medium">工具</th>
                <th className="text-right px-4 py-2 font-medium">Tokens</th>
                <th className="text-right px-4 py-2 font-medium">耗时</th>
              </tr>
            </thead>
            <tbody>
              {(events ?? []).slice(0, 50).map(ev => (
                <tr key={ev.id} className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--bg-hover)]">
                  <td className="px-4 py-2 text-[var(--text-muted)]">
                    {new Date(ev.createdAt).toLocaleTimeString('zh-CN')}
                  </td>
                  <td className="px-4 py-2">
                    <span className={
                      ev.type === 'tool_error' ? 'text-[var(--danger)]' :
                      ev.type === 'model_usage' ? 'text-[var(--info)]' :
                      'text-[var(--text-secondary)]'
                    }>{ev.type}</span>
                  </td>
                  <td className="px-4 py-2 text-[var(--text-primary)]">{ev.toolName ?? '—'}</td>
                  <td className="px-4 py-2 text-right text-[var(--text-secondary)] tabular-nums">
                    {ev.inputTokens != null || ev.outputTokens != null
                      ? `${formatNum(ev.inputTokens ?? 0)} / ${formatNum(ev.outputTokens ?? 0)}`
                      : '—'}
                  </td>
                  <td className="px-4 py-2 text-right text-[var(--text-muted)] tabular-nums">
                    {ev.durationMs != null ? `${ev.durationMs} ms` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-surface)]">
        <div className="border-b border-[var(--border)] px-4 py-3 flex items-center gap-2">
          <GitBranch size={14} className="text-[var(--chart-2)]" />
          <h3 className="text-sm font-medium text-[var(--text-primary)]">子任务 (Subagents)</h3>
          <span className="ml-auto text-[10px] text-[var(--text-muted)]">{subagents?.length ?? 0} 个</span>
        </div>
        <div className="max-h-[280px] overflow-y-auto custom-scrollbar">
          {(subagents ?? []).length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-[var(--text-muted)]">未派生子任务</div>
          ) : (
            <ul className="divide-y divide-[var(--border)]">
              {(subagents ?? []).map(t => {
                const dot = t.status === 'completed' ? 'bg-[var(--success)]'
                  : t.status === 'running' ? 'bg-[var(--info)] animate-pulse'
                  : t.status === 'failed' ? 'bg-[var(--danger)]'
                  : 'bg-[var(--text-muted)]'
                return (
                  <li key={t.task_id} className="px-4 py-2.5 hover:bg-[var(--bg-hover)]">
                    <div className="flex items-center gap-2">
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
                      <span className="text-xs text-[var(--text-primary)] truncate flex-1">{t.description}</span>
                      <span className="text-[10px] text-[var(--text-muted)] tabular-nums">
                        {t.tool_call_count} tools
                        {t.tool_error_count > 0 && <span className="text-[var(--danger)]"> · {t.tool_error_count} err</span>}
                      </span>
                    </div>
                    {t.summary && <div className="mt-1 text-[10px] text-[var(--text-muted)] line-clamp-2">{t.summary}</div>}
                    {t.error && <div className="mt-1 text-[10px] text-[var(--danger)] line-clamp-2">{t.error}</div>}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </section>
    </div>
  )
}
