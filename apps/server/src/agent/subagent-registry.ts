/**
 * Global registry for asynchronous sub-agent tasks spawned via spawn_agent
 * with `mode: 'async'`. Tracks task lifecycle so the parent agent can:
 *
 *   - poll progress via the `query_subagent` tool
 *   - cancel via `abort_subagent`
 *   - receive completion notification injected into its timeline as a
 *     `<task-notification task_id=... status=...>...</task-notification>`
 *     system message on the next iteration.
 *
 * Persisted to SQLite — survives server restarts. Any tasks that were
 * marked 'running' when the previous process died are auto-marked 'failed'
 * on startup since the underlying async execution is gone.
 */


import { getDb, subagentTasks, subagentStores } from '@src-agent/db'
import { eq, lt } from 'drizzle-orm'
import { logger } from '../logger/index.js'

export interface SubagentTaskRecord {
  taskId: string
  parentThreadId: string
  description: string
  status: 'running' | 'completed' | 'failed' | 'aborted'
  startedAt: number
  finishedAt?: number
  toolCallCount: number
  toolErrorCount: number
  endpointsFound: number
  findingsFound: number
  summary?: string
  error?: string
  progress?: string
}

export interface SubagentTask extends SubagentTaskRecord {
  abortController: AbortController
  /** True once we've appended a `<task-notification>` to the parent's timeline. */
  notificationInjected: boolean
  /** Messages queued by send_message tool, drained by child loop each iteration. */
  pendingMessages: string[]
}

function recordToTask(record: SubagentTaskRecord): SubagentTask {
  return {
    ...record,
    abortController: new AbortController(),
    notificationInjected: false,
    pendingMessages: [],
  }
}

function taskToRecord(task: SubagentTask): SubagentTaskRecord {
  const { abortController, notificationInjected, pendingMessages, ...record } = task
  return record
}

class SubagentRegistry {
  private tasks = new Map<string, SubagentTask>()

  constructor() {
    this.hydrateFromDb().catch((err: unknown) => {
      logger.error('[SubagentRegistry] Failed to hydrate from DB:', err)
    })
  }

  private async hydrateFromDb(): Promise<void> {
    const db = getDb()
    const rows = await db.select().from(subagentTasks).all()

    let recovered = 0
    for (const row of rows) {
      const record: SubagentTaskRecord = {
        taskId: row.taskId,
        parentThreadId: row.parentThreadId,
        description: row.description,
        status: row.status as SubagentTaskRecord['status'],
        startedAt: row.startedAt,
        finishedAt: row.finishedAt ?? undefined,
        toolCallCount: row.toolCallCount,
        toolErrorCount: row.toolErrorCount,
        endpointsFound: row.endpointsFound,
        findingsFound: row.findingsFound,
        summary: row.summary ?? undefined,
        error: row.error ?? undefined,
        progress: row.progress ?? undefined,
      }

      if (record.status === 'running') {
        record.status = 'failed'
        record.error = record.error || 'Server restarted while task was running'
        record.finishedAt = record.finishedAt ?? Date.now()
        recovered++
      }

      const task = recordToTask(record)
      this.tasks.set(task.taskId, task)
    }

    // Batch-sync recovered statuses back to DB
    if (recovered > 0) {
      for (const task of this.tasks.values()) {
        if (task.status === 'failed' && task.error?.includes('Server restarted')) {
          await db.update(subagentTasks)
            .set({ status: task.status, error: task.error, finishedAt: task.finishedAt })
            .where(eq(subagentTasks.taskId, task.taskId))
            .run()
        }
      }
    }

    if (rows.length > 0) {
      logger.info(`[SubagentRegistry] Hydrated ${rows.length} tasks from DB (${recovered} recovered as failed)`)
    }
  }

  private async persist(record: SubagentTaskRecord): Promise<void> {
    try {
      const db = getDb()
      const existing = await db.select().from(subagentTasks).where(eq(subagentTasks.taskId, record.taskId)).get()
      if (existing) {
        await db.update(subagentTasks)
          .set({
            parentThreadId: record.parentThreadId,
            description: record.description,
            status: record.status,
            startedAt: record.startedAt,
            finishedAt: record.finishedAt,
            toolCallCount: record.toolCallCount,
            toolErrorCount: record.toolErrorCount,
            endpointsFound: record.endpointsFound,
            findingsFound: record.findingsFound,
            summary: record.summary,
            error: record.error,
            progress: record.progress,
          })
          .where(eq(subagentTasks.taskId, record.taskId))
          .run()
      } else {
        await db.insert(subagentTasks).values(record).run()
      }
    } catch (err) {
      logger.error('[SubagentRegistry] Failed to persist task:', err)
    }
  }

  register(task: Omit<SubagentTask, 'taskId' | 'notificationInjected'> & { taskId: string }): SubagentTask {
    const full: SubagentTask = { ...task, notificationInjected: false }
    this.tasks.set(full.taskId, full)
    void this.persist(taskToRecord(full))
    return full
  }

  /** Asynchronously save the current state of a task to the DB. */
  save(task: SubagentTask): void {
    void this.persist(taskToRecord(task))
  }

  get(taskId: string): SubagentTask | undefined {
    const fromMemory = this.tasks.get(taskId)
    if (fromMemory) return fromMemory

    // Fallback: try to load from DB (handles edge cases where hydration missed it)
    const db = getDb()
    const row = db.select().from(subagentTasks).where(eq(subagentTasks.taskId, taskId)).get()
    if (!row) return undefined

    const record: SubagentTaskRecord = {
      taskId: row.taskId,
      parentThreadId: row.parentThreadId,
      description: row.description,
      status: row.status as SubagentTaskRecord['status'],
      startedAt: row.startedAt,
      finishedAt: row.finishedAt ?? undefined,
      toolCallCount: row.toolCallCount,
      toolErrorCount: row.toolErrorCount,
      endpointsFound: row.endpointsFound,
      findingsFound: row.findingsFound,
      summary: row.summary ?? undefined,
      error: row.error ?? undefined,
      progress: row.progress ?? undefined,
    }

    const task = recordToTask(record)
    this.tasks.set(taskId, task)
    return task
  }

  listForThread(parentThreadId: string): SubagentTask[] {
    const out: SubagentTask[] = []
    for (const t of this.tasks.values()) {
      if (t.parentThreadId === parentThreadId) out.push(t)
    }
    return out.sort((a, b) => a.startedAt - b.startedAt)
  }

  abort(taskId: string): boolean {
    const task = this.tasks.get(taskId)
    if (!task) return false
    if (task.status === 'running') {
      task.abortController.abort()
      task.status = 'aborted'
      task.finishedAt = Date.now()
      void this.persist(taskToRecord(task))
    }
    return true
  }

  /**
   * Drain pending completion notifications for a thread. Returns the
   * notification strings (the caller appends them to its MessageStore as system
   * messages). Called by agent-loop at the top of each iteration so the parent
   * always sees the latest async results before the next LLM call.
   *
   * When an ObservationStore is provided, the notification includes specific endpoints
   * and findings discovered by the sub-agent (sourced from facts attributed to
   * the sub-agent's thread).
   */
  flushPendingMessages(parentThreadId: string, observationStore?: { getFactsBySource: (source: string) => Array<{ type: string; content: unknown }> }): string[] {
    const out: string[] = []
    for (const task of this.tasks.values()) {
      if (task.parentThreadId !== parentThreadId) continue
      if (task.notificationInjected) continue
      if (task.status === 'running') continue

      let inner = task.summary ?? task.error ?? '(no output)'

      // Enrich with concrete discoveries if ObservationStore is available
      if (observationStore && (task.endpointsFound > 0 || task.findingsFound > 0)) {
        const subFacts = observationStore.getFactsBySource(`subagent:${task.taskId}`)
        if (subFacts.length > 0) {
          const endpoints = subFacts.filter(f => f.type === 'endpoint').slice(0, 5)
          const findings = subFacts.filter(f => f.type === 'vuln_candidate').slice(0, 3)
          const details: string[] = []
          for (const ep of endpoints) {
            const c = ep.content as { method?: string; pathTemplate?: string; url?: string }
            details.push(`  - [接口] ${c.method ?? 'GET'} ${c.pathTemplate ?? c.url ?? '(unknown)'}`)
          }
          for (const f of findings) {
            const c = f.content as { title?: string; severity?: string }
            details.push(`  - [发现] ${c.title ?? '(untitled)'} (${c.severity ?? 'unknown'})`)
          }
          if (details.length > 0) {
            inner += '\n\n具体发现：\n' + details.join('\n')
          }
        }
      }

      out.push(
        `<task-notification task_id="${task.taskId}" status="${task.status}" ` +
        `tool_calls="${task.toolCallCount}" endpoints="${task.endpointsFound}" findings="${task.findingsFound}">\n` +
        inner +
        `\n</task-notification>`,
      )
      task.notificationInjected = true
    }
    return out
  }

  /** Abort all running tasks for a thread (used when the thread is cleared). */
  abortAllForThread(parentThreadId: string): number {
    let count = 0
    for (const task of this.tasks.values()) {
      if (task.parentThreadId !== parentThreadId) continue
      if (task.status !== 'running') continue
      task.abortController.abort()
      task.status = 'aborted'
      task.finishedAt = Date.now()
      void this.persist(taskToRecord(task))
      count++
    }
    return count
  }

  /** Check if any async tasks are still running for a given thread. */
  hasRunningTasks(parentThreadId: string): boolean {
    for (const task of this.tasks.values()) {
      if (task.parentThreadId === parentThreadId && task.status === 'running') return true
    }
    return false
  }

  /** Return a promise that resolves when all running tasks for a thread finish. */
  waitForThread(parentThreadId: string, signal?: AbortSignal): Promise<void> {
    if (!this.hasRunningTasks(parentThreadId)) return Promise.resolve()
    return new Promise((resolve) => {
      const check = () => {
        if (!this.hasRunningTasks(parentThreadId) || signal?.aborted) {
          clearInterval(timer)
          resolve()
        }
      }
      const timer = setInterval(check, 500)
      signal?.addEventListener('abort', () => { clearInterval(timer); resolve() }, { once: true })
    })
  }

  // ─── Store persistence (for continue_subagent) ──────────────────────────

  /** Save a child agent's MessageStore so it can be resumed later. */
  async saveStore(taskId: string, storeData: string, systemPrompt?: string, agentType?: string): Promise<void> {
    try {
      const db = getDb()
      const existing = await db.select().from(subagentStores).where(eq(subagentStores.taskId, taskId)).get()
      if (existing) {
        await db.update(subagentStores)
          .set({ storeData, systemPrompt, agentType, createdAt: Date.now() })
          .where(eq(subagentStores.taskId, taskId))
          .run()
      } else {
        await db.insert(subagentStores).values({ taskId, storeData, systemPrompt, agentType, createdAt: Date.now() }).run()
      }
    } catch (err) {
      logger.error('[SubagentRegistry] Failed to save store:', err)
    }
  }

  /** Restore a child agent's saved state for continuation. */
  restoreStore(taskId: string): { storeData: string; systemPrompt?: string; agentType?: string } | null {
    const db = getDb()
    const row = db.select().from(subagentStores).where(eq(subagentStores.taskId, taskId)).get()
    if (!row) return null
    return {
      storeData: row.storeData,
      systemPrompt: row.systemPrompt ?? undefined,
      agentType: row.agentType ?? undefined,
    }
  }

  /** Delete expired stores (older than 1 hour). Called at startup. */
  cleanupExpiredStores(): void {
    try {
      const db = getDb()
      const cutoff = Date.now() - 3600_000
      db.delete(subagentStores).where(lt(subagentStores.createdAt, cutoff)).run()
    } catch (err) {
      logger.error('[SubagentRegistry] Failed to cleanup expired stores:', err)
    }
  }
}

export const subagentRegistry = new SubagentRegistry()
