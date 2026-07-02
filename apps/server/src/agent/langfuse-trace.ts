/**
 * Langfuse trace helpers — turn the agent's per-thread runs into structured,
 * groupable traces inside a single Langfuse session.
 *
 * The `@langfuse/otel` processor only exports the Vercel AI SDK's spans
 * (instrumentation scope `ai`). Trace/session grouping is driven entirely by
 * the metadata the AI SDK writes onto those spans — Langfuse maps a set of
 * *reserved* metadata keys to trace-level fields on ingest:
 *   - `langfuseTraceId`   → forces every streamText call in one run under one trace
 *   - `sessionId`         → groups all of a session's traces in the Session view
 *   - `userId`            → we map this to the *thread* id so a sub-agent's run is
 *                           a distinct, attributable lane inside the session
 *   - `tags`              → `kind:main` / `kind:subagent` + `parent:<threadId>`
 *                           so sub-session lineage is visible at a glance
 *
 * `createTraceId()` is async (it derives a deterministic-ish id), so callers
 * await one id per run and thread it down through the loop.
 */

import { createTraceId } from '@langfuse/tracing'

export { createTraceId }

export type RunKind = 'main' | 'subagent'

export interface TraceContext {
  /** One trace per run (main thread or a single sub-agent task). */
  traceId: string
  /** Stable session id — the Langfuse Session that aggregates every thread. */
  sessionId?: string
  /**
   * The thread this run executes in. For the main agent this is the thread id;
   * for a sub-agent it's the task id. Mapped to Langfuse `userId` so each
   * sub-session shows up as its own attributable lane.
   */
  threadId?: string
  /** Parent thread id for sub-agents — recorded as a tag for lineage. */
  parentThreadId?: string
  kind: RunKind
}

/**
 * Build the `experimental_telemetry.metadata` object handed to streamText.
 * Includes Langfuse reserved keys for grouping plus a few free-form fields
 * (iteration, contextPct) that surface as observation metadata in the UI.
 */
export function buildTelemetryMetadata(
  ctx: TraceContext,
  extra: { iteration?: number; contextPct?: number; contextTokens?: number; effectiveTokens?: number } = {},
): Record<string, string | number | boolean | string[]> {
  const tags = [`kind:${ctx.kind}`]
  if (ctx.parentThreadId) tags.push(`parent:${ctx.parentThreadId}`)

  const meta: Record<string, string | number | boolean | string[]> = {
    langfuseTraceId: ctx.traceId,
    // Langfuse merges tags from metadata onto the trace. OTel attribute values
    // accept string[], which is what Langfuse expects for tags.
    tags,
  }
  if (ctx.sessionId) meta.sessionId = ctx.sessionId
  // userId = threadId → distinguishes main vs each sub-agent sub-session.
  if (ctx.threadId) meta.userId = ctx.threadId
  if (ctx.kind === 'subagent') meta.langfuseUpdateParent = false

  if (extra.iteration != null) meta.iteration = extra.iteration
  if (extra.contextPct != null) meta.contextPct = Math.round(extra.contextPct * 1000) / 10
  if (extra.contextTokens != null) meta.contextTokens = extra.contextTokens
  if (extra.effectiveTokens != null) meta.effectiveTokens = extra.effectiveTokens
  return meta
}