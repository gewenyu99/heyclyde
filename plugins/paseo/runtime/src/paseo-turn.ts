import {dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {exitReason,runProcess} from './backends/spawn.ts'
import {readJson} from './store.ts'
import {clydeHome} from './config.ts'
import {memoryMaintenance} from './flow/prompts.ts'
import type {Run} from './flow/types.ts'
import type {Thread} from './types.ts'
/** Mirrored sessions have one writer: Paseo. Clyde still owns the queue and work list. */
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { turnTimeoutMs } from './config.ts'
import { lastJsonBlock } from './backends/spawn.ts'
import type { TurnInput, TurnOutput } from './backends/types.ts'
import { helperCommand, paseo, type Ran } from './paseo.ts'

function sessionFile(input: TurnInput): string | undefined {
  if (input.rung.backend !== 'codex' || !input.session) return
  const home = input.env.CODEX_HOME || join(input.env.HOME || homedir(), '.codex')
  for (const dir of ['sessions', 'archived_sessions']) {
    const root = join(home, dir)
    try {
      const file = readdirSync(root, { recursive: true }).find((p) => String(p).endsWith(`-${input.session}.jsonl`))
      if (file) return join(root, String(file))
    } catch { /* Not every Codex home has archived sessions. */ }
  }
}

function requireOk(r: Ran, command: string): void {
  if (r.code !== 0) throw new Error(`paseo ${command} failed: ${r.json?.error?.message || r.stderr.trim() || r.code}`)
}

export async function runPaseoTurn(id: string, input: TurnInput): Promise<TurnOutput> {
  const out: TurnOutput = { ok: false, text: '', session: input.session }
  const file = sessionFile(input)
  if (input.rung.backend === 'codex' && !file) return { ...out, error: 'mirrored Codex session file is missing' }
  let offset = file ? statSync(file).size : 0
  let partial = ''
  let completed = false
  let failure: string | undefined
  const read = () => {
    if (!file) return
    const size = statSync(file).size
    if (size <= offset) return
    const data = Buffer.alloc(size - offset)
    const fd = openSync(file, 'r')
    let bytes: number
    try { bytes = readSync(fd, data, 0, data.length, offset) } finally { closeSync(fd) }
    partial += data.subarray(0, bytes).toString('utf8')
    offset += bytes
    const lines = partial.split('\n')
    partial = lines.pop()!
    for (const line of lines) {
      let row: any
      try { row = JSON.parse(line) } catch { continue }
      const p = row.payload
      if (row.type === 'event_msg' && p?.type === 'task_complete') {
        completed = true
        out.text = p.last_agent_message ?? out.text
      } else if (row.type === 'event_msg' && p?.type === 'task_failed') failure = p.error?.message ?? p.message ?? 'Paseo turn failed'
      else if (row.type === 'event_msg' && p?.type === 'agent_message') input.onProgress?.((p.message ?? '').slice(0, 300))
      else if (row.type === 'event_msg' && p?.type === 'token_count') out.usage = p.info?.last_token_usage
      else if (row.type === 'response_item' && p?.type === 'message' && p.role === 'assistant') {
        const text = (p.content ?? []).map((c: any) => c.text ?? '').join('')
        if (text) input.onProgress?.(text.slice(0, 300))
      } else if (row.type === 'response_item' && p?.type === 'function_call') input.onProgress?.(`paseo ran ${p.name}`)
    }
  }
  // An imported app-server does not inherit the old CLI worker's environment. Supply the non-secret CLI context explicitly.
  const context = Object.entries(input.env).filter(([k]) => ['CLYDE_HOME', 'CLYDE_BIN', 'CLYDE_THREAD_ID', 'CLYDE_RUN_ID', 'CLYDE_MEMORY_SCOPE', 'CLAUDE_PLUGIN_ROOT'].includes(k))
    .map(([k, v]) => `${k}='${v.replaceAll("'", "'\\''")}'`).join(' ')
  const prompt = `${input.systemAppend ? `${input.systemAppend}\n\n` : ''}For clyde CLI calls in this turn, prefix commands with: ${context}. Use CLYDE_BIN with node if clyde is not on PATH.\n\n${input.prompt}${input.schema ? `\n\nAnswer with JSON matching this schema: ${JSON.stringify(input.schema)}` : ''}`
  let polling: ReturnType<typeof setInterval> | undefined
  let sent = false
  let stop: Promise<Ran> | undefined
  const interrupt = () => { if (sent) stop ??= paseo(['stop', id]) }
  const since = new Date().toISOString()
  try {
    if (input.signal.aborted) throw new Error('paseo was stopped')
    requireOk(await paseo(['send', '--no-wait', id, '--prompt', prompt]), 'send')
    sent = true
    input.signal.addEventListener('abort', interrupt, { once: true })
    if (input.signal.aborted) interrupt()
    input.onProgress?.('Paseo is running the mirrored turn')
    polling = setInterval(() => { try { read() } catch { /* Read again after wait. */ } }, 1000)
    const timeout = turnTimeoutMs()
    const waited = await paseo(['wait', id, '--timeout', String(Math.ceil(timeout / 1000))], timeout + 5000)
    if (waited.code !== 0 || input.signal.aborted) {
      interrupt()
      await stop
      requireOk(waited, 'wait')
      throw new Error('paseo was stopped')
    }
    read()
    const inspected = await paseo(['inspect', id])
    requireOk(inspected, 'inspect')
    if (inspected.json?.Status === 'failed' || inspected.json?.Status === 'error') throw new Error('Paseo agent failed')
    if (failure) throw new Error(failure)
    if (file && !completed) throw new Error('Paseo became idle without completing the Codex turn')
    if (!file) {
      const logs = await paseo(['logs', id, '--since', since, '--filter', 'text'])
      requireOk(logs, 'logs')
      out.text = logs.stdout.trim()
    }
    out.ok = true
    if (input.schema) {
      out.json = lastJsonBlock(out.text)
      if (out.json === undefined) throw new Error('Paseo answered with text that is not JSON despite the requested schema')
    }
  } catch (err) {
    out.ok = false
    out.error = (err as Error).message
  } finally {
    clearInterval(polling)
    input.signal.removeEventListener('abort', interrupt)
    await stop
  }
  return out
}

export async function runManagedWorker(t:Thread,input:TurnInput):Promise<TurnOutput>{
  const command=helperCommand(join(dirname(fileURLToPath(import.meta.url)),'paseo-worker.mjs'),[],process.env.CLYDE_PASEO_WORKER_BIN)
  if(!command)return {ok:false,text:'',error:'Clyde could not locate the installed Paseo worker launcher.'}
  const env:Record<string,string>={}
  for(const k of ['CLYDE_HOME','CLYDE_BIN','CLYDE_THREAD_ID','CLYDE_RUN_ID','CLYDE_MEMORY_SCOPE','PATH']){
    if(input.env[k])env[k]=input.env[k]!
  }
  let answer:TurnOutput|undefined
  const n=t.turns.length
  const timeoutMs=turnTimeoutMs()
  const run=t.runId && readJson<Run>(join(clydeHome(),'runs',t.runId+'.json'))
  const launch={memoryTask:!!run&&memoryMaintenance(run),id:t.paseoAgentId,parent:t.paseoParentId,first:n===1,messageId:t.id+'-turn-'+n,cwd:t.cwd,
    thread:t.id,run:t.runId,taskTitle:run ? run.title : t.title,
    title:run && t.title.startsWith(run.id+' ') ? run.title+' · '+t.title.slice(run.id.length+1) : t.title,backend:t.rung.backend,model:t.rung.model,thinking:t.rung.effort,
    allowFullAccess:!!run && (run.allowAntigravityFullAccess===true || (run.input as {allowAntigravityFullAccess?:boolean})?.allowAntigravityFullAccess===true),
    env,system:input.systemAppend,prompt:input.prompt,timeoutMs}
  const result=await runProcess({bin:command.cmd,args:command.args,env:command.env as Record<string,string>,cwd:t.cwd,
    stdin:JSON.stringify(launch),timeoutMs:timeoutMs+10000,signal:input.signal,onLine:line=>{
      let msg
      try{msg=JSON.parse(line)}catch{return}
      if(msg.progress)input.onProgress?.(msg.progress)
      if(msg.started)input.onProgress?.('Working in Paseo · '+msg.started)
      if(typeof msg.ok==='boolean')answer={ok:msg.ok,text:msg.text??'',error:msg.error,json:lastJsonBlock(msg.text??'')}
    }}).done
  if(result.aborted||result.timedOut||!answer)return {ok:false,text:'',error:exitReason('Paseo worker',result,timeoutMs)}
  return answer
}
