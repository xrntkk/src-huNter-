import type { Endpoint } from '@src-agent/types'

/** sampleResponse.body cap enforced by the import schema — truncate so the
 *  exported file round-trips cleanly back through import_endpoints. */
const RESP_BODY_CAP = 500

/**
 * Shape an Endpoint to the import-compatible item (same fields as
 * add_endpoints_batch / import_endpoints). DB-internal fields (id, sessionId,
 * createdAt, verificationStatus, params, sourceUrl) are dropped so the result
 * round-trips through import.
 */
function toImportItem(ep: Endpoint): Record<string, unknown> {
  const item: Record<string, unknown> = {
    url: ep.url,
    method: ep.method,
    pathTemplate: ep.pathTemplate,
    source: ep.source,
  }
  const description = (ep as { description?: string | null }).description
  if (description) item.description = description
  if (ep.sampleRequest) item.sampleRequest = ep.sampleRequest
  if (ep.sampleResponse) {
    item.sampleResponse = {
      status: ep.sampleResponse.status,
      body: String(ep.sampleResponse.body ?? '').slice(0, RESP_BODY_CAP),
    }
  }
  if (ep.techStack?.length) item.techStack = ep.techStack
  if (ep.riskHints?.length) item.riskHints = ep.riskHints
  return item
}

/** Trigger a browser download of `endpoints` as an import-compatible JSON file. */
export function downloadEndpointsJson(endpoints: Endpoint[], filename: string): void {
  const items = endpoints.map(toImportItem)
  const blob = new Blob([JSON.stringify(items, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
