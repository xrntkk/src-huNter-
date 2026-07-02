import { useState, useMemo, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Activity, Coins, Wrench, AlertTriangle, DollarSign, Zap, Server } from 'lucide-react'
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from 'recharts'

type Range = 'day' | 'week' | 'month'

interface UsageBucket {
  bucket: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
  modelCalls: number
}

interface ToolBucket { bucket: number; type: string; n: number }

interface ByModelRow {
  modelId: string
  calls: number
  inputTokens: number
  outputTokens: number
  costUsd: number
}

interface SlowToolRow { name: string; count: number; p50: number; p95: number }

interface GlobalPayload {
  range: Range
  bucketMs: number
  since: number
  usage: UsageBucket[]
  tools: ToolBucket[]
  topTools: { name: string; count: number }[]
  byModel: ByModelRow[]
  latency: { count: number; p50: number; p95: number; p99: number; max: number }
  slowestTools: SlowToolRow[]
  errorRate: number
  totalCalls: number
  totalErrors: number
}

interface RecentEvent {
  id: string
  sessionId: string | null
  threadId: string | null
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

const RANGE_LABEL: Record<Range, string> = { day: '日', week: '周', month: '月 (30 天)' }

function formatBucket(ts: number, range: Range): string {
  const d = new Date(ts)
  if (range === 'day') return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
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

function GroupHeading({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 pt-2">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">{children}</h3>
      <div className="h-px flex-1 bg-[var(--border)]" />
    </div>
  )
}

export function AgentDashboard() {
  const [range, setRange] = useState<Range>('day')

  const { data: globalData } = useQuery({
    queryKey: ['telemetry-global', range],
    queryFn: async () => {
      const res = await fetch(`/api/telemetry/global?range=${range}`)
      if (!res.ok) throw new Error('failed')
      return res.json() as Promise<GlobalPayload>
    },
    refetchInterval: 10_000,
  })

  const { data: recent } = useQuery({
    queryKey: ['telemetry-recent'],
    queryFn: async () => {
      const res = await fetch('/api/telemetry/recent?limit=50')
      if (!res.ok) throw new Error('failed')
      return res.json() as Promise<RecentEvent[]>
    },
    refetchInterval: 5_000,
  })

  const totals = useMemo(() => {
    const u = globalData?.usage ?? []
    const tools = globalData?.tools ?? []
    let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0, modelCalls = 0, costUsd = 0
    for (const b of u) {
      inputTokens += b.inputTokens
      outputTokens += b.outputTokens
      cacheReadTokens += b.cacheReadTokens
      cacheWriteTokens += b.cacheWriteTokens
      modelCalls += b.modelCalls
      costUsd += b.costUsd ?? 0
    }
    let toolCalls = 0, toolErrors = 0
    for (const t of tools) {
      if (t.type === 'tool_call') toolCalls += t.n
      if (t.type === 'tool_error') toolErrors += t.n
    }
    const denom = cacheReadTokens + inputTokens
    const cacheHitRate = denom === 0 ? 0 : cacheReadTokens / denom
    return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, modelCalls, toolCalls, toolErrors, cacheHitRate, costUsd }
  }, [globalData])

  const usageChart = useMemo(() => {
    if (!globalData) return []
    return globalData.usage.map(b => ({
      label: formatBucket(b.bucket, globalData.range),
      input: b.inputTokens,
      output: b.outputTokens,
      cacheRead: b.cacheReadTokens,
      cacheWrite: b.cacheWriteTokens,
      cost: b.costUsd ?? 0,
    }))
  }, [globalData])

  const toolsChart = useMemo(() => globalData?.topTools ?? [], [globalData])

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">Agent Dashboard</h2>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            Token 消耗、工具调用、错误率 · 数据保留 30 天
          </p>
        </div>
        <div className="flex rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] p-0.5">
          {(['day', 'week', 'month'] as Range[]).map(r => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${
                range === r
                  ? 'bg-[var(--accent)] text-[var(--accent-foreground)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              }`}
            >
              {RANGE_LABEL[r]}
            </button>
          ))}
        </div>
      </header>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <StatCard icon={DollarSign} label="估算成本" value={`$${totals.costUsd.toFixed(4)}`}
          hint="按公开价目估算" accent="text-[#a5e75e]" />
        <StatCard icon={Coins} label="输入 Tokens" value={formatNum(totals.inputTokens)} accent="text-[#6b9fff]" />
        <StatCard icon={Coins} label="输出 Tokens" value={formatNum(totals.outputTokens)} accent="text-[#a5e75e]" />
        <StatCard icon={Activity} label="模型调用" value={formatNum(totals.modelCalls)}
          hint={`Cache 命中 ${(totals.cacheHitRate * 100).toFixed(1)}%`} accent="text-[#c084fc]" />
        <StatCard icon={Wrench} label="工具调用" value={formatNum(totals.toolCalls)}
          hint={totals.toolErrors > 0
            ? `${totals.toolErrors} 个错误 · ${(globalData?.errorRate ?? 0) * 100 > 0 ? `${((globalData?.errorRate ?? 0) * 100).toFixed(1)}%` : ''}`
            : '无错误'}
          accent="text-[#d4a843]" />
      </div>

      <GroupHeading>用量</GroupHeading>

      <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-medium text-[var(--text-primary)]">Token 用量趋势</h3>
          <span className="text-xs text-[var(--text-muted)]">
            按 {range === 'day' ? '小时' : '天'} 聚合
          </span>
        </div>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={usageChart}>
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

      <GroupHeading>工具</GroupHeading>

      <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-4">
        <h3 className="mb-3 text-sm font-medium text-[var(--text-primary)]">Top 10 工具调用</h3>
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={toolsChart} layout="vertical">
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

      <GroupHeading>成本</GroupHeading>

      <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-4">
        <div className="mb-3 flex items-center gap-2">
          <DollarSign size={14} className="text-[#a5e75e]" />
          <h3 className="text-sm font-medium text-[var(--text-primary)]">成本趋势 (USD)</h3>
        </div>
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={usageChart}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
              <YAxis tick={{ fontSize: 11, fill: 'var(--text-muted)' }} tickFormatter={(v: number) => `$${v.toFixed(4)}`} />
              <Tooltip contentStyle={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
                formatter={(v) => [`$${Number(v).toFixed(6)}`, '成本']} />
              <Line type="monotone" dataKey="cost" stroke="#a5e75e" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-surface)]">
        <div className="border-b border-[var(--border)] px-4 py-3 flex items-center gap-2">
          <Server size={14} className="text-[#6b9fff]" />
          <h3 className="text-sm font-medium text-[var(--text-primary)]">按模型分组</h3>
        </div>
        <table className="w-full text-xs">
          <thead className="text-[var(--text-muted)]">
            <tr className="border-b border-[var(--border)]">
              <th className="text-left px-4 py-2 font-medium">Model</th>
              <th className="text-right px-4 py-2 font-medium">调用</th>
              <th className="text-right px-4 py-2 font-medium">输入</th>
              <th className="text-right px-4 py-2 font-medium">输出</th>
              <th className="text-right px-4 py-2 font-medium">成本</th>
            </tr>
          </thead>
          <tbody>
            {(globalData?.byModel ?? []).map(m => (
              <tr key={m.modelId} className="border-b border-[var(--border)] last:border-0">
                <td className="px-4 py-2 text-[var(--text-primary)]">{m.modelId}</td>
                <td className="px-4 py-2 text-right text-[var(--text-secondary)] tabular-nums">{m.calls}</td>
                <td className="px-4 py-2 text-right text-[var(--text-secondary)] tabular-nums">{formatNum(m.inputTokens)}</td>
                <td className="px-4 py-2 text-right text-[var(--text-secondary)] tabular-nums">{formatNum(m.outputTokens)}</td>
                <td className="px-4 py-2 text-right text-[#a5e75e] tabular-nums">${m.costUsd.toFixed(4)}</td>
              </tr>
            ))}
            {(globalData?.byModel ?? []).length === 0 && (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-[var(--text-muted)]">无模型数据</td></tr>
            )}
          </tbody>
        </table>
      </section>

      <GroupHeading>性能与错误</GroupHeading>

      <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-4">
        <div className="mb-3 flex items-center gap-2">
          <Zap size={14} className="text-[#d4a843]" />
          <h3 className="text-sm font-medium text-[var(--text-primary)]">工具耗时分布</h3>
          <span className="ml-auto text-[10px] text-[var(--text-muted)] tabular-nums">
            n={globalData?.latency.count ?? 0}
            {' · '}P50 {globalData?.latency.p50 ?? 0}ms
            {' · '}P95 {globalData?.latency.p95 ?? 0}ms
            {' · '}P99 {globalData?.latency.p99 ?? 0}ms
          </span>
        </div>
        <div className="h-44">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={globalData?.slowestTools ?? []} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis type="number" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} tickFormatter={(v: number) => `${v}ms`} />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} width={120} />
              <Tooltip contentStyle={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
                formatter={(v, k) => [`${Number(v)} ms`, String(k).toUpperCase()]} />
              <Bar dataKey="p50" fill="#6b9fff" radius={[0, 4, 4, 0]} name="P50" />
              <Bar dataKey="p95" fill="#e76a5e" radius={[0, 4, 4, 0]} name="P95" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-surface)]">
        <div className="border-b border-[var(--border)] px-4 py-3 flex items-center gap-2">
          <AlertTriangle size={14} className="text-[var(--text-muted)]" />
          <h3 className="text-sm font-medium text-[var(--text-primary)]">最近事件 (50 条)</h3>
        </div>
        <div className="max-h-[420px] overflow-y-auto custom-scrollbar">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-[var(--bg-surface)] text-[var(--text-muted)]">
              <tr className="border-b border-[var(--border)]">
                <th className="text-left px-4 py-2 font-medium">时间</th>
                <th className="text-left px-4 py-2 font-medium">类型</th>
                <th className="text-left px-4 py-2 font-medium">工具/模型</th>
                <th className="text-right px-4 py-2 font-medium">Tokens</th>
                <th className="text-right px-4 py-2 font-medium">耗时</th>
              </tr>
            </thead>
            <tbody>
              {(recent ?? []).map(ev => (
                <tr key={ev.id} className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--bg-hover)]">
                  <td className="px-4 py-2 text-[var(--text-muted)]">
                    {new Date(ev.createdAt).toLocaleTimeString('zh-CN')}
                  </td>
                  <td className="px-4 py-2">
                    <span className={
                      ev.type === 'tool_error' ? 'text-[#e76a5e]' :
                      ev.type === 'model_usage' ? 'text-[#6b9fff]' :
                      'text-[var(--text-secondary)]'
                    }>{ev.type}</span>
                  </td>
                  <td className="px-4 py-2 text-[var(--text-primary)]">{ev.toolName ?? '—'}</td>
                  <td className="px-4 py-2 text-right text-[var(--text-secondary)]">
                    {ev.inputTokens != null || ev.outputTokens != null
                      ? `${formatNum(ev.inputTokens ?? 0)} / ${formatNum(ev.outputTokens ?? 0)}`
                      : '—'}
                  </td>
                  <td className="px-4 py-2 text-right text-[var(--text-muted)]">
                    {ev.durationMs != null ? `${ev.durationMs} ms` : '—'}
                  </td>
                </tr>
              ))}
              {(recent?.length ?? 0) === 0 && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-[var(--text-muted)]">暂无事件</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
