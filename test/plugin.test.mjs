import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'

/**
 * These tests load the host half exactly as the host does: a plain ESM import
 * of lib/index.js. The file deliberately imports nothing from `@deepseek-ai/*`,
 * so the suite runs under plain Node on macOS and Windows with no install step.
 */

const scratch = mkdtempSync(join(tmpdir(), 'dsh-config-sync-plugin-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

function makeRepo(name) {
  const dir = join(scratch, name)
  mkdirSync(dir, { recursive: true })
  const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git(['init', '--quiet', '--initial-branch', 'main'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'Test'])
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  git(['add', 'README.md'])
  git(['commit', '--quiet', '-m', 'init'])
  return dir
}

function fakeContext() {
  const tools = []
  return {
    tools,
    ctx: {
      tools: {
        register(definition) {
          tools.push(definition)
          return () => {}
        },
      },
    },
  }
}

async function loadPlugin() {
  return import(pathToFileURL(join(import.meta.dirname, '..', 'lib', 'index.js')).href)
}

test('the plugin exports the host contract', async () => {
  const module = await loadPlugin()
  assert.equal(module.name, 'dsh-syn-config')
  assert.deepEqual(module.inject, ['tools'])
  assert.equal(typeof module.apply, 'function')
  assert.equal(module.DEFAULT_REPO_PATH, join(process.env.HOME ?? process.env.USERPROFILE ?? '', 'dsh-config'))
})

test('apply registers the read-only tools with the declared schema', async () => {
  const module = await loadPlugin()
  const { ctx, tools } = fakeContext()
  await module.apply(ctx, {})
  assert.deepEqual(tools.map((tool) => tool.name), ['dsh_sync_status', 'dsh_sync_doctor', 'dsh_sync_pull', 'dsh_sync_secrets', 'dsh_sync_push', 'dsh_sync_diag'])
  const tool = tools[0]
  assert.equal(tool.name, 'dsh_sync_status')
  assert.equal(tool.parameters.type, 'object')
  assert.ok(tool.parameters.properties.repo)
  assert.equal(tool.output.schema.properties.ok.type, 'boolean')
  assert.ok(tool.output.schema.required.includes('notes'))
  assert.equal(typeof tool.output.render, 'function')
  assert.equal(typeof tool.execute, 'function')
})

test('execute returns a schema-shaped report for a clean repository', async () => {
  const module = await loadPlugin()
  const { ctx, tools } = fakeContext()
  await module.apply(ctx, {})
  const repo = makeRepo('plugin-clean')
  const value = await tools[0].execute({ repo }, { signal: undefined })
  assert.equal(value.ok, true)
  assert.equal(value.repoPresent, true)
  assert.equal(value.branch, 'main')
  assert.equal(value.dirty, 0)
  assert.ok(Array.isArray(value.notes))
  assert.equal(typeof value.repoPath, 'string')
  for (const key of ['ok', 'repoPath', 'repoPresent', 'branch', 'upstream', 'ahead', 'behind', 'dirty', 'dirtyFiles', 'notes']) {
    assert.ok(key in value, `missing output field ${key}`)
  }
})

test('execute reports a missing repository instead of throwing', async () => {
  const module = await loadPlugin()
  const { ctx, tools } = fakeContext()
  await module.apply(ctx, {})
  const value = await tools[0].execute({ repo: join(scratch, 'absent') }, {})
  assert.equal(value.ok, false)
  assert.equal(value.repoPresent, false)
  assert.ok(value.notes.length >= 1)
})

test('apply survives a context that throws on undeclared service reads', async () => {
  const module = await loadPlugin()
  const tools = []
  const strict = new Proxy({ tools: { register: (definition) => tools.push(definition) } }, {
    get(target, property) {
      if (typeof property === 'symbol' || property in target) return Reflect.get(target, property)
      throw new Error(`cannot get property "${String(property)}" without inject`)
    },
  })
  await module.apply(strict, {})
  assert.equal(tools.length, 6)
})

test('apply registers the optional surfaces through ctx.get when available', async () => {
  const module = await loadPlugin()
  const seen = []
  const services = {
    commands: { register: (definition) => seen.push(`cmd:${definition.name}`) },
    skills: { registerProvider: () => seen.push('skill') },
    webServer: { register: (route) => seen.push(`route:${route.path}`) },
  }
  const ctx = {
    tools: { register: () => seen.push('tool') },
    get: (name) => services[name],
  }
  await module.apply(ctx, {})
  assert.ok(seen.includes('cmd:syn-dsh'))
  assert.ok(seen.includes('skill'))
  assert.ok(seen.includes('route:/plugins/dsh-syn-config/status'))
})

test('the tool refuses to inject a secret without an explicit machine opt-in', async () => {
  const module = await loadPlugin()
  const tools = []
  const ctx = { tools: { register: (definition) => tools.push(definition) } }
  await module.apply(ctx, { repoPath: '/tmp/definitely-not-a-repo', profile: 'desktop' })
  const secrets = tools.find((tool) => tool.name === 'dsh_sync_secrets')
  const refused = await secrets.execute({ action: 'inject', dry_run: false })
  assert.equal(refused.ok, false)
  assert.ok(refused.notes.some((note) => note.includes('injected by the human')))
  assert.ok(refused.notes.some((note) => note.includes('apply.sh')))
  // A dry run is allowed: it writes nothing, so it stays usable for diagnosis.
  const dry = await secrets.execute({ action: 'inject', dry_run: true })
  assert.equal(typeof dry.ok, 'boolean')
})
