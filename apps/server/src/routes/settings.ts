import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, rmSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import yaml from 'js-yaml'
import { mcpManager } from '../mcp/manager.js'
import { logger } from '../logger/index.js'
import { reloadSkills, getDisabledSkills, setSkillEnabled } from '../agent/skill-loader.js'
import {
  listAgentTypes, readCustomAgentYaml, writeCustomAgent, deleteCustomAgent, setAgentEnabled,
} from '../agent/agent-loader.js'
import { loadIntelConfig, saveIntelConfig } from '../agent/intel/config.js'
import {
  getRules,
  reloadPermissionsConfig,
  type PermissionConfigFile,
  type PermissionRule,
} from '../agent/permissions.js'
import { reloadModelsConfig } from '../agent/model-router.js'

const MCP_CONFIG_PATH = resolve(process.cwd(), '../../config/mcp.yaml')
const MODELS_CONFIG_PATH = resolve(process.cwd(), '../../config/models.json')
const PERMISSIONS_CONFIG_PATH = resolve(process.cwd(), '../../config/permissions.json')
const SKILLS_ROOT = resolve(process.cwd(), '../../packages/skills')

export const settingsRouter = new Hono()

/**
 * Extract a skill's human description. Prefers the YAML frontmatter
 * `description:` (supporting block scalars `>-` / `|`); falls back to the first
 * markdown heading. Returns '' when neither is present.
 */
function extractSkillDescription(content: string): string {
  if (content.startsWith('---')) {
    const end = content.indexOf('\n---', 3)
    if (end !== -1) {
      const fm = content.slice(3, end)
      const lines = fm.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^description:\s*(.*)$/)
        if (!m) continue
        const inline = m[1].trim()
        // Block scalar (`>-`, `>`, `|`, `|-`): gather following indented lines.
        if (/^[>|][+-]?$/.test(inline)) {
          const collected: string[] = []
          for (let j = i + 1; j < lines.length; j++) {
            if (lines[j] === '' || /^\s/.test(lines[j])) collected.push(lines[j].trim())
            else break
          }
          return collected.filter(Boolean).join(' ').trim()
        }
        return inline.replace(/^['"]|['"]$/g, '').trim()
      }
    }
  }
  const heading = content.split('\n').find(l => l.startsWith('#'))
  return heading ? heading.replace(/^#+\s*/, '').trim() : ''
}

// ========================
// Env Settings (Legacy)
// ========================

settingsRouter.get('/settings/env', async c => {
  return c.json({
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL || '',
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL || '',
    OVERRIDE_MODEL: process.env.OVERRIDE_MODEL || '',
    DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL || '',
    WEB_ORIGIN: process.env.WEB_ORIGIN || 'http://localhost:5173',
    DATABASE_URL: process.env.DATABASE_URL || './data/src-agent.db',
  })
})

settingsRouter.patch(
  '/settings/env',
  zValidator(
    'json',
    z.object({
      ANTHROPIC_BASE_URL: z.string().optional(),
      ANTHROPIC_MODEL: z.string().optional(),
      OVERRIDE_MODEL: z.string().optional(),
      DEEPSEEK_MODEL: z.string().optional(),
    }),
  ),
  async c => {
    const updates = c.req.valid('json')
    const envPath = resolve(process.cwd(), '.env')

    let envContent = ''
    try { envContent = readFileSync(envPath, 'utf-8') } catch {}

    for (const [key, value] of Object.entries(updates)) {
      const regex = new RegExp(`^${key}=.*$`, 'm')
      const line = `${key}=${value}`
      if (regex.test(envContent)) {
        envContent = envContent.replace(regex, line)
      } else {
        envContent += `\n${line}`
      }
      process.env[key] = value
    }

    writeFileSync(envPath, envContent.trim() + '\n')
    return c.json({ ok: true })
  },
)

// ========================
// Models Config
// ========================

settingsRouter.get('/settings/models', async c => {
  if (!existsSync(MODELS_CONFIG_PATH)) {
    return c.json({ models: [], activeModelId: '' })
  }
  try {
    const raw = readFileSync(MODELS_CONFIG_PATH, 'utf-8')
    return c.json(JSON.parse(raw))
  } catch {
    return c.json({ models: [], activeModelId: '' })
  }
})

settingsRouter.put(
  '/settings/models',
  zValidator(
    'json',
    z.object({
      models: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          provider: z.enum(['anthropic', 'openai', 'deepseek', 'openrouter', 'kimi', 'claude-cli']),
          baseURL: z.string(),
          apiKey: z.string(),
          modelId: z.string(),
          largeContext: z.boolean().optional(),
          toolProtocol: z.enum(['native', 'text']).optional(),
        }),
      ),
      activeModelId: z.string(),
      fastModelId: z.string().optional(),
      phaseModelIds: z
        .object({
          recon: z.string().optional(),
          enum: z.string().optional(),
          test: z.string().optional(),
          report: z.string().optional(),
        })
        .optional(),
    }),
  ),
  async c => {
    const config = c.req.valid('json')
    mkdirSync(dirname(MODELS_CONFIG_PATH), { recursive: true })
    writeFileSync(MODELS_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n')
    // Invalidate the model-router's mtime cache so subsequent getModel() calls
    // pick up the new config instead of the stale in-memory copy.
    reloadModelsConfig()
    return c.json({ ok: true })
  },
)

// ========================
// MCP Config
// ========================

settingsRouter.get('/settings/mcp', async c => {
  try {
    const raw = readFileSync(MCP_CONFIG_PATH, 'utf-8')
    return c.json(yaml.load(raw))
  } catch {
    return c.json({ mcpServers: {} })
  }
})

settingsRouter.patch(
  '/settings/mcp',
  zValidator(
    'json',
    z.object({
      mcpServers: z.record(
        z.object({
          type: z.enum(['stdio', 'sse']),
          command: z.string().optional(),
          args: z.array(z.string()).optional(),
          env: z.record(z.string()).optional(),
          url: z.string().optional(),
          headers: z.record(z.string()).optional(),
          apiKey: z.string().optional(),
          enabled: z.boolean().optional(),
        }),
      ),
    }),
  ),
  async c => {
    const config = c.req.valid('json')
    writeFileSync(MCP_CONFIG_PATH, yaml.dump(config, { indent: 2 }))

    // Hot-reload MCP clients
    try {
      await mcpManager.reload(config)
    } catch (err) {
      logger.warn('[Settings] MCP reload failed:', err)
    }

    return c.json({ ok: true })
  },
)

// ========================
// Intel Credentials (信息收集凭据)
// ========================

settingsRouter.get('/settings/intel', async c => {
  const config = loadIntelConfig()
  return c.json(config)
})

settingsRouter.patch(
  '/settings/intel',
  zValidator(
    'json',
    z.object({
      sources: z.record(
        z.object({
          cookie: z.string().optional(),
          enabled: z.boolean().optional(),
        }),
      ),
    }),
  ),
  async c => {
    const config = c.req.valid('json')
    saveIntelConfig(config)
    return c.json({ ok: true })
  },
)

// ========================
// Permissions (tool allow/ask/deny rules)
// ========================

settingsRouter.get('/settings/permissions', async c => {
  const rules = getRules()
  const config: PermissionConfigFile = { rules }
  return c.json(config)
})

settingsRouter.patch(
  '/settings/permissions',
  zValidator(
    'json',
    z.object({
      rules: z.array(
        z.object({
          toolName: z.string().min(1),
          behavior: z.enum(['allow', 'deny', 'ask']),
          argFilter: z.record(z.string()).optional(),
        }),
      ),
    }),
  ),
  async c => {
    const { rules } = c.req.valid('json') as { rules: PermissionRule[] }
    const config: PermissionConfigFile = { rules }
    mkdirSync(dirname(PERMISSIONS_CONFIG_PATH), { recursive: true })
    writeFileSync(PERMISSIONS_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n')
    // Invalidate the permissions mtime cache so subsequent getRules() calls
    // pick up the new config instead of the stale in-memory copy.
    reloadPermissionsConfig()
    return c.json({ ok: true })
  },
)

// ========================
// Skills
// ========================

settingsRouter.get('/settings/skills', async c => {
  if (!existsSync(SKILLS_ROOT)) {
    return c.json({ skills: [] })
  }

  const skills: Array<{ name: string; description: string; enabled: boolean; fileCount: number }> = []
  const entries = readdirSync(SKILLS_ROOT, { withFileTypes: true })
  const disabled = new Set(getDisabledSkills())

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const skillDir = join(SKILLS_ROOT, entry.name)
      const skillMd = join(skillDir, 'SKILL.md')
      let desc = entry.name
      let fileCount = 0

      if (existsSync(skillMd)) {
        const content = readFileSync(skillMd, 'utf-8')
        desc = extractSkillDescription(content) || entry.name

        // Count markdown files
        try {
          const countMdFiles = (dir: string): number => {
            let count = 0
            for (const item of readdirSync(dir, { withFileTypes: true })) {
              if (item.isDirectory()) {
                count += countMdFiles(join(dir, item.name))
              } else if (item.name.endsWith('.md')) {
                count++
              }
            }
            return count
          }
          fileCount = countMdFiles(skillDir)
        } catch {}
      }

      skills.push({
        name: entry.name,
        description: desc,
        enabled: !disabled.has(entry.name),
        fileCount,
      })
    }
  }

  return c.json({ skills })
})

// GET single skill content
settingsRouter.get('/settings/skills/:name', async c => {
  const name = c.req.param('name')
  const skillDir = join(SKILLS_ROOT, name)
  const skillMd = join(skillDir, 'SKILL.md')

  if (!existsSync(skillMd)) {
    return c.json({ error: 'Skill not found' }, 404)
  }

  const content = readFileSync(skillMd, 'utf-8')
  return c.json({ name, content })
})

// Toggle a skill's enabled state (persisted to config/skills.json)
settingsRouter.patch(
  '/settings/skills/:name/enabled',
  zValidator('json', z.object({ enabled: z.boolean() })),
  async c => {
    const name = c.req.param('name')
    const skillDir = join(SKILLS_ROOT, name)
    if (!existsSync(skillDir)) {
      return c.json({ error: 'Skill not found' }, 404)
    }
    setSkillEnabled(name, c.req.valid('json').enabled)
    reloadSkills()
    return c.json({ ok: true })
  },
)

// Create new skill
settingsRouter.post(
  '/settings/skills',
  zValidator(
    'json',
    z.object({
      name: z.string().min(1).regex(/^[a-z0-9_-]+$/i),
      content: z.string().min(1),
    }),
  ),
  async c => {
    const { name, content } = c.req.valid('json')
    const skillDir = join(SKILLS_ROOT, name)

    if (existsSync(skillDir)) {
      return c.json({ error: 'Skill already exists' }, 409)
    }

    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), content)
    reloadSkills()
    return c.json({ ok: true })
  },
)

// Update skill content
settingsRouter.put(
  '/settings/skills/:name',
  zValidator('json', z.object({ content: z.string() })),
  async c => {
    const name = c.req.param('name')
    const { content } = c.req.valid('json')
    const skillMd = join(SKILLS_ROOT, name, 'SKILL.md')

    if (!existsSync(skillMd)) {
      return c.json({ error: 'Skill not found' }, 404)
    }

    writeFileSync(skillMd, content)
    reloadSkills()
    return c.json({ ok: true })
  },
)

// Delete skill
settingsRouter.delete('/settings/skills/:name', async c => {
  const name = c.req.param('name')
  const skillDir = join(SKILLS_ROOT, name)

  if (!existsSync(skillDir)) {
    return c.json({ error: 'Skill not found' }, 404)
  }

  rmSync(skillDir, { recursive: true, force: true })
  reloadSkills()
  return c.json({ ok: true })
})

// ========================
// Agent Types (sub-agent roles)
// ========================

// List all agent types (built-in + custom) with source + enabled state.
settingsRouter.get('/settings/agents', async c => {
  return c.json({ agents: listAgentTypes() })
})

// GET a custom agent's raw YAML (built-ins have no editable file → 404).
settingsRouter.get('/settings/agents/:name', async c => {
  const name = c.req.param('name')
  const content = readCustomAgentYaml(name)
  if (content === undefined) {
    return c.json({ error: 'No editable file (built-in agents are read-only)' }, 404)
  }
  return c.json({ name, content })
})

// Create or update a custom agent's YAML. Editing a built-in writes a custom
// override file of the same name (custom takes precedence in the loader).
settingsRouter.put(
  '/settings/agents/:name',
  zValidator('json', z.object({ content: z.string().min(1) })),
  async c => {
    const name = c.req.param('name')
    const result = writeCustomAgent(name, c.req.valid('json').content)
    if ('error' in result) return c.json(result, 400)
    return c.json({ ok: true })
  },
)

// Create a new custom agent.
settingsRouter.post(
  '/settings/agents',
  zValidator('json', z.object({
    name: z.string().min(1).regex(/^[a-z0-9_-]+$/i),
    content: z.string().min(1),
  })),
  async c => {
    const { name, content } = c.req.valid('json')
    if (readCustomAgentYaml(name) !== undefined) {
      return c.json({ error: 'Agent already exists' }, 409)
    }
    const result = writeCustomAgent(name, content)
    if ('error' in result) return c.json(result, 400)
    return c.json({ ok: true })
  },
)

// Toggle an agent's enabled state (persisted to config/agents.json).
settingsRouter.patch(
  '/settings/agents/:name/enabled',
  zValidator('json', z.object({ enabled: z.boolean() })),
  async c => {
    setAgentEnabled(c.req.param('name'), c.req.valid('json').enabled)
    return c.json({ ok: true })
  },
)

// Delete a custom agent file. Built-ins cannot be deleted (only disabled).
settingsRouter.delete('/settings/agents/:name', async c => {
  const name = c.req.param('name')
  if (!deleteCustomAgent(name)) {
    return c.json({ error: 'Not a custom agent (built-ins cannot be deleted, only disabled)' }, 404)
  }
  return c.json({ ok: true })
})
