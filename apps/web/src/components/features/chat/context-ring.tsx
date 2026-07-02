import { useState, useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { cn } from '~/lib/utils'

interface ContextLane {
  threadId: string | null
  iteration: number | null
  modelId: string | null
  contextTokens: number
  effectiveTokens: number
  contextWindowTokens: number | null
  pct: number
  llmSummaryWatermark: number | null
  ptlBlockWatermark: number | null
  warningLevel: 'ok' | 'warn' | 'critical' | null
  kind: string
  sections: Record<string, number> | null
  updatedAt: number
}

const SECTION_LABELS: Record<string, string> = {
  identity: '身份', rules: '规则', tools: '工具协议', workflow: '工作流',
  style: '风格', input_protocol: '输入协议', base_skills: '技能目录',
  tool_catalog: '工具清单', agent_type_catalog: 'Agent 目录', plan_notes: '计划笔记',
  observer: 'Observer', endpoint_context: '接口上下文', target_memory: '目标记忆',
  relevant_memory: '相关记忆', observations: '观测数据', mcp_instructions: 'MCP 说明',
  loaded_skills: '已加载技能', visible_skills_catalog: '可见技能',
  post_compression_progress: '压缩后进展', _total: '合计',
}

const SECTION_COLORS = ['#6b9fff', '#a5e75e', '#d4a843', '#c084fc', '#e76a5e', '#5ec8d4', '#f08c5e', '#8b9fff', '#b5d75e', '#d48ac0']

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

const R = 8
const CIRC = 2 * Math.PI * R

export function ContextRing({ sessionId, isLoading = false }: { sessionId: string; isLoading?: boolean }) {
  const [hover, setHover] = useState(false)

  const { data, refetch } = useQuery({
    queryKey: ['telemetry-session-context', sessionId],
    queryFn: async () => {
      const res = await fetch(`/api/telemetry/session/${sessionId}/context`)
      if (!res.ok) throw new Error('failed')
      return res.json() as Promise<{ lanes: ContextLane[] }>
    },
    enabled: !!sessionId,
    // 运行中每秒刷新跟住增长，空闲时降到 5s 省请求
    refetchInterval: isLoading ? 1_000 : 5_000,
    // 切换会话时立即重新拉取，不吃全局 staleTime 的缓存，避免短暂显示上个会话的值
    staleTime: 0,
    refetchOnMount: 'always',
  })

  // 运行结束(loading→idle)瞬间，最终快照刚落库，立即拉一次而非等下个轮询
  const prevLoading = useRef(isLoading)
  useEffect(() => {
    if (prevLoading.current && !isLoading) refetch()
    prevLoading.current = isLoading
  }, [isLoading, refetch])

  // 只取主 agent lane
  const main = (data?.lanes ?? []).find(l => l.kind === 'main' || l.threadId == null)
  if (!main) return null

  const pct = Math.min(100, main.pct)
  const dash = (pct / 100) * CIRC

  // Color-code the ring by warning level so the user gets a visual signal
  // before the context hits PTL.
  const ringColor =
    main.warningLevel === 'critical' ? 'var(--danger)' :
    main.warningLevel === 'warn' ? 'var(--warning)' :
    main.warningLevel === 'ok' ? 'var(--success)' :
    'currentColor'

  const sections = main.sections
    ? Object.entries(main.sections).filter(([k]) => k !== '_total').sort((a, b) => b[1] - a[1])
    : []
  const sectionTotal = sections.reduce((s, [, v]) => s + v, 0)

  return (
    <div
      className="relative flex items-center"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button
        type="button"
        className={cn(
          'flex items-center gap-1.5 px-2 py-1.5 rounded-lg transition-colors text-xs',
          'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
          hover && 'bg-[var(--bg-hover)] text-[var(--text-secondary)]',
        )}
        title="主 Agent 上下文占用"
      >
        <svg width="20" height="20" viewBox="0 0 20 20" className="-rotate-90">
          <circle cx="10" cy="10" r={R} fill="none" stroke="var(--bg-hover)" strokeWidth="2.5" />
          <circle
            cx="10" cy="10" r={R} fill="none" stroke={ringColor} strokeWidth="2.5" strokeLinecap="round"
            strokeDasharray={`${dash} ${CIRC}`}
            className="transition-all duration-500"
          />
        </svg>
        <span className="text-[11px] tabular-nums font-medium">
          {pct.toFixed(0)}%
        </span>
      </button>

      {hover && (
        <div className="absolute bottom-full right-0 mb-2 w-[280px] rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] shadow-xl z-50 animate-in fade-in slide-in-from-bottom-1 duration-150 p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-medium text-[var(--text-muted)] uppercase tracking-wider">主 Agent 上下文</span>
            <span className="text-[11px] tabular-nums font-medium text-[var(--text-secondary)]">{pct.toFixed(1)}%</span>
          </div>
          <div className="flex items-center justify-between text-xs mb-1">
            <span className="text-[var(--text-muted)]">占用 / 有效窗口</span>
            <span className="tabular-nums text-[var(--text-secondary)]">
              {formatNum(main.contextTokens)} / {formatNum(main.effectiveTokens)}
            </span>
          </div>
          {main.modelId && (
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="text-[var(--text-muted)]">模型</span>
              <span className="text-[var(--text-secondary)] truncate max-w-[170px]">{main.modelId}</span>
            </div>
          )}
          {main.warningLevel && main.warningLevel !== 'ok' && (
            <div className={cn(
              'flex items-center gap-1.5 text-[11px] mb-1 px-2 py-1 rounded-md',
              main.warningLevel === 'critical' ? 'bg-[var(--danger)]/10 text-[var(--danger)]' : 'bg-[var(--warning)]/10 text-[var(--warning)]',
            )}>
              {main.warningLevel === 'critical' ? '⚠ 逼近上下文上限，可能触发 PTL 阻断' : '⚡ 上下文较高，即将触发自动压缩'}
            </div>
          )}
          {sections.length > 0 && (
            <>
              <div className="flex h-2 rounded-full overflow-hidden bg-[var(--bg-hover)] mt-1">
                {sections.map(([name, v], idx) => (
                  <div key={name} className="h-full"
                    style={{ width: `${(v / sectionTotal) * 100}%`, background: SECTION_COLORS[idx % SECTION_COLORS.length] }}
                    title={`${SECTION_LABELS[name] ?? name}: ${formatNum(v)} tok`} />
                ))}
              </div>
              <div className="mt-2 flex flex-wrap gap-x-2.5 gap-y-1">
                {sections.slice(0, 8).map(([name, v], idx) => (
                  <span key={name} className="flex items-center gap-1 text-[10px] text-[var(--text-muted)]">
                    <span className="w-2 h-2 rounded-sm" style={{ background: SECTION_COLORS[idx % SECTION_COLORS.length] }} />
                    {SECTION_LABELS[name] ?? name}
                    <span className="tabular-nums">{formatNum(v)}</span>
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
