import { useState, useCallback } from 'react'
import { Copy, Check } from 'lucide-react'

interface CodeBlockProps {
  code: string
  language?: string
}

export function CodeBlock({ code, language = '' }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* ignore */ }
  }, [code])

  const lines = code.split('\n')

  return (
    <div className="rounded-lg border border-[var(--border)] overflow-hidden my-2 bg-[#f6f8fa] dark:bg-[#0d1117]">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#eaeef2] border-b border-[var(--border)] dark:bg-[#161b22]">
        <span className="text-[11px] text-[#57606a] font-mono uppercase dark:text-[#8b949e]">{language || 'code'}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 text-[11px] text-[#57606a] hover:text-[#1f2328] transition-colors dark:text-[#8b949e] dark:hover:text-white"
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      {/* Code */}
      <div className="overflow-x-auto">
        <div className="flex">
          {/* Line numbers */}
          <div className="flex-shrink-0 py-3 px-2 text-right select-none bg-[#f6f8fa] border-r border-[#d8dee4] dark:bg-[#0d1117] dark:border-[#21262d]">
            {lines.map((_, i) => (
              <div key={i} className="text-[12px] leading-5 text-[#8c959f] font-mono dark:text-[#484f58]">
                {i + 1}
              </div>
            ))}
          </div>
          {/* Code content */}
          <div className="flex-1 py-3 px-3 overflow-x-auto">
            <pre className="text-[13px] leading-5 text-[#1f2328] font-mono whitespace-pre dark:text-[#e6edf3]">
              <code>{code}</code>
            </pre>
          </div>
        </div>
      </div>
    </div>
  )
}
