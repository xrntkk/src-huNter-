import { useState } from 'react'
import { Cpu, Puzzle, BookOpen, Bot, Search } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '~/components/ui/dialog'
import { cn } from '~/lib/utils'
import { LLMSettingsPage } from '~/routes/settings-llm'
import { MCPSettingsPage } from '~/routes/settings-mcp'
import { IntelSettingsPage } from '~/routes/settings-intel'
import { SkillsSettingsPage } from '~/routes/settings-skills'
import { AgentsSettingsPage } from '~/routes/settings-agents'

type TabKey = 'llm' | 'mcp' | 'intel' | 'skills' | 'agents'

const TABS: Array<{ key: TabKey; label: string; icon: typeof Cpu }> = [
  { key: 'llm', label: 'LLM 模型', icon: Cpu },
  { key: 'mcp', label: 'MCP 服务', icon: Puzzle },
  { key: 'intel', label: '信息收集', icon: Search },
  { key: 'skills', label: 'Skills', icon: BookOpen },
  { key: 'agents', label: '子 Agent', icon: Bot },
]

interface SettingsModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SettingsModal({ open, onOpenChange }: SettingsModalProps) {
  const [tab, setTab] = useState<TabKey>('llm')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton
        className="max-w-5xl h-[85vh] p-0 gap-0 overflow-hidden grid-cols-[16rem_1fr] grid-rows-1"
      >
        <DialogTitle className="sr-only">设置</DialogTitle>

        {/* Sidebar */}
        <aside className="border-r border-[var(--border)] bg-[var(--bg-base)] flex flex-col">
          <div className="px-4 py-3.5 border-b border-[var(--border)] text-sm font-semibold">
            设置
          </div>
          <nav className="flex-1 px-2 py-3 space-y-0.5">
            {TABS.map(item => {
              const isActive = tab === item.key
              return (
                <button
                  key={item.key}
                  onClick={() => setTab(item.key)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-all group',
                    isActive
                      ? 'bg-[var(--accent)] text-[var(--accent-foreground)] font-medium'
                      : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
                  )}
                >
                  <item.icon size={15} className={cn(
                    'transition-colors',
                    isActive ? 'text-[var(--accent-foreground)]' : 'text-[var(--text-muted)] group-hover:text-[var(--text-primary)]',
                  )} />
                  {item.label}
                </button>
              )
            })}
          </nav>
        </aside>

        {/* Content */}
        <main className="min-w-0 overflow-y-auto custom-scrollbar bg-[var(--bg-base)]">
          <div className="px-8 py-8">
            {tab === 'llm' && <LLMSettingsPage />}
            {tab === 'mcp' && <MCPSettingsPage />}
            {tab === 'intel' && <IntelSettingsPage />}
            {tab === 'skills' && <SkillsSettingsPage />}
            {tab === 'agents' && <AgentsSettingsPage />}
          </div>
        </main>
      </DialogContent>
    </Dialog>
  )
}
