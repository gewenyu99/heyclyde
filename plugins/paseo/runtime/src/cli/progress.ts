/** clyde progress "<line>": a one-line status update from inside a thread. The daemon posts it as a thread.progress event. */
import { DaemonClient } from '../client.ts'

export async function main(argv: string[]): Promise<number> {
  const line = argv.join(' ').trim()
  if (!line) {
    console.error('Usage: clyde progress "<line>"')
    return 2
  }
  const thread = process.env.CLYDE_THREAD_ID
  if (!thread) {
    console.error('clyde progress: CLYDE_THREAD_ID is not set, so this is not a clyde thread.')
    return 1
  }
  const client = DaemonClient.fromFile()
  if (!client) {
    console.error('clyde progress: the clyde daemon is not running.')
    return 1
  }
  await client.progress(thread, line.split('\n')[0])
  console.log('Posted.')
  return 0
}
