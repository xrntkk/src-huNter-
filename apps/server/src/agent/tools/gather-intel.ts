/**
 * gather_intel — 企业信息收集工具。
 *
 * 可被 Agent 自动调用，也可由人工通过 /gather 斜杠命令手动触发。
 * 结果以结构化 JSON 返回给模型——不自动入库，由模型决定是否调
 * add_endpoint / add_finding（保持工具职责单一）。
 *
 * 收集策略参考 ENScan_GO：按公司名从企业数据源（爱企查等）收集
 * ICP 备案、APP、微博、微信公众号、招聘、软件著作权、供应商、
 * 投资控股/分支机构等资产，把"公司名 → 数字资产清单"标准化。
 *
 * 凭据：通过环境变量 AQC_COOKIE（爱企查）配置。未配置时返回配置指引。
 */

import { tool } from 'ai'
import { z } from 'zod'
import { nanoid } from 'nanoid'
import { getDb, requestLogs } from '@src-agent/db'
import { untrustedBlock } from '../untrusted.js'
import { gather, implementedSources, getAdapter, DEFAULT_FIELDS } from '../intel/index.js'

const FIELD_ENUM = ['icp', 'app', 'weibo', 'wechat', 'job', 'copyright', 'supplier', 'invest', 'holds', 'branch', 'partner'] as const

function configStatus(): { configured: string[]; missing: string[] } {
  const configured: string[] = []
  const missing: string[] = []
  for (const src of implementedSources()) {
    const adapter = getAdapter(src)
    if (adapter?.available()) configured.push(src)
    else missing.push(src)
  }
  return { configured, missing }
}

export const gatherIntelTool = (sessionId: string) =>
  tool({
    description:
      '企业信息收集：按公司名收集 ICP 备案、APP、微博、微信公众号、招聘、软件著作权、供应商、投资/控股/分支等资产。' +
      '适合测试早期对一个企业做 OSINT 攻击面测绘——产出的 ICP 域名清单可直接作为后续接口探测的入口。' +
      '策略参考 ENScan_GO。数据源凭据在「设置 → 信息收集」页面配置（爱企查 Cookie）。' +
      '结果仅返回给你（模型）不自动入库；若要把 ICP 域名加入接口图谱，请自行调用 add_endpoint / add_endpoints_batch。',
    inputSchema: z.object({
      name: z.string().min(1).describe('公司名关键词，如「小米」「字节跳动」'),
      sources: z
        .array(z.enum(['aqc'] as const))
        .optional()
        .describe('数据源，默认 ["aqc"]。已实现：aqc=爱企查。tyc/kc/rb 待扩展。'),
      fields: z
        .array(z.enum(FIELD_ENUM))
        .optional()
        .describe('要收集的字段，默认 [icp,app,weibo,wechat,job,copyright,supplier]。关系类字段由 invest/branch/deep 触发。'),
      invest: z
        .number().int().min(0).max(100).optional()
        .describe('投资比例过滤（%）：仅保留投资比例 >= 该值的子公司。设置后自动收集 invest 字段。'),
      branch: z
        .boolean().optional()
        .describe('是否收集分支机构。设置后自动收集 branch 字段。'),
      deep: z
        .number().int().min(1).max(3).optional()
        .describe('递归深度：收集几层孙公司资产（需配合 invest 使用，1=子公司，2=孙公司）。默认不递归。'),
      delayMs: z
        .number().int().min(0).max(10000).optional()
        .describe('请求间礼貌延时（毫秒），默认 1500。建议保持以避免账号异常。'),
      maxPages: z
        .number().int().min(1).max(20).optional()
        .describe('每个字段最多翻多少页（防爆跑），默认 5。'),
    }),
    execute: async (input) => {
      const sources = input.sources && input.sources.length > 0 ? input.sources : ['aqc']
      const fields = input.fields && input.fields.length > 0 ? input.fields : DEFAULT_FIELDS

      // 前置凭据检查——任一未配置直接返回指引，不发请求
      const { configured, missing } = configStatus()
      const usable = sources.filter(s => configured.includes(s))
      if (usable.length === 0) {
        const hints = sources
          .map(s => getAdapter(s)?.configHint() ?? `${s}：未实现`)
          .filter(Boolean)
        return {
          error: 'no_credential',
          query: input.name,
          configured,
          missing,
          hint: '未配置任何可用数据源凭据。' + hints.join(' '),
        }
      }
      if (usable.length < sources.length) {
        // 部分源缺凭据——降级到可用源，提示
      }

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5 * 60 * 1000) // 整体 5 分钟上限
      const startedAt = Date.now()

      try {
        const result = await gather(
          {
            name: input.name,
            sources: usable,
            fields,
            invest: input.invest,
            branch: input.branch,
            deep: input.deep,
            delayMs: input.delayMs,
            maxPages: input.maxPages,
          },
          controller.signal,
        )

        // 外部抓取的行数据是攻击者可控内容 → nonce 隔离；统计/域名清单保持原样
        const isolatedFields = result.fields.map(f => ({
          field: f.field,
          name: f.name,
          total: f.total,
          count: f.count,
          rows: f.rows.map(r => untrustedBlock(JSON.stringify(r))),
        }))

        // 写请求日志（便于回放/审计）
        try {
          const db = getDb()
          await db.insert(requestLogs).values({
            id: nanoid(),
            sessionId,
            method: 'GET',
            url: `gather_intel:${usable.join(',')}?name=${encodeURIComponent(input.name)}`,
            requestHeaders: null,
            requestBody: JSON.stringify({ sources: usable, fields, invest: input.invest, branch: input.branch, deep: input.deep }).slice(0, 2000),
            responseStatus: 200,
            responseBody: JSON.stringify({ company: result.company, domains: result.domains, fieldCounts: result.fields.map(f => ({ field: f.field, count: f.count })), subsidiaries: result.subsidiaries.length, notes: result.notes }).slice(0, 3000),
            testPurpose: `gather_intel: ${input.name}`,
            createdAt: new Date(),
          })
        } catch {
          /* 日志失败不影响主流程 */
        }

        return {
          query: result.query,
          sources: result.sources,
          company: result.company,
          // 域名清单是攻击面核心产物，保持明文供模型直接引用
          domains: result.domains,
          domainsCount: result.domains.length,
          subsidiaries: result.subsidiaries,
          subsidiariesCount: result.subsidiaries.length,
          // 字段明细：rows 以 untrusted nonce 包裹
          fields: isolatedFields,
          notes: result.notes,
          durationMs: Date.now() - startedAt,
          ...(result.domains.length > 0
            ? { hint: `发现 ${result.domains.length} 个域名。若要纳入接口图谱，用 add_endpoints_batch 入库（source='intel'，method='UNKNOWN'）；随后可对它们跑接口探测与漏洞验证。` }
            : {}),
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          error: 'gather_failed',
          query: input.name,
          message,
          hint: '可能是网络超时、风控触发或凭据过期。请检查 notes 或重试。',
        }
      } finally {
        clearTimeout(timeout)
      }
    },
  })
