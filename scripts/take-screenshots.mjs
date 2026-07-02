#!/usr/bin/env node
// Capture screenshots of the 5 left-pane tabs in the session workspace.
// Output: docs/screenshots/{tab}.png
//
// Usage:  WEB_URL=http://localhost:5178 SESSION_ID=... node scripts/take-screenshots.mjs

import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const OUT_DIR = resolve(ROOT, 'docs/screenshots')

const WEB_URL = process.env.WEB_URL ?? 'http://localhost:5178'
const SERVER_URL = process.env.SERVER_URL ?? 'http://localhost:3001'

async function pickSession() {
  const fromEnv = process.env.SESSION_ID
  if (fromEnv) return fromEnv
  const res = await fetch(`${SERVER_URL}/api/sessions`)
  const list = await res.json()
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('no sessions found — create one in the UI first or pass SESSION_ID')
  }
  // prefer sessions that have endpoints — likely the most visually interesting
  for (const s of list) {
    const r = await fetch(`${SERVER_URL}/api/sessions/${s.id}/stats`).catch(() => null)
    const stats = r && r.ok ? await r.json() : null
    if (stats && stats.endpointCount > 0) return s.id
  }
  return list[0].id
}

const TABS = [
  { name: 'graph',     label: '接口图谱',  file: '01-endpoint-graph.png' },
  { name: 'report',    label: '漏洞报告',  file: '02-finding-report.png' },
  { name: 'memory',    label: '记忆图谱',  file: '03-memory-graph.png' },
  { name: 'workspace', label: '工作目录',  file: '04-workspace.png' },
  { name: 'dashboard', label: 'Dashboard', file: '05-dashboard.png' },
]

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const sessionId = await pickSession()
  console.log(`[screenshot] session: ${sessionId}`)

  const browser = await chromium.launch()
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 980 },
    deviceScaleFactor: 2, // retina-quality
    colorScheme: 'dark',  // app's default theme
  })
  const page = await ctx.newPage()

  const url = `${WEB_URL}/session/${sessionId}`
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  // Wait for the tab strip — proves the SessionMain component mounted
  await page.locator('button', { hasText: '接口图谱' }).first().waitFor({ timeout: 30_000 })
  await page.waitForTimeout(2000) // let initial graph layout + queries settle

  for (const tab of TABS) {
    console.log(`[screenshot] ${tab.label}`)
    // Tab buttons identified by their visible label text
    const button = page.locator('button', { hasText: new RegExp(`^\\s*${tab.label}`) }).first()
    await button.click()
    await page.waitForTimeout(1200) // chart animations / layout

    // For graph tabs, give ELK layout time to settle
    if (tab.name === 'graph' || tab.name === 'memory') {
      await page.waitForTimeout(800)
    }

    const out = resolve(OUT_DIR, tab.file)
    await page.screenshot({ path: out, fullPage: false })
  }

  await browser.close()
  console.log(`[screenshot] wrote ${TABS.length} files to ${OUT_DIR}`)
}

main().catch(err => {
  console.error('[screenshot] failed:', err.message)
  process.exit(1)
})
