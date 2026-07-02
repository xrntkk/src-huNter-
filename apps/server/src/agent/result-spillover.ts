/**
 * Tool-result spillover — large tool results are written to the session
 * workspace instead of being kept verbatim in the timeline.
 *
 * Rationale (P1-4): a single oversized tool result (e.g. a 200KB HTTP body or
 * a directory listing) gets replayed into the model prompt every iteration
 * until compression kicks in, crowding out useful context and duplicating the
 * curated ObservationStore view. Spilling it to disk lets the timeline keep a short
 * preview + a pointer the model can read back on demand via `file_system`.
 *
 * Storage layout mirrors python.ts: `workspace/{sessionId}/tool-results/`.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Results whose serialized size exceeds this (bytes) are spilled to disk. */
const SPILL_THRESHOLD = 32 * 1024

export interface SpillResult {
  /** Relative path (from workspace/{sessionId}/) for file_system read. */
  relPath: string
  /** Size of the spilled payload in KB (rounded). */
  sizeKB: number
}

/**
 * If `result` serializes to more than SPILL_THRESHOLD bytes, persist it to the
 * session workspace and return a pointer. Otherwise return null (caller keeps
 * the inline result). Failures degrade gracefully to null — the caller then
 * stores the inline (truncated) result as before.
 */
export function spillIfLarge(
  sessionId: string,
  toolCallId: string | undefined,
  result: unknown,
): SpillResult | null {
  if (result == null) return null
  let serialized: string
  try {
    serialized = typeof result === 'string' ? result : JSON.stringify(result)
  } catch {
    return null
  }
  const bytes = Buffer.byteLength(serialized, 'utf-8')
  if (bytes <= SPILL_THRESHOLD) return null

  try {
    const dir = join(process.cwd(), 'workspace', sessionId, 'tool-results')
    mkdirSync(dir, { recursive: true })
    const id = (toolCallId && toolCallId.replace(/[^a-zA-Z0-9._-]/g, '_')) || `res_${Date.now()}`
    const fname = `${id}.json`
    writeFileSync(join(dir, fname), serialized, 'utf-8')
    return { relPath: `tool-results/${fname}`, sizeKB: Math.round(bytes / 1024) }
  } catch {
    return null
  }
}
