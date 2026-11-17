/**
 * Tier 3 support for the artifact and Storage tests: calls against a started memory that record every answer, MCP tool calls
 * that give back the text and whether it was an error, raw byte requests for the PUT to an upload URL and the fetch of a signed
 * link, and note builders.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import { request } from '../../src/request.ts'
import { sql, type RealMemory } from './server.ts'

export const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')
export const bearer = (token: string) => ({ authorization: `Bearer ${token}` })
export const nonce = () => randomUUID().replaceAll('-', '').slice(0, 10)
/** Letters only, so no secret or identifier pattern in redact.ts can match it. */
export const marker = () => randomBytes(16).toString('hex').replace(/\d/g, (d) => 'ghijklmnop'[Number(d)])
/** Plain words of exactly n bytes that no redaction rule touches. */
export const words = (n: number, seed = 'lorem ipsum dolor sit amet') => seed.repeat(Math.ceil(n / seed.length) + 1).slice(0, n)

export type Answer = { text: string; error: boolean }

export type Bed = ReturnType<typeof bedFor>

/** Calls against `memory`, recording every body and Location header in `recorded`. */
export function bedFor(memory: RealMemory) {
  const recorded: { text: string; location: string }[] = []
  const call = async (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) => {
    const r = await request(method, `${memory.url}${path}`, { headers, body, timeoutMs: 120_000 })
    recorded.push({ text: r.text, location: String(r.headers.location ?? '') })
    return r
  }
  /** An MCP session for a token. tool() gives one tool's text and whether it was an error. */
  async function mcp(token = memory.token, client = 'claude-code') {
    const init = await call('POST', '/mcp', bearer(token),
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: client } } })
    const session = String(init.headers['mcp-session-id'])
    const tool = async (name: string, args: Record<string, unknown>): Promise<Answer> => {
      const r = await call('POST', '/mcp', { ...bearer(token), 'mcp-session-id': session }, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } })
      if (r.status !== 200) throw new Error(`${name} answered ${r.status}: ${r.text.slice(0, 300)}`)
      const out = JSON.parse(r.text).result
      return { text: out.content[0].text as string, error: Boolean(out.isError) }
    }
    return { session, tool, init: JSON.parse(init.text).result }
  }
  return { call, mcp, recorded }
}

/** A note an agent can remember: unique title, short body. */
export const note = (title: string, extra: Record<string, unknown> = {}) =>
  ({ pattern: 'observations', title, body: 'A short body.', evidence: 'Tier 3 made it.', ...extra })

/** The entry id a remember reply names. */
export const idOf = (reply: string) => /^Remembered (\S+)\./.exec(reply)![1]

/** Raw bytes in and out over node:http, since the harness's request() sends and reads strings. */
export function raw(method: string, url: string, body?: Buffer, headers: Record<string, string> = {}): Promise<{ status: number; body: Buffer; headers: http.IncomingHttpHeaders }> {
  const target = new URL(url)
  const lib = target.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const req = lib.request(target, { method, headers: { ...headers, ...(body ? { 'content-length': String(body.length) } : {}) } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), headers: res.headers }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(120_000, () => req.destroy(new Error(`${method} ${target.pathname} timed out`)))
    req.end(body)
  })
}

/** The URL upload_blob's reply tells the agent to PUT to. */
export const uploadUrl = (reply: string) => /'(http[^']+)'/.exec(reply)![1]

/** upload_blob, then the PUT of the bytes. Returns the reply. */
export async function upload(tool: (n: string, a: Record<string, unknown>) => Promise<Answer>, bytes: Buffer, mediaType = 'application/octet-stream') {
  const sha = sha256(bytes)
  const reply = await tool('upload_blob', { sha256: sha, size: bytes.length, media_type: mediaType })
  if (reply.error) throw new Error(`upload_blob refused: ${reply.text}`)
  const put = await raw('PUT', uploadUrl(reply.text), bytes, { 'content-type': mediaType })
  if (put.status !== 200) throw new Error(`the PUT answered ${put.status}`)
  return { sha, reply: reply.text }
}

export const countOf = (table: string, where: string) => Number(sql(`select count(*)::int as n from memory.${table} where ${where}`)[0].n)
