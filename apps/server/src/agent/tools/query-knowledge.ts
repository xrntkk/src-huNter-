import { tool } from 'ai'
import { z } from 'zod'
import { searchKnowledge } from '@src-agent/knowledge'

export const queryKnowledgeTool = tool({
  description:
    '查询本地安全知识库，获取特定漏洞类型的测试技巧、Payload、绕过方法。适合在测试前快速获取相关知识。',
  inputSchema: z.object({
    query: z.string().describe('查询内容，如 "IDOR越权测试方法"、"SQL注入payload"、"JWT alg:none"'),
    skillFilter: z
      .enum(['src-web-vuln', 'payloads-everything', 'src-recon'])
      .optional()
      .describe('限定搜索范围的 Skill 目录（可选）'),
    topK: z.number().int().min(1).max(10).default(3),
  }),
  execute: async ({ query, skillFilter, topK }) => {
    const results = await searchKnowledge(query, topK, skillFilter)
    if (!results.length) {
      return { found: false, message: '知识库中未找到相关内容' }
    }
    return {
      found: true,
      results: results.map(r => ({
        source: r.source,
        score: r.score.toFixed(2),
        content: r.content.slice(0, 600),
      })),
    }
  },
})
