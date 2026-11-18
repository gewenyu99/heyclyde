/**
 * R78 (like-vincent #83): every coding app's setup carries its exact hook config, and registering comes first everywhere. The
 * docs' cards, /llms.txt and the agent-setup prompt all show the configs in full, chat apps say they have no hooks, and the
 * installer's bundle and the Antigravity plugin ship the same bytes as memory/proxy/hook.js.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'
import { repoRoot } from '../../src/config.ts'
import { AGENT_SETUP_PROMPT, HOOK_APPS, INSTALL } from '../../../memory/proxy/hook.js'
import { appSteps, CARD_HOOKS, CHAT_CARDS, esc } from '../../../memory/proxy/pages.js'
import { siteFile, sitePage } from '../../../memory/proxy/site.js'

const byApp = Object.fromEntries(HOOK_APPS.map((h: any) => [h.app, h]))
/** The first numbered step of a card. */
const firstStep = (body: string) => /<li>([\s\S]*?)<\/li>/.exec(body)?.[1] ?? ''

test('R78 every coding-app card carries its hook configs and registers first', () => {
  assert.deepEqual(Object.keys(CARD_HOOKS).sort(), ['agent-setup', 'antigravity', 'antigravity-cloud', 'claude-code', 'gemini', 'other'])
  for (const [card, apps] of Object.entries<string[]>(CARD_HOOKS)) {
    const body = appSteps(card).body
    assert.match(firstStep(body), /Register first:.*register_agent.*before anything else/s, `${card} registers first`)
    for (const app of apps) {
      const h = byApp[app]
      assert.ok(body.includes(esc(h.config)), `${card} lacks the ${app} hook config`)
      if (h.extra) assert.ok(body.includes(esc(h.extra[1])), `${card} lacks ${app}'s ${h.extra[0]}`)
      assert.ok(body.includes(esc(h.memory)), `${card} lacks how ${app}'s own memory goes off`)
      assert.match(h.config, /"(PreToolUse|BeforeTool)"/, `${app}'s config has no gate`)
    }
  }
  for (const card of CHAT_CARDS) {
    const body = appSteps(card).body
    assert.match(firstStep(body), /Register first:.*register_agent/s, `${card} registers first`)
    assert.match(body, /no hook system/, `${card} says it has no hooks`)
  }
  // The coding cards' installer is the one command.
  for (const card of ['agent-setup', 'claude-code', 'antigravity', 'gemini']) assert.ok(appSteps(card).body.includes(esc(INSTALL)), card)
})

test('R78 the docs, llms.txt and the setup prompt carry all four hook configs', () => {
  const docs = sitePage('/docs', 'n').html
  const llms = siteFile('heyclyde.me', '/llms.txt')!.body
  assert.ok(docs.includes(esc(INSTALL)) && llms.includes(INSTALL) && AGENT_SETUP_PROMPT.includes(INSTALL))
  for (const h of HOOK_APPS as any[]) {
    assert.ok(docs.includes(esc(h.config)), `docs lack ${h.app}`)
    assert.ok(llms.includes(h.config), `llms.txt lacks ${h.app}`)
    assert.ok(AGENT_SETUP_PROMPT.includes(h.config), `the setup prompt lacks ${h.app}`)
  }
  assert.match(AGENT_SETUP_PROMPT, /^Set up Clyde[^\n]*\n1\. Register first: call Clyde register_agent/)
  assert.match(llms, /1\. Register first: call Clyde register_agent/)
  assert.match(llms, /Hooks are required, not optional/)
  assert.doesNotMatch(docs, /Never wire a hard hook/)
  assert.equal(siteFile('heyclyde.me', '/clyde-gate.sh')!.body.startsWith('#!/bin/sh'), true)
})

test('R78 the bundle and plugin copies match hook.js', () => {
  const r = spawnSync('node', [join(repoRoot(), 'memory', 'sync-client.mjs'), '--check'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
})
