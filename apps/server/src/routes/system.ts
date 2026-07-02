import { Hono } from 'hono'
import { detectClaudeCli } from '../utils/claude-cli-detect.js'
import { STATIC_PROMPT_SECTIONS } from '../prompts/system.js'
import { PromptBuilder } from '../agent/prompt-builder.js'
import { SkillRegistry } from '../agent/skill-registry.js'

export const systemRouter = new Hono()

systemRouter.get('/system/info', c =>
  c.json({
    claudeCli: detectClaudeCli(),
    langfuse: {
      enabled: !!(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY),
      baseURL: process.env.LANGFUSE_BASE_URL ?? null,
    },
  }),
)

systemRouter.get('/debug/prompt-sections', c => {
  const builder = new PromptBuilder({ skillRegistry: new SkillRegistry() })
  const sections = builder.buildSections()
  const tokens = builder.tokenEstimate()

  return c.json({
    sections: sections.map(s => ({
      name: s.name,
      cacheable: s.cacheable,
      chars: s.content.length,
      tokens: tokens[s.name] ?? 0,
    })),
    total: {
      chars: sections.reduce((sum, s) => sum + s.content.length, 0),
      tokens: tokens._total ?? 0,
    },
    staticSectionCount: STATIC_PROMPT_SECTIONS.length,
  })
})
