/**
 * Plan one — per-thread JSONL append-only persistence.
 *
 * Replaces the integral `thread_timelines.timeline_data` blob rewrite with
 * a per-thread JSON-lines log at `apps/server/data/threads/<threadId>.jsonl`.
 * Each line is a single record:
 *
 *   {"t":"msg","seq":42,"ts":"...","msg":{ /* ModelMessage *\/ }}
 *   {"t":"meta","seq":43,"ts":"...","kind":"compression","payload":"..."}
 *   {"t":"meta","seq":44,"ts":"...","kind":"skill_loaded","payload":"src-recon"}
 *   {"t":"marker","seq":45,"ts":"...","payload":{ /* InterruptionMarker *\/ }}
 *
 * Why JSONL rather than the existing blob?
 *   - O(1) append vs O(n) full rewrite each turn.
 *   - Crashes lose at most the trailing line; the rest is recoverable.
 *   - Concurrent readers (UI tail, debug tooling) can stream the file.
 *   - SQLite row stops growing; the DB keeps only metadata + summary.
 *
 * The store remains the single source of truth for an in-memory session;
 * this module is the on-disk projection for restart durability. Hot-path
 * writes go through `appendMessage` / `appendMeta`. Cold-path metadata
 * (last_seq, message_count, compressed_summary) is flushed back to SQLite
 * by the caller (src-agent.ts) at iteration boundaries.
 *
 * Concurrency: the agent loop holds a per-thread `acquireRun` lock which
 * naturally serialises writes. Inside this module we still use a small
 * append-queue so re-entrant calls within the same tick coalesce into a
 * single fs.appendFile and we never interleave half-written lines.
 */
import { promises as fs } from 'node:fs'
import { existsSync, mkdirSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import type { ModelMessage } from 'ai'
import type { InterruptionMarker } from './interruption.js'
import { logger } from '../logger/index.js'

export type JsonlMetaKind = 'compression' | 'skill_loaded' | 'observer_round' | 'ptl_recovery'

export interface JsonlMessageEntry {
  t: 'msg'
  seq: number
  ts: string
  msg: ModelMessage
}
export interface JsonlMetaEntry {
  t: 'meta'
  seq: number
  ts: string
  kind: JsonlMetaKind
  payload: unknown
}
export interface JsonlMarkerEntry {
  t: 'marker'
  seq: number
  ts: string
  payload: InterruptionMarker
}
export type JsonlEntry = JsonlMessageEntry | JsonlMetaEntry | JsonlMarkerEntry

export interface LoadedJsonl {
  messages: ModelMessage[]
  meta: JsonlMetaEntry[]
  markers: InterruptionMarker[]
  lastSeq: number
  /** Lines that failed to parse — surfaced for telemetry; not fatal. */
  corruptLines: number
}

const ROOT_ENV = 'THREAD_JSONL_ROOT'

function rootDir(): string {
  const fromEnv = process.env[ROOT_ENV]
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim())
  // Default: <server-cwd>/data/threads — server is run from apps/server,
  // mirroring how skill-loader.ts resolves packages/skills.
  return resolve(process.cwd(), 'data', 'threads')
}

function ensureDir(path: string): void {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

export class ThreadJsonlStore {
  /** Resolve the on-disk path for a thread's JSONL log. */
  static path(threadId: string): string {
    return join(rootDir(), `${sanitize(threadId)}.jsonl`)
  }

  /**
   * Append a model message. Returns the assigned seq. Caller is responsible
   * for tracking the live seq counter (use `(prevSeq) + 1`); this method does
   * NOT auto-increment so callers can batch-allocate seqs for atomic writes.
   */
  static async appendMessage(threadId: string, seq: number, msg: ModelMessage): Promise<void> {
    const entry: JsonlMessageEntry = { t: 'msg', seq, ts: new Date().toISOString(), msg }
    await appendLine(threadId, entry)
  }

  /** Append a meta entry (compression summary, skill loaded, observer round, etc.). */
  static async appendMeta(threadId: string, seq: number, kind: JsonlMetaKind, payload: unknown): Promise<void> {
    const entry: JsonlMetaEntry = { t: 'meta', seq, ts: new Date().toISOString(), kind, payload }
    await appendLine(threadId, entry)
  }

  /** Append an interruption-state-machine marker (plan two cross-link). */
  static async appendMarker(threadId: string, seq: number, marker: InterruptionMarker): Promise<void> {
    const entry: JsonlMarkerEntry = { t: 'marker', seq, ts: new Date().toISOString(), payload: marker }
    await appendLine(threadId, entry)
  }

  /**
   * Stream-load all entries for a thread. Tolerates a corrupt trailing line
   * (write-during-crash) by counting it and continuing. Missing file → empty
   * loaded set with `lastSeq: 0`.
   */
  static async load(threadId: string): Promise<LoadedJsonl> {
    const path = ThreadJsonlStore.path(threadId)
    const out: LoadedJsonl = { messages: [], meta: [], markers: [], lastSeq: 0, corruptLines: 0 }
    let raw: string
    try {
      raw = await fs.readFile(path, 'utf-8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT') return out
      throw err
    }
    if (!raw) return out
    const lines = raw.split('\n')
    for (const line of lines) {
      if (!line.trim()) continue
      let entry: JsonlEntry
      try {
        entry = JSON.parse(line) as JsonlEntry
      } catch {
        out.corruptLines++
        continue
      }
      if (typeof entry.seq === 'number' && entry.seq > out.lastSeq) out.lastSeq = entry.seq
      switch (entry.t) {
        case 'msg':
          out.messages.push(entry.msg)
          break
        case 'meta':
          out.meta.push(entry)
          break
        case 'marker':
          out.markers.push(entry.payload)
          break
      }
    }
    return out
  }

  /**
   * Write a fresh JSONL by replaying an in-memory store snapshot. Used for
   * one-time migration from the legacy `timeline_data` blob: we serialize
   * each existing message as a `msg` line and stamp meta entries for any
   * compression summary / loaded skills / interruption markers. Atomic via
   * tmp + rename.
   */
  static async writeSnapshot(
    threadId: string,
    snapshot: { messages: ModelMessage[]; meta: Array<{ kind: JsonlMetaKind; payload: unknown }>; markers: InterruptionMarker[] },
  ): Promise<{ path: string; lastSeq: number }> {
    const path = ThreadJsonlStore.path(threadId)
    ensureDir(path)
    const tmp = `${path}.tmp`
    let seq = 0
    const lines: string[] = []
    for (const m of snapshot.messages) {
      seq++
      lines.push(JSON.stringify({ t: 'msg', seq, ts: new Date().toISOString(), msg: m } satisfies JsonlMessageEntry))
    }
    for (const meta of snapshot.meta) {
      seq++
      lines.push(JSON.stringify({ t: 'meta', seq, ts: new Date().toISOString(), kind: meta.kind, payload: meta.payload } satisfies JsonlMetaEntry))
    }
    for (const marker of snapshot.markers) {
      seq++
      lines.push(JSON.stringify({ t: 'marker', seq, ts: new Date().toISOString(), payload: marker } satisfies JsonlMarkerEntry))
    }
    await fs.writeFile(tmp, lines.join('\n') + (lines.length > 0 ? '\n' : ''), 'utf-8')
    await fs.rename(tmp, path)
    return { path, lastSeq: seq }
  }
}

// ─── Internals ────────────────────────────────────────────────────────────

const queues = new Map<string, Promise<void>>()

async function appendLine(threadId: string, entry: JsonlEntry): Promise<void> {
  const path = ThreadJsonlStore.path(threadId)
  ensureDir(path)
  // Per-thread sequential queue: re-entrant calls in the same tick chain
  // through the previous append's promise so we never interleave writes.
  const prev = queues.get(threadId) ?? Promise.resolve()
  const next = prev
    .then(async () => {
      await fs.appendFile(path, JSON.stringify(entry) + '\n', 'utf-8')
    })
    .catch(err => {
      // Surface the failure on the next caller so a single fs blip doesn't
      // permanently kill the queue, but log it loudly so we notice.
      logger.error(`[ThreadJsonlStore] append failed for ${threadId}:`, err)
    })
  queues.set(threadId, next)
  return next
}

function sanitize(threadId: string): string {
  // ThreadIds are uuid-ish but be paranoid: refuse path separators and dots
  // to keep us inside `data/threads/`.
  return threadId.replace(/[^a-zA-Z0-9_-]/g, '_')
}
