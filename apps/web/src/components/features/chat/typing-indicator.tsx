export function TypingIndicator() {
  return (
    <div className="flex items-center space-x-1.5 bg-[var(--bg-surface)] px-3 py-1.5 rounded-full">
      <span
        className="w-1.5 h-1.5 bg-[var(--text-muted)] rounded-full animate-bounce-dot"
        style={{ animationDelay: '0ms' }}
      />
      <span
        className="w-1.5 h-1.5 bg-[var(--text-muted)] rounded-full animate-bounce-dot"
        style={{ animationDelay: '75ms' }}
      />
      <span
        className="w-1.5 h-1.5 bg-[var(--text-muted)] rounded-full animate-bounce-dot"
        style={{ animationDelay: '150ms' }}
      />
    </div>
  )
}
