import { useState, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Save, Plus, Trash2, Server, Terminal, Globe, ChevronDown, ChevronUp, Zap, Eye, EyeOff } from 'lucide-react'
import { toast } from 'react-hot-toast'
import { api } from '~/lib/api'
import { cn } from '~/lib/utils'
import { MonacoEditor } from '~/components/ui/monaco-editor'

interface McpServer {
  type: 'stdio' | 'sse'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  apiKey?: string
  enabled?: boolean
}

/** Password input with show/hide toggle for API keys. */
function ApiKeyInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [revealed, setRevealed] = useState(false)
  return (
    <div className="relative">
      <input
        type={revealed ? 'text' : 'password'}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-[#717888] bg-[#454545] px-3 py-2 pr-9 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] placeholder:italic focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30 focus:border-[var(--accent)]/40 transition-all"
      />
      <button
        type="button"
        onClick={() => setRevealed(!revealed)}
        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
        title={revealed ? '隐藏' : '显示'}
      >
        {revealed ? <EyeOff size={13} /> : <Eye size={13} />}
      </button>
    </div>
  )
}

export function MCPSettingsPage() {
  const queryClient = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['settings-mcp'],
    queryFn: api.settings.getMcp,
  })

  const [servers, setServers] = useState<Record<string, McpServer>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [newName, setNewName] = useState('')
  const hasSyncedRef = useRef(false)

  // Sync when data first loads. We only do this once — subsequent refetches
  // (e.g. after a successful save) shouldn't clobber unsaved local edits.
  useEffect(() => {
    if (data?.mcpServers && !hasSyncedRef.current) {
      hasSyncedRef.current = true
      setServers(data.mcpServers as Record<string, McpServer>)
    }
  }, [data])

  const updateMutation = useMutation({
    mutationFn: api.settings.updateMcp,
    onSuccess: () => {
      toast.success('MCP 配置已保存')
      queryClient.invalidateQueries({ queryKey: ['settings-mcp'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const handleSave = () => {
    updateMutation.mutate({ mcpServers: servers })
  }

  const addServer = () => {
    // Auto-generate a unique default name when the input is empty.
    // Without this the button is permanently disabled until the user
    // types — confusing UX (looks broken). Users can rename the server
    // afterwards via the inline rename control on the card header.
    let name = newName.trim()
    if (!name) {
      let n = Object.keys(servers).length + 1
      while (servers[`server_${n}`]) n++
      name = `server_${n}`
    } else if (servers[name]) {
      // Name collision — append a counter so we never silently overwrite.
      let n = 2
      while (servers[`${name}_${n}`]) n++
      name = `${name}_${n}`
    }
    setServers(prev => ({
      ...prev,
      [name]: { type: 'stdio', command: '', args: [] },
    }))
    setExpanded(prev => new Set(prev).add(name))
    setNewName('')
  }

  const renameServer = (oldName: string, nextName: string) => {
    const trimmed = nextName.trim()
    if (!trimmed || trimmed === oldName) return
    if (servers[trimmed]) {
      toast.error(`已存在同名服务：${trimmed}`)
      return
    }
    setServers(prev => {
      // Preserve key order so the renamed entry stays in place.
      const next: Record<string, McpServer> = {}
      for (const [k, v] of Object.entries(prev)) {
        next[k === oldName ? trimmed : k] = v
      }
      return next
    })
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.delete(oldName)) next.add(trimmed)
      return next
    })
  }

  const removeServer = (name: string) => {
    setServers(prev => {
      const next = { ...prev }
      delete next[name]
      return next
    })
    setExpanded(prev => {
      const next = new Set(prev)
      next.delete(name)
      return next
    })
  }

  const updateServer = (name: string, patch: Partial<McpServer>) => {
    setServers(prev => ({
      ...prev,
      [name]: { ...prev[name], ...patch },
    }))
  }

  // Enable/disable persists immediately so the manager reloads (connects or
  // drops the server) without the user hitting Save.
  const toggleEnabled = (name: string) => {
    const next = {
      ...servers,
      [name]: { ...servers[name], enabled: servers[name].enabled === false },
    }
    setServers(next)
    updateMutation.mutate({ mcpServers: next })
  }

  const updateArgs = (name: string, argsStr: string) => {
    try {
      const args = argsStr.split('\n').filter(s => s.trim())
      updateServer(name, { args })
    } catch {}
  }

  const toggleExpand = (name: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
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
          MCP 服务配置
        </h2>
        <p className="text-sm text-[var(--text-muted)] mt-1">管理 Model Context Protocol (MCP) 服务器连接</p>
      </div>

      {/* Add new server */}
      <div className="flex gap-2">
        <input
          type="text"
          value={newName}
          onChange={e => setNewName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && addServer()}
          placeholder="新 MCP 服务名称（留空将自动生成）..."
          className={cn(
            'flex-1 rounded-lg border border-[#717888] bg-[#454545] px-3 py-2 text-sm',
            'text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] placeholder:italic',
            'focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30 focus:border-[var(--accent)]/40',
            'transition-all',
          )}
        />
        <button
          onClick={addServer}
          className="flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-4 py-2 text-sm font-medium text-[var(--accent-foreground)] bg-[var(--accent)] hover:opacity-90 transition-all"
        >
          <Plus size={14} />
          添加
        </button>
      </div>

      {/* Firecrawl quick-add banner */}
      {!servers['firecrawl'] && (
        <div className="rounded-xl border border-[#e76a5e]/30 bg-[#e76a5e]/5 px-4 py-3.5">
          <div className="flex items-start gap-3">
            <Zap size={16} className="text-[#e76a5e] flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-[var(--text-primary)]">Firecrawl MCP</div>
              <p className="text-xs text-[var(--text-muted)] mt-1 leading-relaxed">
                一键接入 Firecrawl —— 搜索、抓取、爬取、地图、结构化提取等 12 个工具，覆盖全网数据获取。
                需要 <a href="https://firecrawl.dev/app/api-keys" target="_blank" rel="noopener" className="text-[var(--accent)] hover:underline">API Key</a>。
              </p>
            </div>
            <button
              onClick={() => {
                setServers(prev => ({
                  ...prev,
                  firecrawl: {
                    type: 'sse',
                    url: 'https://mcp.firecrawl.dev/{apiKey}/v2/mcp',
                    apiKey: '',
                    enabled: true,
                  },
                }))
                setExpanded(prev => new Set(prev).add('firecrawl'))
                toast.success('已添加 Firecrawl，请填写 API Key')
              }}
              className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-[var(--accent-foreground)] bg-[#e76a5e] hover:opacity-90 transition-all flex-shrink-0"
            >
              <Zap size={12} /> 一键添加
            </button>
          </div>
        </div>
      )}

      {/* Server list */}
      <div className="space-y-3">
        {Object.entries(servers).map(([name, server]) => {
          const isExpanded = expanded.has(name)
          return (
            <div
              key={name}
              className="rounded-xl border border-[var(--border-strong)] bg-[var(--bg-surface)] overflow-hidden"
            >
              {/* Header */}
              <div className="flex items-center justify-between w-full px-4 py-3 hover:bg-[var(--bg-hover)] transition-colors">
                <div className="flex items-center gap-2.5 flex-1 min-w-0">
                  <Server size={15} className={cn('flex-shrink-0', server.enabled !== false ? 'text-[var(--accent)]' : 'text-[var(--text-placeholder)]')} />
                  <input
                    type="text"
                    defaultValue={name}
                    onClick={e => e.stopPropagation()}
                    onBlur={e => renameServer(name, e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                      if (e.key === 'Escape') {
                        ;(e.target as HTMLInputElement).value = name
                        ;(e.target as HTMLInputElement).blur()
                      }
                    }}
                    title="点击重命名"
                    className="bg-transparent text-sm font-medium outline-none border-b border-transparent hover:border-[var(--border)] focus:border-[var(--accent)]/60 transition-colors min-w-0"
                  />
                  <span className={cn(
                    'text-[10px] px-1.5 py-0.5 rounded-md font-medium border flex-shrink-0',
                    server.type === 'stdio'
                      ? 'bg-[#a5e75e]/10 text-[#a5e75e] border-[#a5e75e]/20'
                      : 'bg-[#6b9fff]/10 text-[#6b9fff] border-[#6b9fff]/20',
                  )}>
                    {server.type === 'stdio' ? 'STDIO' : 'SSE'}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    role="switch"
                    aria-checked={server.enabled !== false}
                    tabIndex={0}
                    title={server.enabled !== false ? '已启用，点击禁用' : '已禁用，点击启用'}
                    onClick={() => toggleEnabled(name)}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleEnabled(name) } }}
                    className={cn(
                      'relative inline-flex h-4 w-7 flex-shrink-0 cursor-pointer items-center rounded-full transition-colors',
                      server.enabled !== false ? 'bg-[var(--accent)]' : 'bg-[var(--border-strong)]',
                    )}
                  >
                    <span className={cn(
                      'inline-block h-3 w-3 transform rounded-full bg-[var(--accent-foreground)] transition-transform',
                      server.enabled !== false ? 'translate-x-3.5' : 'translate-x-0.5',
                    )} />
                  </span>
                  <button
                    type="button"
                    onClick={() => removeServer(name)}
                    className="rounded-md p-1 text-[var(--text-muted)] hover:text-[#e76a5e] hover:bg-[#e76a5e]/10 transition-colors"
                    title="删除"
                  >
                    <Trash2 size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleExpand(name)}
                    className="rounded-md p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                    title={isExpanded ? '收起' : '展开'}
                  >
                    {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </button>
                </div>
              </div>

              {/* Details */}
              {isExpanded && (
                <div className="px-4 pb-4 space-y-3 border-t border-[var(--border)]">
                  {/* Type */}
                  <div className="pt-3">
                    <label className="text-[11px] text-[var(--text-muted)] uppercase tracking-wider mb-1.5 block">类型</label>
                    <div className="flex gap-2">
                      {(['stdio', 'sse'] as const).map(t => (
                        <button
                          key={t}
                          type="button"
                          onClick={() => updateServer(name, { type: t })}
                          className={cn(
                            'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium border transition-all',
                            server.type === t
                              ? 'bg-[var(--accent)]/10 text-[var(--accent)] border-[var(--accent)]/20'
                              : 'bg-[var(--bg-input)] text-[var(--text-muted)] border-[var(--border)] hover:text-[var(--text-secondary)]',
                          )}
                        >
                          {t === 'stdio' ? <Terminal size={12} /> : <Globe size={12} />}
                          {t.toUpperCase()}
                        </button>
                      ))}
                    </div>
                  </div>

                  {server.type === 'stdio' ? (
                    <>
                      <div className="space-y-1.5">
                        <label className="text-[11px] text-[var(--text-muted)] uppercase tracking-wider">命令</label>
                        <input
                          type="text"
                          value={server.command || ''}
                          onChange={e => updateServer(name, { command: e.target.value })}
                          placeholder="如：npx"
                          className="w-full rounded-lg border border-[#717888] bg-[#454545] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] placeholder:italic focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30 focus:border-[var(--accent)]/40 transition-all"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[11px] text-[var(--text-muted)] uppercase tracking-wider">参数（每行一个）</label>
                        <div className="w-full rounded-lg border border-[#717888] overflow-hidden" style={{ height: 100 }}>
                          <MonacoEditor
                            value={(server.args || []).join('\n')}
                            filename="args.txt"
                            onChange={(v) => updateArgs(name, v)}
                            className="h-full"
                          />
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="space-y-1.5">
                        <label className="text-[11px] text-[var(--text-muted)] uppercase tracking-wider">URL</label>
                        <input
                          type="url"
                          value={server.url || ''}
                          onChange={e => updateServer(name, { url: e.target.value })}
                          placeholder="如：http://localhost:3000/sse 或 https://mcp.firecrawl.dev/{apiKey}/v2/mcp"
                          className="w-full rounded-lg border border-[#717888] bg-[#454545] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] placeholder:italic focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30 focus:border-[var(--accent)]/40 transition-all"
                        />
                        {server.url?.includes('{apiKey}') && (
                          <p className="text-[10px] text-[var(--text-muted)]">URL 中的 <code className="px-1 py-0.5 rounded bg-[var(--bg-input)]">{`{apiKey}`}</code> 占位符将自动替换为下方 API Key</p>
                        )}
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[11px] text-[var(--text-muted)] uppercase tracking-wider">API Key</label>
                        <ApiKeyInput
                          value={server.apiKey || ''}
                          onChange={v => updateServer(name, { apiKey: v })}
                          placeholder="如：fc-xxx"
                        />
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          )
        })}

        {Object.keys(servers).length === 0 && (
          <div className="text-center py-12 rounded-xl border border-dashed border-[var(--border)] bg-[var(--bg-surface)]">
            <Server size={24} className="mx-auto text-[var(--text-muted)] mb-2" />
            <div className="text-sm text-[var(--text-muted)]">暂无 MCP 服务</div>
            <div className="text-xs text-[var(--text-placeholder)] mt-1">添加一个 MCP 服务以扩展 Agent 能力</div>
          </div>
        )}
      </div>

      {Object.keys(servers).length > 0 ? (
        <button
          onClick={handleSave}
          disabled={updateMutation.isPending}
          className="flex items-center gap-2 rounded-lg px-5 py-2 text-sm font-medium text-[var(--accent-foreground)] bg-[var(--accent)] hover:opacity-90 disabled:opacity-40 transition-all"
        >
          <Save size={14} />
          {updateMutation.isPending ? '保存中...' : '保存配置'}
        </button>
      ) : (
        // Allow saving an empty config so users can clear all MCP servers.
        <button
          onClick={handleSave}
          disabled={updateMutation.isPending || !data || Object.keys((data?.mcpServers as Record<string, unknown>) ?? {}).length === 0}
          className="flex items-center gap-2 rounded-lg px-5 py-2 text-sm font-medium text-[var(--text-secondary)] bg-[var(--bg-input)] border border-[var(--border)] hover:bg-[var(--bg-hover)] disabled:opacity-40 transition-all"
          title="保存空配置（清空所有 MCP 服务）"
        >
          <Save size={14} />
          {updateMutation.isPending ? '保存中...' : '保存（清空）'}
        </button>
      )}
    </div>
  )
}
