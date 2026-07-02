/**
 * 爱企查（AQC）数据源适配器。
 *
 * 实现参考 ENScan_GO/internal/aiqicha（aiqicha.go / bean.go / helper.go）：
 *   - 搜索：/s/advanceFilterAjax?q=<name>  →  data.resultList[]，pid 用 transformNumber 按 ddw 解密
 *   - 基础信息：/detail/basicAllDataAjax?pid=<pid>  →  data.basicData
 *   - 字段分页：/<api>?size=10&pid=<pid>&p=<page>  →  data.list[]
 *   - 反爬：UA + Cookie + Referer；检测"百度安全验证"页；401/302→Cookie 过期；403→IP 封禁
 *
 * Cookie 通过环境变量 AQC_COOKIE 提供（需含 http-only 字段，不要用 document.cookie）。
 */

import type { CompanyHit, FieldSpec, InfoPage, IntelAdapter } from './types.js'

const BASE = 'https://aiqicha.baidu.com'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.43'

/** ENScan_GO bean.go getENMap——AQC 支持的字段及其 API 路径。 */
const FIELD_MAP: FieldSpec[] = [
  { key: 'icp', name: 'ICP备案', api: 'detail/icpinfoAjax' },
  { key: 'app', name: 'APP', api: 'c/appinfoAjax' },
  { key: 'weibo', name: '微博', api: 'c/microblogAjax' },
  { key: 'wechat', name: '微信公众号', api: 'c/wechatoaAjax' },
  { key: 'job', name: '招聘信息', api: 'c/enterprisejobAjax' },
  { key: 'copyright', name: '软件著作权', api: 'detail/copyrightAjax' },
  { key: 'supplier', name: '供应商', api: 'c/supplierAjax' },
  { key: 'invest', name: '投资信息', api: 'detail/investajax' },
  { key: 'holds', name: '控股企业', api: 'detail/holdsAjax' },
  { key: 'branch', name: '分支信息', api: 'detail/branchajax' },
  { key: 'partner', name: '股东信息', api: 'detail/sharesAjax' },
]

/**
 * pid 解密：ENScan_GO transformNumber。搜索接口返回的 pid 是按 ddw(1|2)
 * 做了数字替换的密文，这里用同样的替换表还原。ddw 非 1/2 时原样返回。
 */
function transformNumber(input: string, t: number): string {
  if (t !== 1 && t !== 2) return input
  const codes: Record<number, Record<string, string>> = {
    1: { '0': '0', '1': '1', '2': '2', '3': '3', '4': '5', '5': '4', '6': '7', '7': '6', '8': '9', '9': '8' },
    2: { '0': '0', '1': '1', '2': '2', '3': '3', '4': '6', '5': '8', '6': '9', '7': '4', '8': '5', '9': '7' },
  }
  const map = codes[t]
  let out = ''
  for (const ch of input) out += map[ch] ?? ch
  return out
}

/** 可重试的错误（安全验证页、临时网络错）。 */
export class AqcRetryableError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'AqcRetryableError'
  }
}
/** 凭据/配置错误（Cookie 过期、缺失）。 */
export class AqcAuthError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'AqcAuthError'
  }
}

interface AqcConfig {
  cookie?: string
}

export function createAqcAdapter(cfg: AqcConfig = {}): IntelAdapter {
  const cookie = cfg.cookie ?? process.env.AQC_COOKIE

  function available(): boolean {
    return !!cookie && cookie.trim().length > 0
  }

  function configHint(): string {
    return '未配置 AQC_COOKIE。请在「设置 → 信息收集」页面填入爱企查 Cookie（登录 https://aiqicha.baidu.com 后，从浏览器开发者工具 Network 任一请求头复制完整 Cookie，需含 http-only 字段，勿用 document.cookie）。'
  }

  /** 统一请求 + 反爬识别。参考 ENScan_GO helper.go req()。 */
  async function req(path: string, signal: AbortSignal, retry = 1): Promise<string> {
    const url = path.startsWith('http') ? path : `${BASE}/${path.replace(/^\//, '')}`
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': UA,
        Accept: 'text/html, application/xhtml+xml, image/jxr, */*',
        Cookie: cookie ?? '',
        Referer: `${BASE}/`,
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      signal,
    })

    if (res.status === 401 || res.status === 302) {
      throw new AqcAuthError(`AQC Cookie 过期或无效（HTTP ${res.status}），请重新获取 AQC_COOKIE`)
    }
    if (res.status === 403) {
      throw new AqcRetryableError('AQC 返回 403：当前 IP 被禁止访问，请更换 IP 或稍后重试')
    }
    if (res.status === 404) {
      throw new Error(`AQC 请求 404：${path}`)
    }
    if (!res.ok) {
      throw new Error(`AQC 请求失败 HTTP ${res.status}：${path}`)
    }

    const text = await res.text()
    // 百度安全验证风控页——重试一次，仍命中则抛出可恢复错误让上层换源/提示
    if (text.includes('百度安全验证') || text.includes('wappass.baidu.com')) {
      if (retry > 0) {
        await sleep(3000, signal)
        return req(path, signal, retry - 1)
      }
      throw new AqcRetryableError('AQC 触发百度安全验证，请在浏览器打开 https://aiqicha.baidu.com 完成验证后刷新 Cookie 再试')
    }
    return text
  }

  async function searchCompany(name: string, signal: AbortSignal): Promise<CompanyHit[]> {
    const path = `s/advanceFilterAjax?q=${encodeURIComponent(name)}&p=1&s=10&f={}`
    const content = await req(path, signal)
    const data = safeJsonParse(content)
    if (!data) throw new Error('AQC 搜索响应非 JSON（可能触发了风控页）')
    const list = (data?.data?.resultList ?? []) as Array<Record<string, unknown>>
    const ddw = Number(data?.ddw ?? 0)
    return list.map(v => {
      const rawPid = String(v.pid ?? '')
      const pid = transformNumber(rawPid, ddw)
      return {
        pid,
        name: String(v.entName ?? v.name ?? ''),
        legalPerson: str(v.legalPerson),
        openStatus: str(v.openStatus),
        regCapital: str(v.regCapital),
        startDate: str(v.startDate),
        ...v,
      }
    })
  }

  async function getBaseInfo(pid: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    const content = await req(`detail/basicAllDataAjax?pid=${pid}`, signal)
    const data = safeJsonParse(content)
    const base = (data?.data?.basicData ?? {}) as Record<string, unknown>
    return { ...base, pid }
  }

  async function getFieldPage(pid: string, field: string, page: number, signal: AbortSignal): Promise<InfoPage> {
    const spec = FIELD_MAP.find(f => f.key === field)
    if (!spec) throw new Error(`AQC 不支持字段：${field}`)
    const content = await req(`${spec.api}?size=10&pid=${pid}&p=${page}`, signal)
    const data = safeJsonParse(content)
    let node = data?.data
    // invest 关系接口特殊：数据在 data.investRecordData（参考 aiqicha.go GetInfoByPage）
    if (spec.api === 'relations/relationalMapAjax') node = node?.investRecordData
    const list = (node?.list ?? []) as Array<Record<string, unknown>>
    const total = Number(node?.total ?? 0)
    const size = Number(node?.size ?? 10)

    // ICP 备案特殊：每行的 domain 是数组，展开成多行（参考 aiqicha.go）
    const rows: Record<string, unknown>[] = []
    if (field === 'icp') {
      for (const row of list) {
        const domains = Array.isArray(row.domain) ? row.domain : []
        const homes = Array.isArray(row.homeSite) ? row.homeSite : []
        const home = homes[0] ?? ''
        if (domains.length === 0) {
          rows.push({ ...row, domain: '', homeSite: home })
        } else {
          for (const d of domains) {
            rows.push({ ...row, domain: d, homeSite: home })
          }
        }
      }
    } else {
      rows.push(...list)
    }
    return { total, size, rows }
  }

  return {
    name: 'aqc',
    available,
    configHint,
    searchCompany,
    getBaseInfo,
    getFieldPage,
    getFields: () => FIELD_MAP,
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────

function safeJsonParse(s: string): any {
  try {
    return JSON.parse(s)
  } catch {
    // ENScan 会把 <em> 高亮标记替换掉再解析；这里宽松处理：尝试截取首个 {...}
    const m = s.match(/\{[\s\S]*\}/)
    if (m) {
      try {
        return JSON.parse(m[0])
      } catch {
        return null
      }
    }
    return null
  }
}

function str(v: unknown): string | undefined {
  return v == null ? undefined : String(v)
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
