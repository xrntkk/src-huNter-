import { create } from 'zustand'
import type { Session } from '@src-agent/types'

interface SessionStore {
  currentSession: Session | null
  selectedEndpointIds: string[]
  setCurrentSession: (session: Session | null) => void
  setSelectedEndpointIds: (ids: string[]) => void
  toggleEndpointSelection: (id: string) => void
  clearSelection: () => void
}

export const useSessionStore = create<SessionStore>(set => ({
  currentSession: null,
  selectedEndpointIds: [],

  setCurrentSession: session => set({ currentSession: session }),

  setSelectedEndpointIds: ids => set({ selectedEndpointIds: ids }),

  toggleEndpointSelection: id =>
    set(s => ({
      selectedEndpointIds: s.selectedEndpointIds.includes(id)
        ? s.selectedEndpointIds.filter(x => x !== id)
        : [...s.selectedEndpointIds, id],
    })),

  clearSelection: () => set({ selectedEndpointIds: [] }),
}))
