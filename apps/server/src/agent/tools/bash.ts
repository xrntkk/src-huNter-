/**
 * Bash execution tool — runs shell commands with the user's default shell.
 *
 * Replaces the narrower `http_request`. The agent has full freedom to use
 * curl, dig, whois, nmap, jq, ffuf, etc. Output is streamed/captured and
 * truncated; no command allow-list (the SRC agent is trusted by design).
 */

import { tool } from 'ai'
import { z } from 'zod'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

function workspaceDir(sessionId: string): string {
  const dir = join(process.cwd(), 'workspace', sessionId)
  mkdirSync(dir, { recursive: true })
  return dir
}

function pickShell(): { bin: string; flag: string } {
  const env = process.env.SHELL
  if (env && env.trim().length > 0) return { bin: env, flag: '-c' }
  if (process.platform === 'win32') return { bin: 'cmd.exe', flag: '/c' }
  return { bin: '/bin/sh', flag: '-c' }
}

export function bashTool(sessionId: string) {
  return tool({
    description:
      '在用户默认 shell 中执行任意 shell 命令。可用于 curl/dig/whois/nmap/jq/ffuf 等任意 CLI 工具。' +
      '默认工作目录为 workspace/{sessionId}（不强制限制访问范围，可 cd 到其它目录）。' +
      '返回 stdout/stderr/exitCode/duration。stdout/stderr 各自截断到 20KB。' +
      '注意：长期运行的服务（如 http server）会被 timeout 杀掉，不要用来开守护进程。',
    inputSchema: z.object({
      command: z
        .string()
        .min(1)
        .describe(
          '要执行的 shell 命令字符串。会作为单个参数传给 shell -c，所以可使用管道、重定向、&&、|| 等。' +
            '示例：`curl -sS -i https://example.com -H "Authorization: Bearer xxx"`、`dig +short example.com`'
        ),
      cwd: z
        .string()
        .optional()
        .describe(
          '可选工作目录，绝对或相对路径。相对路径基于 workspace/{sessionId}。不填则使用 workspace/{sessionId}。'
        ),
      timeout: z
        .number()
        .int()
        .min(1)
        .default(60)
        .describe('执行超时（秒），无上限。默认 60。超时会以 SIGKILL 终止进程。'),
      env: z
        .record(z.string())
        .optional()
        .describe('追加到当前进程环境的变量。`PATH` 等保留默认值。'),
    }),
    execute: async ({ command, cwd, timeout, env }) => {
      const baseDir = workspaceDir(sessionId)
      const resolvedCwd = cwd
        ? (cwd.startsWith('/') || /^[A-Za-z]:[\\/]/.test(cwd) ? cwd : join(baseDir, cwd))
        : baseDir

      const { bin, flag } = pickShell()

      return new Promise<unknown>((resolve) => {
        const startTime = Date.now()
        let stdout = ''
        let stderr = ''
        let truncStdout = false
        let truncStderr = false
        const MAX = 20 * 1024
        let settled = false
        let timedOut = false

        const child = spawn(bin, [flag, command], {
          cwd: resolvedCwd,
          env: { ...process.env, ...(env ?? {}) },
          stdio: ['ignore', 'pipe', 'pipe'],
        })

        const timer = setTimeout(() => {
          timedOut = true
          try {
            child.kill('SIGKILL')
          } catch {
            // ignore
          }
        }, timeout * 1000)

        child.stdout.on('data', (chunk: Buffer) => {
          if (stdout.length >= MAX) {
            truncStdout = true
            return
          }
          const next = stdout + chunk.toString('utf-8')
          if (next.length > MAX) {
            stdout = next.slice(0, MAX)
            truncStdout = true
          } else {
            stdout = next
          }
        })

        child.stderr.on('data', (chunk: Buffer) => {
          if (stderr.length >= MAX) {
            truncStderr = true
            return
          }
          const next = stderr + chunk.toString('utf-8')
          if (next.length > MAX) {
            stderr = next.slice(0, MAX)
            truncStderr = true
          } else {
            stderr = next
          }
        })

        child.on('error', (err) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve({
            success: false,
            error: err.message,
            shell: bin,
            command,
            cwd: resolvedCwd,
            stdout,
            stderr,
            duration: Date.now() - startTime,
          })
        })

        child.on('close', (code, signal) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve({
            success: code === 0 && !timedOut,
            timedOut,
            exitCode: code,
            signal,
            shell: bin,
            command,
            cwd: resolvedCwd,
            stdout: truncStdout ? stdout + `\n... [truncated to ${MAX} bytes]` : stdout,
            stderr: truncStderr ? stderr + `\n... [truncated to ${MAX} bytes]` : stderr,
            duration: Date.now() - startTime,
          })
        })
      })
    },
  })
}
