/**
 * Slash-command registry — backend-owned prompt injection.
 *
 * The frontend only ever sees a command's `name`/`label`/`description` (served
 * via GET /api/slash-commands). When the user sends `/<name>`, the real prompt
 * lives here and is injected server-side; the UI bubble shows only `label`.
 *
 * To add a command: append an entry below. `skills` are auto-merged into the
 * turn's visible skill catalog so the methodology loads without the user
 * toggling it manually.
 */

export interface SlashCommand {
  /** Invocation token after the slash, e.g. `recon` → `/recon`. ASCII, no spaces. */
  name: string
  /** Friendly label shown in the chat bubble and completion menu. */
  label: string
  /** One-line menu description. Never contains the prompt body. */
  description: string
  /** The real, hidden prompt injected as the user turn the model sees. */
  prompt: string
  /** Skill names auto-enabled for this turn (merged into selectedSkills). */
  skills: string[]
}

const COMMANDS: SlashCommand[] = [
  {
    name: 'recon',
    label: '接口侦察',
    description: '对目标站点进行接口侦察与资产发现',
    skills: ['src-recon'],
    prompt:
      '【任务】对目标站点进行接口侦察与资产发现。\n【强制约束】必须严格遵循 src-recon 技能的双阶段并行流水线方法论，恪守其中"主 Agent 硬性红线"——主 Agent 全程只允许调用 load_skill 编排子 Agent，禁止越过红线直接执行收集/分析动作。不得跳过任何阶段，不得自创流程。',
  },
  {
    name: 'verify',
    label: '漏洞验证',
    description: '对已发现的接口并行分桶进行漏洞验证与安全测试',
    skills: ['src-web-vuln'],
    prompt:
      '【任务】对已发现的接口进行漏洞验证与安全测试。\n【强制约束】必须严格遵循 src-web-vuln 技能的并行分类探索方法论：主 Agent 按信号矩阵把接口切片到多个漏洞家族桶，sync 并行 spawn 多个 exploit-verify 子 Agent 独立验证。子 Agent 凭自身安全知识自主决定测什么、怎么测，不受固定规则束缚；仅遵守 conventions 子文档定义的行为红线与报告标准。前置条件不满足（图谱为空）时先发现接口，不得跳过、不得凭空捏造结果。',
  },
  {
    name: 'gather',
    label: '企业信息收集',
    description: '按公司名收集 ICP/APP/公众号/投资等企业资产（OSINT 攻击面测绘）',
    skills: [],
    prompt:
      '【任务】对指定企业进行信息收集与攻击面测绘。\n【说明】用户会给出公司名（及可选的筛选条件）。请直接调用 gather_intel 工具执行收集——它按 ENScan_GO 策略从爱企查等数据源拉取 ICP 备案、APP、微博、微信公众号、招聘、软件著作权、供应商、投资/控股/分支机构等资产。\n【凭据前置】gather_intel 依赖 AQC_COOKIE 环境变量；若工具返回 no_credential，请如实告知用户需配置凭据，不要伪造结果。\n【结果处理】工具返回的 ICP 域名清单是核心攻击面产物。请：\n1. 汇总各字段条数与高价值资产（ICP 域名、APP、公众号）\n2. 若用户未明确要求只看不动，可主动询问是否要把域名批量入库到接口图谱（add_endpoints_batch，source="intel"）\n3. 禁止复述完整 rows，只报统计与亮点\n【边界】仅做公开信息收集，不进行任何攻击性操作。',
  },
]

const BY_NAME = new Map(COMMANDS.map(c => [c.name.toLowerCase(), c]))

/** Public metadata for the completion menu — never exposes `prompt`. */
export interface SlashCommandMeta {
  name: string
  label: string
  description: string
  skills: string[]
}

export function listSlashCommands(): SlashCommandMeta[] {
  return COMMANDS.map(({ name, label, description, skills }) => ({ name, label, description, skills }))
}

/**
 * Parse a raw user message. Returns the matched command when the message is
 * exactly `/<name>` (optionally followed by extra free-text args on the same
 * or following lines), otherwise null. Extra text after the token is appended
 * to the injected prompt as additional user context.
 */
export function resolveSlashCommand(
  raw: string,
): { command: SlashCommand; injectedPrompt: string; extra: string } | null {
  const text = raw.trimStart()
  if (!text.startsWith('/')) return null
  const m = /^\/([A-Za-z0-9_-]+)([\s\S]*)$/.exec(text)
  if (!m) return null
  const command = BY_NAME.get(m[1].toLowerCase())
  if (!command) return null
  const extra = m[2].trim()
  const injectedPrompt = extra ? `${command.prompt}\n\n【补充说明】${extra}` : command.prompt
  return { command, injectedPrompt, extra }
}
