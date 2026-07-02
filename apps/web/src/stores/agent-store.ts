import { create } from 'zustand'

type AgentStatus = 'idle' | 'running' | 'error'

interface AgentStore {
  status: AgentStatus
  statusMessage: string
  setStatus: (status: AgentStatus, message?: string) => void
}

export const useAgentStore = create<AgentStore>(set => ({
  status: 'idle',
  statusMessage: '',
  setStatus: (status, message = '') => set({ status, statusMessage: message }),
}))
