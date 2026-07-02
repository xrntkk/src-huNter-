import { tool } from 'ai'
import { z } from 'zod'
import { loadSkill, getSkillNames, getSkillCatalog } from '../skill-loader.js'
import { SkillRegistry } from '../skill-registry.js'
import type { MessageStore } from '../message-store.js'

interface LoadSkillToolOptions {
  /**
   * If provided and non-empty, restricts which skills the agent may load this turn.
   * Names outside this set are rejected even if they exist on disk — the user
   * has narrowed the agent's visible skill catalog.
   */
  getVisibleSkillNames?: () => string[] | undefined
}

export function createLoadSkillTool(
  registry: SkillRegistry,
  store?: MessageStore,
  options: LoadSkillToolOptions = {},
) {
  return tool({
    description:
      '按需加载指定 skill 的文档到当前上下文中。' +
      '不传 subPath 时加载该 skill 的 SKILL.md 主文档；传 subPath（如 "idor"、"jwt/exploits"）时只加载对应子文档。' +
      '加载后内容作为系统提示的一部分供你参考，不会污染对话历史。先看主文档了解概览，再按需逐个 subPath 拉取细节，避免一次塞入整个目录。',
    inputSchema: z.object({
      skill: z.string().describe('要加载的 skill 名称。必须来自系统提示中的可用技能目录。'),
      subPath: z
        .string()
        .optional()
        .describe(
          '可选：技能目录内的子文档路径（不含 .md 扩展），仅加载该子文档。例如对 src-web-vuln 传 "idor" 加载 IDOR 测试细节。' +
            '可用 subPath 列表见技能目录里 ▸ 标注。',
        ),
      release: z
        .boolean()
        .optional()
        .describe(
          '可选：传 true 释放当前激活技能的聚焦模式并从上下文中移除该技能文档，' +
            '释放上下文空间并恢复完整工具集。任务完成后用此参数清理已不需要的技能。',
        ),
      unload: z
        .string()
        .optional()
        .describe(
          '可选：从上下文中移除指定技能（及其所有子文档），但不影响当前工具聚焦。' +
            '用于清理已完成任务的技能文档以释放上下文空间。传入技能名称即可。',
        ),
    }),
    execute: async ({ skill, subPath, release, unload }) => {
      // Unload a specific skill without affecting the active contract.
      if (unload) {
        const removed = registry.unload(unload)
        if (removed > 0) {
          store?.removeSkillLoaded(unload)
          return {
            loaded: false,
            unloaded: true,
            skillName: unload,
            entriesRemoved: removed,
            message: `已从上下文中移除技能 ${unload}（${removed} 个文档），释放了上下文空间。`,
          }
        }
        return {
          loaded: false,
          unloaded: false,
          skillName: unload,
          message: `技能 ${unload} 未加载，无需移除。`,
        }
      }

      if (release) {
        // Release the active contract AND unload its skill body from context.
        const activeSkill = registry.getActiveSkill()
        registry.clearContract()
        if (activeSkill) {
          const removed = registry.unload(activeSkill)
          if (removed > 0) store?.removeSkillLoaded(activeSkill)
          return {
            loaded: false,
            released: true,
            skillName: activeSkill,
            entriesRemoved: removed,
            message: `已释放技能 ${activeSkill} 的聚焦模式并从上下文中移除其文档（${removed} 个），恢复完整工具集。`,
          }
        }
        return {
          loaded: false,
          released: true,
          message: '已释放技能聚焦模式，恢复完整工具集。（当前无激活技能文档需要移除）',
        }
      }

      const sub = subPath?.trim() || ''

      if (registry.has(skill, sub)) {
        // Re-loading an already-cached entry doc re-applies its contract so the
        // model can re-focus a skill it loaded earlier (e.g. after switching away).
        let reHint = ''
        if (!sub) {
          const meta = getSkillCatalog().find(s => s.name === skill || s.dir === skill)
          if (meta?.allowedTools?.length) {
            registry.setContract(meta.name, meta.allowedTools)
            reHint = ` 已重新进入聚焦模式，工具集收窄至：${meta.allowedTools.join('、')}。`
          } else {
            registry.clearContract()
          }
        }
        return {
          loaded: true,
          skillName: skill,
          subPath: sub || undefined,
          message: (sub
            ? `子文档 ${skill}#${sub} 已加载，可继续执行。`
            : `skill ${skill} 已加载，可直接参考其方法论继续执行。`) + reHint,
        }
      }

      const visible = options.getVisibleSkillNames?.()
      if (visible && visible.length > 0 && !visible.includes(skill)) {
        return {
          loaded: false,
          skillName: skill,
          availableSkills: visible,
          message: `skill ${skill} 不在当前可见范围内。本轮可见 skill: ${visible.join(', ')}`,
        }
      }

      const result = loadSkill(skill, sub || undefined)
      if (!result) {
        if (sub) {
          // Help the model recover by listing the actual sub-doc slugs.
          const meta = getSkillCatalog().find(s => s.name === skill || s.dir === skill)
          const validSubs = meta?.subDocs.map(d => d.path) ?? []
          return {
            loaded: false,
            skillName: skill,
            subPath: sub,
            availableSubPaths: validSubs,
            message: validSubs.length > 0
              ? `子文档 ${skill}#${sub} 不存在。${skill} 可用子文档: ${validSubs.join(', ')}`
              : `${skill} 没有子文档；不传 subPath 直接加载主文档即可。`,
          }
        }
        return {
          loaded: false,
          skillName: skill,
          availableSkills: getSkillNames(visible),
          message: `未找到 skill: ${skill}。可用 skill: ${getSkillNames(visible).join(', ')}`,
        }
      }

      registry.load(result.name, result.content, result.subPath)
      store?.addSkillLoaded(result.subPath ? `${result.name}#${result.subPath}` : result.name)

      // Apply (or clear) the tool contract. Contracts live on the entry doc
      // only — loading a sub-doc leaves whatever contract is active untouched.
      let contractHint = ''
      if (!result.subPath) {
        if (result.allowedTools && result.allowedTools.length > 0) {
          registry.setContract(result.name, result.allowedTools)
          contractHint = ` 已进入聚焦模式，本轮工具集收窄至：${result.allowedTools.join('、')}（外加 load_skill/ask_user/add_finding/list_endpoints 始终可用）。完成后切换技能或传 release:true 释放。`
        } else {
          // Contract-less entry doc clears any prior focus.
          registry.clearContract()
        }
      }

      const subDocHint = !result.subPath && result.subDocs.length > 0
        ? ` 该 skill 还有 ${result.subDocs.length} 个子文档可按需加载: ${result.subDocs.map(d => d.path).join(', ')}。`
        : ''

      return {
        loaded: true,
        skillName: result.name,
        subPath: result.subPath || undefined,
        availableSubPaths: !result.subPath ? result.subDocs.map(d => d.path) : undefined,
        contractTools: !result.subPath && result.allowedTools?.length ? result.allowedTools : undefined,
        message:
          (result.subPath
            ? `已加载子文档: ${result.name}#${result.subPath}（${result.content.length} 字符）。`
            : `已加载 skill: ${result.name}（${result.content.length} 字符）。`) +
          contractHint +
          subDocHint +
          ' 内容已注入系统提示，请继续执行任务。',
      }
    },
  })
}
