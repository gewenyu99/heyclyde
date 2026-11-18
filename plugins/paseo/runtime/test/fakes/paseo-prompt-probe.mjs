// Runs under Paseo's own runtime. Drives Paseo's real startAgentRun (agent/agent-prompt.js) with a stub agent manager whose
// steer answer is "inactive" (agent-manager.js:1839 / :1858), the answer that can go stale. A turn starts at the point given in
// argv[3]: a number of microtask hops (inside the daemon's own chain) or "macrotask" (the next event-loop turn, which is where any I/O result lands).
// Prints what the daemon did: {"log":[...]}.
const [dir, steer, startsAt] = process.argv.slice(2)
const { startAgentRun } = await import(`${dir}/agent/agent-prompt.js`)
const log = []
let turn = false
const begin = () => { turn = true; log.push('turn-started') }
const manager = {
  reloadStalePluginSession: async () => {},
  getAgent: () => ({}),
  tryRunOutOfBand: () => false,
  hasInFlightRun: () => turn,
  steerOrReplaceActiveTurn: async () => {
    log.push(`steer:${steer}`)
    await Promise.resolve()
    return steer === 'steered' ? { status: 'steered' } : { status: 'inactive' }
  },
  replaceAgentRun: async () => { log.push('CANCELLED-RUNNING-TURN'); return (async function* () {})() },
  streamAgent: () => { log.push('queued-start'); return (async function* () {})() },
}
const logger = { trace() {}, info() {}, error() {} }
const done = startAgentRun(manager, 'pointman', 'clyde: hi', logger, { replaceRunning: true, activeTurnBehavior: 'steer' })
// A number N starts the turn after N microtask hops, 'macrotask' on the next event-loop turn.
if (startsAt === 'macrotask') setImmediate(begin)
else {
  const hop = (n) => (n === 0 ? begin() : queueMicrotask(() => hop(n - 1)))
  hop(Number(startsAt))
}
const result = await done
await new Promise((resolve) => setTimeout(resolve, 20))
console.log(JSON.stringify({ result, log }))
