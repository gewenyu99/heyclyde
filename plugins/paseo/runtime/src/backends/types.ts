/** What a backend takes and returns for one turn. One turn is one CLI process. */
import type { BackendName, Rung } from '../types.ts'

export type TurnInput = {
  directory?: boolean
  rung: Rung; cwd: string; session?: string; prompt: string; readOnly?: boolean
  systemAppend?: string; env: Record<string, string>; schema?: object; signal: AbortSignal
  onProgress?: (line: string) => void
  // Called as soon as the session id is known, before the turn ends, so a daemon crash mid-turn keeps it.
  onSession?: (session: string) => void
}

export type TurnOutput = { ok: boolean; text: string; session?: string; json?: unknown; error?: string; usage?: unknown }

export interface Backend {
  name: BackendName
  family(rung: Rung): string
  runTurn(input: TurnInput): Promise<TurnOutput>
}
