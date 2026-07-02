/**
 * 信息收集模块的凭据配置持久化。
 *
 * 配置文件：config/intel.json（与 mcp.yaml / models.json 同目录）
 *
 * 设计：保存配置时同步注入 process.env（如 AQC_COOKIE），这样各数据源
 * 适配器（aqc.ts 等）只读 process.env 即可，无需感知配置文件存在。
 * 启动时调用 loadIntelConfig() 一次，把磁盘配置同步到内存。
 *
 * 结构：
 * {
 *   "sources": {
 *     "aqc": { "cookie": "...", "enabled": true }
 *   }
 * }
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

const INTEL_CONFIG_PATH = resolve(process.cwd(), '../../config/intel.json')

export interface IntelSourceConfig {
  /** 凭据（如爱企查完整 Cookie，含 http-only 字段）。 */
  cookie?: string
  /** 是否启用。false 时即使配了 cookie 也不使用。 */
  enabled?: boolean
}

export interface IntelConfig {
  sources: Record<string, IntelSourceConfig>
}

const DEFAULT_CONFIG: IntelConfig = { sources: {} }

/** 把配置中的凭据同步到 process.env，让适配器通过 process.env 读取。 */
function syncToEnv(config: IntelConfig): void {
  // 爱企查
  const aqc = config.sources.aqc
  if (aqc?.enabled !== false && aqc?.cookie && aqc.cookie.trim()) {
    process.env.AQC_COOKIE = aqc.cookie
  } else {
    // 配置里禁用或清空 → 清掉 env，避免用到旧值
    delete process.env.AQC_COOKIE
  }
  // 后续数据源（tyc/kc/rb）按同模式扩展
}

/** 从磁盘加载配置并同步到 process.env。文件不存在时返回默认空配置。 */
export function loadIntelConfig(): IntelConfig {
  if (!existsSync(INTEL_CONFIG_PATH)) {
    return { ...DEFAULT_CONFIG }
  }
  try {
    const raw = readFileSync(INTEL_CONFIG_PATH, 'utf-8')
    const parsed = JSON.parse(raw) as IntelConfig
    const config: IntelConfig = {
      sources: parsed.sources ?? {},
    }
    syncToEnv(config)
    return config
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

/** 保存配置到磁盘并同步到 process.env。 */
export function saveIntelConfig(config: IntelConfig): void {
  mkdirSync(dirname(INTEL_CONFIG_PATH), { recursive: true })
  writeFileSync(INTEL_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n')
  syncToEnv(config)
}
