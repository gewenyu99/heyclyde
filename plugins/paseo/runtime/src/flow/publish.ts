import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { FlowCtx } from './types.ts'
import { headSha } from './shell.ts'

const exec = promisify(execFile)
export async function publishDraft(ctx: FlowCtx) {
  const run = ctx.run
  const checkSignal = () => {
    if (ctx.signal?.aborted) throw new Error('Publication aborted')
  }
  checkSignal()
  const cmd = async (bin: string, args: string[]) => {
    checkSignal()
    return (await exec(bin, args, { cwd: run.cwd, timeout: 60000, ...(ctx.signal ? { signal: ctx.signal } : {}) })).stdout.trim()
  }
  const head = run.auditedHead
  if (!head || await headSha(run.cwd) !== head || await cmd('git', ['status', '--porcelain'])) {
    throw new Error('A clean, audited revision is required for publication')
  }
  await cmd('git', ['push', 'origin', head + ':refs/heads/' + run.branch])
  const remote = await cmd('git', ['ls-remote', 'origin', 'refs/heads/' + run.branch])
  if (remote.split(/\s+/)[0] !== head) throw new Error('Remote branch does not match the audit')
  const find = async () =>
    JSON.parse(
      await cmd('gh', ['pr', 'list', '--head', run.branch, '--state', 'open', '--json', 'url,headRefOid']),
    ) as { url: string; headRefOid: string }[]
  const dir = await mkdtemp(join(tmpdir(), 'clyde-pr-'))
  try {
    const file = join(dir, 'body.md')
    await writeFile(
      file,
      [
        run.title,
        '',
        'Audited revision: ' + head,
        '',
        ...run.stages.filter((s) => s.status === 'passed').map((s) => '- ' + s.name + ': ' + (s.summary || 'passed')),
      ].join('\n'),
    )
    const [existing] = await find()
    if (existing && existing.headRefOid !== head) throw new Error('Existing PR has a different head')
    checkSignal()
    if (existing) await cmd('gh', ['pr', 'edit', existing.url, '--body-file', file])
    else await cmd('gh', ['pr', 'create', '--draft', '--head', run.branch, '--title', run.title, '--body-file', file])
    const [verified] = await find()
    if (verified?.headRefOid !== head) throw new Error('Could not verify the published PR head')
    run.pullRequest = verified.url
    ctx.persist()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
