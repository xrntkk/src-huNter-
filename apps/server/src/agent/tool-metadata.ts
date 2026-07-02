/**
 * Tool concurrency metadata.
 *
 * - `concurrent: true` — tool may run in parallel when the LLM emits multiple
 *   tool calls in a single step.
 * - `barrier: true` — tool acts as a parallel barrier: it may run in parallel
 *   with other instances of itself in the same batch, but the batch will not
 *   start any non-barrier tools until all barriers in the batch finish. This
 *   is for tools that block the parent's reasoning by design (e.g. sync
 *   spawn_agent: while children run, the parent should not be issuing other
 *   tool calls — those calls would race the children).
 *
 * Tools not listed default to `{ concurrent: false, readonly: false, barrier: false }`.
 */
export const TOOL_CONCURRENCY: Record<string, { concurrent: boolean; readonly: boolean; barrier?: boolean }> = {
  http_request: { concurrent: true, readonly: true },
  query_knowledge: { concurrent: true, readonly: true },
  list_endpoints: { concurrent: true, readonly: true },
  query_subagent: { concurrent: true, readonly: true },
  browser_navigate: { concurrent: true, readonly: false },
  browser_screenshot: { concurrent: true, readonly: true },
  browser_get_text: { concurrent: true, readonly: true },
  browser_click: { concurrent: true, readonly: false },
  browser_fill: { concurrent: true, readonly: false },
  browser_evaluate: { concurrent: true, readonly: false },
  spawn_agent: { concurrent: true, readonly: false, barrier: true },
}

export function isConcurrentSafe(toolName: string): boolean {
  return TOOL_CONCURRENCY[toolName]?.concurrent ?? false
}

export function isBarrierTool(toolName: string): boolean {
  return TOOL_CONCURRENCY[toolName]?.barrier ?? false
}
