import { Moon, Sun, Monitor } from 'lucide-react'
import { useTheme } from '~/contexts/theme-context'
import { cn } from '~/lib/utils'

interface ThemeToggleProps {
  className?: string
  size?: number
}

export function ThemeToggle({ className, size = 16 }: ThemeToggleProps) {
  const { theme, resolvedTheme, toggleTheme } = useTheme()

  const icon = theme === 'dark' ? <Moon size={size} /> :
               theme === 'light' ? <Sun size={size} /> :
               <Monitor size={size} />

  const label = theme === 'dark' ? '深色模式' :
                theme === 'light' ? '浅色模式' :
                '跟随系统'

  return (
    <button
      onClick={toggleTheme}
      className={cn(
        'rounded-lg flex items-center justify-center transition-all',
        'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]',
        className,
      )}
      title={`${label} (${resolvedTheme === 'dark' ? '当前深色' : '当前浅色'})`}
    >
      {icon}
    </button>
  )
}
