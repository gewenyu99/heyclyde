/**
 * Git worktrees for threads and runs, on branch clyde/<id>, cut from the repo's HEAD. A top-level task, one the point
 * man started for Wen, is a Paseo workspace in the repo's own project, titled with the task's name, so his sidebar
 * groups every task under the repo. Everything else is a plain worktree at <CLYDE_HOME>/worktrees/<id>, which Paseo
 * never sees: a worktree outside Paseo's project gets a project of its own named after its folder.
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

export function createWorktree(repoDir: string, id: string, title?: string, topLevel = false): Worktree {
  const repo = git(repoDir, 'rev-parse', '--show-toplevel')
  const base = baseSha(repo)
  const branch = `clyde/${id}`
  const ws = topLevel && readState() && process.env.CLYDE_PASEO_MIRROR !== 'off' ? paseoWorkspace(repo, id, branch, base, title || id) : null
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
