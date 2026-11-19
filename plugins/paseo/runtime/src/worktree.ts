/**
 * Cut a task branch from the source checkout's HEAD. Legacy mirrored tasks can request a visible Paseo workspace.
 * Native workers register their Clyde-owned checkout in their originating Paseo project when the first worker launches.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { clydeHome } from './config.ts'
import { paseoBin, readState } from './paseo.ts'

export type Worktree = { path: string; branch: string; base: string; repo: string; workspace?: string }

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

export function baseSha(path: string): string {
  return git(path, 'rev-parse', 'HEAD')
}

export function createWorktree(repoDir: string, id: string, title?: string, visibleMirror = false): Worktree {
  const repo = git(repoDir, 'rev-parse', '--show-toplevel')
  const base = baseSha(repo)
  const branch = `clyde/${id}`
  const ws = visibleMirror && readState() && process.env.CLYDE_PASEO_MIRROR !== 'off' ? paseoWorkspace(repo, id, branch, base, title || id) : null
  if (ws) return { path: ws.cwd, branch, base, repo, workspace: ws.workspaceId }
  const path = join(clydeHome(), 'worktrees', id)
  git(repo, 'worktree', 'add', '-b', branch, path, base)
  return { path, branch, base, repo }
}

/** A worktree workspace in the repo's Paseo project, or null when Paseo can't make one, so git does it instead. */
function paseoWorkspace(repo: string, id: string, branch: string, base: string, title: string): { cwd: string; workspaceId: string } | null {
  try {
    const out = execFileSync(paseoBin(), ['workspace', 'create', '--isolation', 'worktree', '--path', repo, '--mode', 'branch-off',
      '--new-branch', branch, '--base', base, '--worktree-slug', id, '--title', title, '--json'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 })
    const ws = JSON.parse(out)
    return typeof ws?.cwd === 'string' && existsSync(ws.cwd) ? { cwd: ws.cwd, workspaceId: String(ws.workspaceId) } : null
  } catch {
    return null
  }
}
