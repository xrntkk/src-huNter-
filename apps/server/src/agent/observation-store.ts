/**
 * ObservationStore — passive recording layer for SRC Agent observations.
 *
 * Stores immutable Facts (endpoints, vulns, tech stack, etc.) in SQLite.
 * Does NOT control the agent loop — it is a read/write data store only.
 *
 * Replaces the former "FactGraph" which included an Intent/task layer
 * that actively drove loop behavior. That layer has been removed.
 */

import { eq } from 'drizzle-orm'
import { getDb, facts } from '@src-agent/db'
import type { FactType, FactContent } from '@src-agent/db'
import { nanoid } from 'nanoid'
import { logger } from '../logger/index.js'

/* ─── Types ─── */

export interface Fact {
  id: string
  sessionId: string
  threadId: string
  type: FactType
  content: FactContent
  source: string
  sourceToolCallId?: string
  basedOnFactIds?: string[]
  confidence?: number
  createdAt: Date
}

/* ─── ObservationStore ─── */

export class ObservationStore {
  private _facts = new Map<string, Fact>()
  private loaded = false
  private _pendingInserts: Fact[] = []
  private _pendingDeletes: string[] = []
  private _dirty = false

  constructor(
    private readonly sessionId: string,
    private readonly threadId: string,
  ) {}

  getSessionId(): string {
    return this.sessionId
  }

  getThreadId(): string {
    return this.threadId
  }

  /* ─── Load / Persist ─── */

  load(): void {
    const db = getDb()
    const rows = db
      .select()
      .from(facts)
      .where(eq(facts.sessionId, this.sessionId))
      .all()

    for (const row of rows) {
      this._facts.set(row.id, rowToFact(row))
    }

    this.loaded = true
    logger.info(`[ObservationStore] Loaded ${this._facts.size} facts for session=${this.sessionId}`)
  }

  ensureLoaded(): void {
    if (!this.loaded) this.load()
  }

  persist(): void {
    if (!this._dirty) return
    const db = getDb()

    try {
      db.transaction((tx) => {
        for (const fact of this._pendingInserts) {
          tx.insert(facts)
            .values({
              id: fact.id,
              sessionId: fact.sessionId,
              threadId: fact.threadId,
              type: fact.type,
              content: fact.content,
              source: fact.source,
              sourceToolCallId: fact.sourceToolCallId,
              basedOnFactIds: fact.basedOnFactIds,
              confidence: fact.confidence,
              createdAt: fact.createdAt,
            })
            .run()
        }
        for (const id of this._pendingDeletes) {
          tx.delete(facts).where(eq(facts.id, id)).run()
        }
      })
    } catch (err) {
      logger.error('[ObservationStore] Flush failed:', err)
      return
    }

    const total = this._pendingInserts.length + this._pendingDeletes.length
    if (total > 0) {
      logger.info(`[ObservationStore] Flushed ${total} pending write(s)`)
    }

    this._pendingInserts = []
    this._pendingDeletes = []
    this._dirty = false
  }

  get dirty(): boolean {
    return this._dirty
  }

  /* ─── Fact CRUD ─── */

  addFact(input: Omit<Fact, 'id' | 'createdAt'>): Fact {
    this.ensureLoaded()
    const id = nanoid()
    const now = new Date()
    const fact: Fact = { ...input, id, createdAt: now }

    this._pendingInserts.push(fact)
    this._dirty = true
    this._facts.set(id, fact)
    logger.info(`[ObservationStore] Added fact ${id} (${fact.type}) from ${fact.source}`)
    return fact
  }

  getFact(id: string): Fact | undefined {
    this.ensureLoaded()
    return this._facts.get(id)
  }

  deleteFact(id: string): boolean {
    this.ensureLoaded()
    if (!this._facts.has(id)) return false
    this._pendingDeletes.push(id)
    this._dirty = true
    this._facts.delete(id)
    logger.info(`[ObservationStore] Deleted fact ${id}`)
    return true
  }

  getFactsByType(type: FactType): Fact[] {
    this.ensureLoaded()
    return Array.from(this._facts.values()).filter(f => f.type === type)
  }

  getFactsBySource(source: string): Fact[] {
    this.ensureLoaded()
    return Array.from(this._facts.values()).filter(f => f.source === source)
  }

  getDerivedFacts(parentFactId: string): Fact[] {
    this.ensureLoaded()
    return Array.from(this._facts.values()).filter(
      f => f.basedOnFactIds?.includes(parentFactId),
    )
  }

  getAllFacts(): Fact[] {
    this.ensureLoaded()
    return Array.from(this._facts.values())
  }

  /* ─── Context Builders ─── */

  buildContextPrompt(opts?: { selectedEndpointIds?: string[] }): string {
    this.ensureLoaded()
    const lines: string[] = []

    const endpointFacts = this.getFactsByType('endpoint')
    const vulnFacts = this.getFactsByType('vuln_candidate')

    const stats: string[] = []
    if (endpointFacts.length > 0) stats.push(`接口 ${endpointFacts.length}`)
    if (vulnFacts.length > 0) stats.push(`漏洞 ${vulnFacts.length}`)
    if (stats.length > 0) {
      lines.push(`## 当前态势 | ${stats.join(' · ')}`)
      lines.push('')
    }

    const featured = this.getFeaturedEndpoints(10, opts?.selectedEndpointIds)
    if (featured.length > 0) {
      lines.push(`## 重点关注接口（${featured.length}/${endpointFacts.length}）`)
      for (const f of featured) {
        const c = f.content as {
          method?: string
          pathTemplate?: string
          url?: string
          riskHints?: string[]
          description?: string
        }
        const riskTag = c.riskHints?.length ? ` [${c.riskHints.slice(0, 2).join(', ')}]` : ''
        const desc = c.description ? ` — ${c.description.slice(0, 40)}` : ''
        lines.push(`- ${c.method ?? 'GET'} ${c.pathTemplate ?? c.url ?? '(unknown)'}${riskTag}${desc}`)
      }
      lines.push('')
    }

    if (endpointFacts.length > 10 || vulnFacts.length > 0) {
      lines.push(
        '> 提示：上下文仅展示精选接口。如需查看完整列表或按条件筛选，请调用 `list_endpoints` 工具。',
      )
      lines.push('')
    }

    return lines.join('\n')
  }

  summarizeProgress(): string {
    this.ensureLoaded()
    const endpoints = this.getFactsByType('endpoint')
    const vulns = this.getFactsByType('vuln_candidate')

    const lines: string[] = ['## 当前工作状态（压缩后自动注入）']
    lines.push(`- 已发现接口: ${endpoints.length} 个`)
    lines.push(`- 已确认漏洞/线索: ${vulns.length} 个`)

    const risky = endpoints.filter(f => {
      const c = f.content as { riskHints?: string[] }
      return c.riskHints && c.riskHints.length > 0
    })
    if (risky.length > 0) {
      lines.push(`- 高风险接口: ${risky.length} 个`)
    }

    return lines.join('\n')
  }

  summary(): { facts: number } {
    this.ensureLoaded()
    return { facts: this._facts.size }
  }

  private getFeaturedEndpoints(limit: number, selectedIds?: string[]): Fact[] {
    this.ensureLoaded()
    const endpoints = this.getFactsByType('endpoint')
    if (endpoints.length <= limit) return endpoints

    const scored = endpoints.map(f => {
      const c = f.content as { endpointId?: string; riskHints?: string[] }
      let score = f.createdAt.getTime()
      if (selectedIds?.includes(c.endpointId ?? '')) score += 1_000_000
      if (c.riskHints?.length) score += c.riskHints.length * 100_000
      return { fact: f, score }
    })

    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit).map(s => s.fact)
  }
}

/* ─── Row converter ─── */

function rowToFact(row: typeof facts.$inferSelect): Fact {
  return {
    id: row.id,
    sessionId: row.sessionId,
    threadId: row.threadId,
    type: row.type as FactType,
    content: (row.content ?? {}) as FactContent,
    source: row.source,
    sourceToolCallId: row.sourceToolCallId ?? undefined,
    basedOnFactIds: (row.basedOnFactIds as string[] | null) ?? undefined,
    confidence: row.confidence ?? undefined,
    createdAt: new Date(row.createdAt),
  }
}
