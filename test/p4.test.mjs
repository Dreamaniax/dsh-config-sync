import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { registerCommands } from '../lib/core/commands.js'
import { registerSkill } from '../lib/core/skill.js'
import { registerStatusRoute, STATUS_PATH } from '../lib/core/http.js'

const scratch = mkdtempSync(join(tmpdir(), 'dsh-config-sync-p4-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function fixture(name) {
  const root = join(scratch, name)
  const repo = join(root, 'repo')
  const home = join(root, 'home')
  mkdirSync(join(repo, 'skills', 'alpha'), { recursive: true })
  writeFileSync(join(repo, 'skills', 'alpha', 'SKILL.md'), '# alpha\n')
  git(repo, ['init', '--quiet', '--initial-branch', 'main'])
  git(repo, ['config', 'user.email', 't@e.c'])
  git(repo, ['config', 'user.name', 'T'])
  git(repo, ['add', '-A'])
  git(repo, ['commit', '--quiet', '-m', 'init'])
  mkdirSync(home, { recursive: true })
  return { repo, home }
}

function captureCommand(settings) {
  const commands = []
  registerCommands({ commands: { register: (definition) => commands.push(definition) } }, settings)
  return commands[0]
}

test('the /syn-dsh command registers with a hint and a handler', () => {
  const { repo, home } = fixture('command-shape')
  const command = captureCommand({ repoPath: repo, dshHome: home, profile: 'desktop', gitTimeoutMs: 15_000 })
  assert.equal(command.name, 'syn-dsh')
  assert.equal(typeof command.handler, 'function')
  assert.ok(command.input.hint.includes('push'))
})

test('status reports the branch and a clean worktree', async () => {
  const { repo, home } = fixture('command-status')
  const command = captureCommand({ repoPath: repo, dshHome: home, profile: 'desktop', gitTimeoutMs: 15_000 })
  const result = await command.handler({ rawInput: 'status' })
  assert.equal(result.kind, 'success')
  assert.ok(result.text.includes('main'))
  assert.ok(result.text.includes('clean worktree'))
})

test('push without "now" is a dry run and commits nothing', async () => {
  const { repo, home } = fixture('command-push')
  const before = git(repo, ['rev-parse', 'HEAD']).trim()
  const command = captureCommand({ repoPath: repo, dshHome: home, profile: 'desktop', gitTimeoutMs: 15_000 })
  const result = await command.handler({ rawInput: 'push' })
  assert.ok(result.text.includes('dry run'))
  assert.equal(git(repo, ['rev-parse', 'HEAD']).trim(), before)
})

test('an unknown subcommand is an error, not a crash', async () => {
  const { repo, home } = fixture('command-unknown')
  const command = captureCommand({ repoPath: repo, dshHome: home, profile: 'desktop', gitTimeoutMs: 15_000 })
  const result = await command.handler({ rawInput: 'explode' })
  assert.equal(result.kind, 'error')
  assert.ok(result.text.includes('unknown subcommand'))
})

test('the bundled skill provider serves the skill body', async () => {
  const providers = []
  registerSkill({ skills: { registerProvider: (factory) => providers.push(factory) } })
  assert.equal(providers.length, 1)
  const provider = providers[0]()
  const candidates = await provider.list()
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].name, 'syn-dsh')
  assert.equal(candidates[0].rank, 600)
  assert.equal(candidates[0].invocation.userInvocable, true)
  const loaded = await provider.get(candidates[0])
  assert.ok(loaded.content.includes('Syn DSH'))
  assert.ok(loaded.content.length > 1000)
})

test('the status route answers GET with JSON and refuses other methods', async () => {
  const { repo, home } = fixture('route')
  const routes = []
  registerStatusRoute({ webServer: { register: (route) => routes.push(route) } }, { repoPath: repo, timeoutMs: 15_000 })
  // The surface grew to a card + panel: status, doctor, secrets, plan. The
  // status route is still the one that must answer without side effects.
  assert.equal(routes.length, 4)
  const statusRoute = routes.find((route) => route.path === STATUS_PATH)
  assert.ok(statusRoute)

  const response = await statusRoute.resource(new Request(`http://127.0.0.1${STATUS_PATH}`, { method: 'GET' }))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const body = await response.json()
  assert.equal(body.branch, 'main')
  assert.equal(body.dirty, 0)
  // File names never leave the host: the route is readable by any local process.
  assert.equal('dirtyFiles' in body, false)
  assert.equal(body.ok, true)

  const refused = await statusRoute.resource(new Request(`http://127.0.0.1${STATUS_PATH}`, { method: 'POST' }))
  assert.equal(refused.status, 405)
})

test('a composition without a web server still loads', () => {
  assert.equal(registerStatusRoute({}, { repoPath: '/tmp/x', timeoutMs: 1000 }), false)
})
