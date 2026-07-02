/**
 * Built-in Playwright browser automation tools.
 * No external MCP server needed — direct integration for reliability.
 */

import { tool } from 'ai'
import { z } from 'zod'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { logger } from '../../logger/index.js'
import { untrustedBlock } from '../untrusted.js'

/* ─── Shared browser instance (lazy init, per-process) ─── */

// Two singleton slots: headless (default, fast) and headed (interactive login).
// Switching mode requires a separate launch — the same Browser can't toggle.
let headlessBrowser: Browser | null = null
let headedBrowser: Browser | null = null
let nextPageId = 1
const pages = new Map<number, Page>()
// Each pageId owns its own context so cookies / storage stay isolated.
const pageContexts = new Map<number, BrowserContext>()

async function getBrowser(headed = false): Promise<Browser> {
  if (headed) {
    if (!headedBrowser) {
      headedBrowser = await chromium.launch({ headless: false })
      logger.info('[Playwright] Headed browser launched')
    }
    return headedBrowser
  }
  if (!headlessBrowser) {
    headlessBrowser = await chromium.launch({ headless: true })
    logger.info('[Playwright] Headless browser launched')
  }
  return headlessBrowser
}

async function closeBrowser(): Promise<void> {
  if (headlessBrowser) {
    await headlessBrowser.close()
    headlessBrowser = null
  }
  if (headedBrowser) {
    await headedBrowser.close()
    headedBrowser = null
  }
  pages.clear()
  pageContexts.clear()
  nextPageId = 1
  logger.info('[Playwright] All browsers closed')
}

function workspacePath(sessionId: string, subPath: string): string {
  const base = join(process.cwd(), 'workspace', sessionId, 'screenshots')
  mkdirSync(base, { recursive: true })
  return join(base, subPath)
}

/* ─── Tool: browser_navigate ─── */

const cookieSchema = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string().optional().describe('Cookie 作用域，如 .example.com。和 url 二选一'),
  path: z.string().optional().describe('Cookie 路径，默认 /'),
  url: z.string().optional().describe('Cookie 关联的 URL，和 domain 二选一'),
  expires: z.number().optional().describe('Unix 秒时间戳；不填表示会话 cookie'),
  httpOnly: z.boolean().optional(),
  secure: z.boolean().optional(),
  sameSite: z.enum(['Strict', 'Lax', 'None']).optional(),
})

export const browserNavigateTool = (sessionId: string) => tool({
  description:
    '使用 Playwright 打开浏览器并导航到指定 URL。返回页面 ID 和页面标题。这是所有浏览器操作的第一步。' +
    '需要登录态时优先用 storageStatePath 指向 browser_login_wait 保存的 storage 文件（包含完整 cookies + localStorage）；只有零散 cookie 时才用 cookies 参数。' +
    'headed=true 会用有头浏览器（适合调试或 SSO 滑块/扫码场景）。',
  inputSchema: z.object({
    url: z.string().describe('要导航的完整 URL'),
    waitUntil: z
      .enum(['load', 'domcontentloaded', 'networkidle'])
      .default('networkidle')
      .describe('等待页面加载完成的条件'),
    cookies: z
      .array(cookieSchema)
      .optional()
      .describe(
        '导航前注入的 Cookie 列表。每项需提供 name+value，并通过 domain 或 url 指定作用域。' +
          '示例：[{name:"session", value:"abc", domain:".example.com", path:"/"}]'
      ),
    storageStatePath: z
      .string()
      .optional()
      .describe('可选：相对 workspace 的 storage state 文件路径（如 "auth/ehall.json"），由 browser_login_wait 产出。包含 cookies + localStorage，比手填 cookies 更完整。'),
    headed: z
      .boolean()
      .default(false)
      .describe('是否使用有头浏览器（默认 false 走 headless）。仅在调试或观察 SSO 跳转时使用。'),
    userAgent: z.string().optional().describe('可选：覆盖默认 User-Agent'),
    extraHeaders: z
      .record(z.string())
      .optional()
      .describe('可选：注入额外的 HTTP 请求头，如 {"Authorization": "Bearer xxx"}'),
  }),
  execute: async ({ url, waitUntil, cookies, storageStatePath, headed, userAgent, extraHeaders }) => {
    try {
      const b = await getBrowser(headed)
      // Resolve absolute storageState path (relative to session workspace)
      const storageStateAbs = storageStatePath
        ? join(process.cwd(), 'workspace', sessionId, storageStatePath)
        : undefined
      const context = await b.newContext({
        ...(userAgent ? { userAgent } : {}),
        ...(extraHeaders ? { extraHTTPHeaders: extraHeaders } : {}),
        ...(storageStateAbs ? { storageState: storageStateAbs } : {}),
      })

      let injectedCookies = 0
      if (cookies && cookies.length > 0) {
        const normalized = cookies.map((c) => {
          if (!c.domain && !c.url) {
            // Fall back to the navigate URL so addCookies doesn't reject it.
            return { ...c, url }
          }
          return c
        })
        await context.addCookies(normalized as any)
        injectedCookies = normalized.length
      }

      const page = await context.newPage()
      const pageId = nextPageId++
      pages.set(pageId, page)
      pageContexts.set(pageId, context)

      const res = await page.goto(url, { waitUntil })
      const title = await page.title().catch(() => '')

      return {
        pageId,
        url: page.url(),
        title,
        status: res?.status() ?? 0,
        injectedCookies,
        loadedStorageState: !!storageStateAbs,
        headed,
        success: true,
      }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  },
})

/* ─── Tool: browser_screenshot ─── */

export function browserScreenshotTool(sessionId: string) {
  return tool({
    description:
      '对指定页面进行截图并保存到工作目录。支持全页截图或元素截图。返回截图文件路径。',
    inputSchema: z.object({
      pageId: z.number().describe('browser_navigate 返回的页面 ID'),
      fullPage: z.boolean().default(true).describe('是否截取整个页面（true）或仅可视区域（false）'),
      selector: z.string().optional().describe('可选：仅对某个 CSS 选择器对应的元素截图'),
      filename: z.string().describe('截图文件名，如 "login-page.png"'),
    }),
    execute: async ({ pageId, fullPage, selector, filename }) => {
      const page = pages.get(pageId)
      if (!page) {
        return { success: false, error: `页面 ${pageId} 不存在，请先调用 browser_navigate` }
      }
      try {
        const path = workspacePath(sessionId, filename)
        mkdirSync(dirname(path), { recursive: true })

        if (selector) {
          const el = await page.locator(selector).first()
          await el.screenshot({ path })
        } else {
          await page.screenshot({ path, fullPage })
        }

        return { success: true, path, filename }
      } catch (err: any) {
        return { success: false, error: err.message }
      }
    },
  })
}

/* ─── Tool: browser_get_text ─── */

export const browserGetTextTool = tool({
  description:
    '提取页面中的文本内容。支持提取整个页面的可见文本，或指定 CSS 选择器对应的元素文本。',
  inputSchema: z.object({
    pageId: z.number().describe('browser_navigate 返回的页面 ID'),
    selector: z.string().optional().describe('可选：CSS 选择器，如 "a"、"script[src]"、"form input"'),
    maxLength: z.number().default(5000).describe('返回文本的最大长度'),
  }),
  execute: async ({ pageId, selector, maxLength }) => {
    const page = pages.get(pageId)
    if (!page) {
      return { success: false, error: `页面 ${pageId} 不存在，请先调用 browser_navigate` }
    }
    try {
      let text: string
      if (selector) {
        const els = await page.locator(selector).all()
        const texts = await Promise.all(els.slice(0, 50).map(el => el.textContent().catch(() => '')))
        text = texts.filter(Boolean).join('\n')
      } else {
        text = (await page.locator('body').textContent().catch(() => '')) ?? ''
      }

      const truncated = text.length > maxLength ? text.slice(0, maxLength) + '...' : text
      // 页面文本由目标站点控制，是 prompt injection 入口 → nonce 隔离
      return { success: true, text: truncated ? untrustedBlock(truncated) : '', totalLength: text.length }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  },
})

/* ─── Tool: browser_click ─── */

export const browserClickTool = tool({
  description: '在页面上点击指定 CSS 选择器的元素。',
  inputSchema: z.object({
    pageId: z.number().describe('browser_navigate 返回的页面 ID'),
    selector: z.string().describe('CSS 选择器，如 "#login-btn"、"button[type=submit]"'),
    waitForNavigation: z.boolean().default(false).describe('点击后是否等待页面跳转'),
  }),
  execute: async ({ pageId, selector, waitForNavigation }) => {
    const page = pages.get(pageId)
    if (!page) {
      return { success: false, error: `页面 ${pageId} 不存在，请先调用 browser_navigate` }
    }
    try {
      if (waitForNavigation) {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'networkidle' }),
          page.click(selector),
        ])
      } else {
        await page.click(selector)
      }
      const title = await page.title().catch(() => '')
      return { success: true, url: page.url(), title }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  },
})

/* ─── Tool: browser_fill ─── */

export const browserFillTool = tool({
  description: '在页面的表单输入框中填入值。',
  inputSchema: z.object({
    pageId: z.number().describe('browser_navigate 返回的页面 ID'),
    selector: z.string().describe('CSS 选择器，如 "#username"、"input[name=email]"'),
    value: z.string().describe('要填入的值'),
  }),
  execute: async ({ pageId, selector, value }) => {
    const page = pages.get(pageId)
    if (!page) {
      return { success: false, error: `页面 ${pageId} 不存在，请先调用 browser_navigate` }
    }
    try {
      await page.fill(selector, value)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  },
})

/* ─── Tool: browser_evaluate ─── */

export const browserEvaluateTool = tool({
  description:
    '在浏览器页面中执行 JavaScript 代码。用于提取复杂数据、修改 DOM、触发事件等高级操作。',
  inputSchema: z.object({
    pageId: z.number().describe('browser_navigate 返回的页面 ID'),
    script: z.string().describe('要在页面上下文中执行的 JavaScript 代码。返回值会被序列化后返回。'),
  }),
  execute: async ({ pageId, script }) => {
    const page = pages.get(pageId)
    if (!page) {
      return { success: false, error: `页面 ${pageId} 不存在，请先调用 browser_navigate` }
    }
    try {
      const result = await page.evaluate((code) => {
        // eslint-disable-next-line no-eval
        return eval(code)
      }, script)
      // eval 返回值来自页面上下文，攻击者可控 → nonce 隔离
      const serialized = JSON.stringify(result).slice(0, 3000)
      return { success: true, result: serialized ? untrustedBlock(serialized) : '' }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  },
})

/* ─── Tool: browser_login_wait ─── */

/**
 * Open a HEADED browser window at the login URL and block until the user has
 * finished logging in (滑块 / 扫码 / 短信验证 / OAuth 跳转回原站). "Logged in"
 * is detected via a user-supplied success signal:
 *   - successUrlContains: substring match against page.url() (e.g. "/fe")
 *   - or both omitted: explicit poll mode — succeeds when the URL leaves the
 *     login domain (auto-derived from initial URL host)
 *
 * Once detected, the tool persists the full BrowserContext storage (cookies +
 * localStorage + IndexedDB) to a workspace file. Downstream headless crawlers
 * load it via browser_navigate({ storageStatePath: "..." }) and inherit the
 * complete login state — no manual cookie copying.
 */
export function browserLoginWaitTool(sessionId: string) {
  return tool({
    description:
      '打开有头浏览器让用户手动登录（适合 SSO 滑块 / 扫码 / 短信 / OAuth 等无法自动化的场景），阻塞等待登录成功后把完整登录态（cookies + localStorage）保存到 workspace 文件。' +
      '后续 headless 浏览器子任务用 browser_navigate({ storageStatePath: "<返回的路径>" }) 即可继承登录态。' +
      '调用前请先用 ask_user 告知用户即将弹出窗口，请其登录后等待程序自动完成。',
    inputSchema: z.object({
      url: z.string().describe('登录入口 URL（通常就是要访问的目标系统首页，会被自动跳转到登录页）'),
      successUrlContains: z
        .string()
        .optional()
        .describe('登录成功的判定 - 当 page.url() 包含该子串时视为成功（如 "/fe" 或 目标系统域名）。不填则使用"离开登录域名"的默认判定。'),
      storageStatePath: z
        .string()
        .default('auth/storage.json')
        .describe('保存路径，相对 workspace（默认 auth/storage.json）。同一目标多次登录可以用不同名字。'),
      timeoutSec: z
        .number()
        .int()
        .min(30)
        .default(600)
        .describe('最长等待时间（秒）。默认 600 秒（10 分钟），足够扫码 / 短信 / 滑块。'),
      pollIntervalMs: z
        .number()
        .int()
        .min(500)
        .default(1500)
        .describe('成功判定的轮询间隔（毫秒）'),
      stableSec: z
        .number()
        .int()
        .min(1)
        .default(6)
        .describe('成功判定的连续稳定窗口（秒）。SSO 流程中浏览器经常瞬间跳到第三方域再跳回，' +
          '必须 URL 持续匹配成功条件且期间未回退到登录域至少这么长才算真正登录成功。默认 6 秒。'),
    }),
    execute: async ({ url, successUrlContains, storageStatePath, timeoutSec, pollIntervalMs, stableSec }) => {
      let context: BrowserContext | null = null
      try {
        const b = await getBrowser(true) // headed
        context = await b.newContext()
        const page = await context.newPage()
        const pageId = nextPageId++
        pages.set(pageId, page)
        pageContexts.set(pageId, context)

        await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {})

        // Determine the "login host" we expect to leave when login succeeds.
        // After page.goto the URL may already have redirected to the SSO host.
        const initialHost = (() => {
          try { return new URL(page.url()).host } catch { return '' }
        })()

        const matches = (currentUrl: string): boolean => {
          if (successUrlContains) return currentUrl.includes(successUrlContains)
          // Default: success when the page leaves the initial (login) host
          try {
            const h = new URL(currentUrl).host
            return !!initialHost && h !== initialHost
          } catch { return false }
        }

        const deadline = Date.now() + timeoutSec * 1000
        let success = false
        let lastUrl = page.url()
        // Stability tracking: success only counts once `matches(url)` has been
        // continuously true for at least stableSec. Any URL flip back to a
        // non-matching state resets the timer. Avoids false positives during
        // SSO redirect storms (e.g. captcha popups, IdP intermediate hops).
        let stableSinceMs: number | null = null
        const stableMs = stableSec * 1000

        while (Date.now() < deadline) {
          lastUrl = page.url()
          const ok = matches(lastUrl)
          if (ok) {
            if (stableSinceMs === null) stableSinceMs = Date.now()
            if (Date.now() - stableSinceMs >= stableMs) {
              await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
              // One last sanity check after waiting for networkidle: the page
              // might have redirected away during that wait.
              if (matches(page.url())) {
                lastUrl = page.url()
                success = true
                break
              }
              // Redirected away — reset and keep watching.
              stableSinceMs = null
            }
          } else {
            // Reset stability window on any flip back to login domain.
            stableSinceMs = null
          }
          await new Promise(r => setTimeout(r, pollIntervalMs))
        }

        if (!success) {
          return {
            success: false,
            error: `登录等待超时（${timeoutSec}s），最后停留在 ${lastUrl}`,
            lastUrl,
          }
        }

        // Persist storage state (cookies + localStorage + IndexedDB).
        const absPath = join(process.cwd(), 'workspace', sessionId, storageStatePath)
        mkdirSync(dirname(absPath), { recursive: true })
        await context.storageState({ path: absPath })

        return {
          success: true,
          storageStatePath, // workspace-relative — what to pass to browser_navigate
          finalUrl: lastUrl,
          pageId, // user can reuse this page if they want to keep poking around
          message: `登录态已保存到 ${storageStatePath}。后续可用 browser_navigate({ storageStatePath: "${storageStatePath}" }) 继承登录态。`,
        }
      } catch (err: any) {
        return { success: false, error: err.message }
      }
    },
  })
}

/* ─── Tool: browser_close ─── */

export const browserCloseTool = tool({
  description: '关闭浏览器实例，释放资源。任务完成后请调用。',
  inputSchema: z.object({}),
  execute: async () => {
    try {
      await closeBrowser()
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  },
})

/* ─── Registry ─── */

export function getPlaywrightTools(sessionId: string) {
  return {
    browser_navigate: browserNavigateTool(sessionId),
    browser_screenshot: browserScreenshotTool(sessionId),
    browser_get_text: browserGetTextTool,
    browser_click: browserClickTool,
    browser_fill: browserFillTool,
    browser_evaluate: browserEvaluateTool,
    browser_login_wait: browserLoginWaitTool(sessionId),
    browser_close: browserCloseTool,
  }
}
