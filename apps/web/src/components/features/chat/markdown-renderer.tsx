import React, { memo, useState, useEffect, useRef } from 'react'
import { CodeBlock } from './code-block'
import { cn } from '~/lib/utils'

/**
 * Throttles value updates — returns the latest value at most once per `delay` ms.
 * During streaming this prevents re-parsing markdown on every chunk.
 */
function useThrottledValue<T>(value: T, delay: number): T {
  const [throttled, setThrottled] = useState(value)
  const lastExecuted = useRef(Date.now())

  useEffect(() => {
    const now = Date.now()
    const elapsed = now - lastExecuted.current

    if (elapsed >= delay) {
      lastExecuted.current = now
      setThrottled(value)
    } else {
      const timer = setTimeout(() => {
        lastExecuted.current = Date.now()
        setThrottled(value)
      }, delay - elapsed)
      return () => clearTimeout(timer)
    }
  }, [value, delay])

  return throttled
}

interface MarkdownRendererProps {
  content: string
  className?: string
}

/**
 * Simple markdown parser for bolt.diy-style rendering.
 * Supports: headings, bold, italic, code inline, code blocks, lists, links, paragraphs, tables, images
 *
 * PERFORMANCE: useThrottledValue throttles re-parses to ~5/sec during streaming
 *             React.memo skips re-renders when content hasn't changed
 */
export const MarkdownRenderer = memo(function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
  // Throttle content updates during streaming: parse at most once per 200ms
  const throttledContent = useThrottledValue(content, 200)

  const blocks = parseMarkdown(throttledContent)

  return (
    <div className={cn('space-y-1', className)}>
      {blocks.map((block, i) => (
        <BlockElement key={i} block={block} />
      ))}
    </div>
  )
})

interface Block {
  type: 'heading' | 'paragraph' | 'code' | 'list' | 'blockquote' | 'divider' | 'table' | 'image'
  content?: string
  level?: number
  language?: string
  items?: string[]
  rows?: string[][]
  src?: string
  alt?: string
}

function parseMarkdown(text: string): Block[] {
  const lines = text.split('\n')
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Divider
    if (/^---+$/.test(line.trim()) || /^\*\*\*+$/.test(line.trim())) {
      blocks.push({ type: 'divider' })
      i++
      continue
    }

    // Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/)
    if (headingMatch) {
      blocks.push({ type: 'heading', level: headingMatch[1].length, content: headingMatch[2] })
      i++
      continue
    }

    // Code block
    const codeStart = line.match(/^```(\w*)/)
    if (codeStart) {
      const language = codeStart[1] || ''
      let code = ''
      i++
      while (i < lines.length && !lines[i].startsWith('```')) {
        code += lines[i] + '\n'
        i++
      }
      blocks.push({ type: 'code', language, content: code.slice(0, -1) })
      i++ // skip closing ```
      continue
    }

    // Image: ![alt](url)
    const imgMatch = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/)
    if (imgMatch) {
      blocks.push({ type: 'image', alt: imgMatch[1], src: imgMatch[2] })
      i++
      continue
    }

    // Table
    if (isTableLine(line)) {
      const rows: string[][] = []
      // Header row
      rows.push(parseTableRow(line))
      i++
      // Separator row (skip)
      if (i < lines.length && isTableLine(lines[i]) && lines[i].includes('---')) {
        i++
      }
      // Data rows
      while (i < lines.length && isTableLine(lines[i])) {
        rows.push(parseTableRow(lines[i]))
        i++
      }
      blocks.push({ type: 'table', rows })
      continue
    }

    // List
    if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && (/^\s*[-*+]\s+/.test(lines[i]) || /^\s*\d+\.\s+/.test(lines[i]))) {
        items.push(lines[i].replace(/^\s*[-*+\d.]\s+/, ''))
        i++
      }
      blocks.push({ type: 'list', items })
      continue
    }

    // Blockquote
    if (line.startsWith('> ')) {
      let quote = ''
      while (i < lines.length && lines[i].startsWith('> ')) {
        quote += lines[i].slice(2) + '\n'
        i++
      }
      blocks.push({ type: 'blockquote', content: quote.trim() })
      continue
    }

    // Empty line - skip
    if (line.trim() === '') {
      i++
      continue
    }

    // Paragraph (accumulate until empty line)
    let para = ''
    while (i < lines.length && lines[i].trim() !== '') {
      para += lines[i] + ' '
      i++
    }
    blocks.push({ type: 'paragraph', content: para.trim() })
  }

  return blocks
}

function isTableLine(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('|') && trimmed.endsWith('|')
}

function parseTableRow(line: string): string[] {
  return line
    .trim()
    .slice(1, -1) // remove leading/trailing |
    .split('|')
    .map(cell => cell.trim())
}

function BlockElement({ block }: { block: Block }) {
  switch (block.type) {
    case 'heading':
      return (
        <h3
          className={cn(
            'font-semibold text-[var(--text-primary)] mt-3 mb-1',
            block.level === 1 && 'text-lg',
            block.level === 2 && 'text-base',
            block.level && block.level >= 3 && 'text-sm',
          )}
        >
          {block.content}
        </h3>
      )

    case 'code':
      return <CodeBlock code={block.content || ''} language={block.language} />

    case 'table':
      if (!block.rows || block.rows.length === 0) return null
      return (
        <div className="overflow-x-auto my-2">
          <table className="w-full text-sm text-[var(--text-secondary)] border border-[var(--border)] rounded-lg overflow-hidden">
            <thead>
              <tr className="bg-[var(--bg-hover)] border-b border-[var(--border)]">
                {block.rows[0].map((cell, j) => (
                  <th key={j} className="px-3 py-2 text-left text-xs font-semibold text-[var(--text-primary)]">
                    {renderInline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.slice(1).map((row, ri) => (
                <tr key={ri} className="border-b border-[var(--border)] last:border-b-0 hover:bg-[var(--bg-hover)]/50 transition-colors">
                  {row.map((cell, ci) => (
                    <td key={ci} className="px-3 py-2 text-xs">
                      {renderInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )

    case 'list':
      return (
        <ul className="space-y-0.5 py-1">
          {block.items?.map((item, j) => (
            <li key={j} className="flex items-start gap-2 text-sm text-[var(--text-secondary)]">
              <span className="text-[var(--accent)] mt-1.5 flex-shrink-0 w-1 h-1 rounded-full bg-[var(--accent)]" />
              <span className="leading-relaxed">{renderInline(item)}</span>
            </li>
          ))}
        </ul>
      )

    case 'blockquote':
      return (
        <div className="border-l-2 border-[var(--accent)] pl-3 py-1 my-2 bg-[var(--accent)]/5 rounded-r-md">
          <p className="text-sm text-[var(--text-secondary)] italic leading-relaxed">
            {block.content}
          </p>
        </div>
      )

    case 'divider':
      return <hr className="border-[var(--border)] my-3" />

    case 'image':
      return (
        <div className="my-2">
          <img
            src={block.src}
            alt={block.alt || ''}
            className="max-w-full rounded-lg border border-[var(--border)]"
            loading="lazy"
            onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
          />
        </div>
      )

    case 'paragraph':
    default:
      return (
        <p className="text-sm text-[var(--text-secondary)] leading-relaxed py-0.5">
          {renderInline(block.content || '')}
        </p>
      )
  }
}

/**
 * Render inline markdown: bold, italic, inline code, links
 */
function renderInline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  let key = 0

  const tokens: Array<{ type: 'text' | 'bold' | 'italic' | 'code' | 'link'; content: string; url?: string; index: number; len: number }> = []

  const patterns = [
    { regex: /\*\*\*(.+?)\*\*\*/g, type: 'bold' as const },
    { regex: /\*\*(.+?)\*\*/g, type: 'bold' as const },
    { regex: /\*(.+?)\*/g, type: 'italic' as const },
    { regex: /`(.+?)`/g, type: 'code' as const },
    { regex: /\[([^\]]+)\]\(([^)]+)\)/g, type: 'link' as const },
  ]

  for (const p of patterns) {
    let match
    const regex = new RegExp(p.regex.source, 'g')
    while ((match = regex.exec(text)) !== null) {
      tokens.push({ type: p.type, content: match[1], url: match[2], index: match.index, len: match[0].length })
    }
  }

  // Sort by index, remove overlaps
  tokens.sort((a, b) => a.index - b.index)
  const filtered: typeof tokens = []
  let lastEnd = -1
  for (const t of tokens) {
    if (t.index >= lastEnd) {
      filtered.push(t)
      lastEnd = t.index + t.len
    }
  }

  let pos = 0
  for (const t of filtered) {
    if (t.index > pos) {
      parts.push(<span key={key++}>{text.slice(pos, t.index)}</span>)
    }

    switch (t.type) {
      case 'bold':
        parts.push(
          <strong key={key++} className="font-semibold text-[var(--text-primary)]">
            {t.content}
          </strong>,
        )
        break
      case 'italic':
        parts.push(<em key={key++}>{t.content}</em>)
        break
      case 'code':
        parts.push(
          <code
            key={key++}
            className="px-1 py-0.5 rounded bg-[var(--bg-surface)] text-[var(--accent)] text-xs font-mono border border-[var(--border)]"
          >
            {t.content}
          </code>,
        )
        break
      case 'link':
        parts.push(
          <a
            key={key++}
            href={t.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--accent)] hover:underline"
          >
            {t.content}
          </a>,
        )
        break
      default:
        parts.push(<span key={key++}>{t.content}</span>)
    }

    pos = t.index + t.len
  }

  if (pos < text.length) {
    parts.push(<span key={key++}>{text.slice(pos)}</span>)
  }

  return parts.length > 0 ? parts : [text]
}
