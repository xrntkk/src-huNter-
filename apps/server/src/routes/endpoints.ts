import { Hono } from 'hono'
import { eq, desc } from 'drizzle-orm'
import { getDb, endpoints, findings, memories, memoryEdges, sessions } from '@src-agent/db'

export const endpointsRouter = new Hono()

// Get all endpoints for a session (with finding counts)
endpointsRouter.get('/sessions/:sessionId/endpoints', async c => {
  const db = getDb()
  const sessionId = c.req.param('sessionId')
  const eps = await db
    .select()
    .from(endpoints)
    .where(eq(endpoints.sessionId, sessionId))
    .orderBy(desc(endpoints.createdAt))
  return c.json(eps)
})

/** Extract a normalized host (with port if non-default) from an endpoint URL.
 *  Returns '' when the URL is unparseable. Used for grouping endpoints by
 *  subdomain in the graph view. */
function hostOf(url: string | null | undefined): string {
  if (!url) return ''
  try {
    const u = new URL(url)
    return u.host // e.g. api.example.com:8443
  } catch {
    return ''
  }
}

// Get endpoint graph data (for ReactFlow)
endpointsRouter.get('/sessions/:sessionId/endpoint-graph', async c => {
  const db = getDb()
  const sessionId = c.req.param('sessionId')

  const [eps, fds, sess] = await Promise.all([
    db.select().from(endpoints).where(eq(endpoints.sessionId, sessionId)),
    db.select().from(findings).where(eq(findings.sessionId, sessionId)),
    db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1),
  ])

  const sessionDomain = sess[0]?.domain ?? ''
  const sessionHost = hostOf(sessionDomain) || sessionDomain

  // Group endpoints by host. Single-host sessions collapse to the original
  // "domain root → endpoints" shape. Multi-host sessions (subdomain
  // enumeration, asset discovery) get a session root plus one domain node
  // per host, so the agent's recon results are visually distinguishable.
  const hostToEps = new Map<string, typeof eps>()
  for (const ep of eps) {
    const h = hostOf(ep.url) || sessionHost
    if (!h) continue
    const list = hostToEps.get(h) ?? []
    list.push(ep)
    hostToEps.set(h, list)
  }

  const hosts = [...hostToEps.keys()].sort()
  const hasMultipleHosts = hosts.length > 1

  // Root node: when only one host, the root is that host (preserves the
  // pre-existing visual layout). When multiple, the root is the session
  // target, and each host hangs off it as a separate domain node.
  const rootId = hasMultipleHosts ? `domain-${sessionId}` : `domain-${sessionHost || sessionId}`
  const rootLabel = hasMultipleHosts
    ? (sessionDomain || 'Target')
    : (sessionHost || 'Domain Root')

  const nodes: Array<{
    id: string
    type: 'domain' | 'endpoint' | 'finding'
    data: Record<string, unknown>
  }> = [
    {
      id: rootId,
      type: 'domain',
      data: { label: rootLabel, nodeType: 'domain' },
    },
  ]
  // Per-host domain nodes (only when more than one host)
  if (hasMultipleHosts) {
    for (const h of hosts) {
      nodes.push({
        id: `domain-host-${h}`,
        type: 'domain',
        data: { label: h, nodeType: 'domain', host: h },
      })
    }
  }
  // Endpoint nodes
  for (const ep of eps) {
    nodes.push({
      id: ep.id,
      type: 'endpoint',
      data: {
        nodeType: 'endpoint',
        method: ep.method,
        pathTemplate: ep.pathTemplate,
        url: ep.url,
        description: ep.description,
        verificationStatus: ep.verificationStatus,
        params: ep.params,
        sampleRequest: ep.sampleRequest,
        sampleResponse: ep.sampleResponse,
        source: ep.source,
        techStack: ep.techStack,
        riskHints: ep.riskHints,
        findingCount: fds.filter(f => f.endpointId === ep.id).length,
        host: hostOf(ep.url) || sessionHost,
      },
    })
  }
  // Finding nodes — include host and endpointId so the frontend can group
  // findings with their endpoint's host cluster without relying solely on
  // edge traversal. This matters when the endpoint → finding edge is the
  // only signal: if the frontend's reverse lookup misses for any reason
  // (ordering, missing host on endpoint, etc.), findings would land in the
  // root bucket and appear disconnected from their endpoints.
  const epById = new Map(eps.map(ep => [ep.id, ep]))
  for (const f of fds) {
    const ep = f.endpointId ? epById.get(f.endpointId) : undefined
    const fHost = ep ? (hostOf(ep.url) || sessionHost) : ''
    nodes.push({
      id: f.id,
      type: 'finding',
      data: {
        nodeType: 'finding',
        type: f.type,
        severity: f.severity,
        title: f.title,
        status: f.status,
        endpointId: f.endpointId ?? '',
        host: fHost,
      },
    })
  }

  const edges: Array<{ id: string; source: string; target: string }> = []
  // Root → host domain (only multi-host)
  if (hasMultipleHosts) {
    for (const h of hosts) {
      edges.push({ id: `e-root-${h}`, source: rootId, target: `domain-host-${h}` })
    }
  }
  // Domain/host → endpoint
  for (const ep of eps) {
    const h = hostOf(ep.url) || sessionHost
    const src = hasMultipleHosts ? `domain-host-${h}` : rootId
    edges.push({ id: `e-domain-${ep.id}`, source: src, target: ep.id })
  }
  // Endpoint → finding
  for (const f of fds.filter(x => x.endpointId)) {
    edges.push({ id: `e-${f.endpointId}-${f.id}`, source: f.endpointId!, target: f.id })
  }

  return c.json({ nodes, edges })
})

// Get memory graph data (for ReactFlow) — agent-authored long-term memory.
endpointsRouter.get('/sessions/:sessionId/memory-graph', async c => {
  const db = getDb()
  const sessionId = c.req.param('sessionId')

  const mems = await db
    .select()
    .from(memories)
    .where(eq(memories.sessionId, sessionId))
    .orderBy(desc(memories.createdAt))

  const memIds = new Set(mems.map(m => m.id))
  const allEdges = await db.select().from(memoryEdges)
  // Edges have no sessionId column; scope by membership of both endpoints.
  const scopedEdges = allEdges.filter(e => memIds.has(e.from) && memIds.has(e.to))

  const nodes = mems.map(m => ({
    id: m.id,
    type: 'memory',
    data: {
      nodeType: 'memory',
      kind: m.kind,
      title: m.title,
      content: m.content,
      createdAt: m.createdAt,
    },
  }))

  const edges = scopedEdges.map(e => ({
    id: `m-${e.from}-${e.to}-${e.relation}`,
    source: e.from,
    target: e.to,
    label: e.relation,
  }))

  return c.json({ nodes, edges })
})
endpointsRouter.get('/endpoints/:id', async c => {
  const db = getDb()
  const id = c.req.param('id')
  const [ep] = await db.select().from(endpoints).where(eq(endpoints.id, id))
  if (!ep) return c.json({ error: 'Not found' }, 404)
  const fds = await db.select().from(findings).where(eq(findings.endpointId, id))
  return c.json({ ...ep, findings: fds })
})
