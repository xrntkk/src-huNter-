import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  BookOpen, Plus, Trash2, Edit2, X, Save, FileText,
  ChevronDown, ChevronUp, AlertTriangle,
} from 'lucide-react'
import { toast } from 'react-hot-toast'
import { api } from '~/lib/api'
import { cn } from '~/lib/utils'
import { MonacoEditor } from '~/components/ui/monaco-editor'

export function SkillsSettingsPage() {
  const queryClient = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['settings-skills'],
    queryFn: api.settings.getSkills,
  })

  const [expandedSkill, setExpandedSkill] = useState<string | null>(null)
  const [editingSkill, setEditingSkill] = useState<string | null>(null)
  const [editContent, setEditContent] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [newContent, setNewContent] = useState('')
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)

  const skills = data?.skills || []

  const createMutation = useMutation({
    mutationFn: ({ name, content }: { name: string; content: string }) =>
      api.settings.createSkill(name, content),
    onSuccess: () => {
      toast.success('Skill 已创建')
      queryClient.invalidateQueries({ queryKey: ['settings-skills'] })
      setShowCreate(false)
      setNewName('')
      setNewContent('')
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const updateMutation = useMutation({
    mutationFn: ({ name, content }: { name: string; content: string }) =>
      api.settings.updateSkill(name, content),
    onSuccess: () => {
      toast.success('Skill 已更新')
      queryClient.invalidateQueries({ queryKey: ['settings-skills'] })
      setEditingSkill(null)
      setEditContent('')
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const deleteMutation = useMutation({
    mutationFn: api.settings.deleteSkill,
    onSuccess: () => {
      toast.success('Skill 已删除')
      queryClient.invalidateQueries({ queryKey: ['settings-skills'] })
      setDeleteConfirm(null)
      if (expandedSkill === deleteConfirm) setExpandedSkill(null)
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const toggleMutation = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) =>
      api.settings.setSkillEnabled(name, enabled),
    onSuccess: (_data, vars) => {
      toast.success(vars.enabled ? 'Skill 已启用' : 'Skill 已禁用')
      queryClient.invalidateQueries({ queryKey: ['settings-skills'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const { data: skillDetail } = useQuery({
    queryKey: ['settings-skill', expandedSkill],
    queryFn: () => api.settings.getSkill(expandedSkill!),
    enabled: !!expandedSkill && !editingSkill,
  })

  const { data: editDetail } = useQuery({
    queryKey: ['settings-skill', editingSkill],
    queryFn: () => api.settings.getSkill(editingSkill!),
    enabled: !!editingSkill,
  })

  // Sync edit content when edit detail loads
  const [hasSyncedEdit, setHasSyncedEdit] = useState(false)
  if (editDetail && editingSkill && !hasSyncedEdit) {
    setEditContent(editDetail.content)
    setHasSyncedEdit(true)
  }

  const handleStartEdit = (name: string) => {
    setEditingSkill(name)
    setHasSyncedEdit(false)
    setEditContent('')
  }

  const handleCancelEdit = () => {
    setEditingSkill(null)
    setEditContent('')
    setHasSyncedEdit(false)
  }

  const handleSaveEdit = () => {
    if (!editingSkill) return
    updateMutation.mutate({ name: editingSkill, content: editContent })
  }

  const handleCreate = () => {
    const name = newName.trim()
    if (!name) {
      toast.error('请输入 Skill 名称')
      return
    }
    if (!/^[a-z0-9_-]+$/i.test(name)) {
      toast.error('名称只能包含字母、数字、下划线和连字符')
      return
    }
    const content = newContent.trim() || `# ${name}\n\nDescribe your skill here.`
    createMutation.mutate({ name, content })
  }

  const toggleExpand = (name: string) => {
    if (editingSkill) return
    setExpandedSkill(prev => (prev === name ? null : name))
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
            Skills 管理
          </h2>
          <p className="text-sm text-[var(--text-muted)] mt-1">
            创建、编辑和删除技能库。技能会在对话时根据上下文自动注入系统提示
          </p>
        </div>
        <button
          onClick={() => { setShowCreate(true); setNewName(''); setNewContent('') }}
          className="flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-4 py-2 text-sm font-medium text-[var(--accent-foreground)] bg-[var(--accent)] hover:opacity-90 transition-all"
        >
          <Plus size={14} />
          新建 Skill
        </button>
      </div>

      {/* Create new skill panel */}
      {showCreate && (
        <div className="rounded-xl border border-[var(--accent)]/30 bg-[var(--bg-surface)] overflow-hidden">
          <div className="px-4 py-3 border-b border-[var(--border)] flex items-center justify-between">
            <span className="text-sm font-medium text-[var(--accent)]">新建 Skill</span>
            <button
              onClick={() => { setShowCreate(false); setNewName(''); setNewContent('') }}
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
                placeholder="my-skill（仅字母、数字、下划线、连字符）"
                className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--bg-input)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30 focus:border-[var(--accent)]/40 transition-all"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-1">
                <BookOpen size={11} /> SKILL.md 内容
              </label>
              <div className="w-full rounded-lg border border-[var(--border-strong)] overflow-hidden" style={{ height: 240 }}>
                <MonacoEditor
                  value={newContent}
                  filename="SKILL.md"
                  onChange={setNewContent}
                  className="h-full"
                />
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
                onClick={() => { setShowCreate(false); setNewName(''); setNewContent('') }}
                className="flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
              >
                <X size={12} /> 取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Skills list */}
      <div className="space-y-2">
        {skills.map(skill => {
          const isExpanded = expandedSkill === skill.name
          const isEditing = editingSkill === skill.name
          const isDeleting = deleteConfirm === skill.name

          return (
            <div
              key={skill.name}
              className={cn(
                'rounded-xl border overflow-hidden transition-all',
                isExpanded || isEditing
                  ? 'border-[var(--border-strong)] bg-[var(--bg-surface)]'
                  : 'border-[var(--border)] bg-[var(--bg-surface)] hover:border-[var(--border-strong)]',
              )}
            >
              {/* Header */}
              <button
                type="button"
                onClick={() => toggleExpand(skill.name)}
                disabled={!!editingSkill}
                className="flex items-center justify-between w-full px-4 py-3 hover:bg-[var(--bg-hover)] transition-colors disabled:cursor-default"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <BookOpen size={15} className={cn('flex-shrink-0', skill.enabled ? 'text-[var(--accent)]' : 'text-[var(--text-placeholder)]')} />
                  <div className="min-w-0 text-left">
                    <div className="flex items-center gap-2">
                      <span className={cn('text-sm font-medium', skill.enabled ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]')}>{skill.name}</span>
                      {!skill.enabled && (
                        <span className="text-[10px] text-[var(--text-placeholder)] bg-[var(--bg-badge)] px-1.5 py-0.5 rounded-md">已禁用</span>
                      )}
                    </div>
                    <p className="text-xs text-[var(--text-muted)] mt-0.5 whitespace-pre-wrap break-words">{skill.description}</p>
                  </div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <span
                    role="switch"
                    aria-checked={skill.enabled}
                    tabIndex={0}
                    title={skill.enabled ? '点击禁用' : '点击启用'}
                    onClick={e => { e.stopPropagation(); toggleMutation.mutate({ name: skill.name, enabled: !skill.enabled }) }}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggleMutation.mutate({ name: skill.name, enabled: !skill.enabled }) } }}
                    className={cn(
                      'relative inline-flex h-4 w-7 flex-shrink-0 cursor-pointer items-center rounded-full transition-colors mr-1',
                      skill.enabled ? 'bg-[var(--accent)]' : 'bg-[var(--border-strong)]',
                    )}
                  >
                    <span className={cn(
                      'inline-block h-3 w-3 transform rounded-full bg-[var(--accent-foreground)] transition-transform',
                      skill.enabled ? 'translate-x-3.5' : 'translate-x-0.5',
                    )} />
                  </span>
                  <span className="text-[10px] text-[var(--text-muted)] bg-[var(--bg-badge)] px-1.5 py-0.5 rounded-md">
                    {skill.fileCount} 文件
                  </span>
                  <button
                    type="button"
                    onClick={e => { e.stopPropagation(); handleStartEdit(skill.name) }}
                    className="rounded-md p-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                    title="编辑"
                  >
                    <Edit2 size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={e => { e.stopPropagation(); setDeleteConfirm(skill.name) }}
                    className="rounded-md p-1.5 text-[var(--text-muted)] hover:text-[var(--danger)] hover:bg-[var(--danger)]/10 transition-colors"
                    title="删除"
                  >
                    <Trash2 size={13} />
                  </button>
                  {isExpanded ? (
                    <ChevronUp size={14} className="text-[var(--text-muted)]" />
                  ) : (
                    <ChevronDown size={14} className="text-[var(--text-muted)]" />
                  )}
                </div>
              </button>

              {/* Delete confirmation */}
              {isDeleting && (
                <div className="px-4 pb-3 border-t border-[var(--border)] pt-3">
                  <div className="flex items-center gap-2 text-sm text-[var(--danger)] mb-2">
                    <AlertTriangle size={14} />
                    <span>确定要删除 skill &quot;{skill.name}&quot; 吗？此操作不可撤销。</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => deleteMutation.mutate(skill.name)}
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

              {/* View content */}
              {isExpanded && !isEditing && skillDetail?.name === skill.name && (
                <div className="px-4 pb-4 border-t border-[var(--border)]">
                  <div className="pt-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[11px] text-[var(--text-muted)] uppercase tracking-wider">SKILL.md</span>
                      <button
                        onClick={() => handleStartEdit(skill.name)}
                        className="flex items-center gap-1 text-[11px] text-[var(--accent)] hover:opacity-80 transition-colors"
                      >
                        <Edit2 size={11} /> 编辑
                      </button>
                    </div>
                    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-base)] p-3 overflow-auto max-h-[400px]">
                      <pre className="text-xs text-[var(--text-secondary)] font-mono whitespace-pre-wrap leading-relaxed">
                        {skillDetail.content}
                      </pre>
                    </div>
                  </div>
                </div>
              )}

              {/* Edit content */}
              {isEditing && (
                <div className="px-4 pb-4 border-t border-[var(--border)]">
                  <div className="pt-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-[var(--text-muted)] uppercase tracking-wider">编辑 SKILL.md</span>
                    </div>
                    <div className="w-full rounded-lg border border-[var(--border-strong)] overflow-hidden" style={{ height: 320 }}>
                      <MonacoEditor
                        value={editContent}
                        filename="SKILL.md"
                        onChange={setEditContent}
                        className="h-full"
                      />
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

        {skills.length === 0 && !showCreate && (
          <div className="text-center py-12 rounded-xl border border-dashed border-[var(--border)] bg-[var(--bg-surface)]">
            <BookOpen size={24} className="mx-auto text-[var(--text-muted)] mb-2" />
            <div className="text-sm text-[var(--text-muted)]">暂无技能</div>
            <div className="text-xs text-[var(--text-placeholder)] mt-1">点击右上角新建 Skill</div>
          </div>
        )}
      </div>
    </div>
  )
}
