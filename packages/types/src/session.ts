export type SessionStatus = 'idle' | 'crawling' | 'ready' | 'testing' | 'analyzing' | 'completed' | 'error'

export interface Session {
  id: string
  domain: string
  title: string | null
  status: SessionStatus
  createdAt: number
  updatedAt: number
  endpointCount?: number
  findingCount?: number
}

export interface CreateSessionInput {
  domain: string
  title?: string
}
