/**
 * The read-only HTTP surface behind the composer chip and its panel.
 *
 * These tests pin the contract the browser half depends on: four routes, GET
 * only, no secret and no file name in any payload, a 60-second cache on the
 * expensive answers, and a 400 for an unknown plan action.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DOCTOR_PATH,
  PLAN_PATH,
  SECRETS_PATH,
  STATUS_PATH,
  cached,
  doctorPayload,
  planPayload,
  registerStatusRoute,
} from '../lib/core/http.js'
import { formatDoctor, formatPlan, formatStatus } from '../lib/core/commands.js'

const scratch = mkdtempSync(join(tmpdir(), 'dsh-syn-config-http-'))

function repoWithConfig() {
  const repo = mkdtempSync(join(scratch, 'repo-'))
  mkdirSync(join(repo, 'profiles', 'desktop'), { recursive: true })
  writeFileSync(join(repo, 'profiles', 'desktop', 'cordis.patch.yml'), '- id: dsh-syn-config\n  name: dsh-syn-config\n')
  writeFileSync(join(repo, 'AGENTS.md'), '# agents\n')
  return repo
}

function fakeServer() {
  const routes = []
  registerStatusRoute(
    { webServer: { register: (route) => routes.push(route) } },
    { repoPath: repoWithConfig(), profile: 'desktop', dshHome: scratch, gitTimeoutMs: 15_000 },
  )
  return routes
}

test('the read-only surface registers four GET routes', () => {
  const routes = fakeServer()
  assert.deepEqual(routes.map((route) => route.path), [STATUS_PATH, DOCTOR_PATH, SECRETS_PATH, PLAN_PATH])
  for (const route of routes) assert.equal(typeof route.resource, 'function')
})

test('every route refuses a method other than GET or HEAD', async () => {
  for (const route of fakeServer()) {
    const refused = await route.resource(new Request(`http://127.0.0.1${route.path}`, { method: 'POST' }))
    assert.equal(refused.status, 405, route.path)
    assert.equal(refused.headers.get('allow'), 'GET, HEAD')
  }
})

test('the plan route rejects an unknown action with 400', async () => {
  const plan = fakeServer().find((route) => route.path === PLAN_PATH)
  const answer = await plan.resource(new Request(`http://127.0.0.1${PLAN_PATH}?action=rebase`, { method: 'GET' }))
  assert.equal(answer.status, 400)
  const body = await answer.json()
  assert.equal(body.ok, false)
})

test('the status payload carries no file names', async () => {
  const status = fakeServer().find((route) => route.path === STATUS_PATH)
  const body = await (await status.resource(new Request(`http://127.0.0.1${STATUS_PATH}`))).json()
  assert.equal('dirtyFiles' in body, false)
  assert.equal(typeof body.repoPath, 'string')
  assert.equal(typeof body.repoPresent, 'boolean')
})

test('the doctor payload keeps counts and the worst finding only', () => {
  const payload = doctorPayload({
    fail: 1,
    warn: 2,
    exitCode: 1,
    profile: 'desktop',
    sections: [
      { title: '工具链', status: 'ok', items: [] },
      { title: '密钥', status: 'error', items: [{ level: 'error', text: '发现 2 处明文' }, { level: 'warn', text: '次要' }] },
    ],
  })
  assert.equal(payload.ok, false)
  assert.equal(payload.sections[0].summary, '')
  assert.equal(payload.sections[1].summary, '发现 2 处明文')
  assert.equal(payload.sections[1].blocking, 1)
})

test('the plan payload never exposes a diff body, only counts', () => {
  const push = planPayload('push', {
    ok: true,
    changes: { added: ['a'], updated: ['b', 'c'], deleted: [] },
    gates: { lint: { ok: true }, redact: { changed: ['x'] }, scan: { ok: true } },
    commit: { created: 'abc123', unchanged: false },
    manifest: { skills: 7 },
    warnings: ['secret-ish value was redacted'],
  })
  assert.deepEqual(push.changes, { added: 1, updated: 2, deleted: 0 })
  assert.equal(push.gates.redacted, 1)
  assert.equal(JSON.stringify(push).includes('diff'), false)

  const pull = planPayload('pull', {
    ok: true,
    incomingCommits: 3,
    before: 'aaaabbbbcccc',
    after: 'dddd',
    mirrors: [{ name: 'skills', planned: { added: [1], updated: [2], deleted: [] } }],
    warnings: [],
  })
  assert.equal(pull.mirrors[0].added, 1)
  assert.equal(pull.before, 'aaaabbbbcccc')
})

test('the cache reuses an answer inside its window and re-reads after it', async () => {
  let reads = 0
  const read = cached(async () => ({ reads: (reads += 1) }), 40)
  assert.equal((await read()).cached, false)
  assert.equal((await read()).cached, true)
  assert.equal(reads, 1)
  await new Promise((resolve) => setTimeout(resolve, 60))
  const fresh = await read()
  assert.equal(fresh.cached, false)
  assert.equal(reads, 2)
})

test('a failed read does not poison the cache', async () => {
  let attempt = 0
  const read = cached(async () => {
    attempt += 1
    if (attempt === 1) throw new Error('boom')
    return { ok: true }
  }, 1000)
  await assert.rejects(read, /boom/)
  assert.deepEqual((await read()).body, { ok: true })
})

test('the doctor command renders one table row per section', () => {
  const text = formatDoctor({
    fail: 0,
    warn: 1,
    exitCode: 2,
    sections: [
      { title: '工具链', status: 'ok', items: [] },
      { title: 'profile', status: 'warn', items: [{ level: 'warn', text: '5 行漂移' }] },
    ],
  })
  assert.match(text, /health: 0 blocking \/ 1 warnings/)
  assert.match(text, /\| # \| 检查 \| 状态 \| 最差一处 \|/)
  assert.match(text, /\| 2 \| profile \| ⚠️ warn \| 5 行漂移 \|/)
})

test('the status command renders a table and escapes pipes', () => {
  const text = formatStatus({
    ok: true,
    repoPath: '/tmp/a|b',
    repoPresent: true,
    branch: 'main',
    upstream: 'origin/main',
    ahead: 1,
    behind: 0,
    dirty: 2,
  })
  assert.match(text, /\| 仓库 \| `\/tmp\/a\\\|b` \|/)
  assert.match(text, /\| 领先 \/ 落后 \| 1 \/ 0 \|/)
  assert.match(text, /changed file/)
})

test('a plan table lists the numbers, not the patches', () => {
  const text = formatPlan('pull', {
    incomingCommits: 2,
    before: 'abcdef12',
    after: 'abcdef34',
    mirrors: [{ name: 'skills', planned: { added: [1], updated: [], deleted: [2, 3] } }],
    warnings: [],
  })
  assert.match(text, /\| 远端提交 \| 2 \|/)
  assert.match(text, /skills \+1 ~0 -2/)
})
