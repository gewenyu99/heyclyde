/** clyde up: the daemon, then the point man. By default a Claude Code agent in Paseo, the local UI. --terminal runs pi here, --happier goes through Happier. */
import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import { extensionInstalled, extensionPath } from '../backends/pi.ts'
import { ensureDaemon } from '../client.ts'
import { createPointMan, POINT_MAN_TAG, readState, saveState, sessionExists, unavailable } from '../happier.ts'
import * as paseo from '../paseo.ts'
import { CHATGPT, ladder } from '../roles.ts'
import { installExtension } from './install.ts'

export async function main(argv: string[]): Promise<number> {
  let values: { cwd?: string; terminal?: boolean; happier?: boolean; 'no-open'?: boolean }
  try {
    values = parseArgs({ args: argv, options: { cwd: { type: 'string' }, terminal: { type: 'boolean' }, happier: { type: 'boolean' }, 'no-open': { type: 'boolean' } } }).values
  } catch (err) {
    console.error(`${(err as Error).message}\nUsage: clyde up [--cwd D] [--terminal | --happier] [--no-open]`)
    return 2
  }
  const cwd = values.cwd ?? process.cwd()
  const client = await ensureDaemon()
  say('daemon', 'ok', `pid ${client.info.pid}, port ${client.info.port}`)
  if (!values.terminal && !values.happier) return inPaseo(cwd, !values['no-open'])
  // Happier can't pass -e, so pi must find the extension in its agent dir.
  const ext = installExtension()
  if (ext.status === 'done') say('extension', 'linked', ext.detail)
  const why = values.terminal ? 'you asked for the terminal' : await unavailable()
  if (why) {
    say('point man', 'terminal', `${why}, so pi runs here.`)
    return terminal(cwd)
  }
  const saved = readState()
  if (saved && (await sessionExists(saved.sessionId))) {
    say('point man', 'ok', `Happier session ${saved.sessionId}. Open it in the Happier app.`)
    return 0
  }
  let id: string
  try {
    id = await createPointMan(cwd)
  } catch (err) {
    say('point man', 'terminal', `${(err as Error).message}, so pi runs here.`)
    return terminal(cwd)
  }
  saveState({ sessionId: id, tag: POINT_MAN_TAG, cwd, createdAt: new Date().toISOString() })
  say('point man', 'started', `Happier session ${id}. Open it in the Happier app.`)
  return 0
}

/** The point man as a Claude Code agent in Paseo: reused while it exists, else started in cwd. Then Paseo opens on it. */
async function inPaseo(cwd: string, show: boolean): Promise<number> {
  const why = await paseo.ensureRunning()
  if (why) {
    console.error(`clyde up: ${why}. clyde up --terminal runs pi here instead.`)
    return 1
  }
  const saved = paseo.readState()
  let id = saved && (await paseo.agentExists(saved.agentId)) ? saved.agentId : ''
  if (id) say('point man', 'ok', `Paseo agent ${id}`)
  else {
    try {
      id = await paseo.createPointMan(cwd)
    } catch (err) {
      console.error(`clyde up: ${(err as Error).message}`)
      return 1
    }
    paseo.saveState({ agentId: id, cwd, createdAt: new Date().toISOString() })
    say('point man', 'started', `Paseo agent ${id}, Claude Code on your plan, in ${cwd}`)
  }
  if (show) await paseo.open(id).catch((err) => console.error(`clyde up: ${(err as Error).message}. Open Paseo yourself.`))
  return 0
}

/** One step per line, in aligned columns. */
function say(name: string, word: string, detail: string): void {
  console.log(`${name.padEnd(10)}  ${word.padEnd(8)}  ${detail}`)
}

/** CLYDE_POINT_MAN=1 pi, attached to this terminal, until you quit it. */
function terminal(cwd: string): Promise<number> {
  const env = { ...process.env, CLYDE_POINT_MAN: '1' }
  delete env.CLYDE_DELIVERY
  // The point man runs on the thread role's pi model, never pi's own default, which can be a Claude sign-in (ruling 4).
  const model = ladder('thread').find((r) => r.backend === 'pi')?.model ?? CHATGPT
  const args = [...(extensionInstalled(env) ? [] : ['-e', extensionPath()]), '--model', model]
  const bin = process.env.CLYDE_PI_BIN || 'pi'
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, env, stdio: 'inherit' })
    child.on('error', (err) => {
      console.error(`clyde up: can't start ${bin}: ${err.message}. Install pi, or set CLYDE_PI_BIN.`)
      resolve(1)
    })
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 130 : 1)))
  })
}
