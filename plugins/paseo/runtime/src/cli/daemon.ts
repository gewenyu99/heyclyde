/** clyde daemon: runs the daemon in the foreground until SIGINT or SIGTERM. */
import { ensureDaemon, healthy, isStaleHealth } from '../client.ts'
import { clydeHome, readDaemonInfo } from '../config.ts'
import { startDaemon } from '../daemon.ts'

export async function main(argv: string[]): Promise<number> {
  if (argv[0] === 'ensure') {
    const client = await ensureDaemon({ restartIfStale: true })
    if (argv.includes('--status')) console.log(isStaleHealth(await client.health()) ? 'deferred' : 'current')
    return 0
  }
  const existing = readDaemonInfo()
  if (await healthy(existing)) {
    console.error(`clyde daemon is already running on port ${existing?.port}, pid ${existing?.pid}.`)
    return 1
  }
  const daemon = await startDaemon()
  console.log(`clyde daemon listening on 127.0.0.1:${daemon.port}, state in ${clydeHome()}`)
  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => resolve())
    process.once('SIGTERM', () => resolve())
  })
  await daemon.close()
  return 0
}
