import type { RouteObject } from 'react-router'

export const routes: RouteObject[] = [
  {
    path: '/',
    lazy: async () => {
      const { HomePage } = await import('./routes/home.js')
      return { Component: HomePage }
    },
  },
  {
    path: '/session/:sessionId',
    lazy: async () => {
      const { SessionPage } = await import('./routes/session.js')
      return { Component: SessionPage }
    },
  },
  {
    path: '/settings',
    lazy: async () => {
      const { SettingsLayout } = await import('./routes/settings.js')
      return { Component: SettingsLayout }
    },
    children: [
      {
        index: true,
        lazy: async () => {
          const { LLMSettingsPage } = await import('./routes/settings-llm.js')
          return { Component: LLMSettingsPage }
        },
      },
      {
        path: 'mcp',
        lazy: async () => {
          const { MCPSettingsPage } = await import('./routes/settings-mcp.js')
          return { Component: MCPSettingsPage }
        },
      },
      {
        path: 'intel',
        lazy: async () => {
          const { IntelSettingsPage } = await import('./routes/settings-intel.js')
          return { Component: IntelSettingsPage }
        },
      },
      {
        path: 'skills',
        lazy: async () => {
          const { SkillsSettingsPage } = await import('./routes/settings-skills.js')
          return { Component: SkillsSettingsPage }
        },
      },
      {
        path: 'agents',
        lazy: async () => {
          const { AgentsSettingsPage } = await import('./routes/settings-agents.js')
          return { Component: AgentsSettingsPage }
        },
      },
      {
        path: 'general',
        lazy: async () => {
          const { GeneralSettingsPage } = await import('./routes/settings-general.js')
          return { Component: GeneralSettingsPage }
        },
      },
    ],
  },
]
