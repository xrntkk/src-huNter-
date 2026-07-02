import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import yaml from 'js-yaml'

export interface McpServerConfig {
  type: 'stdio' | 'sse'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  /** API key injected into URL (e.g. Firecrawl SSE: https://mcp.firecrawl.dev/{apiKey}/v2/mcp). */
  apiKey?: string
  /** When false, the manager skips connecting this server. Defaults to true. */
  enabled?: boolean
}

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>
}

export function loadMcpConfig(configPath?: string): McpConfig {
  const paths = [
    configPath,
    resolve(process.cwd(), 'config/mcp.yaml'),
    resolve(process.cwd(), '../../config/mcp.yaml'),
  ].filter(Boolean) as string[]

  for (const p of paths) {
    if (existsSync(p)) {
      const raw = readFileSync(p, 'utf-8')
      return yaml.load(raw) as McpConfig
    }
  }

  return { mcpServers: {} }
}
