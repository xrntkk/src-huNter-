import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { getDb, sessions, findings, endpoints } from '@src-agent/db'

export const reportsRouter = new Hono()

const CVSS_BASE: Record<string, string> = {
  critical: '9.0-10.0',
  high: '7.0-8.9',
  medium: '4.0-6.9',
  low: '0.1-3.9',
  info: '0.0',
}

const SEVERITY_EMOJI: Record<string, string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🔵',
  info: '⚪',
}

const VULN_TYPE_NAME: Record<string, string> = {
  idor: 'Insecure Direct Object Reference (IDOR)',
  sqli: 'SQL Injection',
  xss: 'Cross-Site Scripting (XSS)',
  ssrf: 'Server-Side Request Forgery (SSRF)',
  ssti: 'Server-Side Template Injection (SSTI)',
  rce: 'Remote Code Execution (RCE)',
  logic: 'Business Logic Vulnerability',
  auth_bypass: 'Authentication Bypass',
  info_disclosure: 'Sensitive Information Disclosure',
  other: 'Other Vulnerability',
}

// GET /api/sessions/:id/report?format=md|json
reportsRouter.get('/sessions/:sessionId/report', async c => {
  const db = getDb()
  const sessionId = c.req.param('sessionId')
  const format = (c.req.query('format') ?? 'md') as 'md' | 'json'

  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId))
  if (!session) return c.json({ error: 'Not found' }, 404)

  const fds = await db.select().from(findings).where(eq(findings.sessionId, sessionId))
  const eps = await db.select().from(endpoints).where(eq(endpoints.sessionId, sessionId))

  const severityOrder: Record<string, number> = {
    critical: 0, high: 1, medium: 2, low: 3, info: 4,
  }
  const sorted = [...fds].sort(
    (a, b) => (severityOrder[a.severity] ?? 5) - (severityOrder[b.severity] ?? 5),
  )

  if (format === 'json') {
    return c.json({
      session: { id: session.id, domain: session.domain, title: session.title },
      summary: {
        totalEndpoints: eps.length,
        totalFindings: fds.length,
        bySeverity: Object.fromEntries(
          ['critical', 'high', 'medium', 'low', 'info'].map(s => [
            s,
            fds.filter(f => f.severity === s).length,
          ]),
        ),
      },
      findings: sorted.map(f => ({
        ...f,
        endpoint: eps.find(e => e.id === f.endpointId) ?? null,
        cvssRange: CVSS_BASE[f.severity] ?? '?',
        typeName: VULN_TYPE_NAME[f.type] ?? f.type,
      })),
    })
  }

  // Markdown report
  const confirmed = sorted.filter(f => f.status === 'confirmed')
  const unconfirmed = sorted.filter(f => f.status === 'unconfirmed')
  const highRisk = sorted.filter(f => ['critical', 'high'].includes(f.severity))

  const lines: string[] = [
    `# SRC 漏洞挖掘报告`,
    ``,
    `| 字段 | 内容 |`,
    `|------|------|`,
    `| **目标域名** | \`${session.domain}\` |`,
    `| **测试标题** | ${session.title ?? '—'} |`,
    `| **测试时间** | ${new Date(session.createdAt).toLocaleString('zh-CN')} |`,
    `| **报告生成** | ${new Date().toLocaleString('zh-CN')} |`,
    ``,
    `---`,
    ``,
    `## 测试摘要`,
    ``,
    `| 指标 | 数量 |`,
    `|------|------|`,
    `| 发现接口总数 | ${eps.length} |`,
    `| 发现漏洞总数 | ${fds.length} |`,
    `| 高危漏洞（严重/高危） | ${highRisk.length} |`,
    `| 已确认漏洞 | ${confirmed.length} |`,
    `| 待确认漏洞 | ${unconfirmed.length} |`,
    ``,
    `### 漏洞严重程度分布`,
    ``,
    ...['critical', 'high', 'medium', 'low', 'info'].map(s => {
      const count = fds.filter(f => f.severity === s).length
      const bar = '█'.repeat(count)
      return `- ${SEVERITY_EMOJI[s]} **${s.toUpperCase()}**: ${count} ${bar}`
    }),
    ``,
    `---`,
    ``,
    `## 漏洞详情`,
    ``,
  ]

  for (let i = 0; i < sorted.length; i++) {
    const f = sorted[i]
    const ep = eps.find(e => e.id === f.endpointId)
    const evidence = f.evidence as { request?: string; response?: string } | null
    const statusIcon = f.status === 'confirmed' ? '✅' : f.status === 'false_positive' ? '❌' : '⚠️'

    lines.push(
      `### ${i + 1}. ${SEVERITY_EMOJI[f.severity]} [${f.severity.toUpperCase()}] ${f.title}`,
      ``,
      `| 属性 | 值 |`,
      `|------|-----|`,
      `| **漏洞类型** | ${VULN_TYPE_NAME[f.type] ?? f.type} |`,
      `| **严重程度** | ${f.severity.toUpperCase()} (CVSS ${CVSS_BASE[f.severity] ?? '?'}) |`,
      `| **状态** | ${statusIcon} ${f.status} |`,
      ep ? `| **受影响接口** | \`${ep.method} ${ep.pathTemplate}\` |` : '',
      ``,
      `**漏洞描述**`,
      ``,
      f.description ?? '（无描述）',
      ``,
      `**复现步骤**`,
      ``,
      ...(f.reproSteps as string[]).map((s, idx) => `${idx + 1}. ${s}`),
      ``,
    )

    if (evidence?.request) {
      lines.push(
        `**证据 - 请求**`,
        ``,
        '```http',
        evidence.request,
        '```',
        ``,
      )
    }

    if (evidence?.response) {
      lines.push(
        `**证据 - 响应**`,
        ``,
        '```',
        evidence.response.slice(0, 800),
        '```',
        ``,
      )
    }

    lines.push(
      `**修复建议**`,
      ``,
      getRemediationAdvice(f.type),
      ``,
      `---`,
      ``,
    )
  }

  lines.push(
    `## 接口清单`,
    ``,
    `| Method | Path | Source | Risk Hints |`,
    `|--------|------|--------|------------|`,
    ...eps.map(ep =>
      `| \`${ep.method}\` | \`${ep.pathTemplate}\` | ${ep.source} | ${(ep.riskHints as string[]).join(', ') || '—'} |`
    ),
  )

  const md = lines.filter(l => l !== '').join('\n')

  return new Response(md, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="report-${sessionId}.md"`,
    },
  })
})

function getRemediationAdvice(type: string): string {
  const advice: Record<string, string> = {
    idor: '在服务端验证资源所有权：对每个请求检查 `resource.ownerId === currentUser.id`，不要仅依赖前端隐藏或客户端传入的 ID。',
    sqli: '使用参数化查询（Prepared Statements）或 ORM，禁止将用户输入直接拼入 SQL 字符串。',
    xss: '对所有输出到 HTML 的用户数据进行转义；设置严格的 CSP 响应头；使用现代框架的模板引擎自动转义。',
    ssrf: '建立出站请求的白名单，拒绝私网 IP（10.x、172.x、192.168.x）；禁用不必要的协议（file://、gopher://）。',
    ssti: '使用沙箱化的模板引擎，禁止将用户输入传入模板渲染函数；对输入进行严格过滤。',
    rce: '最小化服务器权限（最小权限原则）；对输入严格验证；避免将用户输入传入 exec/eval 类函数。',
    logic: '梳理业务逻辑流程，添加服务端状态机验证；对关键操作添加幂等控制；限制关键参数的枚举范围。',
    auth_bypass: '所有敏感接口必须在服务端验证 JWT/Session 有效性；不信任客户端传入的权限标识。',
    info_disclosure: '生产环境禁用 debug 模式和详细错误信息；添加统一错误处理返回通用错误信息；审查日志输出。',
    other: '根据具体漏洞情况制定修复方案，建议遵循 OWASP 安全编码规范。',
  }
  return advice[type] ?? advice.other
}
