import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { layoutFlowElements } from '~/lib/elk-layout'
import { EndpointNode } from './endpoint-node'
import { FindingNode } from './finding-node'
import { GraphSidebar } from './graph-sidebar'
import { useTheme } from '~/contexts/theme-context'

export interface GraphNode {
  id: string
  type: 'domain' | 'endpoint' | 'finding'
  data: Record<string, unknown>
}

export interface GraphEdge {
  id: string
  source: string
  target: string
}

interface EndpointGraphProps {
  sessionId: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  selectedIds: string[]
  onSelectEndpoints: (ids: string[]) => void
}

const NODE_TYPES = {
  domain: EndpointNode,
  endpoint: EndpointNode,
  finding: FindingNode,
}

const NODE_W = 260
const NODE_H_DOMAIN = 44
const NODE_H_ENDPOINT = 88
const NODE_H_FINDING = 76

// Threshold beyond which per-host endpoint groups auto-collapse on first
// render. With ~1000 endpoints spread across hosts, rendering every node
// upfront overwhelms both ELK (layout seconds) and ReactFlow (DOM nodes).
// Collapsed groups render only the host domain node; clicking it expands
// the endpoints for that host on demand.
const COLLAPSE_THRESHOLD = 40
// Inter-block gap (px) between host clusters on the canvas. Wide enough
// that hosts read as visually separate clusters without wasted space.
const BLOCK_GAP_X = 120
const BLOCK_GAP_Y = 140

function nodeHeightFor(type: GraphNode['type']) {
  if (type === 'domain') return NODE_H_DOMAIN
  if (type === 'finding') return NODE_H_FINDING
  return NODE_H_ENDPOINT
}

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

export function EndpointGraph({
  sessionId,
  nodes: rawNodes,
  edges: rawEdges,
  selectedIds,
  onSelectEndpoints,
}: EndpointGraphProps) {
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({})
  const [version, setVersion] = useState(0)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  // Per-host collapse state. Hosts with >=1 selected endpoint are forced
  // expanded so the user can see what they picked without an extra click.
  const [collapsedHosts, setCollapsedHosts] = useState<Set<string>>(new Set())
  const [autoCollapsed, setAutoCollapsed] = useState(false)
  const { setCenter } = useReactFlow()
  const { resolvedTheme } = useTheme()
  const layoutRunRef = useRef(0)

  const edgeColor = resolvedTheme === 'dark' ? '#3c3c4a' : '#c2c5cc'
  const bgDotColor = resolvedTheme === 'dark' ? '#2a2d35' : '#d8dade'

  // Resolve endpoint → host map and finding → host.
  // Findings now carry their own `host` field (added server-side), so we
  // read it directly first. The edge-based reverse lookup remains as a
  // fallback for any older graph payloads that lack the field.
  const { endpointToHost, findingToHost, hostDomainNodes } = useMemo(() => {
    const epToHost = new Map<string, string>()
    const hostDomains = new Set<string>()
    for (const n of rawNodes) {
      if (n.type === 'endpoint') {
        const h = String((n.data as { host?: string }).host ?? '')
        if (h) epToHost.set(n.id, h)
      }
      if (n.type === 'domain') {
        const h = String((n.data as { host?: string }).host ?? '')
        if (h) hostDomains.add(h)
      }
    }
    // Findings: prefer the explicit `host` field on the node; fall back to
    // traversing the endpoint → finding edge when the field is absent.
    const fToHost = new Map<string, string>()
    for (const n of rawNodes) {
      if (n.type === 'finding') {
        const h = String((n.data as { host?: string }).host ?? '')
        if (h) fToHost.set(n.id, h)
      }
    }
    for (const e of rawEdges) {
      if (fToHost.has(e.target)) continue
      const h = epToHost.get(e.source)
      if (h) fToHost.set(e.target, h)
    }
    return { endpointToHost: epToHost, findingToHost: fToHost, hostDomainNodes: hostDomains }
  }, [rawNodes, rawEdges])

  // Group nodes by host for clustered layout. Root domain node + any
  // disconnected nodes fall into the special '' bucket.
  const hostGroups = useMemo(() => {
    const groups = new Map<string, GraphNode[]>()
    for (const n of rawNodes) {
      let h = ''
      if (n.type === 'endpoint') h = endpointToHost.get(n.id) ?? ''
      else if (n.type === 'finding') h = findingToHost.get(n.id) ?? ''
      else if (n.type === 'domain') {
        const dh = String((n.data as { host?: string }).host ?? '')
        // Session-root domain (no host field) goes in the '' bucket.
        h = dh
      }
      const list = groups.get(h) ?? []
      list.push(n)
      groups.set(h, list)
    }
    return groups
  }, [rawNodes, endpointToHost, findingToHost])

  // Auto-collapse hosts whose endpoint count exceeds the threshold. Runs
  // once when hostGroups first becomes available; subsequent toggles are
  // driven by the user clicking a host domain node.
  useEffect(() => {
    if (autoCollapsed) return
    const hostsToCollapse: string[] = []
    for (const [host, groupNodes] of hostGroups) {
      if (!host) continue // root bucket — never collapse
      const epCount = groupNodes.filter(n => n.type === 'endpoint').length
      if (epCount >= COLLAPSE_THRESHOLD) hostsToCollapse.push(host)
    }
    if (hostsToCollapse.length > 0) {
      setCollapsedHosts(new Set(hostsToCollapse))
      setAutoCollapsed(true)
    }
  }, [hostGroups, autoCollapsed])

  // Stable structural signature: only changes when nodes or edges change set.
  const structureKey = useMemo(() => {
    const n = rawNodes.map(x => x.id).sort().join('|')
    const e = rawEdges.map(x => `${x.source}>${x.target}`).sort().join('|')
    return `${n}::${e}`
  }, [rawNodes, rawEdges])

  // Recompute layout whenever the graph structure changes.
  // Per-host partitioned layout: each host cluster is laid out independently
  // by ELK (DOWN direction), then clusters are placed on a grid. This keeps
  // individual ELK runs small (one host = tens to low-hundreds of endpoints)
  // even when the session has 1000+ endpoints across many subdomains, and
  // produces visually obvious host separation on the canvas.
  useEffect(() => {
    if (rawNodes.length === 0) {
      setPositions({})
      return
    }
    const runId = ++layoutRunRef.current
    let cancelled = false

    // Bucket nodes/edges by host. The '' bucket holds the session root and
    // any orphans; it is placed at the top of the canvas.
    const hostToNodes = new Map<string, GraphNode[]>()
    const hostToEdges = new Map<string, GraphEdge[]>()
    for (const [host, groupNodes] of hostGroups) {
      hostToNodes.set(host, groupNodes)
      hostToEdges.set(host, [])
    }
    for (const e of rawEdges) {
      const srcHost =
        endpointToHost.get(e.source) ??
        findingToHost.get(e.source) ??
        (hostDomainNodes.has(e.source.replace('domain-host-', '')) ? e.source.replace('domain-host-', '') : '')
      const tgtHost =
        endpointToHost.get(e.target) ??
        findingToHost.get(e.target) ??
        (hostDomainNodes.has(e.target.replace('domain-host-', '')) ? e.target.replace('domain-host-', '') : '')
      // Root → host-domain edges go in the root bucket; everything else
      // lives with whichever host its endpoints belong to.
      const bucket = srcHost || tgtHost || ''
      hostToEdges.get(bucket)?.push(e)
    }

    // Lay out each host cluster in parallel.
    const layoutPromises: Array<Promise<{ host: string; nodes: Node[]; width: number; height: number }>> = []
    for (const [host, groupNodes] of hostToNodes) {
      const groupEdges = hostToEdges.get(host) ?? []
      const seedNodes = groupNodes.map(n => ({
        id: n.id,
        type: n.type,
        position: { x: 0, y: 0 },
        data: {},
        width: NODE_W,
        height: nodeHeightFor(n.type),
      })) as Node[]
      const seedEdges = groupEdges.map(e => ({
        id: e.id,
        source: e.source,
        target: e.target,
      })) as Edge[]

      const p = layoutFlowElements(seedNodes, seedEdges, {
        direction: 'DOWN',
        nodeWidth: NODE_W,
        nodeHeight: NODE_H_ENDPOINT,
        spacing: 48,
        layerSpacing: 90,
      }).then(result => {
        let maxX = 0
        let maxY = 0
        let hasNonZero = false
        for (const n of result.nodes) {
          if (n.position.x > maxX) maxX = n.position.x
          if (n.position.y > maxY) maxY = n.position.y
          if (n.position.x !== 0 || n.position.y !== 0) hasNonZero = true
        }
        // ELK all-zero fallback: simple grid within the cluster.
        if (!hasNonZero && result.nodes.length > 1) {
          const cols = Math.ceil(Math.sqrt(result.nodes.length))
          result.nodes.forEach((n, i) => {
            n.position = {
              x: (i % cols) * (NODE_W + 40),
              y: Math.floor(i / cols) * (NODE_H_ENDPOINT + 60),
            }
            if (n.position.x > maxX) maxX = n.position.x
            if (n.position.y > maxY) maxY = n.position.y
          })
        }
        return { host, nodes: result.nodes, width: maxX + NODE_W, height: maxY + nodeHeightFor('endpoint') }
      }).catch(() => {
        // Hard fallback: grid layout for this cluster.
        const cols = Math.ceil(Math.sqrt(groupNodes.length))
        const fallbackNodes = groupNodes.map((n, i) => ({
          id: n.id,
          position: {
            x: (i % cols) * (NODE_W + 40),
            y: Math.floor(i / cols) * (NODE_H_ENDPOINT + 60),
          },
        })) as Node[]
        return {
          host,
          nodes: fallbackNodes,
          width: cols * (NODE_W + 40),
          height: Math.ceil(groupNodes.length / cols) * (NODE_H_ENDPOINT + 60),
        }
      })
      layoutPromises.push(p)
    }

    Promise.all(layoutPromises).then(results => {
      if (cancelled || runId !== layoutRunRef.current) return
      const next: Record<string, { x: number; y: number }> = {}

      // Sort clusters: root bucket first (top), then alphabetical by host.
      const sorted = [...results].sort((a, b) => {
        if (a.host === '' && b.host !== '') return -1
        if (a.host !== '' && b.host === '') return 1
        return a.host.localeCompare(b.host)
      })

      // Pack clusters onto a grid. Column count scales with cluster count
      // so a handful of hosts sit in one row while dozens wrap naturally.
      const cols = Math.min(Math.max(1, Math.ceil(Math.sqrt(sorted.length))), 4)
      let cursorX = 0
      let cursorY = 0
      let rowMaxH = 0
      let colIdx = 0
      for (const r of sorted) {
        for (const n of r.nodes) {
          next[n.id] = { x: cursorX + n.position.x, y: cursorY + n.position.y }
        }
        rowMaxH = Math.max(rowMaxH, r.height)
        colIdx++
        if (colIdx >= cols) {
          cursorX = 0
          cursorY += rowMaxH + BLOCK_GAP_Y
          rowMaxH = 0
          colIdx = 0
        } else {
          cursorX += r.width + BLOCK_GAP_X
        }
      }
      setPositions(next)
      setVersion(v => v + 1)
    })
    return () => { cancelled = true }
  }, [structureKey, rawNodes, rawEdges, hostGroups, endpointToHost, findingToHost, hostDomainNodes])

  // Filter out endpoints/findings whose host is collapsed. Collapsed hosts
  // still show their domain node so the user has something to click to expand.
  const visibleNodes = useMemo(() => {
    if (collapsedHosts.size === 0) return rawNodes
    return rawNodes.filter(n => {
      if (n.type === 'endpoint') {
        const h = endpointToHost.get(n.id) ?? ''
        if (h && collapsedHosts.has(h)) return false
      }
      if (n.type === 'finding') {
        const h = findingToHost.get(n.id) ?? ''
        if (h && collapsedHosts.has(h)) return false
      }
      return true
    })
  }, [rawNodes, collapsedHosts, endpointToHost, findingToHost])

  // Drop edges that reference hidden nodes so ReactFlow doesn't draw
  // arrows into nothing.
  const visibleEdges = useMemo(() => {
    if (collapsedHosts.size === 0) return rawEdges
    const visibleIds = new Set(visibleNodes.map(n => n.id))
    return rawEdges.filter(e => visibleIds.has(e.source) && visibleIds.has(e.target))
  }, [rawEdges, visibleNodes, collapsedHosts])

  const flowNodes: Node[] = useMemo(
    () =>
      visibleNodes.map(n => {
        const isDomain = n.type === 'domain'
        const host = String((n.data as { host?: string }).host ?? '')
        const isCollapsedHost = isDomain && !!host && collapsedHosts.has(host)
        const epCount = isCollapsedHost
          ? (hostGroups.get(host)?.filter(x => x.type === 'endpoint').length ?? 0)
          : 0
        const findingCount = isCollapsedHost
          ? (hostGroups.get(host)?.filter(x => x.type === 'finding').length ?? 0)
          : 0
        return {
          id: n.id,
          type: n.type,
          position: positions[n.id] ?? { x: 0, y: 0 },
          width: NODE_W,
          height: nodeHeightFor(n.type),
          data: {
            ...n.data,
            selected: selectedIds.includes(n.id),
            collapsed: isCollapsedHost,
            collapsedEndpointCount: epCount,
            collapsedFindingCount: findingCount,
          },
        }
      }),
    [visibleNodes, positions, selectedIds, collapsedHosts, hostGroups],
  )

  const flowEdges: Edge[] = useMemo(
    () =>
      visibleEdges.map(e => ({
        id: e.id,
        source: e.source,
        target: e.target,
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: edgeColor },
        style: { stroke: edgeColor, strokeWidth: 1.4 },
      })),
    [visibleEdges, edgeColor],
  )

  const handleNodeClick: NodeMouseHandler<Node> = useCallback(
    (event, node) => {
      // Clicking a host domain node toggles its endpoint cluster collapse.
      // Holding a modifier key bypasses the toggle and falls through to
      // the normal selection path, so multi-select still works on domains.
      const data = node.data as { nodeType?: string; host?: string; collapsed?: boolean }
      const isHostDomain = data.nodeType === 'domain' && !!data.host
      if (isHostDomain && !(event.ctrlKey || event.metaKey || event.shiftKey)) {
        const host = data.host!
        setCollapsedHosts(prev => {
          const next = new Set(prev)
          if (next.has(host)) next.delete(host)
          else next.add(host)
          return next
        })
        return
      }
      if (node.type === 'finding') return
      const isMulti = event.ctrlKey || event.metaKey || event.shiftKey
      if (isMulti) {
        onSelectEndpoints(
          selectedIds.includes(node.id)
            ? selectedIds.filter(id => id !== node.id)
            : [...selectedIds, node.id],
        )
      } else {
        onSelectEndpoints(selectedIds.includes(node.id) && selectedIds.length === 1 ? [] : [node.id])
      }
    },
    [selectedIds, onSelectEndpoints],
  )

  const handleSidebarSelect = useCallback(
    (id: string, multi: boolean) => {
      if (multi) {
        onSelectEndpoints(
          selectedIds.includes(id) ? selectedIds.filter(x => x !== id) : [...selectedIds, id],
        )
      } else {
        onSelectEndpoints(selectedIds.includes(id) && selectedIds.length === 1 ? [] : [id])
      }
    },
    [selectedIds, onSelectEndpoints],
  )

  const handleFocusNode = useCallback(
    (id: string) => {
      // Auto-expand the host containing the focused node so the sidebar
      // focus action always reveals the target endpoint.
      const host = endpointToHost.get(id) ?? findingToHost.get(id) ?? ''
      if (host && collapsedHosts.has(host)) {
        setCollapsedHosts(prev => {
          const next = new Set(prev)
          next.delete(host)
          return next
        })
      }
      const pos = positions[id]
      if (!pos) return
      const node = rawNodes.find(n => n.id === id)
      const h = node ? nodeHeightFor(node.type) : NODE_H_ENDPOINT
      // Defer centering until after the expand re-render so the position
      // is actually on screen.
      requestAnimationFrame(() =>
        setCenter(pos.x + NODE_W / 2, pos.y + h / 2, { zoom: 1.2, duration: 400 }),
      )
    },
    [positions, rawNodes, setCenter, endpointToHost, findingToHost, collapsedHosts],
  )

  if (rawNodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--text-muted)]">
        <div className="text-center space-y-2">
          <div>发送域名让 Agent 开始发现接口</div>
          <div className="text-xs text-[var(--text-placeholder)]">示例：帮我发现 https://example.com 的所有接口</div>
        </div>
      </div>
    )
  }

  // Heuristic: when the visible node count is large, enable ReactFlow's
  // built-in viewport culling so off-screen nodes skip DOM rendering.
  // This is the single most effective lever for 1000+ endpoint sessions.
  const enableViewportCulling = visibleNodes.length > 200

  return (
    <div className="flex h-full min-h-0 w-full">
      <GraphSidebar
        sessionId={sessionId}
        nodes={rawNodes}
        selectedIds={selectedIds}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(c => !c)}
        onSelect={handleSidebarSelect}
        onFocus={handleFocusNode}
      />
      <div className="flex-1 min-w-0 h-full">
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={NODE_TYPES}
          onNodeClick={handleNodeClick}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          nodesDraggable={false}
          nodesConnectable={false}
          minZoom={0.05}
          maxZoom={2}
          panOnScroll
          zoomOnScroll={false}
          onlyRenderVisibleElements={enableViewportCulling}
          proOptions={{ hideAttribution: true }}
          className="bg-[var(--bg-base)]"
          defaultEdgeOptions={{
            style: { stroke: edgeColor, strokeWidth: 1.4 },
            markerEnd: { type: MarkerType.ArrowClosed, color: edgeColor },
          }}
        >
          <FitViewOnChange version={version} />
          <Background color={bgDotColor} gap={24} size={1} />
          <Controls
            position="bottom-right"
            showInteractive={false}
            className="rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] shadow-lg"
          />
        </ReactFlow>
      </div>
    </div>
  )
}
