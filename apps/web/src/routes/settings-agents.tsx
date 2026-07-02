import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Bot, Plus, Trash2, Edit2, X, Save, FileText,
  ChevronDown, ChevronUp, AlertTriangle, Wrench,
} from 'lucide-react'
import { toast } from 'react-hot-toast'
import { api } from '~/lib/api'
import { cn } from '~/lib/utils'
import { MonacoEditor } from '~/components/ui/monaco-editor'

const NEW_AGENT_TEMPLATE = `name: my-agent
description: 一句话描述这个子 Agent 的职责
when_to_use: |
  详细说明何时该用这个子 Agent、适合什么场景、不适合什么场景。
  主 Agent 会根据这段文字决定是否选用本类型。
system_prompt: |
  你是一个 ... Agent。

  ## 角色
  你的职责是 ...

  ## 规则
  1. ...

  ## 输出
  完成后总结 ...
tools:
  - http_request
  - python_exec
  - load_skill
max_iterations: 15
model: inherit
`

export function AgentsSettingsPage() {
  const queryClient = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['settings-agents'],
    queryFn: api.settings.getAgents,
  })

  const [expanded, setExpanded] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [editContent, setEditContent] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [newContent, setNewContent] = useState(NEW_AGENT_TEMPLATE)
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)

  const agents = data?.agents || []

  const createMutation = useMutation({
    mutationFn: ({ name, content }: { name: string; content: string }) =>
      api.settings.createAgent(name, content),
    onSuccess: () => {
      toast.success('子 Agent 已创建')
      queryClient.invalidateQueries({ queryKey: ['settings-agents'] })
      setShowCreate(false); setNewName(''); setNewContent(NEW_AGENT_TEMPLATE)
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const updateMutation = useMutation({
    mutationFn: ({ name, content }: { name: string; content: string }) =>
      api.settings.updateAgent(name, content),
    onSuccess: () => {
      toast.success('子 Agent 已更新')
      queryClient.invalidateQueries({ queryKey: ['settings-agents'] })
      setEditing(null); setEditContent('')
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const deleteMutation = useMutation({
    mutationFn: api.settings.deleteAgent,
    onSuccess: () => {
      toast.success('子 Agent 已删除')
      queryClient.invalidateQueries({ queryKey: ['settings-agents'] })
      setDeleteConfirm(null)
      if (expanded === deleteConfirm) setExpanded(null)
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const toggleMutation = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) =>
      api.settings.setAgentEnabled(name, enabled),
    onSuccess: (_d, vars) => {
      toast.success(vars.enabled ? '已启用' : '已禁用')
      queryClient.invalidateQueries({ queryKey: ['settings-agents'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const { data: editDetail } = useQuery({
    queryKey: ['settings-agent', editing],
    queryFn: () => api.settings.getAgent(editing!),
    enabled: !!editing,
  })

  const [hasSyncedEdit, setHasSyncedEdit] = useState(false)
  if (editDetail && editing && !hasSyncedEdit) {
    setEditContent(editDetail.content)
    setHasSyncedEdit(true)
  }

  const handleStartEdit = (name: string) => {
    setEditing(name); setHasSyncedEdit(false); setEditContent('')
  }
  const handleCancelEdit = () => {
    setEditing(null); setEditContent(''); setHasSyncedEdit(false)
  }
  const handleSaveEdit = () => {
    if (editing) updateMutation.mutate({ name: editing, content: editContent })
  }
  const handleCreate = () => {
    const name = newName.trim()
    if (!name) { toast.error('请输入名称'); return }
    if (!/^[a-z0-9_-]+$/i.test(name)) { toast.error('名称只能含字母、数字、下划线、连字符'); return }
    createMutation.mutate({ name, content: newContent })
  }
  const toggleExpand = (name: string) => {
    if (editing) return
    setExpanded(prev => (prev === name ? null : name))
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
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold leading-6 tracking-tight text-[var(--text-primary)]">
            子 Agent 管理
          </h2>
          <p className="text-sm text-[var(--text-muted)] mt-1">
            定义可被 spawn_agent 选用的子 Agent 角色。内置角色可禁用或覆盖；自定义角色以 YAML 存于 config/agents/
          </p>
        </div>
        <button
          onClick={() => { setShowCreate(true); setNewName(''); setNewContent(NEW_AGENT_TEMPLATE) }}
          className="flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-4 py-2 text-sm font-medium text-[var(--accent-foreground)] bg-[var(--accent)] hover:opacity-90 transition-all"
        >
          <Plus size={14} />
          新增
        </button>
      </div>

      {showCreate && (
        <div className="rounded-xl border border-[var(--accent)]/30 bg-[var(--bg-surface)] overflow-hidden">
          <div className="px-4 py-3 border-b border-[var(--border)] flex items-center justify-between">
            <span className="text-sm font-medium text-[var(--accent)]">新建</span>
            <button
              onClick={() => { setShowCreate(false); setNewName(''); setNewContent(NEW_AGENT_TEMPLATE) }}
              className="rounded-md p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
            >
              <X size={14} />
            </button>
          </div>
          <div className="px-4 py-4 space-y-3">
            <div className="space-y-1.5">
              <label className="text-[11px] text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-1">
                <FileText size={11} /> 名称
              </label>
              <input
                type="text"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="my-agent（仅字母、数字、下划线、连字符）"
                className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--bg-input)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30 focus:border-[var(--accent)]/40 transition-all"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-1">
                <Bot size={11} /> 角色定义 (YAML)
              </label>
              <div className="w-full rounded-lg border border-[var(--border-strong)] overflow-hidden" style={{ height: 280 }}>
                <MonacoEditor value={newContent} filename="agent.yaml" onChange={setNewContent} className="h-full" />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handleCreate}
                disabled={createMutation.isPending || !newName.trim()}
                className="flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-xs font-medium text-[var(--accent-foreground)] bg-[var(--accent)] hover:opacity-90 disabled:opacity-40 transition-all"
              >
                <Plus size={12} />
                {createMutation.isPending ? '创建中...' : '确认创建'}
              </button>
              <button
                onClick={() => { setShowCreate(false); setNewName(''); setNewContent(NEW_AGENT_TEMPLATE) }}
                className="flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
              >
                <X size={12} /> 取消
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {agents.map(agent => {
          const isExpanded = expanded === agent.name
          const isEditing = editing === agent.name
          const isDeleting = deleteConfirm === agent.name
          return (
            <div
              key={agent.name}
              className={cn(
                'rounded-xl border overflow-hidden transition-all',
                isExpanded || isEditing
                  ? 'border-[var(--border-strong)] bg-[var(--bg-surface)]'
                  : 'border-[var(--border)] bg-[var(--bg-surface)] hover:border-[var(--border-strong)]',
              )}
            >
              <button
                type="button"
                onClick={() => toggleExpand(agent.name)}
                disabled={!!editing}
                className="flex items-center justify-between w-full px-4 py-3 hover:bg-[var(--bg-hover)] transition-colors disabled:cursor-default"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Bot size={15} className={cn('flex-shrink-0', agent.enabled ? 'text-[var(--accent)]' : 'text-[var(--text-placeholder)]')} />
                  <div className="min-w-0 text-left">
                    <div className="flex items-center gap-2">
                      <span className={cn('text-sm font-medium', agent.enabled ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]')}>{agent.name}</span>
                      <span className="text-[10px] text-[var(--text-muted)] bg-[var(--bg-badge)] px-1.5 py-0.5 rounded-md">
                        {agent.source === 'built-in' ? '内置' : '自定义'}
                      </span>
                      {!agent.enabled && (
                        <span className="text-[10px] text-[var(--text-placeholder)] bg-[var(--bg-badge)] px-1.5 py-0.5 rounded-md">已禁用</span>
                      )}
                    </div>
                    <p className="text-xs text-[var(--text-muted)] mt-0.5 whitespace-pre-wrap break-words">{agent.description}</p>
                  </div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <span
                    role="switch"
                    aria-checked={agent.enabled}
                    tabIndex={0}
                    title={agent.enabled ? '点击禁用' : '点击启用'}
                    onClick={e => { e.stopPropagation(); toggleMutation.mutate({ name: agent.name, enabled: !agent.enabled }) }}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggleMutation.mutate({ name: agent.name, enabled: !agent.enabled }) } }}
                    className={cn(
                      'relative inline-flex h-4 w-7 flex-shrink-0 cursor-pointer items-center rounded-full transition-colors mr-1',
                      agent.enabled ? 'bg-[var(--accent)]' : 'bg-[var(--border-strong)]',
                    )}
                  >
                    <span className={cn(
                      'inline-block h-3 w-3 transform rounded-full bg-[var(--accent-foreground)] transition-transform',
                      agent.enabled ? 'translate-x-3.5' : 'translate-x-0.5',
                    )} />
                  </span>
                  <button
                    type="button"
                    onClick={e => { e.stopPropagation(); handleStartEdit(agent.name) }}
                    className="rounded-md p-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                    title={agent.source === 'built-in' ? '覆盖（创建自定义副本）' : '编辑'}
                  >
                    <Edit2 size={13} />
                  </button>
                  {agent.source === 'custom' && (
                    <button
                      type="button"
                      onClick={e => { e.stopPropagation(); setDeleteConfirm(agent.name) }}
                      className="rounded-md p-1.5 text-[var(--text-muted)] hover:text-[var(--danger)] hover:bg-[var(--danger)]/10 transition-colors"
                      title="删除"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                  {isExpanded ? (
                    <ChevronUp size={14} className="text-[var(--text-muted)]" />
                  ) : (
                    <ChevronDown size={14} className="text-[var(--text-muted)]" />
                  )}
                </div>
              </button>

              {isDeleting && (
                <div className="px-4 pb-3 border-t border-[var(--border)] pt-3">
                  <div className="flex items-center gap-2 text-sm text-[var(--danger)] mb-2">
                    <AlertTriangle size={14} />
                    <span>确定删除子 Agent &quot;{agent.name}&quot;？此操作不可撤销。</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => deleteMutation.mutate(agent.name)}
                      disabled={deleteMutation.isPending}
                      className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-white bg-[var(--danger)] hover:opacity-90 disabled:opacity-40 transition-all"
                    >
                      <Trash2 size={11} />
                      {deleteMutation.isPending ? '删除中...' : '确认删除'}
                    </button>
                    <button
                      onClick={() => setDeleteConfirm(null)}
                      className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                    >
                      <X size={11} /> 取消
                    </button>
                  </div>
                </div>
              )}

              {isExpanded && !isEditing && (
                <div className="px-4 pb-4 border-t border-[var(--border)] pt-3 space-y-3">
                  {agent.whenToUse && (
                    <div>
                      <div className="text-[11px] text-[var(--text-muted)] uppercase tracking-wider mb-1">使用场景</div>
                      <p className="text-xs text-[var(--text-secondary)] whitespace-pre-wrap leading-relaxed">{agent.whenToUse}</p>
                    </div>
                  )}
                  <div className="flex flex-wrap gap-3 text-xs text-[var(--text-muted)]">
                    <span className="flex items-center gap-1">
                      <Wrench size={11} /> {agent.tools && agent.tools.length > 0 ? `${agent.tools.length} 个工具` : '继承父工具集'}
                    </span>
                    <span>最大迭代：{agent.maxIterations ?? '父设定'}</span>
                    <span>模型：{agent.model ?? 'inherit'}</span>
                  </div>
                  {agent.tools && agent.tools.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {agent.tools.map(t => (
                        <span key={t} className="text-[10px] text-[var(--text-secondary)] bg-[var(--bg-badge)] px-1.5 py-0.5 rounded-md font-mono">{t}</span>
                      ))}
                    </div>
                  )}
                  <button
                    onClick={() => handleStartEdit(agent.name)}
                    className="flex items-center gap-1 text-[11px] text-[var(--accent)] hover:opacity-80 transition-colors"
                  >
                    <Edit2 size={11} /> {agent.source === 'built-in' ? '覆盖此内置角色' : '编辑 YAML'}
                  </button>
                </div>
              )}

              {isEditing && (
                <div className="px-4 pb-4 border-t border-[var(--border)]">
                  <div className="pt-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-[var(--text-muted)] uppercase tracking-wider">
                        {agent.source === 'built-in' ? '覆盖为自定义 YAML（保存后优先于内置）' : '编辑 agent.yaml'}
                      </span>
                    </div>
                    <div className="w-full rounded-lg border border-[var(--border-strong)] overflow-hidden" style={{ height: 360 }}>
                      <MonacoEditor value={editContent} filename="agent.yaml" onChange={setEditContent} className="h-full" />
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={handleSaveEdit}
                        disabled={updateMutation.isPending}
                        className="flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-xs font-medium text-[var(--accent-foreground)] bg-[var(--accent)] hover:opacity-90 disabled:opacity-40 transition-all"
                      >
                        <Save size={12} />
                        {updateMutation.isPending ? '保存中...' : '保存'}
                      </button>
                      <button
                        onClick={handleCancelEdit}
                        className="flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                      >
                        <X size={12} /> 取消
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )
        })}

        {agents.length === 0 && !showCreate && (
          <div className="text-center py-12 rounded-xl border border-dashed border-[var(--border)] bg-[var(--bg-surface)]">
            <Bot size={24} className="mx-auto text-[var(--text-muted)] mb-2" />
            <div className="text-sm text-[var(--text-muted)]">暂无子 Agent</div>
            <div className="text-xs text-[var(--text-placeholder)] mt-1">点击右上角新建子 Agent</div>
          </div>
        )}
      </div>
    </div>
  )
}


