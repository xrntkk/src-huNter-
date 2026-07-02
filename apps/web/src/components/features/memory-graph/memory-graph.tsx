import { useEffect, useMemo, useState, useCallback } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MarkerType,
  useReactFlow,
  type Node,
  type Edge,
  type NodeMouseHandler,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { X } from 'lucide-react'
import { layoutFlowElements } from '~/lib/elk-layout'
import { MemoryNode } from './memory-node'
import { MarkdownRenderer } from '~/components/features/chat/markdown-renderer'
import { useTheme } from '~/contexts/theme-context'

export interface MemoryGraphNode {
  id: string
  type: string
  data: Record<string, unknown>
}

export interface MemoryGraphEdge {
  id: string
  source: string
  target: string
  label?: string
}

interface MemoryGraphProps {
  nodes: MemoryGraphNode[]
  edges: MemoryGraphEdge[]
}

const NODE_TYPES = { memory: MemoryNode }

function FitViewOnChange({ version }: { version: number }) {
  const { fitView } = useReactFlow()
  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      requestAnimationFrame(() => fitView({ padding: 0.15, duration: 200 })),
    )
    return () => cancelAnimationFrame(frame)
  }, [fitView, version])
  return null
}

export function MemoryGraph({ nodes: rawNodes, edges: rawEdges }: MemoryGraphProps) {
  const [layouted, setLayouted] = useState<{ nodes: Node[]; edges: Edge[] }>({
    nodes: [],
    edges: [],
  })
  const [version, setVersion] = useState(0)
  const [selected, setSelected] = useState<MemoryGraphNode | null>(null)
  const { resolvedTheme } = useTheme()

  const isDark = resolvedTheme === 'dark'
  const edgeColor = '#6366f1'
  const labelTextColor = isDark ? '#9ca3af' : '#6b7280'
  const labelBgColor = isDark ? '#1a1d24' : '#f5f5f5'
  const bgDotColor = isDark ? '#2a2d35' : '#d8dade'

  const flowNodes: Node[] = useMemo(
    () =>
      rawNodes.map(n => ({
        id: n.id,
        type: n.type,
        position: { x: 0, y: 0 },
        data: { ...n.data },
      })),
    [rawNodes],
  )

  const flowEdges: Edge[] = useMemo(
    () =>
      rawEdges.map(e => ({
        id: e.id,
        source: e.source,
        target: e.target,
        label: e.label,
        labelStyle: { fill: labelTextColor, fontSize: 10 },
        labelBgStyle: { fill: labelBgColor },
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: edgeColor },
        style: { stroke: edgeColor, strokeWidth: 1.4 },
      })),
    [rawEdges, edgeColor, labelTextColor, labelBgColor],
  )

  const structureKey = useMemo(() => {
    const n = rawNodes.map(x => x.id).sort().join('|')
    const e = rawEdges.map(x => `${x.source}>${x.target}`).sort().join('|')
    return `${n}::${e}`
  }, [rawNodes, rawEdges])

  const handleNodeClick: NodeMouseHandler = useCallback(
    (_evt, node) => {
      const raw = rawNodes.find(n => n.id === node.id)
      if (raw) setSelected(raw)
    },
    [rawNodes],
  )

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') setSelected(null)
  }, [])

  useEffect(() => {
    if (!selected) return
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selected, handleKeyDown])

  useEffect(() => {
    let active = true
    layoutFlowElements(flowNodes, flowEdges, {
      direction: 'DOWN',
      nodeWidth: 260,
      nodeHeight: 90,
      spacing: 60,
      layerSpacing: 100,
    })
      .then(result => {
        if (!active) return
        const items = result.nodes as Node[]
        const allZero = items.length > 1 && items.every(n => n.position.x === 0 && n.position.y === 0)
        if (allZero) {
          const cols = Math.ceil(Math.sqrt(items.length))
          items.forEach((n, i) => {
            n.position = { x: (i % cols) * 320, y: Math.floor(i / cols) * 170 }
          })
        }
        setLayouted({ nodes: items, edges: result.edges as Edge[] })
        setVersion(v => v + 1)
      })
      .catch(() => {
        if (!active) return
        const cols = Math.ceil(Math.sqrt(flowNodes.length))
        const fallback = flowNodes.map((n, i) => ({
          ...n,
          position: { x: (i % cols) * 320, y: Math.floor(i / cols) * 170 },
        }))
        setLayouted({ nodes: fallback, edges: flowEdges })
        setVersion(v => v + 1)
      })
    return () => { active = false }
  }, [structureKey])

  if (rawNodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--text-muted)]">
        <div className="text-center space-y-2">
          <div>暂无记忆</div>
          <div className="text-xs text-[var(--text-placeholder)]">Agent 在探索中记录的洞察、教训与关联会显示在这里</div>
        </div>
      </div>
    )
  }

  return (
    <>
      <ReactFlow
        nodes={layouted.nodes}
        edges={layouted.edges}
        nodeTypes={NODE_TYPES}
        onNodeClick={handleNodeClick}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        nodesDraggable={false}
        nodesConnectable={false}
        minZoom={0.2}
        maxZoom={2}
        panOnScroll
        zoomOnScroll={false}
        proOptions={{ hideAttribution: true }}
        className="bg-[var(--bg-base)]"
      >
        <FitViewOnChange version={version} />
        <Background color={bgDotColor} gap={24} size={1} />
        <Controls
          position="bottom-right"
          showInteractive={false}
          className="rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] shadow-lg"
        />
      </ReactFlow>
      {selected && (
        <MemoryNodeDetail
          node={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  )
}

const KIND_LABEL: Record<string, string> = {
  note: '笔记',
  lesson: '经验',
  hypothesis: '假设',
  todo: '待办',
}

function MemoryNodeDetail({ node, onClose }: { node: MemoryGraphNode; onClose: () => void }) {
  const d = node.data as {
    kind?: string
    title?: string
    content?: string
  }
  const kind = String(d.kind ?? 'note')
  const title = String(d.title ?? '（无标题）')
  const content = String(d.content ?? '')

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 supports-backdrop-filter:backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="relative w-full max-w-2xl max-h-[80vh] flex flex-col rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] shadow-2xl"
      >
        <div className="flex items-center gap-2 px-5 py-3 border-b border-[var(--border)]">
          <span className="rounded border border-current/30 px-1.5 py-0.5 font-mono text-[10px] uppercase opacity-80 text-[var(--text-muted)]">
            {KIND_LABEL[kind] ?? kind}
          </span>
          <span className="text-xs text-[var(--text-placeholder)] font-mono truncate">
            {node.id}
          </span>
          <button
            onClick={onClose}
            className="ml-auto p-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-all"
            title="关闭 (Esc)"
          >
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
          <h3 className="text-base font-semibold text-[var(--text-primary)] mb-3 leading-snug">
            {title}
          </h3>
          {content ? (
            <div className="text-sm text-[var(--text-secondary)] leading-relaxed">
              <MarkdownRenderer content={content} />
            </div>
          ) : (
            <div className="text-xs text-[var(--text-placeholder)] italic">（无正文内容）</div>
          )}
        </div>
      </div>
    </div>
  )
}
