import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, type Dirent } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const SKILLS_ROOT = join(process.cwd(), '..', '..', 'packages', 'skills')
const SKILLS_CONFIG = resolve(process.cwd(), '..', '..', 'config', 'skills.json')

/** Read the set of globally-disabled skill names from config/skills.json. */
function readDisabledSkills(): Set<string> {
  try {
    const raw = readFileSync(SKILLS_CONFIG, 'utf-8')
    const parsed = JSON.parse(raw) as { disabled?: string[] }
    return new Set(parsed.disabled ?? [])
  } catch {
    return new Set()
  }
}

export function getDisabledSkills(): string[] {
  return [...readDisabledSkills()].sort()
}

/** Toggle a skill's enabled state, persisting to config/skills.json. */
export function setSkillEnabled(name: string, enabled: boolean): void {
  const disabled = readDisabledSkills()
  if (enabled) disabled.delete(name)
  else disabled.add(name)
  writeFileSync(SKILLS_CONFIG, JSON.stringify({ disabled: [...disabled].sort() }, null, 2) + '\n')
}

// Per-skill description cap in the catalog. Mirrors Claude Code's 250-char
// truncation — keeps the static prompt prefix bounded as skills grow.
const CATALOG_DESCRIPTION_MAX = 200
// Hard ceiling on the rendered catalog block. With ~80 imported skills the
// raw catalog rounds to ~20KB; 28KB cap leaves headroom for further additions
// without truncation. Still cached as a stable prompt prefix.
const CATALOG_TOTAL_MAX = 28000

export interface SkillSubDoc {
  /** Slug used as `subPath` in the load_skill tool — relative path from the skill dir, no extension. */
  path: string
  /** First-line heading or filename, for display. */
  title: string
}

export interface SkillMeta {
  name: string
  dir: string
  description: string
  whenToUse: string
  /** Markdown files inside the skill dir other than the entry SKILL.md, for progressive disclosure. */
  subDocs: SkillSubDoc[]
  /**
   * Optional tool contract declared in frontmatter (`allowed_tools`). When set,
   * loading this skill's entry doc narrows the agent's active tool set to this
   * list (plus a hardcoded escape-hatch set). Empty/undefined ⇒ no narrowing.
   */
  allowedTools?: string[]
}

interface DiscoveryCache {
  mtimeMs: number
  skills: SkillMeta[]
}

let discoveryCache: DiscoveryCache | undefined

function firstNonEmpty(...values: Array<string | undefined>): string {
  return values.find(v => v && v.trim().length > 0)?.trim() ?? ''
}

function parseFrontmatter(content: string): Record<string, string> {
  if (!content.startsWith('---')) return {}
  const end = content.indexOf('\n---', 3)
  if (end === -1) return {}
  const raw = content.slice(3, end).trim()
  const out: Record<string, string> = {}
  const lines = raw.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const idx = line.indexOf(':')
    // Indented continuation of a previous block scalar is consumed inside the
    // multi-line branch below; if we land here it's either a top-level key or
    // garbage we skip.
    if (idx === -1 || /^\s/.test(line)) { i++; continue }
    const key = line.slice(0, idx).trim()
    const rawValue = line.slice(idx + 1).trim()
    if (!key) { i++; continue }
    // YAML block scalar indicators: `>` / `>-` / `|` / `|-` / `>+` / `|+`
    // followed by indented content lines.
    const blockMatch = rawValue.match(/^([>|])([+-]?)\s*$/)
    if (blockMatch) {
      const folded = blockMatch[1] === '>'
      const collected: string[] = []
      i++
      // Consume all subsequent lines that are blank or more-indented than the key.
      while (i < lines.length) {
        const next = lines[i]
        if (next === '' || /^\s/.test(next)) {
          collected.push(next.replace(/^\s+/, ''))
          i++
        } else {
          break
        }
      }
      const joined = folded
        ? collected.map(l => l.trim()).filter(Boolean).join(' ')
        : collected.join('\n').trim()
      out[key] = joined
      continue
    }
    out[key] = rawValue.replace(/^['"]|['"]$/g, '')
    i++
  }
  return out
}

function extractHeading(content: string): string {
  const match = content.match(/^#\s+(.+)$/m)
  return match?.[1]?.trim() ?? ''
}

/**
 * Parse a frontmatter `allowed_tools` value into a tool-name list. Accepts both
 * a comma-separated string (`http_request, python_exec`) and an inline YAML
 * array (`[http_request, python_exec]`). Returns undefined when absent/empty so
 * skills without a contract stay in the legacy (no-narrowing) path.
 */
function parseAllowedTools(fm: Record<string, string>): string[] | undefined {
  const raw = fm.allowed_tools ?? fm['allowed-tools']
  if (!raw) return undefined
  const tools = raw
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map(t => t.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
  return tools.length > 0 ? tools : undefined
}

function extractDescription(content: string): string {
  const fm = parseFrontmatter(content)
  const heading = extractHeading(content)
  const firstParagraph = content
    .replace(/^---[\s\S]*?\n---\s*/, '')
    .split('\n')
    .map(l => l.trim())
    .find(l => l && !l.startsWith('#') && !l.startsWith('```'))
  return firstNonEmpty(fm.description, fm.summary, fm.when_to_use, heading, firstParagraph, '专项技能')
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max - 1).trimEnd() + '…'
}

function readEntryContent(dirPath: string): string {
  try {
    const skillPath = join(dirPath, 'SKILL.md')
    if (existsSync(skillPath)) return readFileSync(skillPath, 'utf-8')
    const files = readdirSync(dirPath).filter(f => f.endsWith('.md')).sort()
    if (!files.length) return ''
    return readFileSync(join(dirPath, files[0]), 'utf-8')
  } catch {
    return ''
  }
}

/** Walk a skill dir to enumerate non-entry markdown for progressive disclosure. */
function discoverSubDocs(dirPath: string): SkillSubDoc[] {
  const out: SkillSubDoc[] = []
  const root = resolve(dirPath)
  function walk(current: string, depth: number) {
    if (depth > 3) return
    let entries: Dirent[] = []
    try {
      entries = readdirSync(current, { withFileTypes: true }) as Dirent[]
    } catch {
      return
    }
    for (const entry of entries) {
      const entryName = String(entry.name)
      const full = join(current, entryName)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      if (!/\.(md|markdown)$/i.test(entryName)) continue
      const rel = relative(root, full)
      // Skip entry SKILL.md and obvious noise.
      if (/^SKILL\.md$/i.test(rel)) continue
      if (/^README\.md$/i.test(rel) && depth === 0) continue
      let title = entryName.replace(/\.(md|markdown)$/i, '')
      try {
        const head = readFileSync(full, 'utf-8').slice(0, 1024)
        const m = head.match(/^#\s+(.+)$/m)
        if (m?.[1]) title = m[1].trim()
      } catch { /* ignore */ }
      const slug = rel.replace(/\.(md|markdown)$/i, '').replace(/\\/g, '/')
      out.push({ path: slug, title })
    }
  }
  walk(root, 0)
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

function discoverSkillsFresh(): SkillMeta[] {
  try {
    return readdirSync(SKILLS_ROOT, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => {
        const dirPath = join(SKILLS_ROOT, d.name)
        const content = readEntryContent(dirPath)
        const fm = parseFrontmatter(content)
        const name = firstNonEmpty(fm.name, d.name)
        const description = extractDescription(content)
        const whenToUse = firstNonEmpty(fm.when_to_use, fm['when-to-use'], fm.description, description)
        const subDocs = discoverSubDocs(dirPath)
        const allowedTools = parseAllowedTools(fm)
        return { name, dir: d.name, description, whenToUse, subDocs, ...(allowedTools ? { allowedTools } : {}) }
      })
      .filter(s => s.name && s.description)
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

/** mtime of SKILLS_ROOT — cheap invalidation signal for the memoized catalog. */
function rootMtime(): number {
  try {
    return statSync(SKILLS_ROOT).mtimeMs
  } catch {
    return 0
  }
}

function discoverSkills(): SkillMeta[] {
  const mtime = rootMtime()
  if (discoveryCache && discoveryCache.mtimeMs === mtime) {
    return discoveryCache.skills
  }
  const skills = discoverSkillsFresh()
  discoveryCache = { mtimeMs: mtime, skills }
  return skills
}

/** Force re-scan on next access. Call from the settings reload hook. */
export function reloadSkills(): void {
  discoveryCache = undefined
}

export function getSkillCatalog(visibleNames?: string[]): SkillMeta[] {
  const disabled = readDisabledSkills()
  const all = discoverSkills().filter(s => !disabled.has(s.name) && !disabled.has(s.dir))
  if (!visibleNames || visibleNames.length === 0) return all
  const set = new Set(visibleNames)
  return all.filter(s => set.has(s.name) || set.has(s.dir))
}

/**
 * Build a token-budgeted catalog string for the system prompt. Each skill
 * entry's description is truncated to CATALOG_DESCRIPTION_MAX; the whole
 * block is hard-capped at CATALOG_TOTAL_MAX. Sub-document slugs are listed
 * inline so the model knows what `load_skill` subPaths exist without us
 * sending the bodies upfront.
 */
export function buildSkillCatalog(visibleNames?: string[]): string {
  const catalog = getSkillCatalog(visibleNames)
  if (catalog.length === 0) return ''

  const header = [
    '## 可用技能目录',
    '',
    '调用 `load_skill` 工具按需加载技能，加载后内容追加到系统提示。' +
      '若技能含子文档（标记 ▸），传 `subPath` 参数渐进式读取细节，避免一次性载入整个目录。',
    '',
  ]

  const lines: string[] = []
  let used = header.join('\n').length
  let truncatedCount = 0

  for (const s of catalog) {
    const desc = truncate(s.description.replace(/\s+/g, ' '), CATALOG_DESCRIPTION_MAX)
    const when = s.whenToUse && s.whenToUse !== s.description
      ? truncate(s.whenToUse.replace(/\s+/g, ' '), CATALOG_DESCRIPTION_MAX)
      : ''
    const block: string[] = []
    block.push(`- **${s.name}** — ${desc}`)
    if (when) block.push(`  使用场景：${when}`)
    if (s.subDocs.length > 0) {
      const list = s.subDocs.map(d => `\`${d.path}\``).join(', ')
      block.push(`  ▸ 子文档：${truncate(list, 400)}`)
    }
    const text = block.join('\n')
    if (used + text.length + 1 > CATALOG_TOTAL_MAX) {
      truncatedCount = catalog.length - lines.length
      break
    }
    lines.push(text)
    used += text.length + 1
  }
  if (truncatedCount > 0) {
    lines.push(`- …还有 ${truncatedCount} 个技能未列出（达到 catalog 长度上限）。需要时直接传名称给 \`load_skill\`。`)
  }

  return [...header, ...lines].join('\n')
}

/** Get available skill names. Optionally filtered to a visible subset. */
export function getSkillNames(visibleNames?: string[]): string[] {
  return getSkillCatalog(visibleNames).map(s => s.name)
}

/** Find a skill by name OR directory slug. */
function findSkill(name: string): SkillMeta | undefined {
  return discoverSkills().find(s => s.name === name || s.dir === name)
}

/**
 * Resolve a `subPath` against the skill dir, refusing escapes and only
 * returning content for files that were enumerated as sub-docs (so the model
 * can't poke at arbitrary files via the tool).
 */
function resolveSubDocPath(meta: SkillMeta, subPath: string): string | undefined {
  const normalized = subPath.replace(/\\/g, '/').replace(/^\.?\/+/, '')
  if (normalized.includes('..')) return undefined
  const match = meta.subDocs.find(d => d.path === normalized || d.path === normalized.replace(/\.(md|markdown)$/i, ''))
  if (!match) return undefined
  const candidates = [`${match.path}.md`, `${match.path}.markdown`]
  for (const rel of candidates) {
    const abs = resolve(SKILLS_ROOT, meta.dir, rel)
    const skillRoot = resolve(SKILLS_ROOT, meta.dir)
    if (!abs.startsWith(skillRoot)) return undefined
    if (existsSync(abs)) return abs
  }
  return undefined
}

/** Load full content of a single skill by name (entry document only). */
export function loadSkillByName(name: string): string {
  const meta = findSkill(name)
  if (!meta) return ''
  return readEntryContent(join(SKILLS_ROOT, meta.dir))
}

export interface LoadSkillResult {
  /** Resolved canonical name. */
  name: string
  /** subPath that was loaded; empty string for the entry document. */
  subPath: string
  /** Markdown body. */
  content: string
  /** Sub-doc slugs available for follow-up loads (only meaningful for entry doc). */
  subDocs: SkillSubDoc[]
  /** Tool contract from the skill's frontmatter (entry doc only). */
  allowedTools?: string[]
}

/**
 * Load a skill, optionally a specific sub-document inside its directory.
 * Returns undefined when not found, leaving the caller to render a helpful error.
 */
export function loadSkill(name: string, subPath?: string): LoadSkillResult | undefined {
  const meta = findSkill(name)
  if (!meta) return undefined
  if (!subPath) {
    const content = readEntryContent(join(SKILLS_ROOT, meta.dir))
    if (!content) return undefined
    return {
      name: meta.name,
      subPath: '',
      content,
      subDocs: meta.subDocs,
      ...(meta.allowedTools ? { allowedTools: meta.allowedTools } : {}),
    }
  }
  const abs = resolveSubDocPath(meta, subPath)
  if (!abs) return undefined
  try {
    const content = readFileSync(abs, 'utf-8')
    const slug = subPath.replace(/\.(md|markdown)$/i, '').replace(/\\/g, '/')
    return { name: meta.name, subPath: slug, content, subDocs: [] }
  } catch {
    return undefined
  }
}

/** Load only the skill catalog into the system prompt. */
export function loadSkillsForContext(visibleNames?: string[]): string {
  return buildSkillCatalog(visibleNames)
}
