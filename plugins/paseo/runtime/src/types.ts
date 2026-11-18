/** The shapes the daemon, the CLI and the point man share. PLAN.md "Daemon contract" is the reference. */

export type BackendName = 'pi' | 'claude' | 'codex' | 'antigravity'
export type Effort = 'low' | 'medium' | 'high'

// permission is the claude permission mode for this rung. It defaults to bypassPermissions inside clyde worktrees.
export type Rung = { backend: BackendName; model?: string; effort?: Effort; notes?: boolean; permission?: string }

export type ThreadStatus = 'running' | 'queued' | 'idle' | 'failed' | 'stopped'

export type Turn = {
  n: number; prompt: string; startedAt: string; endedAt?: string
  ok?: boolean; text?: string; error?: string; json?: unknown; usage?: unknown
}

export type Thread = {
  id: string; title: string; rung: Rung; cwd: string; worktree?: string; branch?: string; base?: string
  status: ThreadStatus; session?: string; queue: string[]; turns: Turn[]
  runId?: string; stage?: string; readOnly?: boolean; createdAt: string; updatedAt: string
  // Only a run's selected representative has mirrorTitle. CLI-created child threads carry their parent.
  mirrorTitle?: string; parentThreadId?: string
  schema?: object; systemAppend?: string; progress?: string; result?: unknown
  // When the last result was posted, the follow-up turns clyde queued in a row, and this turn's Stop hook refusals.
  resultAt?: string; nudges?: number; stopBlocks?: number
}

export type ClydeEvent = {
  id: number; at: string; type: string; threadId?: string; runId?: string; summary: string; data?: unknown
}
