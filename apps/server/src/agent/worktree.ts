/**
 * Git Worktree isolation for sub-agents. Creates a temporary worktree
 * branched from HEAD so a child agent can modify files without conflicting
 * with the parent or sibling agents.
 *
 * Lifecycle:
 *   1. createWorktree(taskId) → path to worktree directory
 *   2. Sub-agent runs with CWD = worktree path
 *   3. checkWorktreeChanges(path) → boolean (any uncommitted changes?)
 *   4. removeWorktree(taskId) — clean up (only if no changes)
 *
 * If the sub-agent made changes, the worktree is preserved and reported
 * in the <task-notification> so the parent can decide to merge.
 */

import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const WORKTREE_BASE = '.git/worktrees-subagent'

function getProjectRoot(): string {
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim()
  } catch {
    return process.cwd()
  }
}

export interface WorktreeInfo {
  path: string
  branch: string
  taskId: string
}

export function createWorktree(taskId: string): WorktreeInfo {
  const root = getProjectRoot()
  const branch = `subagent/${taskId}`
  const worktreePath = resolve(root, WORKTREE_BASE, taskId)

  execSync(`git worktree add -b "${branch}" "${worktreePath}" HEAD`, {
    cwd: root,
    encoding: 'utf-8',
    stdio: 'pipe',
  })

  return { path: worktreePath, branch, taskId }
}

export function checkWorktreeChanges(worktreePath: string): boolean {
  if (!existsSync(worktreePath)) return false
  try {
    const status = execSync('git status --porcelain', {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: 'pipe',
    })
    return status.trim().length > 0
  } catch {
    return false
  }
}

export function removeWorktree(taskId: string): void {
  const root = getProjectRoot()
  const worktreePath = resolve(root, WORKTREE_BASE, taskId)
  const branch = `subagent/${taskId}`

  try {
    execSync(`git worktree remove "${worktreePath}" --force`, {
      cwd: root,
      encoding: 'utf-8',
      stdio: 'pipe',
    })
  } catch { /* worktree may not exist */ }

  try {
    execSync(`git branch -D "${branch}"`, {
      cwd: root,
      encoding: 'utf-8',
      stdio: 'pipe',
    })
  } catch { /* branch may not exist */ }
}

/** Clean up orphaned worktrees from prior runs (called at server startup). */
export function cleanupOrphanedWorktrees(): void {
  const root = getProjectRoot()
  const worktreeDir = resolve(root, WORKTREE_BASE)
  if (!existsSync(worktreeDir)) return

  try {
    execSync('git worktree prune', { cwd: root, encoding: 'utf-8', stdio: 'pipe' })
  } catch { /* ignore */ }
}
