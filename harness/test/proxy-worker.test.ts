/**
 * Tier 1: memory's Cloudflare Worker (memory/proxy/worker.js), with fetch stubbed. R38 (#42): the country headers the function
 * trusts for the blocked-country checks come from request.cf, never from the client.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import worker from '../../memory/proxy/worker.js'

test('the Worker overwrites country headers from request.cf', async () => {
  const seen: Headers[] = []
  const real = globalThis.fetch
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    seen.push(new Headers(init.headers))
    return new Response('ok')
  }) as typeof fetch
  try {
    const req = new Request('https://memory.heyclyde.me/mcp', { method: 'POST', body: '{}', headers: { 'cf-ipcountry': 'US', 'cf-region-code': 'ON', 'cf-connecting-ip': '203.0.113.9' } })
    Object.defineProperty(req, 'cf', { value: { country: 'DE', regionCode: 'BE' } })
    await worker.fetch(req, { PROXY_SECRET: 'test-secret' })
    const bare = new Request('https://memory.heyclyde.me/mcp', { method: 'POST', body: '{}', headers: { 'cf-ipcountry': 'US', 'cf-region-code': 'ON' } })
    await worker.fetch(bare, { PROXY_SECRET: 'test-secret' })
  } finally {
    globalThis.fetch = real
  }
  assert.equal(seen[0].get('cf-ipcountry'), 'DE')
  assert.equal(seen[0].get('cf-region-code'), 'BE')
  assert.equal(seen[0].get('x-memory-client'), '203.0.113.9')
  assert.equal(seen[0].get('x-memory-proxy'), 'test-secret')
  // No request.cf: the client's own claims are dropped, not passed on.
  assert.equal(seen[1].get('cf-ipcountry'), null)
  assert.equal(seen[1].get('cf-region-code'), null)
})
