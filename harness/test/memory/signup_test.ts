/**
 * R54 (#59): the Worker's sign-in page asks Turnstile when the function hands it a site key, and the page's CSP opens only
 * Cloudflare's challenge origin for it. Without a key the page stays as locked down as every other.
 */
import assert from 'node:assert/strict'
import worker from '../../../memory/proxy/worker.js'

const ENV = { PROXY_SECRET: 'test-proxy-secret' }
const ORIGIN = 'https://challenges.cloudflare.com'

async function askEmail(extra: Record<string, unknown>) {
  globalThis.fetch = (() => Promise.resolve(Response.json({ state: 'ask_email', message: 'memory: enter your email.', ...extra }))) as typeof fetch
  const r = await worker.fetch(new Request('https://memory.heyclyde.me/oauth/consent?authorization_id=abcdef12-3456-7890-abcd-ef1234567890',
    { headers: { accept: 'text/html' } }), ENV)
  return { csp: r.headers.get('content-security-policy') ?? '', html: await r.text() }
}

Deno.test('R54: the sign-in page asks Turnstile', async () => {
  const { csp, html } = await askEmail({ turnstile_site_key: '0x4AAAAAAATESTKEY' })
  const widgets = [...html.matchAll(/class="cf-turnstile"[^>]*data-sitekey="([^"]+)"/g)]
  assert.equal(widgets.length, 1, html)
  assert.equal(widgets[0][1], '0x4AAAAAAATESTKEY')
  const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1]
  assert.ok(nonce, csp)
  assert.match(html, new RegExp(`<script nonce="${nonce}" src="${ORIGIN}/turnstile/v0/api\\.js"`))
  assert.match(csp, new RegExp(`script-src 'nonce-${nonce}' ${ORIGIN};`))
  assert.match(csp, new RegExp(`frame-src ${ORIGIN};`))
  const origins = [...csp.matchAll(/https?:\/\/[^\s;']+/g)].map((m) => m[0])
  assert.deepEqual([...new Set(origins)], [ORIGIN], 'no other origin')

  const plain = await askEmail({})
  assert.ok(!plain.html.includes('cf-turnstile') && !plain.csp.includes(ORIGIN))
  // A load is a src or a stylesheet; a link a reader clicks is not.
  assert.equal([...plain.html.matchAll(/src="https?:\/\/|<link[^>]+href="https?:\/\//g)].length, 0, 'nothing loaded from another origin')

  const social = await askEmail({ turnstile_site_key: '0x4AAAAAAATESTKEY', providers: ['google', 'github'] })
  assert.ok(social.html.includes('/oauth/provider?authorization_id=abcdef12-3456-7890-abcd-ef1234567890&amp;provider=google') || social.html.includes('/oauth/provider?authorization_id=abcdef12-3456-7890-abcd-ef1234567890&provider=google'), social.html)
  assert.ok(social.html.includes('Continue with Google') && social.html.includes('Continue with GitHub'), social.html)
  assert.ok(social.html.includes('Sign in with Google or GitHub, or enter your email'), social.html)
  assert.equal([...social.html.matchAll(/<img[^>]+src="https?:\/\/|<link[^>]+href="https?:\/\//g)].length, 0, 'social icons are inline SVGs with zero external loads')

  const googleOnly = await askEmail({ providers: ['google'] })
  assert.ok(googleOnly.html.includes('Continue with Google') && !googleOnly.html.includes('Continue with GitHub'), googleOnly.html)
  assert.ok(googleOnly.html.includes('Sign in with Google, or enter your email'), googleOnly.html)
})
