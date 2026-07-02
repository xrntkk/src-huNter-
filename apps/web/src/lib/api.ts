import type { Session, Endpoint, Finding, ModelsConfigFile, SystemInfo } from '@src-agent/types'

const BASE = '/api'

async function req<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(text)
  }
  return res.json() as Promise<T>
}

// ----- Shared response shapes -----

/** Slash-command metadata for the chat input autocomplete (no prompt body). */
export interface SlashCommandMeta {
  name: string
  label: string
  description: string
}

export interface FileTreeNode {
  name: string
  path: string
  type: 'file' | 'dir'
  size?: number
  modifiedAt?: number
  children?: FileTreeNode[]
}

export interface GraphNode {
  id: string
  type: string
  data: unknown
  position?: { x: number; y: number }
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  type?: string
  label?: string
}

export interface WorkspaceFile {
  type: string
  path: string
  name?: string
  size?: number
  modifiedAt?: number
  isBinary?: boolean
  isImage?: boolean
  mime?: string
  content?: string
}

export interface SkillSummary {
  name: string
  description: string
  enabled: boolean
  fileCount: number
}

export interface AgentSummary {
  name: string
  description: string
  whenToUse?: string
  tools?: string[]
  maxIterations?: number
  model?: string
  source: 'built-in' | 'custom'
  enabled: boolean
}

export const api = {
  sessions: {
    list: () => req<Session[]>('/sessions'),
    get: (id: string) => req<Session>(`/sessions/${id}`),
    create: (domain: string, title?: string) =>
      req<Session>('/sessions', {
        method: 'POST',
        body: JSON.stringify({ domain, title }),
      }),
    patch: (id: string, data: Partial<Pick<Session, 'status' | 'title'>>) =>
      req<Session>(`/sessions/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetch(`${BASE}/sessions/${id}`, { method: 'DELETE' }),
  },

  endpoints: {
    list: (sessionId: string) =>
      req<Endpoint[]>(`/sessions/${sessionId}/endpoints`),
    graph: (sessionId: string) =>
      req<{ nodes: GraphNode[]; edges: GraphEdge[] }>(
        `/sessions/${sessionId}/endpoint-graph`,
      ),
    memoryGraph: (sessionId: string) =>
      req<{ nodes: GraphNode[]; edges: GraphEdge[] }>(
        `/sessions/${sessionId}/memory-graph`,
      ),
    get: (id: string) =>
      req<Endpoint & { findings: Finding[] }>(`/endpoints/${id}`),
  },

  reports: {
    download: (sessionId: string) =>
      fetch(`${BASE}/sessions/${sessionId}/report`),
  },

  settings: {
    getEnv: () => req<Record<string, string>>('/settings/env'),
    updateEnv: (data: Record<string, string>) =>
      req<{ ok: boolean }>('/settings/env', { method: 'PATCH', body: JSON.stringify(data) }),
    getMcp: () => req<{ mcpServers: Record<string, unknown> }>('/settings/mcp'),
    updateMcp: (data: { mcpServers: Record<string, unknown> }) =>
      req<{ ok: boolean }>('/settings/mcp', { method: 'PATCH', body: JSON.stringify(data) }),
    getSkills: () => req<{ skills: SkillSummary[] }>('/settings/skills'),
    getSkill: (name: string) => req<{ name: string; content: string }>(`/settings/skills/${encodeURIComponent(name)}`),
    createSkill: (name: string, content: string) =>
      req<{ ok: boolean }>('/settings/skills', { method: 'POST', body: JSON.stringify({ name, content }) }),
    updateSkill: (name: string, content: string) =>
      req<{ ok: boolean }>(`/settings/skills/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify({ content }) }),
    deleteSkill: (name: string) =>
      req<{ ok: boolean }>(`/settings/skills/${encodeURIComponent(name)}`, { method: 'DELETE' }),
    setSkillEnabled: (name: string, enabled: boolean) =>
      req<{ ok: boolean }>(`/settings/skills/${encodeURIComponent(name)}/enabled`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
    getModels: () => req<ModelsConfigFile>('/settings/models'),
    updateModels: (data: ModelsConfigFile) =>
      req<{ ok: boolean }>('/settings/models', { method: 'PUT', body: JSON.stringify(data) }),
    getAgents: () => req<{ agents: AgentSummary[] }>('/settings/agents'),
    getAgent: (name: string) => req<{ name: string; content: string }>(`/settings/agents/${encodeURIComponent(name)}`),
    createAgent: (name: string, content: string) =>
      req<{ ok: boolean }>('/settings/agents', { method: 'POST', body: JSON.stringify({ name, content }) }),
    updateAgent: (name: string, content: string) =>
      req<{ ok: boolean }>(`/settings/agents/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify({ content }) }),
    deleteAgent: (name: string) =>
      req<{ ok: boolean }>(`/settings/agents/${encodeURIComponent(name)}`, { method: 'DELETE' }),
    setAgentEnabled: (name: string, enabled: boolean) =>
      req<{ ok: boolean }>(`/settings/agents/${encodeURIComponent(name)}/enabled`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
    getIntel: () => req<{ sources: Record<string, { cookie?: string; enabled?: boolean }> }>('/settings/intel'),
    updateIntel: (data: { sources: Record<string, { cookie?: string; enabled?: boolean }> }) =>
      req<{ ok: boolean }>('/settings/intel', { method: 'PATCH', body: JSON.stringify(data) }),
  },

  workspace: {
    tree: (sessionId: string) =>
      req<{ tree: FileTreeNode[]; path: string }>(`/sessions/${sessionId}/workspace`),
    file: (sessionId: string, filePath: string) =>
      req<WorkspaceFile>(`/sessions/${sessionId}/workspace/${filePath}`),
    write: (sessionId: string, filePath: string, content: string) =>
      req<{ success: boolean }>(`/sessions/${sessionId}/workspace/${filePath}`, { method: 'PUT', body: JSON.stringify({ content }) }),
  },

  system: {
    getInfo: () => req<SystemInfo>('/system/info'),
  },

  chat: {
    slashCommands: () => req<{ commands: SlashCommandMeta[] }>('/slash-commands'),
  },
}
