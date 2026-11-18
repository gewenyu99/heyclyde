/**
 * Hands one message to a Paseo agent, and only if the daemon itself finds the agent has no turn running.
 *
 * Why not paseo send: Paseo 0.11.2, paths inside Paseo.app/Contents/Resources/app.asar/node_modules/@getpaseo
 *  - cli/dist/commands/agent/send.js:142 calls sendAgentMessage(id, text, { images }) and never sets activeTurnBehavior.
 *  - server/dist/server/server/session.js:6172 then defaults it to "interrupt", and agent/agent-prompt.js:203 sets
 *    replaceRunning: true, so agent/agent-manager.js:1788-1801 replaceAgentRun cancels the run in flight. That cancel is
 *    the "The user doesn't want to proceed with this tool use" the point man saw. The daemon never refuses a send to a
 *    running agent, so an idle check before paseo send, or before any send_agent_message, can't make it safe: a turn
 *    can start between the check and the send. The wire has no way to say "only if idle" (protocol/dist/messages.js:975
 *    takes activeTurnBehavior "interrupt" or "steer", and every daemon send path sets replaceRunning: true).
 *
 * What does refuse: a schedule that targets an agent. server/dist/server/server/schedule/service.js:650-651 checks
 * hasInFlightRun(agent.id) and throws "Agent ... already has an active run" before anything is sent. So this script creates
 * a one-run schedule for the agent and fires it once (the client's scheduleRunOnce). A running agent gets the failed run and
 * nothing else: {"ok":false,"busy":true}, and the caller waits for idle again. An idle agent starts a turn with the message.
 *
 * The check and the start are not one step. service.js:653 awaits startAgentRun, and agent/agent-prompt.js:64 awaits
 * steerOrReplaceActiveRun before it starts anything, so a turn could begin after the daemon's check. It can't cancel a tool call:
 *  - The schedule passes activeTurnBehavior "steer" (service.js:653-655), so agent-prompt.js:4-17 asks
 *    agent-manager.js:1835 steerOrReplaceActiveTurn first, never the interrupting replace that paseo send ends up in.
 *  - That finds the new turn and hands the message to Claude's steerActiveTurn (providers/claude/agent.js:1841-1866).
 *    It pushes the message onto the live input with priority "next" (:1857) and returns "accepted". The running tool call
 *    is untouched and the message is read at the next break in the turn. Nothing clears pending permissions, since the
 *    schedule leaves clearPendingPermissions unset.
 *  - Steer can be unavailable: for a slash command (:1842), a compaction (:1846), or a turn whose live query and input are not
 *    set yet (:1851-1854). Then agent-manager.js:1861-1866 replaces the turn, the cancel path the paseo send ends in. It is
 *    not reachable from this schedule after the check passed. hasInFlightRun (agent-manager.js:449-457) is true for any
 *    foreground turn, and service.js:650-655, startAgentRun (agent-prompt.js:64), steerOrReplaceActiveRun (:4-17) and
 *    steerOrReplaceActiveTurn (agent-manager.js:1836) run in one tick with no await, so the turn it reads as active is a turn
 *    the check already refused. A turn that starts while the daemon loads the agent (service.js:640) is refused with its
 *    steering unready. A background turn (activeTurnId with no foreground turn) answers "inactive" at agent-manager.js:1857.
 *    The text always opens with the "<paseo-system>" envelope (agent-prompt.js:126), never "/".
 *  - The one answer that can go stale is "inactive": startOrReplaceRun (agent-prompt.js:21-26) re-reads hasInFlightRun a few
 *    promise hops after steerOrReplaceActiveTurn answers (agent-manager.js:1839, :1858), and every daemon send path sets
 *    replaceRunning, so the wire has no variant without it. Those hops hold no I/O. A turn reaches a tool call only after the
 *    model answers, on a later event-loop turn, so a turn that starts after the hops is left alone and the message starts its
 *    own run (queued-start). Only a turn begun inside those 3 hops is replaced (swept in delivery-paseo.test.ts), and it has run no
 *    tool call. Nothing outside the daemon's own microtask chain can start one there: another sender's I/O result is a later
 *    event-loop turn. This one case can't be closed from clyde: service.js:654 and every other startAgentRun caller sets
 *    replaceRunning, so the wire has no send that refuses to replace. A Paseo change (replaceRunning: false there) would.
 * So the gap costs a message that waits inside the turn, not a cancelled tool call. The script sees a run that keeps
 * going and reports {"ok":true}, so the message isn't also sent again.
 * Paseo 0.16 also checks out-of-band commands and reloads stale plugin sessions before steering.
 * The synthetic probe observes replacement through the fourth microtask hop on this version.
 * Checked live on 0.11.2 against an agent in the middle of a Bash call: the run failed with "already has an active run",
 * the call kept running, and the agent got no message. Against an idle agent the message arrived as a turn.
 * The agent sees the text inside a <paseo-system> block headed by the schedule's name and ids.
 *
 * Run by paseo.ts under Paseo's own runtime:
 *   paseo-deliver.mjs <cli dist dir> <agent id>   (message on stdin)
 * Prints {"ok":true}, {"ok":false,"busy":true,"error":"..."} or {"ok":false,"error":"..."} and exits 0 or 1.
 */
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const POLL_MS = 150
// A refusal is on the run within milliseconds of the fire, so a run still going after this long was accepted.
const ACCEPTED_AFTER_MS = 1500
const GIVE_UP_MS = 30_000
const DAY_MS = 24 * 60 * 60 * 1000

const [dist, agentId] = process.argv.slice(2)
const text = await new Promise((resolve) => {
  let data = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => { data += chunk })
  process.stdin.on('end', () => resolve(data))
})
const load = (file) => import(pathToFileURL(join(dist, file)).href)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** What the finished or ongoing run says about the message: sent, refused because a turn runs, or not sent. */
function outcome(run, sinceRunning) {
  if (run.status === 'succeeded') return { ok: true }
  if (run.status === 'failed') {
    const error = String(run.error ?? 'the schedule run failed')
    if (/already has an active run/.test(error)) return { ok: false, busy: true, error }
    // The turn started and then stopped on a permission, so the message is with the agent.
    if (/is waiting for permission/.test(error)) return { ok: true }
    return { ok: false, error }
  }
  return sinceRunning >= ACCEPTED_AFTER_MS ? { ok: true } : null
}

let client
let scheduleId
let result
try {
  if (!dist || !agentId || !text.trim()) throw new Error('usage: paseo-deliver.mjs <cli dist dir> <agent id> with the message on stdin')
  const { selectDaemonTarget } = await load('utils/daemon-target.js')
  const { connectToDaemon } = await load('utils/client.js')
  client = await connectToDaemon({ target: selectDaemonTarget({}, process.env, false) })
  const created = await client.scheduleCreate({
    prompt: text,
    cadence: { type: 'every', everyMs: DAY_MS },
    target: { type: 'agent', agentId },
    name: 'clyde',
    maxRuns: 1,
    runOnCreate: false,
  })
  scheduleId = created?.schedule?.id
  if (!scheduleId) throw new Error(created?.error ?? 'Paseo created no schedule')
  // The run holds until the agent's turn ends, so the answer is read from the schedule's run, not from this call.
  const fired = client.scheduleRunOnce({ id: scheduleId }).catch((err) => ({ error: err?.message ?? String(err) }))
  const began = Date.now()
  let runningSince = null
  while (!result && Date.now() - began < GIVE_UP_MS) {
    await sleep(POLL_MS)
    const run = (await client.scheduleInspect({ id: scheduleId }))?.schedule?.runs?.at(-1)
    if (!run) continue
    if (run.status === 'running') runningSince ??= Date.now()
    result = outcome(run, runningSince ? Date.now() - runningSince : 0)
  }
  if (!result) {
    const answered = await Promise.race([fired, sleep(0).then(() => null)])
    throw new Error(answered?.error ?? 'Paseo did not answer the schedule run')
  }
} catch (err) {
  result = { ok: false, error: err?.message ?? String(err) }
} finally {
  // Deleting the schedule leaves a turn that is already running alone; it only clears the sidebar entry.
  if (client && scheduleId) await client.scheduleDelete({ id: scheduleId }).catch(() => {})
  await client?.close().catch(() => {})
}
console.log(JSON.stringify(result))
process.exitCode = result.ok ? 0 : 1
