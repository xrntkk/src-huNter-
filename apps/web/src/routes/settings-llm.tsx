import { useState, useEffect, useRef, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Plus, Trash2, Edit2, CheckCircle2, Cpu, Link, Bot, Key,
  X, ChevronDown, Star, Terminal, Zap,
} from 'lucide-react'
import { toast } from 'react-hot-toast'
import { api } from '~/lib/api'
import { cn } from '~/lib/utils'
import type { ModelConfig, ModelProvider } from '@src-agent/types'

const PROVIDERS: { value: ModelProvider; label: string; hint: string }[] = [
  { value: 'anthropic', label: 'Anthropic', hint: 'e.g. claude-sonnet-4-20250514' },
  { value: 'openai', label: 'OpenAI', hint: 'e.g. gpt-4o' },
  { value: 'deepseek', label: 'DeepSeek', hint: 'Base URL 使用 /v1 端点，e.g. https://api.deepseek.com/v1' },
  { value: 'openrouter', label: 'OpenRouter', hint: 'e.g. anthropic/claude-sonnet-4' },
  { value: 'kimi', label: 'Kimi', hint: 'OpenAI 兼容，e.g. https://api.kimi.com/coding/' },
  { value: 'claude-cli', label: 'Claude CLI', hint: '调用本机 Claude Code CLI 走 OAuth；Model ID 用 alias（如 sonnet/opus）或留空跟 CLI 默认模型' },
]

const PROVIDER_COLORS: Record<ModelProvider, string> = {
  anthropic: 'bg-[#d4a843]/10 text-[#d4a843] border-[#d4a843]/20',
  openai: 'bg-[#6b9fff]/10 text-[#6b9fff] border-[#6b9fff]/20',
  deepseek: 'bg-[#a5e75e]/10 text-[#a5e75e] border-[#a5e75e]/20',
  openrouter: 'bg-[#e76a5e]/10 text-[#e76a5e] border-[#e76a5e]/20',
  kimi: 'bg-[#8b5cf6]/10 text-[#8b5cf6] border-[#8b5cf6]/20',
  'claude-cli': 'bg-[#cc785c]/10 text-[#cc785c] border-[#cc785c]/20',
}

const emptyModel = (): ModelConfig => ({
  id: '',
  name: '',
  provider: 'anthropic',
  baseURL: '',
  apiKey: '',
  modelId: '',
  largeContext: false,
})

export function LLMSettingsPage() {
  const queryClient = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['settings-models'],
    queryFn: api.settings.getModels,
  })

  const { data: systemInfo } = useQuery({
    queryKey: ['system-info'],
    queryFn: api.system.getInfo,
    staleTime: Infinity, // 启动期已探测一次，前端不重复轮询
  })

  const [models, setModels] = useState<ModelConfig[]>([])
  const [activeModelId, setActiveModelId] = useState('')
  const [fastModelId, setFastModelId] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<ModelConfig>(emptyModel())
  const [showAdd, setShowAdd] = useState(false)
  const hasSyncedRef = useRef(false)

  useEffect(() => {
    if (data && !hasSyncedRef.current) {
      hasSyncedRef.current = true
      setModels(data.models || [])
      setActiveModelId(data.activeModelId || '')
      setFastModelId(data.fastModelId || '')
    }
  }, [data])

  const updateMutation = useMutation({
    mutationFn: api.settings.updateModels,
    onSuccess: () => {
      toast.success('模型配置已保存')
      queryClient.invalidateQueries({ queryKey: ['settings-models'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const autoSave = useCallback(() => {
    if (!hasSyncedRef.current || models.length === 0) return
    updateMutation.mutate({
      models,
      activeModelId,
      ...(fastModelId ? { fastModelId } : {}),
    })
  }, [models, activeModelId, fastModelId])

  // Auto-save on every meaningful state change (skip initial sync).
  const isFirstRender = useRef(true)
  useEffect(() => {
    if (isFirstRender.current) { isFirstRender.current = false; return }
    autoSave()
  }, [models, activeModelId, fastModelId])

  const startEdit = (model: ModelConfig) => {
    setEditingId(model.id)
    setDraft({ ...model })
  }

  const cancelEdit = () => {
    setEditingId(null)
    setDraft(emptyModel())
  }

  const saveEdit = () => {
    if (!draft.name.trim() || !draft.modelId.trim() || !draft.baseURL.trim()) {
      toast.error('请填写完整信息')
      return
    }
    setModels(prev =>
      prev.map(m => (m.id === editingId ? { ...draft, id: editingId } : m)),
    )
    setEditingId(null)
    setDraft(emptyModel())
    toast.success('已更新')
  }

  const addModel = () => {
    if (!draft.name.trim() || !draft.modelId.trim() || !draft.baseURL.trim()) {
      toast.error('请填写完整信息')
      return
    }
    const newId = crypto.randomUUID()
    const newModel = { ...draft, id: newId }
    setModels(prev => [...prev, newModel])
    if (!activeModelId) setActiveModelId(newId)
    setShowAdd(false)
    setDraft(emptyModel())
    toast.success('模型已添加')
  }

  const removeModel = (id: string) => {
    setModels(prev => {
      const remaining = prev.filter(m => m.id !== id)
      if (activeModelId === id) {
        setActiveModelId(remaining[0]?.id || '')
      }
      return remaining
    })
  }

  const setActive = (id: string) => {
    setActiveModelId(id)
  }

  const quickAddClaudeCli = () => {
    setEditingId(null)
    setShowAdd(true)
    setDraft({
      ...emptyModel(),
      provider: 'claude-cli',
      name: 'Claude (本地 CLI)',
      baseURL: '',
      apiKey: '',
      modelId: 'sonnet',
    })
  }

  const activeProviderHint = PROVIDERS.find(p => p.value === draft.provider)?.hint || ''

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold leading-6 tracking-tight text-[var(--text-primary)]">
            Language Model (LLM)
          </h2>
          <p className="text-sm text-[var(--text-muted)] mt-1">管理多个 LLM 模型配置，支持 Anthropic、OpenAI、DeepSeek、OpenRouter、Kimi</p>
        </div>
        <button
          onClick={() => {
            setShowAdd(true)
            setDraft(emptyModel())
            setEditingId(null)
          }}
          className="flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-4 py-2 text-sm font-medium text-[var(--accent-foreground)] bg-[var(--accent)] hover:opacity-90 transition-all"
        >
          <Plus size={14} />
          添加模型
        </button>
      </div>

      {/* Claude CLI detected banner */}
      {systemInfo?.claudeCli.found && (
        <div className="rounded-xl border border-[#cc785c]/30 bg-[#cc785c]/5 px-4 py-3.5">
          <div className="flex items-start gap-3">
            <Terminal size={16} className="text-[#cc785c] flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium text-[var(--text-primary)]">已检测到 Claude CLI</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded-md font-medium border bg-[#cc785c]/10 text-[#cc785c] border-[#cc785c]/20">
                  {systemInfo.claudeCli.version}
                </span>
              </div>
              <p className="text-xs text-[var(--text-muted)] mt-1 leading-relaxed">
                可一键添加本地 Claude 模型 —— 直接用 Claude Code SDK 调用，复用本机 OAuth 凭证，无需 API Key。Model ID 推荐用 alias（<code className="px-1 py-0.5 rounded bg-[var(--bg-input)] text-[var(--text-secondary)]">sonnet</code> / <code className="px-1 py-0.5 rounded bg-[var(--bg-input)] text-[var(--text-secondary)]">opus</code>）或留空跟随 CLI 默认。
              </p>
            </div>
            <button
              onClick={quickAddClaudeCli}
              className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-[var(--accent-foreground)] bg-[#cc785c] hover:opacity-90 transition-all flex-shrink-0"
            >
              <Zap size={12} /> 一键添加
            </button>
          </div>
        </div>
      )}

      {/* Model list */}
      <div className="space-y-3">
        {models.map(model => {
          const isEditing = editingId === model.id
          const isActive = activeModelId === model.id
          const providerInfo = PROVIDERS.find(p => p.value === model.provider)

          return (
            <div
              key={model.id}
              className={cn(
                'rounded-xl border overflow-hidden transition-all',
                isActive
                  ? 'border-[var(--accent)]/40 bg-[var(--bg-surface)]'
                  : 'border-[var(--border-strong)] bg-[var(--bg-surface)]',
              )}
            >
              {/* Header row */}
              <div className="flex items-center justify-between px-4 py-3">
                <div className="flex items-center gap-3 min-w-0">
                  <Cpu size={15} className="text-[var(--accent)] flex-shrink-0" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-[var(--text-primary)] truncate">
                        {model.name}
                      </span>
                      {isActive && (
                        <span className="flex items-center gap-0.5 text-[10px] font-medium text-[var(--accent-foreground)] bg-[var(--accent)] px-2 py-0.5 rounded-full flex-shrink-0">
                          <Star size={9} /> 默认
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className={cn(
                        'text-[10px] px-1.5 py-0.5 rounded-md font-medium border',
                        PROVIDER_COLORS[model.provider],
                      )}>
                        {providerInfo?.label || model.provider}
                      </span>
                      <span className="text-xs text-[var(--text-muted)] truncate">{model.modelId}</span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1 flex-shrink-0">
                  {!isActive && (
                    <button
                      onClick={() => setActive(model.id)}
                      className="rounded-md p-1.5 text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--accent)]/10 transition-colors"
                      title="设为默认"
                    >
                      <Star size={13} />
                    </button>
                  )}
                  <button
                    onClick={() => startEdit(model)}
                    className="rounded-md p-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                    title="编辑"
                  >
                    <Edit2 size={13} />
                  </button>
                  <button
                    onClick={() => removeModel(model.id)}
                    className="rounded-md p-1.5 text-[var(--text-muted)] hover:text-[var(--danger)] hover:bg-[var(--danger)]/10 transition-colors"
                    title="删除"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>

              {/* Edit panel */}
              {isEditing && (
                <div className="px-4 pb-4 border-t border-[var(--border)] space-y-3">
                  <div className="pt-3 grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <label className="text-[11px] text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-1">
                        <Bot size={11} /> 名称
                      </label>
                      <input
                        type="text"
                        value={draft.name}
                        onChange={e => setDraft(p => ({ ...p, name: e.target.value }))}
                        placeholder="模型显示名称"
                        className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--bg-input)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30 focus:border-[var(--accent)]/40 transition-all"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[11px] text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-1">
                        <Cpu size={11} /> 提供商
                      </label>
                      <div className="relative">
                        <select
                          value={draft.provider}
                          onChange={e => setDraft(p => ({ ...p, provider: e.target.value as ModelProvider }))}
                          className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--bg-input)] px-3 py-2 text-sm text-[var(--text-primary)] appearance-none focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30 focus:border-[var(--accent)]/40 transition-all"
                        >
                          {PROVIDERS.map(p => (
                            <option key={p.value} value={p.value}>{p.label}</option>
                          ))}
                        </select>
                        <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none" />
                      </div>
                    </div>
                    <div className="space-y-1.5 col-span-2">
                      <label className="text-[11px] text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-1">
                        <Link size={11} /> Base URL
                      </label>
                      <input
                        type="text"
                        value={draft.baseURL}
                        onChange={e => setDraft(p => ({ ...p, baseURL: e.target.value }))}
                        placeholder="https://api.anthropic.com"
                        className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--bg-input)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30 focus:border-[var(--accent)]/40 transition-all"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[11px] text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-1">
                        <Bot size={11} /> Model ID
                      </label>
                      <input
                        type="text"
                        value={draft.modelId}
                        onChange={e => setDraft(p => ({ ...p, modelId: e.target.value }))}
                        placeholder={activeProviderHint}
                        className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--bg-input)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30 focus:border-[var(--accent)]/40 transition-all"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[11px] text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-1">
                        <Key size={11} /> API Key
                      </label>
                      <input
                        type="password"
                        value={draft.apiKey}
                        onChange={e => setDraft(p => ({ ...p, apiKey: e.target.value }))}
                        placeholder="sk-..."
                        className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--bg-input)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30 focus:border-[var(--accent)]/40 transition-all"
                      />
                    </div>
                  </div>
                  <label className="flex items-center gap-2 pt-1 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={!!draft.largeContext}
                      onChange={e => setDraft(p => ({ ...p, largeContext: e.target.checked }))}
                      className="h-3.5 w-3.5 rounded border-[var(--border-strong)] accent-[var(--accent)]"
                    />
                    <span className="text-xs text-[var(--text-secondary)]">支持 1M 上下文</span>
                    <span className="text-[11px] text-[var(--text-muted)]">（提高时间线压缩阈值，长会话更晚触发压缩）</span>
                  </label>
                  <div className="space-y-1.5">
                    <label className="text-[11px] text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-1">
                      <Cpu size={11} /> 工具调用协议
                    </label>
                    <div className="relative">
                      <select
                        value={draft.toolProtocol ?? 'native'}
                        onChange={e => setDraft(p => ({ ...p, toolProtocol: e.target.value as 'native' | 'text' }))}
                        className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--bg-input)] px-3 py-2 text-sm text-[var(--text-primary)] appearance-none focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30 focus:border-[var(--accent)]/40 transition-all"
                      >
                        <option value="native">Native（结构化函数调用，推荐）</option>
                        <option value="text">Text（从文本中恢复工具调用）</option>
                      </select>
                      <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none" />
                    </div>
                    <span className="text-[11px] text-[var(--text-muted)]">绝大多数模型（DeepSeek v4 / Anthropic / OpenAI / Kimi）用 Native。仅当模型无法原生 function-calling、只会在文本里写工具调用时才选 Text。</span>
                  </div>
                  <div className="flex items-center gap-2 pt-1">
                    <button
                      onClick={saveEdit}
                      className="flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-xs font-medium text-[var(--accent-foreground)] bg-[var(--accent)] hover:opacity-90 transition-all"
                    >
                      <CheckCircle2 size={12} /> 保存修改
                    </button>
                    <button
                      onClick={cancelEdit}
                      className="flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                    >
                      <X size={12} /> 取消
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })}

        {/* Add new model panel */}
        {showAdd && (
          <div className="rounded-xl border border-[var(--accent)]/30 bg-[var(--bg-surface)] overflow-hidden">
            <div className="px-4 py-3 border-b border-[var(--border)] flex items-center justify-between">
              <span className="text-sm font-medium text-[var(--accent)]">添加新模型</span>
              <button
                onClick={() => { setShowAdd(false); setDraft(emptyModel()) }}
                className="rounded-md p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
              >
                <X size={14} />
              </button>
            </div>
            <div className="px-4 pb-4 space-y-3">
              <div className="pt-3 grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-[11px] text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-1">
                    <Bot size={11} /> 名称
                  </label>
                  <input
                    type="text"
                    value={draft.name}
                    onChange={e => setDraft(p => ({ ...p, name: e.target.value }))}
                    placeholder="模型显示名称"
                    className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--bg-input)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30 focus:border-[var(--accent)]/40 transition-all"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[11px] text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-1">
                    <Cpu size={11} /> 提供商
                  </label>
                  <div className="relative">
                    <select
                      value={draft.provider}
                      onChange={e => setDraft(p => ({ ...p, provider: e.target.value as ModelProvider }))}
                      className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--bg-input)] px-3 py-2 text-sm text-[var(--text-primary)] appearance-none focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30 focus:border-[var(--accent)]/40 transition-all"
                    >
                      {PROVIDERS.map(p => (
                        <option key={p.value} value={p.value}>{p.label}</option>
                      ))}
                    </select>
                    <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none" />
                  </div>
                </div>
                <div className="space-y-1.5 col-span-2">
                  <label className="text-[11px] text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-1">
                    <Link size={11} /> Base URL
                  </label>
                  <input
                    type="text"
                    value={draft.baseURL}
                    onChange={e => setDraft(p => ({ ...p, baseURL: e.target.value }))}
                    placeholder={draft.provider === 'claude-cli' ? 'http://localhost:8000/v1' : draft.provider === 'deepseek' ? 'https://api.deepseek.com/v1' : draft.provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : draft.provider === 'kimi' ? 'https://api.kimi.com/coding/' : 'https://api.anthropic.com'}
                    className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--bg-input)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30 focus:border-[var(--accent)]/40 transition-all"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[11px] text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-1">
                    <Bot size={11} /> Model ID
                  </label>
                  <input
                    type="text"
                    value={draft.modelId}
                    onChange={e => setDraft(p => ({ ...p, modelId: e.target.value }))}
                    placeholder={activeProviderHint}
                    className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--bg-input)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30 focus:border-[var(--accent)]/40 transition-all"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[11px] text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-1">
                    <Key size={11} /> API Key
                  </label>
                  <input
                    type="password"
                    value={draft.apiKey}
                    onChange={e => setDraft(p => ({ ...p, apiKey: e.target.value }))}
                    placeholder="sk-..."
                    className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--bg-input)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30 focus:border-[var(--accent)]/40 transition-all"
                  />
                </div>
              </div>
              <label className="flex items-center gap-2 pt-1 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={!!draft.largeContext}
                  onChange={e => setDraft(p => ({ ...p, largeContext: e.target.checked }))}
                  className="h-3.5 w-3.5 rounded border-[var(--border-strong)] accent-[var(--accent)]"
                />
                <span className="text-xs text-[var(--text-secondary)]">支持 1M 上下文</span>
                <span className="text-[11px] text-[var(--text-muted)]">（提高时间线压缩阈值，长会话更晚触发压缩）</span>
              </label>
              <div className="space-y-1.5">
                <label className="text-[11px] text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-1">
                  <Cpu size={11} /> 工具调用协议
                </label>
                <div className="relative">
                  <select
                    value={draft.toolProtocol ?? 'native'}
                    onChange={e => setDraft(p => ({ ...p, toolProtocol: e.target.value as 'native' | 'text' }))}
                    className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--bg-input)] px-3 py-2 text-sm text-[var(--text-primary)] appearance-none focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30 focus:border-[var(--accent)]/40 transition-all"
                  >
                    <option value="native">Native（结构化函数调用，推荐）</option>
                    <option value="text">Text（从文本中恢复工具调用）</option>
                  </select>
                  <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none" />
                </div>
                <span className="text-[11px] text-[var(--text-muted)]">绝大多数模型（DeepSeek v4 / Anthropic / OpenAI / Kimi）用 Native。仅当模型无法原生 function-calling、只会在文本里写工具调用时才选 Text。</span>
              </div>
              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={addModel}
                  className="flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-xs font-medium text-[var(--accent-foreground)] bg-[var(--accent)] hover:opacity-90 transition-all"
                >
                  <Plus size={12} /> 确认添加
                </button>
                <button
                  onClick={() => { setShowAdd(false); setDraft(emptyModel()) }}
                  className="flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                >
                  <X size={12} /> 取消
                </button>
              </div>
            </div>
          </div>
        )}

        {models.length === 0 && !showAdd && (
          <div className="text-center py-12 rounded-xl border border-dashed border-[var(--border)] bg-[var(--bg-surface)]">
            <Cpu size={24} className="mx-auto text-[var(--text-muted)] mb-2" />
            <div className="text-sm text-[var(--text-muted)]">暂无模型配置</div>
            <div className="text-xs text-[var(--text-placeholder)] mt-1">点击右上角添加模型</div>
          </div>
        )}
      </div>

      {/* Fast model selector — applied to compression / intent classification / memory extraction */}
      {models.length > 0 && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-4 space-y-3">
          <div className="flex items-start gap-3">
            <Zap size={16} className="text-[var(--accent)] flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-[var(--text-primary)]">Fast 模型（辅助调用）</div>
              <p className="text-xs text-[var(--text-muted)] mt-1 leading-relaxed">
                用于上下文压缩、意图分类、记忆抽取等高频但低价值的辅助 LLM 调用。建议选一个比主模型更便宜的（如 DeepSeek / Haiku），可显著降低成本与延迟。留空则使用主模型。
              </p>
            </div>
          </div>
          <div className="relative">
            <select
              value={fastModelId}
              onChange={e => setFastModelId(e.target.value)}
              className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--bg-input)] px-3 py-2 text-sm text-[var(--text-primary)] appearance-none focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30 focus:border-[var(--accent)]/40 transition-all"
            >
              <option value="">(默认 — 与主模型相同)</option>
              {models.map(m => (
                <option key={m.id} value={m.id}>
                  {m.name} — {m.modelId}
                </option>
              ))}
            </select>
            <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none" />
          </div>
        </div>
      )}


      {/* Provider hints */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-4 space-y-2">
        <div className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider mb-2">提供商配置提示</div>
        {PROVIDERS.map(p => (
          <div key={p.value} className="flex items-start gap-2 text-sm text-[var(--text-secondary)]">
            <span className={cn('text-[10px] px-1.5 py-0.5 rounded-md font-medium border flex-shrink-0 mt-0.5', PROVIDER_COLORS[p.value])}>
              {p.label}
            </span>
            <span className="text-xs text-[var(--text-muted)]">{p.hint}</span>
          </div>
        ))}
        <div className="text-xs text-[var(--text-muted)] pt-1 border-t border-[var(--border)] mt-2">
          DeepSeek、OpenRouter 和 Kimi 使用 OpenAI 兼容接口，配置时选择对应提供商即可。Kimi 支持 OpenAI 和 Anthropic 两种协议，使用 OpenAI 协议时选择 Kimi 提供商，使用 Anthropic 协议时选择 Anthropic 提供商并将 Base URL 设为 https://api.kimi.com/coding/anthropic。
        </div>
      </div>
    </div>
  )
}
