import { useState, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Save, KeyRound, Eye, EyeOff, ExternalLink, ShieldCheck } from 'lucide-react'
import { toast } from 'react-hot-toast'
import { api } from '~/lib/api'
import { cn } from '~/lib/utils'

interface IntelSourceConfig {
  cookie?: string
  enabled?: boolean
}

type Sources = Record<string, IntelSourceConfig>

/** 已实现的数据源元信息——用于渲染固定的卡片列表。 */
const KNOWN_SOURCES: Array<{
  key: string
  label: string
  description: string
  loginUrl: string
  envVar: string
  hint: string
}> = [
  {
    key: 'aqc',
    label: '爱企查',
    description: '百度爱企查——默认数据源，覆盖 ICP/APP/公众号/投资等企业资产',
    loginUrl: 'https://aiqicha.baidu.com',
    envVar: 'AQC_COOKIE',
    hint: '登录后从浏览器开发者工具 Network 任一请求头复制完整 Cookie（需含 http-only 字段，勿用 document.cookie）',
  },
  // 后续数据源（tyc/kc/rb）按同模式在此追加
]

export function IntelSettingsPage() {
  const queryClient = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['settings-intel'],
    queryFn: api.settings.getIntel,
  })

  const [sources, setSources] = useState<Sources>({})
  const [revealed, setRevealed] = useState<Set<string>>(new Set())
  const hasSyncedRef = useRef(false)

  useEffect(() => {
    if (data?.sources && !hasSyncedRef.current) {
      hasSyncedRef.current = true
      setSources(data.sources as Sources)
    }
  }, [data])

  const updateMutation = useMutation({
    mutationFn: api.settings.updateIntel,
    onSuccess: () => {
      toast.success('信息收集凭据已保存')
      queryClient.invalidateQueries({ queryKey: ['settings-intel'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const handleSave = () => {
    updateMutation.mutate({ sources })
  }

  const updateSource = (key: string, patch: Partial<IntelSourceConfig>) => {
    setSources(prev => ({
      ...prev,
      [key]: { ...prev[key], ...patch },
    }))
  }

  const toggleEnabled = (key: string) => {
    const cur = sources[key]?.enabled !== false
    updateSource(key, { enabled: !cur })
  }

  const toggleReveal = (key: string) => {
    setRevealed(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold leading-6 tracking-tight text-[var(--text-primary)]">
          信息收集凭据
        </h2>
        <p className="text-sm text-[var(--text-muted)] mt-1">
          配置企业信息收集模块（gather_intel 工具）所需的数据源凭据。保存后即时生效，无需重启。
        </p>
      </div>

      <div className="space-y-3">
        {KNOWN_SOURCES.map(src => {
          const cfg = sources[src.key] ?? {}
          const enabled = cfg.enabled !== false
          const hasCookie = !!cfg.cookie && cfg.cookie.trim().length > 0
          const isRevealed = revealed.has(src.key)
          return (
            <div
              key={src.key}
              className="rounded-xl border border-[var(--border-strong)] bg-[var(--bg-surface)] overflow-hidden"
            >
              {/* Header */}
              <div className="flex items-center justify-between px-4 py-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <KeyRound size={15} className={cn('flex-shrink-0', hasCookie && enabled ? 'text-[var(--accent)]' : 'text-[var(--text-placeholder)]')} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-[var(--text-primary)]">{src.label}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-md font-medium border bg-[var(--bg-input)] text-[var(--text-muted)] border-[var(--border)] flex-shrink-0">
                        {src.envVar}
                      </span>
                      {hasCookie && (
                        <span className={cn(
                          'text-[10px] px-1.5 py-0.5 rounded-md font-medium border flex-shrink-0',
                          enabled
                            ? 'bg-[#a5e75e]/10 text-[#a5e75e] border-[#a5e75e]/20'
                            : 'bg-[var(--bg-input)] text-[var(--text-placeholder)] border-[var(--border)]',
                        )}>
                          {enabled ? '已配置' : '已禁用'}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-[var(--text-muted)] mt-0.5 truncate">{src.description}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span
                    role="switch"
                    aria-checked={enabled}
                    tabIndex={0}
                    title={enabled ? '已启用，点击禁用' : '已禁用，点击启用'}
                    onClick={() => toggleEnabled(src.key)}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleEnabled(src.key) } }}
                    className={cn(
                      'relative inline-flex h-4 w-7 cursor-pointer items-center rounded-full transition-colors',
                      enabled ? 'bg-[var(--accent)]' : 'bg-[var(--border-strong)]',
                    )}
                  >
                    <span className={cn(
                      'inline-block h-3 w-3 transform rounded-full bg-[var(--accent-foreground)] transition-transform',
                      enabled ? 'translate-x-3.5' : 'translate-x-0.5',
                    )} />
                  </span>
                </div>
              </div>

              {/* Body */}
              <div className="px-4 pb-4 space-y-3 border-t border-[var(--border)]">
                <div className="pt-3 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="text-[11px] text-[var(--text-muted)] uppercase tracking-wider">Cookie</label>
                    <div className="flex items-center gap-2">
                      <a
                        href={src.loginUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors"
                        title="打开登录页"
                      >
                        登录页 <ExternalLink size={11} />
                      </a>
                      <button
                        type="button"
                        onClick={() => toggleReveal(src.key)}
                        className="flex items-center gap-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                        title={isRevealed ? '隐藏' : '显示明文'}
                      >
                        {isRevealed ? <EyeOff size={12} /> : <Eye size={12} />}
                        {isRevealed ? '隐藏' : '显示'}
                      </button>
                    </div>
                  </div>
                  {isRevealed ? (
                    <textarea
                      value={cfg.cookie ?? ''}
                      onChange={e => updateSource(src.key, { cookie: e.target.value })}
                      placeholder={src.hint}
                      rows={3}
                      className={cn(
                        'w-full rounded-lg border border-[#717888] bg-[#454545] px-3 py-2 text-sm',
                        'text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] placeholder:italic',
                        'focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30 focus:border-[var(--accent)]/40',
                        'transition-all resize-y font-mono',
                      )}
                    />
                  ) : (
                    <input
                      type="password"
                      value={cfg.cookie ?? ''}
                      onChange={e => updateSource(src.key, { cookie: e.target.value })}
                      placeholder={src.hint}
                      className={cn(
                        'w-full rounded-lg border border-[#717888] bg-[#454545] px-3 py-2 text-sm',
                        'text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] placeholder:italic',
                        'focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30 focus:border-[var(--accent)]/40',
                        'transition-all font-mono',
                      )}
                    />
                  )}
                  <p className="text-[11px] text-[var(--text-placeholder)] leading-relaxed">{src.hint}</p>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Security note */}
      <div className="flex items-start gap-2.5 rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] px-3.5 py-3">
        <ShieldCheck size={14} className="flex-shrink-0 mt-0.5 text-[var(--text-muted)]" />
        <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
          凭据以明文存储在 <code className="px-1 py-0.5 rounded bg-[var(--bg-input)] text-[var(--text-secondary)]">config/intel.json</code>，仅本机读取，不会上传。
          保存后立即注入运行时环境变量，gather_intel 工具即可使用。Cookie 过期后需重新获取——出现 401/302 时回到此页更新即可。
        </p>
      </div>

      <button
        onClick={handleSave}
        disabled={updateMutation.isPending}
        className="flex items-center gap-2 rounded-lg px-5 py-2 text-sm font-medium text-[var(--accent-foreground)] bg-[var(--accent)] hover:opacity-90 disabled:opacity-40 transition-all"
      >
        <Save size={14} />
        {updateMutation.isPending ? '保存中...' : '保存配置'}
      </button>
    </div>
  )
}
