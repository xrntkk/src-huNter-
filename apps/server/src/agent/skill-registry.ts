/**
 * SkillRegistry — session-scoped skill storage.
 *
 * Skills loaded via `load_skill` are stored here, NOT injected into the timeline.
 * The agent loop pulls skill content from the registry and appends it to the
 * system prompt on each generateText() call. This means:
 *
 * - Skill docs never pollute the timeline / conversation history
 * - They survive timeline compression (not counted as tokens in timeline)
 * - They are automatically dropped when the agent run ends (registry is GC'd)
 * - Sub-documents (e.g. "src-web-vuln#idor") are stored under composite keys
 *   so progressive disclosure of a skill's reference docs is supported.
 */

interface LoadedEntry {
  /** Skill name (without subPath). */
  name: string
  /** subPath inside the skill dir; empty string means the entry SKILL.md. */
  subPath: string
  /** Markdown body. */
  content: string
}

function makeKey(name: string, subPath: string): string {
  return subPath ? `${name}#${subPath}` : name
}

export class SkillRegistry {
  private loaded = new Map<string, LoadedEntry>()
  /**
   * Active tool contract. Set when a skill declaring `allowed_tools` is loaded;
   * the agent loop reads getActiveTools() each step to narrow the visible tool
   * set. Cleared by loading a contract-less skill or an explicit release.
   */
  private activeContract?: { skill: string; allowedTools: string[] }

  /** Load (or replace) a skill / sub-document. */
  load(name: string, content: string, subPath = ''): void {
    this.loaded.set(makeKey(name, subPath), { name, subPath, content })
  }

  /** Set the active tool contract — narrows the agent's visible tools to this list. */
  setContract(skill: string, allowedTools: string[]): void {
    this.activeContract = { skill, allowedTools }
  }

  /** Clear the active contract — restores the full tool set. */
  clearContract(): void {
    this.activeContract = undefined
  }

  /**
   * Unload a skill and all its sub-documents from the registry, freeing the
   * context it occupied in the system prompt. Also clears the active contract
   * if it belongs to this skill. Returns the number of entries removed.
   */
  unload(name: string): number {
    let removed = 0
    for (const key of Array.from(this.loaded.keys())) {
      const entry = this.loaded.get(key)!
      if (entry.name === name) {
        this.loaded.delete(key)
        removed++
      }
    }
    if (this.activeContract?.skill === name) {
      this.activeContract = undefined
    }
    return removed
  }

  /** Tools allowed by the active contract, or undefined when none is active. */
  getActiveTools(): string[] | undefined {
    return this.activeContract?.allowedTools
  }

  /** Name of the skill whose contract is currently active, if any. */
  getActiveSkill(): string | undefined {
    return this.activeContract?.skill
  }

  has(name: string, subPath = ''): boolean {
    return this.loaded.has(makeKey(name, subPath))
  }

  count(): number {
    return this.loaded.size
  }

  /** All currently-loaded entries as `name` or `name#subPath` strings. */
  keys(): string[] {
    return Array.from(this.loaded.keys())
  }

  /**
   * Distinct skill names currently loaded (one per skill, ignoring subPath).
   * Useful for stop-event payloads and UI surfacing.
   */
  names(): string[] {
    const set = new Set<string>()
    for (const entry of this.loaded.values()) set.add(entry.name)
    return Array.from(set)
  }

  /** Build a system-prompt fragment grouping entries by skill. */
  buildSystemFragment(): string {
    if (this.loaded.size === 0) return ''
    const grouped = new Map<string, LoadedEntry[]>()
    for (const entry of this.loaded.values()) {
      const arr = grouped.get(entry.name) ?? []
      arr.push(entry)
      grouped.set(entry.name, arr)
    }
    const parts: string[] = ['## 已加载的技能文档（参考以下方法论执行任务）', '']
    const activeSkill = this.activeContract?.skill
    for (const [name, entries] of grouped) {
      // Entry doc first, then sub-docs in stable order.
      entries.sort((a, b) => {
        if (!a.subPath && b.subPath) return -1
        if (a.subPath && !b.subPath) return 1
        return a.subPath.localeCompare(b.subPath)
      })
      parts.push(`### Skill: ${name}`)
      if (name === activeSkill) {
        parts.push(
          `**⚡ 当前激活技能：${name}。本轮工具集已收窄到该技能声明的范围。` +
            `专注执行其方法论，完成后传 release:true 释放聚焦并移除文档以释放上下文空间，` +
            `或用 unload 参数移除其他已完成技能的文档。**`,
        )
      }
      for (const e of entries) {
        if (e.subPath) parts.push(`#### 子文档: ${e.subPath}`)
        parts.push(e.content)
        parts.push('')
      }
    }
    return parts.join('\n')
  }

  clear(): void {
    this.loaded.clear()
    this.activeContract = undefined
  }
}
