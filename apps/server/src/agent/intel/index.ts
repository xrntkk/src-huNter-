/**
 * 信息收集编排层。
 *
 * - getAdapter(source)：按 key 取数据源适配器（目前实现 aqc；tyc/kc/rb 可按同模式扩展）。
 * - gather(options)：执行完整的"公司名 → 资产清单"收集流程，参考 ENScan_GO runner/enscan.go：
 *     1. 搜索公司 → 取首个匹配的 pid
 *     2. 拉基本信息
 *     3. 按请求字段分页拉取，聚合 rows
 *     4. 从 ICP 抽域名、从 invest/branch/holds 抽关联公司
 *     5. （可选）按 deep 递归收集孙公司资产
 *
 * 多源支持：sources 传入多个时，逐源收集并合并去重（域名/关联公司按 pid+name 去重）。
 * 单源失败不中断整体——记入 notes，让模型判断是否换源重试。
 */

import { createAqcAdapter, AqcRetryableError, AqcAuthError } from './aqc.js'
import type {
  GatherFieldResult,
  GatherOptions,
  GatherResult,
  IntelAdapter,
} from './types.js'

/** 字段默认集：覆盖常见攻击面资产，不含关系类（关系类由 invest/branch/deep 触发）。 */
export const DEFAULT_FIELDS = ['icp', 'app', 'weibo', 'wechat', 'job', 'copyright', 'supplier']

/** 关系类字段——用于发现关联公司。 */
const RELATION_FIELDS = ['invest', 'holds', 'branch', 'partner']

export function getAdapter(source: string): IntelAdapter | undefined {
  switch (source) {
    case 'aqc':
      return createAqcAdapter()
    // TODO: tyc / kc / rb —— 按 createAqcAdapter 同模式实现
    default:
      return undefined
  }
}

/** 所有已实现的数据源 key（供工具层做入参校验/提示）。 */
export function implementedSources(): string[] {
  return ['aqc']
}

export async function gather(opts: GatherOptions, signal: AbortSignal): Promise<GatherResult> {
  const startedAt = Date.now()
  const sources = opts.sources.length > 0 ? opts.sources : ['aqc']
  const fields = opts.fields.length > 0 ? opts.fields : DEFAULT_FIELDS
  const delayMs = opts.delayMs ?? 1500
  const maxPages = opts.maxPages ?? 5
  const notes: string[] = []

  const allFieldResults = new Map<string, GatherFieldResult>()
  const domains = new Set<string>()
  const subsidiaries = new Map<string, { pid: string; name: string; ratio?: string; kind?: string }>()
  let matched: { pid: string; name: string; base?: Record<string, unknown> } | undefined

  for (const src of sources) {
    const adapter = getAdapter(src)
    if (!adapter) {
      notes.push(`数据源 ${src} 未实现，跳过。已实现：${implementedSources().join(', ')}`)
      continue
    }
    if (!adapter.available()) {
      notes.push(`数据源 ${src} 未配置凭据：${adapter.configHint()}`)
      continue
    }

    try {
      const hit = await pickCompany(adapter, opts.name, signal)
      if (!hit) {
        notes.push(`${src}：未查到关键词「${opts.name}」`)
        continue
      }
      if (!matched) matched = { pid: hit.pid, name: hit.name }

      // 基本信息（enterprise_info）
      let base: Record<string, unknown> | undefined
      try {
        await sleep(delayMs, signal)
        base = await adapter.getBaseInfo(hit.pid, signal)
        if (!matched!.base) matched!.base = base
      } catch (err) {
        notes.push(`${src}：基本信息拉取失败 — ${msg(err)}`)
      }

      // 各字段分页
      const wantFields = resolveFields(fields, opts)
      for (const field of wantFields) {
        await sleep(delayMs, signal)
        const fr = await collectField(adapter, hit.pid, field, maxPages, signal)
        if (!fr) continue
        mergeField(allFieldResults, fr, src)
        extractDomains(field, fr.rows, domains)
        extractSubsidiaries(field, fr.rows, subsidiaries, opts.invest)
      }

      // 递归孙公司（deep）：对 invest/branch 发现的关联公司再跑一遍字段
      if (opts.deep && opts.deep >= 1 && subsidiaries.size > 0) {
        await runDeep(adapter, opts, [...subsidiaries.values()], allFieldResults, domains, subsidiaries, signal, delayMs, maxPages, 1, notes)
      }
    } catch (err) {
      if (err instanceof AqcAuthError) notes.push(`${src} 凭据错误：${err.message}`)
      else if (err instanceof AqcRetryableError) notes.push(`${src} 风控/限流：${err.message}`)
      else notes.push(`${src} 收集异常：${msg(err)}`)
    }
  }

  if (!matched) {
    notes.unshift('未匹配到任何公司。请检查公司名关键词或配置数据源凭据。')
  }

  return {
    query: opts.name,
    sources,
    company: matched ?? { pid: '', name: opts.name },
    fields: [...allFieldResults.values()],
    domains: [...domains],
    subsidiaries: [...subsidiaries.values()],
    notes,
    durationMs: Date.now() - startedAt,
  }
}

// ─── 内部 ──────────────────────────────────────────────────────────────────

/** 搜索公司并选最佳匹配（优先名称完全包含关键词）。 */
async function pickCompany(adapter: IntelAdapter, name: string, signal: AbortSignal) {
  const hits = await adapter.searchCompany(name, signal)
  if (hits.length === 0) return undefined
  const exact = hits.find(h => h.name === name) ?? hits.find(h => h.name.includes(name))
  return exact ?? hits[0]
}

/**
 * 解析本次要拉的字段，并入关系类字段（invest/branch/holds）当 invest/branch/deep 触发。
 * ENScan_GO 的关系字段单独由 -invest/-branch/-deep 控制，不在 -field 里。
 */
function resolveFields(fields: string[], opts: GatherOptions): string[] {
  const out = new Set(fields.filter(f => !RELATION_FIELDS.includes(f)))
  if (opts.invest != null) out.add('invest')
  if (opts.branch) out.add('branch')
  if (opts.deep && opts.deep >= 1 && opts.invest != null) {
    // deep 需要 invest 数据来发现子公司
    out.add('invest')
  }
  return [...out]
}

/** 翻页收集单个字段，直到无更多数据或达到 maxPages 上限。 */
async function collectField(
  adapter: IntelAdapter,
  pid: string,
  field: string,
  maxPages: number,
  signal: AbortSignal,
): Promise<GatherFieldResult | undefined> {
  const spec = adapter.getFields().find(f => f.key === field)
  if (!spec) return undefined
  const rows: Record<string, unknown>[] = []
  let total = 0
  for (let page = 1; page <= maxPages; page++) {
    try {
      const info = await adapter.getFieldPage(pid, field, page, signal)
      total = info.total
      rows.push(...info.rows)
      if (rows.length >= total || info.rows.length === 0) break
    } catch (err) {
      if (err instanceof AqcRetryableError) {
        // 风控页：停止该字段后续翻页，保留已收集的
        return { field, name: spec.name, total, count: rows.length, rows }
      }
      throw err
    }
  }
  return { field, name: spec.name, total, count: rows.length, rows }
}

/** 合并同字段多源结果（按 row 指纹去重）。 */
function mergeField(into: Map<string, GatherFieldResult>, fr: GatherFieldResult, _src: string) {
  const existing = into.get(fr.field)
  if (!existing) {
    into.set(fr.field, fr)
    return
  }
  const seen = new Set(existing.rows.map(r => JSON.stringify(r)))
  for (const r of fr.rows) {
    const k = JSON.stringify(r)
    if (!seen.has(k)) {
      existing.rows.push(r)
      seen.add(k)
      existing.count++
    }
  }
  existing.total = Math.max(existing.total, fr.total)
}

/** 从 ICP 备案行里抽域名。 */
function extractDomains(field: string, rows: Record<string, unknown>[], into: Set<string>) {
  if (field !== 'icp') return
  for (const r of rows) {
    const d = str(r.domain)
    if (d && /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(d)) into.add(d)
    const h = str(r.homeSite)
    if (h) {
      try {
        const host = new URL(String(h)).hostname
        if (host) into.add(host)
      } catch {
        /* homeSite 非完整 URL 时跳过 */
      }
    }
  }
}

/** 从 invest/branch/holds 行里抽关联公司。 */
function extractSubsidiaries(
  field: string,
  rows: Record<string, unknown>[],
  into: Map<string, { pid: string; name: string; ratio?: string; kind?: string }>,
  investFilter?: number,
) {
  if (field !== 'invest' && field !== 'branch' && field !== 'holds') return
  for (const r of rows) {
    const pid = str(r.pid)
    const name = str(r.entName) ?? str(r.name)
    if (!pid || !name) continue
    const ratioStr = str(r.regRate) ?? str(r.proportion) ?? str(r.subRate)
    const ratio = parseRatio(ratioStr)
    if (investFilter != null && ratio != null && ratio < investFilter) continue
    if (!into.has(pid)) {
      into.set(pid, { pid, name, ratio: ratioStr, kind: field })
    }
  }
}

/** deep 递归：对关联公司跑字段收集（一层层下沉）。 */
async function runDeep(
  adapter: IntelAdapter,
  opts: GatherOptions,
  parents: Array<{ pid: string; name: string }>,
  fieldResults: Map<string, GatherFieldResult>,
  domains: Set<string>,
  subsidiaries: Map<string, { pid: string; name: string; ratio?: string; kind?: string }>,
  signal: AbortSignal,
  delayMs: number,
  maxPages: number,
  depth: number,
  notes: string[],
) {
  if (depth > (opts.deep ?? 0)) return
  const newChildren: Array<{ pid: string; name: string }> = []
  const wantFields = opts.fields.filter(f => !RELATION_FIELDS.includes(f))
  for (const parent of parents) {
    try {
      await sleep(delayMs, signal)
      for (const field of wantFields) {
        await sleep(delayMs, signal)
        const fr = await collectField(adapter, parent.pid, field, maxPages, signal)
        if (!fr) continue
        mergeField(fieldResults, fr, adapter.name)
        extractDomains(field, fr.rows, domains)
      }
      // 继续向下找一层投资关系
      if (opts.invest != null && depth < (opts.deep ?? 0)) {
        await sleep(delayMs, signal)
        const fr = await collectField(adapter, parent.pid, 'invest', maxPages, signal)
        if (fr) {
          extractSubsidiaries('invest', fr.rows, subsidiaries, opts.invest)
          for (const r of fr.rows) {
            const pid = str(r.pid)
            const name = str(r.entName) ?? str(r.name)
            if (pid && name && !subsidiaries.has(pid)) {
              subsidiaries.set(pid, { pid, name, kind: 'invest' })
              newChildren.push({ pid, name })
            }
          }
        }
      }
    } catch (err) {
      notes.push(`deep(第${depth}层) ${parent.name} 收集失败：${msg(err)}`)
    }
  }
  if (newChildren.length > 0 && depth < (opts.deep ?? 0)) {
    await runDeep(adapter, opts, newChildren, fieldResults, domains, subsidiaries, signal, delayMs, maxPages, depth + 1, notes)
  }
}

function parseRatio(s?: string): number | undefined {
  if (!s) return undefined
  const m = String(s).match(/(\d+(\.\d+)?)/)
  return m ? Number(m[1]) : undefined
}

function str(v: unknown): string | undefined {
  return v == null ? undefined : String(v)
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new Error('aborted'))
    }, { once: true })
  })
}
