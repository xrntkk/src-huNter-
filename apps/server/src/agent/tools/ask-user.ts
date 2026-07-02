import { tool } from 'ai'
import { z } from 'zod'

/**
 * AskUser tool — modeled after Claude Code's AskUserQuestion.
 * The model invokes this when user intent is ambiguous and it needs
 * clarification before proceeding. Presents structured choices to
 * the user via the frontend.
 */
export const askUserTool = tool({
  description:
    '当用户意图不明确、存在多种可能的执行方向、或需要用户做出选择时，调用此工具向用户提问。' +
    '不要猜测用户意图，不确定时主动询问。' +
    '适用场景：(1) 用户指令模糊，有多种理解方式；(2) 存在多个可行方案需要用户选择；' +
    '(3) 需要额外信息才能继续（如目标范围、认证凭据、优先级）；' +
    '(4) 任务方向需要确认。',
  inputSchema: z.object({
    question: z.string().describe('向用户提出的问题，清晰具体'),
    options: z
      .array(
        z.object({
          label: z.string().describe('选项简短标签（1-5 个词）'),
          description: z.string().describe('选项含义或选择后的行为说明'),
        }),
      )
      .min(2)
      .max(5)
      .describe('供用户选择的选项列表，2-5 个。用户也可以自由输入不在选项中的回答'),
    context: z
      .string()
      .optional()
      .describe('可选的背景说明，帮助用户理解为什么需要做这个选择'),
  }),
  execute: async (params) => {
    return {
      type: 'ask_user' as const,
      question: params.question,
      options: params.options,
      context: params.context,
      awaiting_response: true,
    }
  },
})
