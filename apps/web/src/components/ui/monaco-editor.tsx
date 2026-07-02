import { useRef, useCallback, useEffect, useState } from 'react'
import Editor, { loader, type OnMount } from '@monaco-editor/react'

// Derive the editor instance type from OnMount's first param so we don't need
// a direct `monaco-editor` dependency (it's loaded at runtime via CDN).
type CodeEditor = Parameters<OnMount>[0]

// Configure Monaco loader to use CDN (avoids Vite worker bundling issues)
loader.config({
  paths: {
    vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs',
  },
})

function getLanguageFromFilename(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    py: 'python',
    java: 'java',
    go: 'go',
    rs: 'rust',
    c: 'c',
    cpp: 'cpp',
    h: 'cpp',
    php: 'php',
    rb: 'ruby',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    md: 'markdown',
    json: 'json',
    xml: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
    csv: 'plaintext',
    html: 'html',
    css: 'css',
    sql: 'sql',
    log: 'plaintext',
    txt: 'plaintext',
  }
  return map[ext] ?? 'plaintext'
}

interface MonacoEditorProps {
  value: string
  filename?: string
  onChange?: (value: string) => void
  onSave?: (value: string) => void
  readOnly?: boolean
  height?: string
  className?: string
}

export function MonacoEditor({
  value,
  filename = '',
  onChange,
  onSave,
  readOnly = false,
  height = '100%',
  className,
}: MonacoEditorProps) {
  const editorRef = useRef<CodeEditor | null>(null)
  const [theme, setTheme] = useState<'vs-dark' | 'vs'>('vs-dark')

  // Detect system color scheme
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    setTheme(mq.matches ? 'vs-dark' : 'vs')
    const handler = (e: MediaQueryListEvent) => setTheme(e.matches ? 'vs-dark' : 'vs')
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  // Also listen for class changes on documentElement ( Tailwind dark class )
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const isDark = document.documentElement.classList.contains('dark')
      setTheme(isDark ? 'vs-dark' : 'vs')
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  const handleMount: OnMount = useCallback(
    (ed, monacoInstance) => {
      editorRef.current = ed

      ed.addCommand(monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyS, () => {
        if (onSave) {
          onSave(ed.getValue())
        }
      })

      // Force initial layout calculation, then observe for future resizes
      requestAnimationFrame(() => ed.layout())
      const ro = new ResizeObserver(() => ed.layout())
      ro.observe(ed.getContainerDomNode())
    },
    [onSave],
  )

  const language = getLanguageFromFilename(filename)

  return (
    <div className={className} style={{ height }}>
      <Editor
        height="100%"
        language={language}
        value={value}
        theme={theme}
        onMount={handleMount}
        onChange={(v) => onChange?.(v ?? '')}
        options={{
          readOnly,
          minimap: { enabled: true, scale: 1 },
          fontSize: 13,
          fontFamily: "'JetBrains Mono', 'Fira Code', 'Consolas', monospace",
          lineNumbers: 'on',
          roundedSelection: false,
          scrollBeyondLastLine: false,
          automaticLayout: false,
          wordWrap: 'on',
          tabSize: 2,
          folding: true,
          renderWhitespace: 'selection',
          bracketPairColorization: { enabled: true },
          guides: { bracketPairs: true, indentation: true },
          padding: { top: 8 },
          scrollbar: {
            useShadows: false,
            verticalHasArrows: false,
            horizontalHasArrows: false,
            verticalScrollbarSize: 8,
            horizontalScrollbarSize: 8,
          },
        }}
        loading={
          <div className="flex items-center justify-center h-full text-xs text-[var(--text-muted)]">
            编辑器加载中...
          </div>
        }
      />
    </div>
  )
}

// Expose monaco for external use (e.g. adding custom commands)
export { loader as monacoLoader }
