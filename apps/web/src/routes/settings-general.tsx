import { useState, useEffect } from 'react'
import { Shield, CheckCircle2, X, KeyRound } from 'lucide-react'
import { toast } from 'react-hot-toast'

const SSE_TOKEN_STORAGE_KEY = 'src_agent_token'

export function GeneralSettingsPage() {
  const [token, setToken] = useState('')
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    setToken(localStorage.getItem(SSE_TOKEN_STORAGE_KEY) ?? '')
    setLoaded(true)
  }, [])

  const save = () => {
    const trimmed = token.trim()
    if (trimmed) {
      localStorage.setItem(SSE_TOKEN_STORAGE_KEY, trimmed)
    } else {
      localStorage.removeItem(SSE_TOKEN_STORAGE_KEY)
    }
    toast.success(trimmed ? 'SSE 访问 Token 已保存' : 'SSE 访问 Token 已清除')
  }

  const clear = () => {
    setToken('')
    localStorage.removeItem(SSE_TOKEN_STORAGE_KEY)
    toast.success('SSE 访问 Token 已清除')
  }

  if (!loaded) return null

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold leading-6 tracking-tight text-[var(--text-primary)]">
          通用
        </h2>
        <p className="text-sm text-[var(--text-muted)] mt-1">访问控制与其他基础配置</p>
      </div>

      {/* SSE access token */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-4 space-y-3">
        <div className="flex items-start gap-3">
          <Shield size={16} className="text-[var(--accent)] flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-[var(--text-primary)]">SSE 访问 Token</div>
            <p className="text-xs text-[var(--text-muted)] mt-1 leading-relaxed">
              当服务端设置了 <code className="px-1 py-0.5 rounded bg-[var(--bg-input)] text-[var(--text-secondary)]">SRC_AGENT_TOKEN</code> 环境变量时，图谱 SSE 通道（<code className="px-1 py-0.5 rounded bg-[var(--bg-input)] text-[var(--text-secondary)]">/sessions/:id/events</code>）会要求 token 校验。在此填入相同值，前端订阅时会以 <code className="px-1 py-0.5 rounded bg-[var(--bg-input)] text-[var(--text-secondary)]">?token=</code> 附带。留空则不附带（适用于本地开发，服务端未设置环境变量的场景）。
            </p>
          </div>
        </div>
        <div className="space-y-1.5">
          <label className="text-[11px] text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-1">
            <KeyRound size={11} /> Token
          </label>
          <input
            type="password"
            value={token}
            onChange={e => setToken(e.target.value)}
            placeholder="留空则不启用 SSE token 认证"
            className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--bg-input)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30 focus:border-[var(--accent)]/40 transition-all"
          />
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={save}
            className="flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-xs font-medium text-[var(--accent-foreground)] bg-[var(--accent)] hover:opacity-90 transition-all"
          >
            <CheckCircle2 size={12} /> 保存
          </button>
          <button
            onClick={clear}
            className="flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
          >
            <X size={12} /> 清除
          </button>
        </div>
      </div>
    </div>
  )
}
