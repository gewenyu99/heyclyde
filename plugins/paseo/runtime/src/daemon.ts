/** The clyde daemon: threads, the event log and the HTTP API on 127.0.0.1, with its port and token in daemon.json. */
import { randomBytes } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import type http from 'node:http'
import { DaemonClient, healthy } from './client.ts'
import { daemonInfoPath, daemonPort, loadMemoryEnv, clydeHome, readDaemonInfo } from './config.ts'
import { startDelivery } from './delivery.ts'
import { startMemoryFlush } from './memory-flush.ts'
import { EventLog } from './events.ts'
import { createServer, type Route } from './http.ts'
import { startMirror } from './mirror.ts'
import { runtimeMemory, type Memory } from './memory.ts'
import { routes } from './routes/index.ts'
import { writeJson } from './store.ts'
import { Threads } from './threads.ts'

export type DaemonCtx = {
  threads: Threads; events: EventLog; memory: Memory | null; home: string; token: string
  // The runs module sets this when it mounts, so /health can count runs.
  runCount: () => number
  // Run before threads shut down when the daemon closes, in the order they were added.
  beforeClose: (() => Promise<void> | void)[]
}

export type Daemon = { port: number; token: string; ctx: DaemonCtx; server: http.Server; close: () => Promise<void> }

export async function startDaemon(opts: { port?: number } = {}): Promise<Daemon> {
  const home = clydeHome()
  mkdirSync(home, { recursive: true })
  loadMemoryEnv()
  const token = randomBytes(32).toString('hex')
  const events = new EventLog()
  const memory = runtimeMemory()
  const threads = new Threads({ events, memory })
  const ctx: DaemonCtx = { threads, events, memory, home, token, runCount: () => 0, beforeClose: [] }
  const table: Route[] = []
  const server = createServer(table, token)
  // The port comes first: a daemon that can't listen must not touch threads another daemon may own.
  const port = await listen(server, opts.port ?? daemonPort())
  // Recovery runs before the routes mount, so the runs module sees settled thread states when it resumes runs.
  threads.recover()
  table.push(...routes(ctx))
  // daemon.json goes last, so a client that reads it finds every route answering.
  writeJson(daemonInfoPath(), { pid: process.pid, port, token }, 0o600)
  const stopDelivery = startDelivery(events)
  const stopMemoryFlush = startMemoryFlush(() => ({ url: process.env.MEMORY_URL, runtimeToken: process.env.MEMORY_RUNTIME_TOKEN, agentToken: process.env.MEMORY_TOKEN }))
  // CLYDE_PASEO_MIRROR=off keeps every thread out of Paseo, a switch for when the mirror misbehaves.
  const stopMirror = process.env.CLYDE_PASEO_MIRROR === 'off' ? () => {} : startMirror(events, threads, home)

  let closing: Promise<void> | undefined
  const close = () => (closing ??= (async () => {
    if (typeof stopDelivery === 'function') stopDelivery()
    stopMemoryFlush()
    stopMirror()
    for (const fn of ctx.beforeClose) await fn()
    await threads.shutdown()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    const info = readDaemonInfo()
    if (info?.pid === process.pid && info.port === port) rmSync(daemonInfoPath(), { force: true })
  })())
  return { port, token, ctx, server, close }
}

function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve((server.address() as { port: number }).port)
    })
  })
}

/** The running daemon, or one started in this process that closes when the command ends. Its runs resume on the next start. */
export async function connect(): Promise<{ client: DaemonClient; daemon?: Daemon }> {
  const info = readDaemonInfo()
  if (info && (await healthy(info))) return { client: new DaemonClient(info) }
  let daemon: Daemon
  try {
    daemon = await startDaemon()
  } catch (err) {
    // Another clyde home's daemon holds the default port. This one only lives for the command, so any port works.
    if ((err as { code?: string }).code !== 'EADDRINUSE') throw err
    daemon = await startDaemon({ port: 0 })
  }
  return { client: new DaemonClient({ pid: process.pid, port: daemon.port, token: daemon.token }), daemon }
}
