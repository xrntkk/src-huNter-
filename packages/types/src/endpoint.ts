export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'UNKNOWN'
export type EndpointSource = 'js_parse' | 'network_intercept' | 'page_link' | 'form' | 'manual'
export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical'
export type FindingStatus = 'unconfirmed' | 'confirmed' | 'false_positive'
export type FindingType =
  | 'idor'
  | 'sqli'
  | 'xss'
  | 'ssrf'
  | 'ssti'
  | 'rce'
  | 'logic'
  | 'auth_bypass'
  | 'info_disclosure'
  | 'other'

export interface EndpointParam {
  name: string
  type: 'string' | 'number' | 'boolean' | 'object' | 'array'
  sampleValue?: string
  required?: boolean
}

export interface EndpointParams {
  path?: Record<string, EndpointParam>
  query?: Record<string, EndpointParam>
  body?: Record<string, EndpointParam>
}

export interface SampleRequest {
  headers?: Record<string, string>
  body?: string
}

export interface SampleResponse {
  status: number
  body: string
  contentType?: string
}

export interface Endpoint {
  id: string
  sessionId: string
  url: string
  method: HttpMethod
  pathTemplate: string
  params: EndpointParams | null
  sampleRequest: SampleRequest | null
  sampleResponse: SampleResponse | null
  source: EndpointSource
  sourceUrl: string | null
  techStack: string[]
  riskHints: string[]
  createdAt: number
}

export interface Finding {
  id: string
  sessionId: string
  endpointId: string | null
  type: FindingType
  severity: Severity
  title: string
  description: string | null
  reproSteps: string[]
  evidence: {
    request?: string
    response?: string
    screenshot?: string
  } | null
  status: FindingStatus
  createdAt: number
}
