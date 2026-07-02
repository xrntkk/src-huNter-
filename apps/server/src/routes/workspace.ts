import { Hono } from 'hono'
import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, relative, dirname, sep } from 'node:path'

export const workspaceRouter = new Hono()

function getWorkspaceBase(sessionId: string): string {
  return join(process.cwd(), 'workspace', sessionId)
}

function extractRelPath(c: { req: { param: (k: string) => string; path: string } }): string {
  const sessionId = c.req.param('sessionId')
  const prefix = `/${sessionId}/workspace/`
  const path = c.req.path
  const idx = path.indexOf(prefix)
  if (idx === -1) return ''
  return decodeURIComponent(path.slice(idx + prefix.length))
}

interface TreeNode {
  name: string
  path: string
  type: 'file' | 'dir'
  size?: number
  modifiedAt?: number
  children?: TreeNode[]
}

function buildTree(dirPath: string, basePath: string): TreeNode[] {
  if (!existsSync(dirPath)) return []

  const entries = readdirSync(dirPath, { withFileTypes: true })
  const nodes: TreeNode[] = []

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name)
    const relPath = relative(basePath, fullPath).replace(/\\/g, '/')

    if (entry.isDirectory()) {
      nodes.push({
        name: entry.name,
        path: relPath,
        type: 'dir',
        children: buildTree(fullPath, basePath),
      })
    } else {
      const stat = statSync(fullPath)
      nodes.push({
        name: entry.name,
        path: relPath,
        type: 'file',
        size: stat.size,
        modifiedAt: stat.mtime.getTime(),
      })
    }
  }

  nodes.sort((a, b) => {
    if (a.type === b.type) return a.name.localeCompare(b.name)
    return a.type === 'dir' ? -1 : 1
  })

  return nodes
}

workspaceRouter.get('/:sessionId/workspace/*', async c => {
  const sessionId = c.req.param('sessionId')
  const relPath = extractRelPath(c)
  const base = getWorkspaceBase(sessionId)

  if (!relPath) {
    if (!existsSync(base)) {
      return c.json({ tree: [] as TreeNode[], path: '' })
    }
    const tree = buildTree(base, base)
    return c.json({ tree, path: relative(process.cwd(), base).replace(/\\/g, '/') })
  }

  const targetPath = join(base, relPath)

  if (!targetPath.startsWith(base + sep) && targetPath !== base) {
    return c.json({ error: 'Invalid path' }, 400)
  }

  if (!existsSync(targetPath)) {
    return c.json({ error: 'Not found' }, 404)
  }

  const stat = statSync(targetPath)
  if (stat.isDirectory()) {
    const tree = buildTree(targetPath, base)
    return c.json({ type: 'dir', path: relPath, tree })
  }

  const isText = !/\.(png|jpg|jpeg|gif|webp|bmp|ico|zip|tar|gz|rar|7z|exe|dll|so|dylib)$/i.test(relPath)
  const imageMatch = relPath.toLowerCase().match(/\.(png|jpg|jpeg|gif|webp|bmp|svg|ico)$/)
  if (imageMatch) {
    const mime = imageMatch[1] === 'svg'
      ? 'image/svg+xml'
      : imageMatch[1] === 'jpg'
        ? 'image/jpeg'
        : `image/${imageMatch[1]}`
    const content = readFileSync(targetPath, 'base64')
    return c.json({
      type: 'file',
      path: relPath,
      name: relPath.split('/').pop(),
      size: stat.size,
      modifiedAt: stat.mtime.getTime(),
      isImage: true,
      mime,
      content,
    })
  }
  if (!isText && stat.size > 1024 * 1024) {
    return c.json({ type: 'file', path: relPath, name: relPath.split('/').pop(), size: stat.size, isBinary: true })
  }

  const content = readFileSync(targetPath, isText ? 'utf-8' : 'base64')
  return c.json({
    type: 'file',
    path: relPath,
    name: relPath.split('/').pop(),
    size: stat.size,
    modifiedAt: stat.mtime.getTime(),
    isBinary: !isText,
    content,
  })
})

workspaceRouter.get('/:sessionId/workspace', async c => {
  const sessionId = c.req.param('sessionId')
  const base = getWorkspaceBase(sessionId)

  if (!existsSync(base)) {
    return c.json({ tree: [] as TreeNode[], path: '' })
  }

  const tree = buildTree(base, base)
  return c.json({ tree, path: relative(process.cwd(), base).replace(/\\/g, '/') })
})

workspaceRouter.put('/:sessionId/workspace/*', async c => {
  const sessionId = c.req.param('sessionId')
  const relPath = extractRelPath(c)
  const base = getWorkspaceBase(sessionId)
  const targetPath = join(base, relPath)

  if (!targetPath.startsWith(base + sep) && targetPath !== base) {
    return c.json({ error: 'Invalid path' }, 400)
  }

  try {
    const body = await c.req.json() as { content: string }
    mkdirSync(dirname(targetPath), { recursive: true })
    writeFileSync(targetPath, body.content, 'utf-8')
    return c.json({ success: true, path: relPath })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})
