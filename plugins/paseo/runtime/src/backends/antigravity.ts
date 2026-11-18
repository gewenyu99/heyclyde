import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Backend } from './types.ts'
import { exitReason, lastJsonBlock, runProcess } from './spawn.ts'
import { turnTimeoutMs } from '../config.ts'

/** One result per process. Large audit briefs go in a private file to avoid the OS argument limit. */
export const antigravity: Backend = {
  name: 'antigravity',
  family: () => 'google',
  async runTurn(input) {
    let prompt = [input.systemAppend, input.prompt].filter(Boolean).join('\n\n')
    const args = ['--model', input.rung.model ?? 'gemini-4-carbon-high', '--sandbox', '--output-format', 'json']
    if (input.readOnly) {
      // Plan mode invokes an interactive slash workflow. Audits need only file reads and the supplied diff.
      args.push(
        '--disable-slash-commands',
        '--settings',
        JSON.stringify({ permissions: { deny: ['command(*)', 'write_file(*)', 'mcp(*)', 'execute_url(*)'] } }),
      )
    } else {
      args.push('--mode', 'accept-edits')
    }
    let dir: string | undefined
    try {
      if (Buffer.byteLength(prompt) > 48 * 1024) {
        dir = await mkdtemp(join(tmpdir(), 'clyde-audit-'))
        const file = join(dir, 'brief.md')
        await writeFile(file, prompt, { mode: 0o600 })
        args.push('--add-dir', dir)
        prompt = 'Read the audit brief in ' + file + ' and return the requested findings.'
      }
      args.push('--print', prompt)
      const lines: string[] = []
      const timeoutMs = turnTimeoutMs()
      const result = await runProcess({
        bin: process.env.CLYDE_AGY_BIN || 'agy',
        args,
        cwd: input.cwd,
        env: input.env,
        timeoutMs,
        signal: input.signal,
        onLine: (line) => lines.push(line),
      }).done
      if (result.code || result.aborted || result.timedOut || result.spawnError) {
        return { ok: false, text: '', error: exitReason('agy', result, timeoutMs) }
      }
      const answer = JSON.parse(lines.join('\n'))
      if (answer.status !== 'SUCCESS' || !answer.response?.trim()) {
        return { ok: false, text: '', error: answer.error || result.stderr.trim() || 'Antigravity returned no audit' }
      }
      return { ok: true, text: answer.response, json: lastJsonBlock(answer.response), usage: answer.usage }
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true })
    }
  },
}
