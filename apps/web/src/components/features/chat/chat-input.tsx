import { useState, useRef, useEffect, useCallback, useMemo, type KeyboardEvent } from 'react'
import { Send, Square, Paperclip, X, Sparkles, Plug, Cpu, type LucideIcon, Radar, Bug, KeyRound, FileText, Terminal } from 'lucide-react'
import { cn } from '~/lib/utils'
import { api, type SlashCommandMeta } from '~/lib/api'
import { ContextRing } from './context-ring'
import { TaskList } from './task-list'
import type { PlanState } from '~/hooks/use-session-chat'

// Per-command visuals (icon + accent). Keyed by backend command `name`.
// Prompts live server-side (apps/server/src/agent/slash-commands.ts) — the
// frontend only ever knows name/label/description.
const COMMAND_VISUALS: Record<string, { icon: LucideIcon; accent: string }> = {
  recon: { icon: Radar, accent: 'text-[var(--info)]' },
  verify: { icon: Bug, accent: 'text-[var(--danger)]' },
  idor: { icon: KeyRound, accent: 'text-[var(--warning)]' },
  sqli: { icon: FileText, accent: 'text-[var(--success)]' },
}
const DEFAULT_VISUAL = { icon: Terminal, accent: 'text-[var(--text-muted)]' }

export interface ModelOption {
  id: string
  name: string
  provider?: string
}

export interface SkillOption {
  name: string
  description: string
  enabled: boolean
}

export interface McpServerOption {
  name: string
  enabled: boolean
}

export interface AttachmentFile {
  id: string
  name: string
  size: number
  file: File
}

interface ChatInputProps {
  onSend: (text: string, files?: AttachmentFile[]) => void
  onStop: () => void
  isLoading: boolean
  disabled?: boolean
  sessionId?: string
  models?: ModelOption[]
  selectedModelId?: string
  onModelChange?: (modelId: string) => void
  skills?: SkillOption[]
  selectedSkills?: string[]
  onSkillsChange?: (skills: string[]) => void
  onToggleSkillEnabled?: (name: string, enabled: boolean) => void
  mcpServers?: McpServerOption[]
  selectedMcpServers?: string[]
  onMcpServersChange?: (servers: string[]) => void
  onToggleMcpEnabled?: (name: string, enabled: boolean) => void
  plan?: PlanState | null
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

/** 与设置页一致的开关；圆点用 accent-foreground，暗色下为深色，避免白底白点。 */
function Switch({ checked, onClick }: { checked: boolean; onClick: (e: React.MouseEvent) => void }) {
  return (
    <span
      role="switch"
      aria-checked={checked}
      tabIndex={0}
      onClick={onClick}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(e as unknown as React.MouseEvent) } }}
      className={cn(
        'relative inline-flex h-4 w-7 flex-shrink-0 cursor-pointer items-center rounded-full transition-colors',
        checked ? 'bg-[var(--accent)]' : 'bg-[var(--border-strong)]',
      )}
    >
      <span className={cn(
        'inline-block h-3 w-3 transform rounded-full bg-[var(--accent-foreground)] transition-transform',
        checked ? 'translate-x-3.5' : 'translate-x-0.5',
      )} />
    </span>
  )
}

export function ChatInput({
  onSend,
  onStop,
  isLoading,
  disabled,
  sessionId,
  models = [],
  selectedModelId,
  onModelChange,
  skills = [],
  onToggleSkillEnabled,
  mcpServers = [],
  onToggleMcpEnabled,
  plan,
}: ChatInputProps) {
  const [value, setValue] = useState('')
  const [attachments, setAttachments] = useState<AttachmentFile[]>([])
  const [showSkills, setShowSkills] = useState(false)
  const [showMcp, setShowMcp] = useState(false)
  const [showModels, setShowModels] = useState(false)
  const [commands, setCommands] = useState<SlashCommandMeta[]>([])
  const [menuIndex, setMenuIndex] = useState(0)
  // A picked command sits as a pill above the textarea; the textarea then holds
  // supplementary info (target address, etc). Sent together on submit.
  const [selectedCommand, setSelectedCommand] = useState<SlashCommandMeta | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const prevLoadingRef = useRef(isLoading)
  const skillsRef = useRef<HTMLDivElement>(null)
  const mcpRef = useRef<HTMLDivElement>(null)
  const modelsRef = useRef<HTMLDivElement>(null)

  // Load the slash-command catalog once (names/labels/descriptions only).
  useEffect(() => {
    api.chat.slashCommands().then(r => setCommands(r.commands)).catch(() => {})
  }, [])

  // The completion menu is active when the input is a bare `/token` (no space
  // yet) — i.e. the user is still picking a command. We match by name or label.
  const menuQuery = useMemo(() => {
    const m = /^\/([^\s]*)$/.exec(value)
    return m ? m[1].toLowerCase() : null
  }, [value])
  const filteredCommands = useMemo(() => {
    if (menuQuery === null) return []
    if (!menuQuery) return commands
    return commands.filter(
      c => c.name.toLowerCase().includes(menuQuery) || c.label.toLowerCase().includes(menuQuery),
    )
  }, [commands, menuQuery])
  const menuOpen = menuQuery !== null && filteredCommands.length > 0
  useEffect(() => { setMenuIndex(0) }, [menuQuery])

  useEffect(() => {
    if (prevLoadingRef.current && !isLoading) {
      textareaRef.current?.focus()
    }
    prevLoadingRef.current = isLoading
  }, [isLoading])

  // Close popovers on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (skillsRef.current && !skillsRef.current.contains(e.target as Node)) setShowSkills(false)
      if (mcpRef.current && !mcpRef.current.contains(e.target as Node)) setShowMcp(false)
      if (modelsRef.current && !modelsRef.current.contains(e.target as Node)) setShowModels(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const handleSend = useCallback(() => {
    const text = value.trim()
    // With a command pill, send `/name <supplementary text>`; the backend
    // injects the real prompt and appends the extra text as 补充说明.
    // Without a pill, send the raw text as before.
    if (selectedCommand) {
      if (isLoading || disabled) return
      const payload = text ? `/${selectedCommand.name} ${text}` : `/${selectedCommand.name}`
      onSend(payload, attachments.length > 0 ? attachments : undefined)
    } else {
      if (!text || isLoading || disabled) return
      onSend(text, attachments.length > 0 ? attachments : undefined)
    }
    setValue('')
    setAttachments([])
    setSelectedCommand(null)
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }, [value, isLoading, disabled, onSend, attachments, selectedCommand])

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Completion-menu navigation takes priority over send/newline.
    if (menuOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMenuIndex(i => (i + 1) % filteredCommands.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMenuIndex(i => (i - 1 + filteredCommands.length) % filteredCommands.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const picked = filteredCommands[menuIndex]
        if (picked) pickCommand(picked)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setValue('')
        return
      }
    }
    // Backspace on an empty textarea removes the command pill.
    if (e.key === 'Backspace' && !value && selectedCommand) {
      e.preventDefault()
      setSelectedCommand(null)
      return
    }
    // 输入法 composing 期间（例如中文选词），Enter 用于确认候选词，绝对不能发送。
    // composing 结束后，普通 Enter 直接发送；Shift+Enter 换行；Ctrl/Cmd+Enter 也发送（肌肉记忆）。
    if (e.key === 'Enter') {
      // IME 正在组合输入 —— 让浏览器/输入法自行处理，不拦截。
      if (e.nativeEvent.isComposing || e.keyCode === 229) return
      // Shift+Enter 插入换行（textarea 默认行为，放行）
      if (e.shiftKey) return
      // 普通 Enter 或 Ctrl/Cmd+Enter —— 发送
      e.preventDefault()
      handleSend()
    }
  }

  // Selecting a command turns it into a pill above the textarea — it is NOT
  // sent yet, so the user can add a target address or other details first.
  const pickCommand = (c: SlashCommandMeta) => {
    if (isLoading || disabled) return
    setSelectedCommand(c)
    setValue('')
    const el = textareaRef.current
    if (el) {
      el.style.height = 'auto'
      requestAnimationFrame(() => el.focus())
    }
  }

  const handleInput = () => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    const newAttachments = files.map(f => ({
      id: crypto.randomUUID(),
      name: f.name,
      size: f.size,
      file: f,
    }))
    setAttachments(prev => [...prev, ...newAttachments])
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const removeAttachment = (id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id))
  }

  const enabledSkillCount = skills.filter(s => s.enabled).length
  const enabledMcpCount = mcpServers.filter(s => s.enabled).length

  return (
    <div className="border-t border-[var(--border)] bg-[var(--bg-base)] px-4 py-3">
      <div className="max-w-4xl mx-auto">
        {/* 快捷指令 chips：点击即发送对应 /命令，真实提示词由后端注入 */}
        {!value.trim() && attachments.length === 0 && !isLoading && !selectedCommand && commands.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {commands.map(c => {
              const visual = COMMAND_VISUALS[c.name] ?? DEFAULT_VISUAL
              const Icon = visual.icon
              return (
                <button
                  key={c.name}
                  type="button"
                  onClick={() => pickCommand(c)}
                  title={`/${c.name} · ${c.description}`}
                  className={cn(
                    'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs',
                    'border transition-colors',
                    'border-[var(--border)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
                  )}
                >
                  <Icon size={13} className={visual.accent} />
                  <span className="whitespace-nowrap">{c.label}</span>
                </button>
              )
            })}
          </div>
        )}

        {/* Attachment preview chips */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {attachments.map(a => (
              <div
                key={a.id}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[var(--bg-surface)] border border-[var(--border)] text-xs text-[var(--text-secondary)]"
              >
                <Paperclip size={10} className="text-[var(--text-muted)]" />
                <span className="truncate max-w-[120px]">{a.name}</span>
                <span className="text-[var(--text-muted)]">{formatFileSize(a.size)}</span>
                <button
                  onClick={() => removeAttachment(a.id)}
                  className="ml-0.5 p-0.5 rounded hover:bg-[var(--bg-hover)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                >
                  <X size={10} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Slash-command completion menu — opens while typing a bare /token. */}
        {menuOpen && (
          <div className="relative">
            <div className="absolute bottom-1 left-0 w-[320px] max-w-full rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] shadow-xl z-50 overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-150">
              <div className="px-3 py-2 border-b border-[var(--border)] flex items-center gap-1.5">
                <Terminal size={12} className="text-[var(--text-muted)]" />
                <span className="text-[11px] font-medium text-[var(--text-muted)] uppercase tracking-wider">命令</span>
                <span className="ml-auto text-[10px] text-[var(--text-placeholder)]">↑↓ 选择 · Enter 发送</span>
              </div>
              <div className="max-h-[260px] overflow-y-auto py-1">
                {filteredCommands.map((c, i) => {
                  const visual = COMMAND_VISUALS[c.name] ?? DEFAULT_VISUAL
                  const Icon = visual.icon
                  return (
                    <button
                      key={c.name}
                      type="button"
                      onMouseEnter={() => setMenuIndex(i)}
                      onClick={() => pickCommand(c)}
                      className={cn(
                        'w-full flex items-start gap-2.5 px-3 py-2 text-left transition-colors',
                        i === menuIndex ? 'bg-[var(--accent)]/10' : 'hover:bg-[var(--bg-hover)]',
                      )}
                    >
                      <Icon size={14} className={cn('mt-0.5 flex-shrink-0', visual.accent)} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-medium text-[var(--text-primary)] truncate">{c.label}</span>
                          <span className="text-[10px] text-[var(--text-muted)] font-mono">/{c.name}</span>
                        </div>
                        <div className="text-[10px] text-[var(--text-muted)] line-clamp-1 leading-tight mt-0.5">{c.description}</div>
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        )}

        {/* Main input container */}
        <div
          className={cn(
            'relative flex flex-col rounded-2xl border border-[var(--border-strong)] bg-[var(--bg-surface)]',
            'shadow-sm transition-all',
            'focus-within:ring-1 focus-within:ring-[var(--accent)]/20 focus-within:border-[var(--accent)]/40',
          )}
        >
          {/* Command pill — picked command awaiting supplementary info */}
          {selectedCommand && (() => {
            const visual = COMMAND_VISUALS[selectedCommand.name] ?? DEFAULT_VISUAL
            const Icon = visual.icon
            return (
              <div className="flex items-center gap-1.5 px-4 pt-3">
                <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs border border-[var(--accent)]/40 bg-[var(--accent)]/10 text-[var(--text-primary)]">
                  <Icon size={12} className={visual.accent} />
                  <span className="whitespace-nowrap font-medium">{selectedCommand.label}</span>
                  <span className="text-[10px] text-[var(--text-muted)] font-mono">/{selectedCommand.name}</span>
                  <button
                    type="button"
                    onClick={() => { setSelectedCommand(null); textareaRef.current?.focus() }}
                    className="ml-0.5 p-0.5 rounded hover:bg-[var(--bg-hover)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                    title="移除命令"
                  >
                    <X size={11} />
                  </button>
                </span>
              </div>
            )
          })()}

          {/* Agent plan notes — shown above the textarea when available */}
          <TaskList plan={plan ?? null} />

          {/* Textarea */}
          <textarea
            ref={textareaRef}
            value={value}
            onChange={e => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onInput={handleInput}
            placeholder={
              isLoading
                ? '正在处理中...'
                : selectedCommand
                  ? '补充目标地址等信息（可留空），Enter 发送'
                  : '输入消息... (Enter 发送, Shift+Enter 换行)'
            }
            disabled={disabled || isLoading}
            rows={1}
            className={cn(
              'flex-1 resize-none bg-transparent border-0',
              'px-4 pt-3 pb-1 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)]',
              'focus:outline-none focus:ring-0',
              'disabled:opacity-50 disabled:cursor-not-allowed',
              'min-h-[24px] max-h-[320px] leading-relaxed',
            )}
          />

          {/* Toolbar */}
          <div className="flex items-center gap-1.5 px-3 py-2 border-t border-[var(--border)]/50">
            {/* Left: Attach + Skills + MCP */}
            <div className="flex items-center gap-1 shrink-0">
              {/* Attach */}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors text-xs"
                title="上传附件"
              >
                <Paperclip size={14} />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                onChange={handleFileSelect}
                className="hidden"
              />

              {/* Skills dropdown — 全局启用/禁用开关 */}
              {skills.length > 0 && (
                <div ref={skillsRef} className="relative">
                  <button
                    type="button"
                    onClick={() => { setShowSkills(!showSkills); setShowMcp(false); setShowModels(false) }}
                    className={cn(
                      'flex items-center gap-1 px-2 py-1.5 rounded-lg transition-colors text-xs',
                      showSkills
                        ? 'text-[var(--accent)] bg-[var(--accent)]/10'
                        : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
                    )}
                    title="启用/禁用 Skills"
                  >
                    <Sparkles size={14} />
                    <span>Skills</span>
                    <span className="ml-0.5 text-[10px] bg-[var(--bg-badge)] text-[var(--text-muted)] rounded px-1">{enabledSkillCount}/{skills.length}</span>
                  </button>
                  {showSkills && (
                    <div className="absolute bottom-full left-0 mb-2 w-[280px] rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] shadow-xl z-50 animate-in fade-in slide-in-from-bottom-2 duration-150">
                      <div className="px-3 py-2 border-b border-[var(--border)] flex items-center justify-between">
                        <span className="text-[11px] font-medium text-[var(--text-muted)] uppercase tracking-wider">Skills</span>
                        <span className="text-[10px] text-[var(--text-placeholder)]">全局启用 · 即时生效</span>
                      </div>
                      <div className="max-h-[280px] overflow-y-auto py-1">
                        {skills.map(s => (
                          <div
                            key={s.name}
                            className="w-full flex items-start gap-2.5 px-3 py-2 hover:bg-[var(--bg-hover)] transition-colors"
                          >
                            <div className="min-w-0 flex-1">
                              <div className={cn('text-xs font-medium truncate', s.enabled ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]')}>{s.name}</div>
                              <div className="text-[10px] text-[var(--text-muted)] line-clamp-2 leading-tight mt-0.5">{s.description}</div>
                            </div>
                            <div className="mt-0.5">
                              <Switch
                                checked={s.enabled}
                                onClick={e => { e.stopPropagation(); onToggleSkillEnabled?.(s.name, !s.enabled) }}
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* MCP dropdown — 全局启用/禁用开关 */}
              {mcpServers.length > 0 && (
                <div ref={mcpRef} className="relative">
                  <button
                    type="button"
                    onClick={() => { setShowMcp(!showMcp); setShowSkills(false); setShowModels(false) }}
                    className={cn(
                      'flex items-center gap-1 px-2 py-1.5 rounded-lg transition-colors text-xs',
                      showMcp
                        ? 'text-[var(--accent)] bg-[var(--accent)]/10'
                        : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
                    )}
                    title="启用/禁用 MCP Servers"
                  >
                    <Plug size={14} />
                    <span>MCP</span>
                    <span className="ml-0.5 text-[10px] bg-[var(--bg-badge)] text-[var(--text-muted)] rounded px-1">{enabledMcpCount}/{mcpServers.length}</span>
                  </button>
                  {showMcp && (
                    <div className="absolute bottom-full left-0 mb-2 w-[240px] rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] shadow-xl z-50 animate-in fade-in slide-in-from-bottom-2 duration-150">
                      <div className="px-3 py-2 border-b border-[var(--border)] flex items-center justify-between">
                        <span className="text-[11px] font-medium text-[var(--text-muted)] uppercase tracking-wider">MCP Servers</span>
                        <span className="text-[10px] text-[var(--text-placeholder)]">全局启用 · 即时生效</span>
                      </div>
                      <div className="max-h-[220px] overflow-y-auto py-1">
                        {mcpServers.map(s => (
                          <div
                            key={s.name}
                            className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-[var(--bg-hover)] transition-colors"
                          >
                            <span className={cn('text-xs flex-1 truncate', s.enabled ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]')}>{s.name}</span>
                            <Switch
                              checked={s.enabled}
                              onClick={e => { e.stopPropagation(); onToggleMcpEnabled?.(s.name, !s.enabled) }}
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

            </div>

            {/* Right: Context ring + Model selector + Send/Stop */}
            <div className="flex items-center gap-1.5 shrink-0 ml-auto">
              {sessionId && <ContextRing sessionId={sessionId} isLoading={isLoading} />}
              {/* Model selector */}
              {models.length > 0 && onModelChange && (
                <div ref={modelsRef} className="relative">
                  <button
                    type="button"
                    onClick={() => { setShowModels(!showModels); setShowSkills(false); setShowMcp(false) }}
                    className={cn(
                      'flex items-center gap-1 px-2 py-1.5 rounded-lg transition-colors text-xs',
                      'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
                      showModels && 'bg-[var(--bg-hover)] text-[var(--text-secondary)]',
                    )}
                    title="选择模型"
                  >
                    <Cpu size={14} />
                    <span className="max-w-[120px] truncate">
                      {models.find(m => m.id === selectedModelId)?.name || '模型'}
                    </span>
                  </button>
                  {showModels && (
                    <div className="absolute bottom-full right-0 mb-2 w-[240px] rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] shadow-xl z-50 animate-in fade-in slide-in-from-bottom-2 duration-150">
                      <div className="px-3 py-2 border-b border-[var(--border)]">
                        <span className="text-[11px] font-medium text-[var(--text-muted)] uppercase tracking-wider">Model</span>
                      </div>
                      <div className="max-h-[260px] overflow-y-auto py-1">
                        {models.map(m => {
                          const isActive = m.id === selectedModelId
                          return (
                            <button
                              key={m.id}
                              onClick={() => { onModelChange(m.id); setShowModels(false) }}
                              className={cn(
                                'w-full flex items-center gap-2 px-3 py-2 hover:bg-[var(--bg-hover)] transition-colors text-left',
                                isActive && 'bg-[var(--accent)]/8',
                              )}
                            >
                              <div className="min-w-0 flex-1">
                                <div className={cn(
                                  'text-xs truncate',
                                  isActive ? 'text-[var(--text-primary)] font-medium' : 'text-[var(--text-secondary)]',
                                )}>
                                  {m.name}
                                </div>
                                {m.provider && (
                                  <div className="text-[10px] text-[var(--text-muted)] mt-0.5">{m.provider}</div>
                                )}
                              </div>
                              {isActive && (
                                <div className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] flex-shrink-0" />
                              )}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Send / Stop button */}
              <button
                type="button"
                onClick={isLoading ? onStop : handleSend}
                disabled={!isLoading && ((!value.trim() && !selectedCommand) || disabled)}
                className={cn(
                  'flex items-center justify-center gap-1.5 rounded-xl px-3 py-1.5 text-[13px] font-medium',
                  'transition-all duration-200 disabled:opacity-30 disabled:cursor-not-allowed',
                  isLoading
                    ? 'bg-[var(--danger)]/10 text-[var(--danger)] hover:bg-[var(--danger)]/20 border border-[var(--danger)]/20'
                    : 'bg-[var(--accent)] hover:opacity-90 text-[var(--accent-foreground)]',
                )}
              >
                {isLoading ? (
                  <>
                    <Square size={12} fill="currentColor" />
                    <span>停止</span>
                  </>
                ) : (
                  <>
                    <Send size={13} />
                    <span>发送</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Bottom disclaimer */}
        <div className="text-center mt-2 flex items-center justify-center gap-2">
          <span className="text-[10px] text-[var(--text-muted)]">
            <kbd className="px-1 py-0.5 rounded border border-[var(--border)] bg-[var(--bg-surface)] text-[9px] font-mono">↵</kbd>
            <span className="ml-1">发送</span>
            <span className="mx-2 opacity-40">·</span>
            <kbd className="px-1 py-0.5 rounded border border-[var(--border)] bg-[var(--bg-surface)] text-[9px] font-mono">Shift + ↵</kbd>
            <span className="ml-1">换行</span>
          </span>
          <span className="text-[10px] text-[var(--text-muted)] opacity-60">Hack for fun.</span>
        </div>
      </div>
    </div>
  )
}
