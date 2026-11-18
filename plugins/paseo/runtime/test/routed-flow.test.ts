import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { setup } from './helpers.ts'
import { flowDaemon, waitStatus } from './golden/flow.ts'
import { headSha } from '../src/flow/shell.ts'
import type { Run } from '../src/flow/types.ts'

test('dispatch replay starts one run; Carbon audits, Fable verifies and the selected writer repairs', async () => {
  const result = {
    status: 'done',
    summary: 'Updated the greeting',
    evidence: [{ criterion: 'greeting', evidence: 'hello.txt' }],
  }
  const pass = {
    verdict: 'pass',
    criteria: [{ criterion: 'greeting', pass: true, evidence: 'hello.txt' }],
    notes: 'verified',
  }
  const s = setup([
    { match: 'worker for stage task of', json: result, write: { 'hello.txt': 'helo' }, commit: 'add greeting' },
    { match: 'judge for stage task of', json: pass },
    {
      match: 'Check every finding independently',
      reply: JSON.stringify({ findings: [{ id: 'typo', status: 'confirmed', evidence: 'hello.txt has helo' }] }),
    },
    {
      match: 'worker for stage audit-repair of',
      json: result,
      write: { 'hello.txt': 'hello' },
      commit: 'fix spelling',
    },
    { match: 'judge for stage audit-repair of', json: pass },
  ])
  const fake = join(s.state, 'agy')
  writeFileSync(
    fake,
    '#!/usr/bin/env node\n' +
      'const fs=require("node:fs");const findings=fs.readFileSync("hello.txt","utf8")==="helo"?[{id:"typo",evidence:"hello.txt:1 misspells hello"}]:[];\n' +
      'console.log(JSON.stringify({status:"SUCCESS",response:JSON.stringify({findings})}));\n',
    { mode: 0o755 },
  )
  process.env.CLYDE_AGY_BIN = fake
  const { d, client } = await flowDaemon()
  try {
    const assignment = randomUUID()
    const body = {
      flow: 'task',
      cwd: s.repo,
      assignment,
      input: {
        prompt: 'Write a greeting',
        criteria: ['greeting'],
        routing: { overrides: { worker: 'astra', audit: 'carbon' } },
      },
    }
    const [a, b] = await Promise.all([client.call<Run>('POST', '/runs', body), client.call<Run>('POST', '/runs', body)])
    assert.equal(a.id, b.id)
    const run = await waitStatus(client, a.id, ['done', 'failed', 'asking'])
    assert.equal(
      run.status,
      'done',
      JSON.stringify({ error: run.error, question: run.question, log: run.log.slice(-6) }),
    )
    assert.equal(run.auditedHead, await headSha(run.cwd))
    assert.notEqual(run.auditBaseHead, run.auditedHead)
    assert.equal(run.routes?.verify?.model, 'fable')
    assert.equal(run.routes?.worker?.model, 'astra')
    assert.deepEqual(run.stages.map((s) => s.attempts[0].rung.model), ['gpt-6.2-astra', 'gpt-6.2-astra'])
    assert.equal((await client.runs()).length, 1)
  } finally {
    await d.close()
  }
})
