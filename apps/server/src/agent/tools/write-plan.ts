/**
 * write_plan — the model records its own exploration plan as freeform text.
 *
 * This is a lightweight replacement for the old create_plan tool which used
 * LLM-driven structured plan generation + Intent nodes. Now the model owns
 * its plan entirely — no backend enforcement, no status machine.
 */

import { tool } from 'ai'
import { z } from 'zod'
import type { PlanNotes } from '../plan-notes.js'

export function createWritePlanTool(planNotes: PlanNotes) {
  return tool({
    description:
      '记录或更新你的探索计划。写下你接下来打算做什么、为什么这么做。' +
      '这是你自己的笔记，帮助你在长对话中保持方向感。每次调用会覆盖之前的计划。' +
      '适合：首次接触目标时梳理思路、阶段切换时更新方向、发现重大线索后调整策略。',
    inputSchema: z.object({
      plan: z.string().describe('计划内容，自由格式 markdown 文本。建议包含：目标、当前阶段、待办事项、策略思考。'),
    }),
    execute: async ({ plan }) => {
      planNotes.set(plan)
      return { success: true, summary: '计划已更新' }
    },
  })
}
