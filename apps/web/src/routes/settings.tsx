import { Outlet, useNavigate, useLocation, NavLink } from 'react-router'
import {
  ArrowLeft, Cpu, Puzzle, BookOpen, Bot, Settings, Search, SlidersHorizontal,
} from 'lucide-react'
import { ThemeToggle } from '~/components/ui/theme-toggle'
import { cn } from '~/lib/utils'

const NAV_ITEMS = [
  { path: '/settings', label: 'LLM 模型', icon: Cpu },
  { path: '/settings/mcp', label: 'MCP 服务', icon: Puzzle },
  { path: '/settings/intel', label: '信息收集', icon: Search },
  { path: '/settings/skills', label: 'Skills', icon: BookOpen },
  { path: '/settings/agents', label: '子 Agent', icon: Bot },
  { path: '/settings/general', label: '通用', icon: SlidersHorizontal },
]

export function SettingsLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const backTo = (location.state as { from?: string } | null)?.from ?? '/'

  return (
    <div className="flex h-screen bg-[var(--bg-base)] text-[var(--text-primary)]">
      {/* Sidebar */}
      <aside className="w-64 flex-shrink-0 border-r border-[var(--border)] bg-[var(--bg-base)] flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border)]">
          <button
            onClick={() => navigate(backTo)}
            className="rounded-lg p-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
            title="返回桌面"
          >
            <ArrowLeft size={16} />
          </button>
          <Settings size={16} className="text-[var(--text-primary)]" />
          <h1 className="text-sm font-semibold">Settings</h1>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-2 py-3 space-y-0.5">
          {NAV_ITEMS.map(item => {
            const isActive = location.pathname === item.path ||
              (item.path !== '/settings' && location.pathname.startsWith(item.path))
            return (
              <NavLink
                key={item.path}
                to={item.path}
                state={{ from: backTo }}
                end={item.path === '/settings'}
                className={cn(
                  'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-all group',
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
              </NavLink>
            )
          })}
        </nav>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-[var(--border)]">
          <ThemeToggle className="w-8 h-8" size={15} />
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 min-w-0 overflow-y-auto custom-scrollbar">
        <div className="max-w-3xl mx-auto px-8 py-8">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
