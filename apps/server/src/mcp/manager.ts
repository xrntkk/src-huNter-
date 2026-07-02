import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createMCPClient, type MCPClient } from '@ai-sdk/mcp'
import { type Tool } from 'ai'
import { type McpConfig, loadMcpConfig } from './config.js'
import { untrustedBlock } from '../agent/untrusted.js'
import { logger } from '../logger/index.js'

/**
 * MCP 工具返回的内容来自外部服务器（可能是抓回的页面、第三方 API），属于
 * 攻击者可控数据 → 包一层 nonce 隔离防 prompt injection。兼容 MCP 标准的
 * `content: [{type:'text', text}]` 形态与纯字符串/对象返回。
 */
function wrapMcpExecute(t: Tool): Tool {
  const orig = (t as any).execute
  if (typeof orig !== 'function') return t
  const wrapped = async (...args: any[]) => {
    const out = await orig(...args)
    if (typeof out === 'string') return untrustedBlock(out)
    if (out && typeof out === 'object' && Array.isArray((out as any).content)) {
      return {
        ...out,
        content: (out as any).content.map((p: any) =>
          p && p.type === 'text' && typeof p.text === 'string'
            ? { ...p, text: untrustedBlock(p.text) }
            : p
        ),
      }
    }
    return out
  }
  return { ...(t as any), execute: wrapped } as Tool
}

interface ConnectedServer {
  client: MCPClient
  instructions?: string
}

export class McpManager {
  private clients = new Map<string, ConnectedServer>()
  private toolCache: Record<string, Tool> | null = null

  async init(config?: McpConfig) {
    const cfg = config ?? loadMcpConfig()

    for (const [name, serverCfg] of Object.entries(cfg.mcpServers).sort(([a], [b]) => a.localeCompare(b))) {
      if (serverCfg.enabled === false) {
        logger.info(`[MCP] Skipping ${name}: disabled`)
        continue
      }
      try {
        // @ai-sdk/mcp ships sse/http transports natively. For stdio we hand it
        // the official SDK's StdioClientTransport instance — it is structurally
        // compatible with the MCPTransport interface (start/send/close + event
        // handlers).
        let client: MCPClient
        if (serverCfg.type === 'stdio' && serverCfg.command) {
          const transport = new StdioClientTransport({
            command: serverCfg.command,
            args: serverCfg.args ?? [],
            env: { ...process.env, ...(serverCfg.env ?? {}) } as Record<string, string>,
          })
          client = await createMCPClient({ transport, clientName: `src-agent/${name}` })
        } else if (serverCfg.type === 'sse' && serverCfg.url) {
          // Resolve {apiKey} placeholder in URL (e.g. Firecrawl: https://mcp.firecrawl.dev/{apiKey}/v2/mcp)
          const resolvedUrl = serverCfg.apiKey
            ? serverCfg.url.replace('{apiKey}', serverCfg.apiKey)
            : serverCfg.url
          client = await createMCPClient({
            transport: { type: 'sse', url: resolvedUrl, headers: serverCfg.headers },
            clientName: `src-agent/${name}`,
          })
        } else {
          logger.warn(`[MCP] Skipping ${name}: invalid config`)
          continue
        }

        this.clients.set(name, { client, instructions: client.instructions })
        logger.info(`[MCP] Connected: ${name}`)
      } catch (err) {
        logger.warn(`[MCP] Failed to connect ${name}:`, err instanceof Error ? err.message : err)
      }
    }
  }

  async reload(config?: McpConfig) {
    logger.info('[MCP] Reloading configuration...')
    await this.close()
    this.toolCache = null
    await this.init(config)
    logger.info(`[MCP] Reloaded. Connected ${this.clients.size} servers.`)
  }

  buildInstructionsContext(): string {
    const sections: string[] = []
    for (const [serverName, state] of [...this.clients.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (state.instructions?.trim()) {
        sections.push(`### ${serverName}\n${state.instructions.trim()}`)
      }
    }
    return sections.join('\n\n')
  }

  async getToolsForAI(): Promise<Record<string, Tool>> {
    if (this.toolCache) return this.toolCache
    const tools: Record<string, Tool> = {}

    for (const [serverName, state] of [...this.clients.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      try {
        const serverTools = await state.client.tools()
        for (const toolName of Object.keys(serverTools).sort()) {
          const t = serverTools[toolName] as Tool
          // Some MCP servers emit tools with invalid JSON Schema (e.g.
          // `required: false` instead of an array, or `parameters: false`).
          // These cause 400 errors from providers that strictly validate.
          // Sanitize or skip such tools.
          const params = (t as any).parameters
          if (params === false || params === true) {
            logger.warn(`[MCP] Skipping ${serverName}__${toolName}: parameters is boolean`)
            continue
          }
          // Fix `required: false` → remove it (no required params)
          if (params && typeof params === 'object' && 'jsonSchema' in params) {
            const schema = (params as any).jsonSchema
            if (schema && schema.required === false) {
              delete schema.required
            }
          }
          tools[`${serverName}__${toolName}`] = wrapMcpExecute(t)
        }
      } catch (err) {
        logger.warn(`[MCP] Failed to list tools for ${serverName}:`, err)
      }
    }

    this.toolCache = tools
    return tools
  }

  async close() {
    for (const { client } of this.clients.values()) {
      await client.close().catch(() => {})
    }
    this.clients.clear()
  }
}

export const mcpManager = new McpManager()
