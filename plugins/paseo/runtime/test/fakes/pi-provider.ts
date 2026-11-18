/** A pi extension that registers a scripted model, fake/fake-1. CLYDE_FAKE_PI_SCRIPT names a JSON file of steps, one per model call. */
import { appendFileSync, readFileSync } from 'node:fs'
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

// text replies, tool calls a tool, echo replies with the last user-side message (a custom message reaches the model
// as a user one), tools lists the tools the model was given, and error ends the call with a model error.
export type Step = { text?: string; tool?: string; args?: Record<string, unknown>; echo?: boolean; tools?: boolean; error?: string }
// log, when set, gets one JSON line per model call with what the model saw.
export type Script = { steps: Step[]; log?: string }

export default function fakeProvider(pi: ExtensionAPI): void {
  const faux = fauxProvider({ provider: 'fake', models: [{ id: 'fake-1', name: 'Fake One', contextWindow: 200_000, maxTokens: 8192 }] })
  let calls = 0
  const respond = (context: { messages: any[] }) => {
    // Each call takes one queued response, so the factory queues itself again.
    faux.appendResponses([respond as any])
    // Read on every call, so a test can add steps once it knows an id the model has to pass on.
    const script = load()
    const step = script.steps[calls++] ?? { text: 'The script has no more steps.' }
    const seen = { call: calls, step, lastUser: lastUser(context.messages), tools: tools(context.messages), system: system(context.messages) }
    if (script.log) appendFileSync(script.log, JSON.stringify(seen) + '\n')
    if (step.error) return fauxAssistantMessage([], { stopReason: 'error', errorMessage: step.error })
    if (step.tool) return fauxAssistantMessage([fauxText(step.text ?? `Calling ${step.tool}.`), fauxToolCall(step.tool, step.args ?? {})])
    if (step.echo) return fauxAssistantMessage(fauxText(`echo: ${seen.lastUser}`))
    if (step.tools) return fauxAssistantMessage(fauxText(`tools: ${seen.tools.join(',')}`))
    return fauxAssistantMessage(fauxText(step.text ?? 'ok'))
  }
  faux.setResponses([respond as any])
  pi.registerProvider(faux.provider)
}

function load(): Script {
  const path = process.env.CLYDE_FAKE_PI_SCRIPT
  if (!path) return { steps: [] }
  return JSON.parse(readFileSync(path, 'utf8'))
}

function text(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n')
}

/** System messages ride along in the transcript and can be last, so they're skipped. */
function lastUser(messages: any[]): string {
  const user = messages.filter((m) => m.role !== 'system').findLast((m) => m.role === 'user')
  return user ? text(user.content) : ''
}

/** Replays toolsAdded and toolsRemoved in order, as a provider does. */
function tools(messages: any[]): string[] {
  const names = new Set<string>()
  for (const m of messages.filter((m) => m.role === 'system')) {
    for (const t of m.toolsAdded ?? []) names.add(t.name)
    for (const t of m.toolsRemoved ?? []) names.delete(t.name)
  }
  return [...names].sort()
}

/** The live system prompt: every section's latest text, joined. */
function system(messages: any[]): string {
  const sections: Record<string, string | null> = {}
  const content: string[] = []
  for (const m of messages.filter((m) => m.role === 'system')) {
    if (text(m.content)) content.push(text(m.content))
    Object.assign(sections, m.sections ?? {})
  }
  return [...content, ...Object.values(sections).filter(Boolean)].join('\n')
}
