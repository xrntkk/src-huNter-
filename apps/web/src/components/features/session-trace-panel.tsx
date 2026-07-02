import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, ChevronDown, AlertCircle, Wrench, Cpu, Bell } from 'lucide-react'

interface TraceEvent {
  id: string
  type: string
  toolName: string | null
  modelId: string | null
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  durationMs: number | null
  costUsd: number | null
  data: string | null
  createdAt: number
  iteration: number | null
}

interface Iter {
  iteration: number
  startedAt: number
  endedAt: number
  modelId: string | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
  modelCalls: number
  toolCalls: number
  toolErrors: number
  events: TraceEvent[]
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function durationLabel(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function eventIcon(type: string) {
  if (type === 'model_usage') return <Cpu size={11} className="text-[var(--info)]" />
  if (type === 'tool_call' || type === 'tool_result') return <Wrench size={11} className="text-[var(--warning)]" />
  if (type === 'tool_error') return <AlertCircle size={11} className="text-[var(--danger)]" />
  return <Bell size={11} className="text-[var(--text-muted)]" />
}

function summarizeEvent(ev: TraceEvent): string {
  if (ev.type === 'model_usage') {
    const i = ev.inputTokens ?? 0, o = ev.outputTokens ?? 0, cr = ev.cacheReadTokens ?? 0
    return `${formatNum(i)} in / ${formatNum(o)} out${cr > 0 ? ` · cache ${formatNum(cr)}` : ''}${ev.costUsd != null && ev.costUsd > 0 ? ` · $${ev.costUsd.toFixed(6)}` : ''}`
  }
  if (ev.toolName) {
    const dur = ev.durationMs != null ? ` · ${durationLabel(ev.durationMs)}` : ''
    return `${ev.toolName}${dur}`
  }
  return ev.type
}

interface Props { sessionId: string }

export function SessionTracePanel({ sessionId }: Props) {
  const { data } = useQuery({
    queryKey: ['telemetry-session-trace', sessionId],
    queryFn: async () => {
      const res = await fetch(`/api/telemetry/session/${sessionId}/trace?iterations=30`)
      if (!res.ok) throw new Error('failed')
      return res.json() as Promise<{ iterations: Iter[] }>
    },
    enabled: !!sessionId,
    refetchInterval: 5_000,
  })

  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [activeEvent, setActiveEvent] = useState<TraceEvent | null>(null)

  const iterations = data?.iterations ?? []

  // Pretty-print event data when one is selected
  const detail = useMemo(() => {
    if (!activeEvent) return null
    let parsed: unknown = null
    try { parsed = activeEvent.data ? JSON.parse(activeEvent.data) : null } catch { parsed = activeEvent.data }
    return parsed
  }, [activeEvent])

  const toggle = (n: number) => {
    setExpanded(prev => {
      const s = new Set(prev)
      if (s.has(n)) s.delete(n)
      else s.add(n)
      return s
    })
  }

  if (iterations.length === 0) {
    return null // 无数据时整段隐藏，由父组件的"暂无 telemetry"占位托底
  }

  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-surface)]">
      <div className="border-b border-[var(--border)] px-4 py-3 flex items-center gap-2">
        <Cpu size={14} className="text-[var(--chart-2)]" />
        <h3 className="text-sm font-medium text-[var(--text-primary)]">Trace 时间线</h3>
        <span className="ml-auto text-[10px] text-[var(--text-muted)]">{iterations.length} 轮 · 最近 30</span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] divide-y lg:divide-y-0 lg:divide-x divide-[var(--border)]">
        {/* Left: iteration list */}
        <div className="max-h-[480px] overflow-y-auto custom-scrollbar">
          {iterations.map(it => {
            const isOpen = expanded.has(it.iteration)
            const dur = it.endedAt - it.startedAt
            return (
              <div key={it.iteration} className="border-b border-[var(--border)] last:border-0">
                <button
                  onClick={() => toggle(it.iteration)}
                  className="w-full px-4 py-2.5 hover:bg-[var(--bg-hover)] text-left flex items-start gap-2"
                >
                  {isOpen ? <ChevronDown size={12} className="mt-1 shrink-0 text-[var(--text-muted)]" />
                          : <ChevronRight size={12} className="mt-1 shrink-0 text-[var(--text-muted)]" />}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-[var(--text-primary)] font-medium tabular-nums">#{it.iteration}</span>
                      <span className="text-[10px] text-[var(--text-muted)]">{new Date(it.startedAt).toLocaleTimeString('zh-CN')}</span>
                      <span className="ml-auto text-[10px] text-[var(--text-muted)] tabular-nums">{durationLabel(dur)}</span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[10px] text-[var(--text-muted)] tabular-nums">
                      <span className="text-[var(--info)]">{formatNum(it.inputTokens)} in</span>
                      <span className="text-[var(--success)]">{formatNum(it.outputTokens)} out</span>
                      <span>·</span>
                      <span className="text-[var(--warning)]">{it.toolCalls} tools</span>
                      {it.toolErrors > 0 && <span className="text-[var(--danger)]">{it.toolErrors} err</span>}
                      {it.costUsd > 0 && <span className="ml-auto text-[var(--success)]">${it.costUsd.toFixed(4)}</span>}
                    </div>
                  </div>
                </button>

                {isOpen && (
                  <ul className="pl-7 pr-2 pb-2 space-y-0.5">
                    {it.events.map(ev => (
                      <li key={ev.id}>
                        <button
                          onClick={() => setActiveEvent(ev)}
                          className={`w-full text-left px-2 py-1 rounded text-[11px] flex items-center gap-2 hover:bg-[var(--bg-hover)] ${
                            activeEvent?.id === ev.id ? 'bg-[var(--bg-hover)] ring-1 ring-[var(--accent)]/30' : ''
                          }`}
                        >
                          {eventIcon(ev.type)}
                          <span className="text-[var(--text-secondary)] truncate flex-1">{summarizeEvent(ev)}</span>
                          <span className="text-[9px] text-[var(--text-muted)] tabular-nums">
                            +{ev.createdAt - it.startedAt}ms
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )
          })}
        </div>

        {/* Right: event detail */}
        <div className="max-h-[480px] overflow-y-auto custom-scrollbar p-4">
          {activeEvent ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                {eventIcon(activeEvent.type)}
                <span className="text-sm text-[var(--text-primary)] font-medium">{activeEvent.type}</span>
                {activeEvent.toolName && <span className="text-xs text-[var(--text-muted)]">· {activeEvent.toolName}</span>}
              </div>
              <div className="grid grid-cols-2 gap-2 text-[11px]">
                {activeEvent.modelId && <div><span className="text-[var(--text-muted)]">model: </span>{activeEvent.modelId}</div>}
                {activeEvent.durationMs != null && <div><span className="text-[var(--text-muted)]">duration: </span>{durationLabel(activeEvent.durationMs)}</div>}
                {activeEvent.inputTokens != null && <div><span className="text-[var(--text-muted)]">input: </span>{formatNum(activeEvent.inputTokens)}</div>}
                {activeEvent.outputTokens != null && <div><span className="text-[var(--text-muted)]">output: </span>{formatNum(activeEvent.outputTokens)}</div>}
                {activeEvent.cacheReadTokens != null && activeEvent.cacheReadTokens > 0 && <div><span className="text-[var(--text-muted)]">cache: </span>{formatNum(activeEvent.cacheReadTokens)}</div>}
                {activeEvent.costUsd != null && activeEvent.costUsd > 0 && <div><span className="text-[var(--text-muted)]">cost: </span>${activeEvent.costUsd.toFixed(6)}</div>}
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1.5">payload</div>
                <pre className="text-[10px] text-[var(--text-secondary)] bg-[var(--bg-base)] rounded-md p-3 overflow-x-auto whitespace-pre-wrap break-words border border-[var(--border)] max-h-[280px]">
{JSON.stringify(detail, null, 2)}
                </pre>
              </div>
            </div>
          ) : (
            <div className="text-xs text-[var(--text-muted)] text-center pt-12">点击左侧事件查看详情</div>
          )}
        </div>
      </div>
    </section>
  )
}
