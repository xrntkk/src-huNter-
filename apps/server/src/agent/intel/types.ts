/**
 * 信息收集模块 — 共享类型定义。
 *
 * 设计参考 ENScan_GO：按公司名从企业数据源（爱企查/天眼查/…）收集
 * ICP 备案、APP、微博、微信公众号、招聘、软件著作权、供应商、投资/控股/分支
 * 等企业资产，把"公司名 → 数字资产清单"这条 OSINT 路径标准化。
 *
 * 每个数据源实现 IntelAdapter；上层 gather() 按 source 字段分发。
 * 仅实现抓取与归一化，不写库——结果以结构化 JSON 返回给模型，由模型
 * 决定是否调 add_endpoint / add_finding（保持工具职责单一）。
 */

/** 搜索阶段的一个公司候选。 */
export interface CompanyHit {
  pid: string
  name: string
  legalPerson?: string
  openStatus?: string
  regCapital?: string
  startDate?: string
  [k: string]: unknown
}

/** 字段元数据：调哪个 API、叫什么名。 */
export interface FieldSpec {
  /** 字段 key，如 'icp'、'app'。 */
  key: string
  /** 中文展示名。 */
  name: string
  /** 数据源 base URL 下的 API 路径，如 'detail/icpinfoAjax'。 */
  api: string
}

/** 一页分页数据。 */
export interface InfoPage {
  total: number
  size: number
  rows: Record<string, unknown>[]
}

/**
 * 数据源适配器契约——每个数据源（AQC/TYC/…）实现一份。
 * 参考自 ENScan_GO 的 interface/enscan.go：AdvanceFilter / GetCompanyBaseInfoById / GetInfoByPage / GetENMap。
 */
export interface IntelAdapter {
  /** 数据源 key，如 'aqc'。 */
  name: string
  /** 所需凭据（Cookie 等）是否已配置。 */
  available(): boolean
  /** 配置指引文案，未配置时返回给模型/用户。 */
  configHint(): string
  /** 按关键词搜索公司，返回带 pid 的候选列表（对应 AdvanceFilter）。 */
  searchCompany(name: string, signal: AbortSignal): Promise<CompanyHit[]>
  /** 按 pid 取公司基本信息（对应 GetCompanyBaseInfoById）。 */
  getBaseInfo(pid: string, signal: AbortSignal): Promise<Record<string, unknown>>
  /** 取某字段第 page 页（1-based，对应 GetInfoByPage）。 */
  getFieldPage(pid: string, field: string, page: number, signal: AbortSignal): Promise<InfoPage>
  /** 该数据源支持的字段清单（对应 GetENMap）。 */
  getFields(): FieldSpec[]
}

export interface GatherOptions {
  /** 公司名关键词。 */
  name: string
  /** 数据源列表，如 ['aqc']。 */
  sources: string[]
  /** 要收集的字段，如 ['icp','app','wechat']。 */
  fields: string[]
  /** 投资比例过滤（%），仅保留投资比例 >= 该值的子公司。 */
  invest?: number
  /** 是否收集分支机构。 */
  branch?: boolean
  /** 递归深度：收集几层孙公司（需配合 invest 使用）。 */
  deep?: number
  /** 请求间礼貌延时（毫秒），默认 1500。 */
  delayMs?: number
  /** 每个字段最多翻多少页（防爆跑），默认 5。 */
  maxPages?: number
}

export interface GatherFieldResult {
  field: string
  name: string
  total: number
  count: number
  rows: Record<string, unknown>[]
}

export interface GatherResult {
  query: string
  sources: string[]
  /** 命中的公司（首个匹配）。 */
  company: { pid: string; name: string; base?: Record<string, unknown> }
  /** 各字段收集结果。 */
  fields: GatherFieldResult[]
  /** 从 ICP 备案中抽出的域名清单——攻击面的核心产物。 */
  domains: string[]
  /** 通过 invest/branch/holds 发现的关联公司（用于 deep 递归与后续扩展）。 */
  subsidiaries: Array<{ pid: string; name: string; ratio?: string; kind?: string }>
  /** 过程提示（重试、限流、缺凭据等）。 */
  notes: string[]
  durationMs: number
}
