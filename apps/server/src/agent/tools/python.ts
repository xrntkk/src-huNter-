/**
 * Python script execution tool — runs code in the session workspace.
 */

import { tool } from 'ai'
import { z } from 'zod'
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

function getWorkspaceDir(sessionId: string): string {
  const dir = join(process.cwd(), 'workspace', sessionId, 'scripts')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Max stdout/stderr bytes returned to the model. Output beyond this is
 * truncated (the full run still executes; only what the model SEES is capped).
 * Large data should be written to a file and read via file_system / imported
 * by a dedicated tool, NOT printed — printing routes it through this cap.
 */
const OUTPUT_CAP = 20_000

/* Detect once per process. Prefer python3 (default on macOS / most Linux),
   fall back to python (Windows / older distros). */
type PythonProbe = { bin: string | null; tried: string[]; version?: string }
let pythonProbe: PythonProbe | null = null

function probePython(): PythonProbe {
  if (pythonProbe) return pythonProbe
  const candidates = process.env.PYTHON_BIN
    ? [process.env.PYTHON_BIN, 'python3', 'python']
    : ['python3', 'python']
  const tried: string[] = []
  for (const bin of candidates) {
    if (!bin) continue
    tried.push(bin)
    try {
      const out = execFileSync(bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()
      pythonProbe = { bin, tried, version: out }
      return pythonProbe
    } catch {
      // try next
    }
  }
  pythonProbe = { bin: null, tried }
  return pythonProbe
}

export function pythonTool(sessionId: string) {
  return tool({
    description:
      '在服务器端执行 Python 代码。如果是多行代码，会自动保存为 .py 脚本文件后运行。' +
      '输出结果和脚本文件都会被保存到工作目录。可用于：数据处理、API 调用、漏洞验证脚本、报告生成等。' +
      '注意：返回给你的 stdout/stderr 最多约 20KB，超出会被截断（脚本本身完整执行）。' +
      '需要产出大量数据时，请用脚本写入文件，再用 file_system 分段读取或用专门的导入工具入库——不要直接 print 大数据。',
    inputSchema: z.object({
      code: z
        .string()
        .describe('Python 代码。支持单行命令或多行脚本。可 import requests, json, re 等标准库。'),
      filename: z
        .string()
        .optional()
        .describe('脚本文件名（如 scan.py）。不填则自动生成 script_{timestamp}.py'),
      timeout: z.number().int().min(1).max(120).default(30).describe('执行超时时间（秒），最大 120'),
    }),
    execute: async ({ code, filename, timeout }) => {
      const probe = probePython()
      if (!probe.bin) {
        return {
          success: false,
          error:
            `未找到可用的 Python 解释器。已尝试: ${probe.tried.join(', ')}。` +
            `请安装 Python 3 或在 .env 中设置 PYTHON_BIN 指向可执行文件。`,
        }
      }

      const workspaceDir = getWorkspaceDir(sessionId)
      const fname = filename?.replace(/[^a-zA-Z0-9._-]/g, '_') || `script_${Date.now()}.py`
      const scriptPath = join(workspaceDir, fname)

      mkdirSync(dirname(scriptPath), { recursive: true })
      writeFileSync(scriptPath, code, 'utf-8')

      return new Promise<unknown>((resolve) => {
        const startTime = Date.now()
        let stdout = ''
        let stderr = ''
        let killed = false

        const child = execFile(probe.bin!, [scriptPath], {
          timeout: timeout * 1000,
          maxBuffer: 1024 * 1024 * 10, // 10MB
          cwd: workspaceDir,
        })

        child.stdout?.on('data', (data) => {
          stdout += String(data)
        })

        child.stderr?.on('data', (data) => {
          stderr += String(data)
        })

        child.on('error', (err) => {
          if (killed) return
          killed = true
          resolve({
            success: false,
            error: err.message,
            python: probe.bin,
            pythonVersion: probe.version,
            stdout: stdout.slice(0, OUTPUT_CAP),
            stderr: stderr.slice(0, OUTPUT_CAP),
            scriptPath,
            filename: fname,
            duration: Date.now() - startTime,
          })
        })

        child.on('close', (code, signal) => {
          if (killed) return
          killed = true
          resolve({
            success: code === 0,
            exitCode: code,
            signal,
            python: probe.bin,
            pythonVersion: probe.version,
            stdout: stdout.slice(0, OUTPUT_CAP),
            stderr: stderr.slice(0, OUTPUT_CAP),
            scriptPath,
            filename: fname,
            duration: Date.now() - startTime,
          })
        })
      })
    },
  })
}

/* ─── File system read/write tool for workspace ─── */

export function fileSystemTool(sessionId: string) {
  return tool({
    description:
      '读写工作目录中的文件。用于保存脚本、读取日志、查看截图、编辑配置等。' +
      '路径以 workspace/{sessionId}/ 为根目录，可使用相对路径。' +
      '读取大文件（如混淆 JS）时传 offset/limit 分段读取，避免一次性塞爆 context。',
    inputSchema: z.object({
      action: z
        .enum(['read', 'write', 'list', 'delete'])
        .describe('操作类型：读取、写入、列出目录、删除'),
      path: z.string().describe('相对路径，如 "scripts/scan.py"、"screenshots/login.png"、"."'),
      content: z.string().optional().describe('write 操作时的文件内容'),
      offset: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('read 操作起始行号（1-based）。不传从第 1 行开始。'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(5000)
        .optional()
        .describe('read 操作最多返回行数。不传则一次最多 2000 行；超出返回 totalLines 让你下次接着读。'),
    }),
    execute: async ({ action, path: relPath, content, offset, limit }) => {
      const baseDir = join(process.cwd(), 'workspace', sessionId)
      const targetPath = join(baseDir, relPath)

      // Prevent directory traversal
      if (!targetPath.startsWith(baseDir)) {
        return { success: false, error: '路径超出工作目录范围' }
      }

      try {
        switch (action) {
          case 'read': {
            if (!existsSync(targetPath)) {
              return { success: false, error: `文件不存在: ${relPath}` }
            }
            const data = (await import('node:fs')).readFileSync(targetPath, 'utf-8')
            const startLine = offset ?? 1
            const maxLines = limit ?? 2000
            // Fast path: whole-file read for small files when no slicing requested.
            if (offset === undefined && limit === undefined) {
              const lineCount = data.length === 0 ? 0 : data.split('\n').length
              if (lineCount <= maxLines) {
                return { success: true, content: data, path: relPath, totalLines: lineCount, startLine: 1, endLine: lineCount }
              }
            }
            const lines = data.split('\n')
            const totalLines = lines.length
            if (startLine > totalLines) {
              return { success: true, content: '', path: relPath, totalLines, startLine, endLine: startLine - 1, eof: true }
            }
            const endLine = Math.min(totalLines, startLine + maxLines - 1)
            const slice = lines.slice(startLine - 1, endLine).join('\n')
            return {
              success: true,
              content: slice,
              path: relPath,
              totalLines,
              startLine,
              endLine,
              eof: endLine >= totalLines,
              hint:
                endLine < totalLines
                  ? `还有 ${totalLines - endLine} 行未读，下次传 offset=${endLine + 1} 继续。`
                  : undefined,
            }
          }
          case 'write': {
            if (content === undefined) {
              return { success: false, error: '写入操作需要 content 参数' }
            }
            mkdirSync(dirname(targetPath), { recursive: true })
            writeFileSync(targetPath, content, 'utf-8')
            return { success: true, path: relPath, size: content.length }
          }
          case 'list': {
            const fs = await import('node:fs')
            if (!existsSync(targetPath)) {
              return { success: false, error: `目录不存在: ${relPath}` }
            }
            const entries = fs.readdirSync(targetPath, { withFileTypes: true })
            return {
              success: true,
              path: relPath,
              items: entries.map((e) => ({
                name: e.name,
                isDirectory: e.isDirectory(),
                isFile: e.isFile(),
              })),
            }
          }
          case 'delete': {
            if (!existsSync(targetPath)) {
              return { success: false, error: `文件不存在: ${relPath}` }
            }
            rmSync(targetPath, { recursive: true })
            return { success: true, path: relPath }
          }
        }
      } catch (err: any) {
        return { success: false, error: err.message }
      }
    },
  })
}
