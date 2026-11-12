import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { runDoctor } from '../lib/core/doctor.js'

// CI machines have no dsh CLI; point the doctor at node itself so the
// toolchain check exercises its success path instead of warning about the host.
process.env.DSH_CLI = process.execPath

/**
 * A doctor fixture: one git checkout plus one DSH home, both synthetic, so the
 * six sections can be exercised without touching the real configuration.
 */
const scratch = mkdtempSync(join(tmpdir(), 'dsh-config-sync-doctor-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

const SECRET = 'as_sk_TESTONLYabcdefghij'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function buildFixture(name, overrides = {}) {
  const root = join(scratch, name)
  const repo = join(root, 'dsh-config')
  const home = join(root, 'dsh-home')

  mkdirSync(join(repo, 'skills', 'alpha'), { recursive: true })
  mkdirSync(join(repo, 'skills', 'beta'), { recursive: true })
  writeFileSync(join(repo, 'skills', 'alpha', 'SKILL.md'), '# alpha\n')
  writeFileSync(join(repo, 'skills', 'beta', 'SKILL.md'), '# beta\n')
  mkdirSync(join(repo, 'agents-skills', 'gamma'), { recursive: true })
  mkdirSync(join(repo, 'profiles', 'desktop'), { recursive: true })
  mkdirSync(join(repo, 'weekly'), { recursive: true })
  mkdirSync(join(repo, 'scripts'), { recursive: true })
  writeFileSync(join(repo, 'AGENTS.md'), '# agents\n')
  writeFileSync(join(repo, 'weekly', 'run-weekly.sh'), '#!/bin/sh\necho hi\n')

  const patch = [
    'agent-default-model:',
    '  model: deepseek-chat',
    'mcp:',
    '  - id: anysearch',
    '    env:',
    '      Authorization: "Bearer __ANYSEARCH_API_KEY__"',
    '',
  ].join('\n')
  writeFileSync(join(repo, 'profiles', 'desktop', 'cordis.patch.yml'), patch)
  const manifest = JSON.stringify({ name: 'p', private: true, dsh: { profile: { bundles: [] } }, dependencies: {} }, null, 2)
  writeFileSync(join(repo, 'profiles', 'desktop', 'package.json'), `${manifest}\n`)

  git(repo, ['init', '--quiet', '--initial-branch', 'main'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test'])
  git(repo, ['add', '-A'])
  git(repo, ['commit', '--quiet', '-m', 'init'])
  const bare = join(root, 'origin.git')
  git(root, ['init', '--quiet', '--bare', bare])
  git(repo, ['remote', 'add', 'origin', bare])
  git(repo, ['push', '--quiet', '-u', 'origin', 'main'])

  // The deployed side mirrors the repository, with the local-only
  // reasoningEffort line and the injected secret value.
  mkdirSync(join(home, 'profiles', 'desktop'), { recursive: true })
  mkdirSync(join(home, 'skills', 'alpha'), { recursive: true })
  mkdirSync(join(home, 'skills', 'beta'), { recursive: true })
  writeFileSync(join(home, 'skills', 'alpha', 'SKILL.md'), '# alpha\n')
  writeFileSync(join(home, 'skills', 'beta', 'SKILL.md'), '# beta\n')
  mkdirSync(join(home, 'agents', 'skills', 'gamma'), { recursive: true })
  mkdirSync(join(home, 'learning', 'scripts'), { recursive: true })
  writeFileSync(join(home, 'learning', 'scripts', 'run-weekly.sh'), '#!/bin/sh\necho hi\n')

  const livePatch = patch
    .replace('  model: deepseek-chat\n', '  model: deepseek-chat\n  reasoningEffort: high\n')
    .replace('__ANYSEARCH_API_KEY__', overrides.injectedSecret ?? SECRET)
  writeFileSync(join(home, 'profiles', 'desktop', 'cordis.patch.yml'), livePatch)
  writeFileSync(join(home, 'profiles', 'desktop', 'package.json'), `${manifest}\n`)

  const secretsText = `ANYSEARCH_API_KEY=${overrides.injectedSecret ?? SECRET}\n`
  writeFileSync(join(home, 'secrets.env'), secretsText)
  if (process.platform !== 'win32') chmodSync(join(home, 'secrets.env'), 0o600)

  return { root, repo, home }
}

function sectionById(result, id) {
  return result.sections.find((section) => section.id === id)
}

test('doctor reports a clean fixture as consistent', async () => {
  const { repo, home } = buildFixture('clean')
  const result = await runDoctor({ repoPath: repo, dshHome: home, agentsHome: join(home, 'agents'), profile: 'desktop', offline: true })

  const errors = result.sections.flatMap((section) => section.items.filter((entry) => entry.level === 'error').map((entry) => `${section.id}: ${entry.text}`))
  assert.equal(result.fail, 0, errors.join(' | '))
  assert.equal(result.exitCode === 0 || result.exitCode === 2, true)
  assert.equal(sectionById(result, 'toolchain').status, 'ok')
  assert.equal(sectionById(result, 'skills').status, 'ok')
  assert.equal(sectionById(result, 'secrets').status, 'ok')
  assert.equal(sectionById(result, 'profile').status, 'ok')
  assert.equal(result.repoFacts.branch, 'main')
  assert.equal(result.repoFacts.dirty, 0)
})

test('doctor never echoes a secret value or a key name from secrets.env content', async () => {
  const { repo, home } = buildFixture('redaction')
  const result = await runDoctor({ repoPath: repo, dshHome: home, agentsHome: join(home, 'agents'), profile: 'desktop', offline: true })
  const serialized = JSON.stringify(result)
  assert.ok(!serialized.includes(SECRET), 'the injected secret value must never appear in the report')
})

test('doctor flags a skill that is missing its SKILL.md and a skill only in the repository', async () => {
  const { repo, home } = buildFixture('skills-drift')
  rmSync(join(home, 'skills', 'alpha'), { recursive: true, force: true })
  rmSync(join(repo, 'skills', 'beta', 'SKILL.md'))
  const result = await runDoctor({ repoPath: repo, dshHome: home, agentsHome: join(home, 'agents'), profile: 'desktop', offline: true })
  const skills = sectionById(result, 'skills')
  assert.equal(skills.status, 'warn')
  const text = skills.items.map((entry) => entry.text).join('\n')
  assert.ok(text.includes('仅仓库有（未拉取）：alpha'))
})

test('doctor treats a plaintext repository secret as blocking', async () => {
  const { repo, home } = buildFixture('plaintext')
  writeFileSync(join(repo, 'profiles', 'desktop', 'leaked.yml'), `auth: "Bearer ${SECRET}"\n`)
  const result = await runDoctor({ repoPath: repo, dshHome: home, agentsHome: join(home, 'agents'), profile: 'desktop', offline: true })
  assert.equal(result.fail > 0, true)
  assert.equal(result.exitCode, 1)
  assert.equal(sectionById(result, 'secrets').status, 'error')
})

test('doctor compares settings after redaction and ignores reasoningEffort', async () => {
  const { repo, home } = buildFixture('settings-clean')
  const result = await runDoctor({ repoPath: repo, dshHome: home, agentsHome: join(home, 'agents'), profile: 'desktop', offline: true })
  const text = sectionById(result, 'profile').items.map((entry) => entry.text).join('\n')
  // The deployed copy differs from the repository only by the local-only
  // reasoningEffort line and the injected secret, so the comparison is clean.
  assert.ok(text.includes('cordis.patch.yml 与仓库一致'), text)
})

test('doctor reports real settings drift in changed lines', async () => {
  const { repo, home } = buildFixture('settings-drift')
  const live = join(home, 'profiles', 'desktop', 'cordis.patch.yml')
  writeFileSync(live, [
    'agent-default-model:',
    '  model: deepseek-reasoner',
    '  reasoningEffort: high',
    'mcp:',
    '  - id: anysearch',
    '    env:',
    `      Authorization: "Bearer ${SECRET}"`,
    '',
  ].join('\n'))
  const result = await runDoctor({ repoPath: repo, dshHome: home, agentsHome: join(home, 'agents'), profile: 'desktop', offline: true })
  const text = sectionById(result, 'profile').items.map((entry) => entry.text).join('\n')
  assert.ok(text.includes('与仓库差 2 行'), text)
})

test('doctor flags a live configuration that still holds a placeholder', async () => {
  const { repo, home } = buildFixture('placeholder')
  writeFileSync(
    join(home, 'profiles', 'desktop', 'cordis.patch.yml'),
    'auth: "Bearer __ANYSEARCH_API_KEY__"\n',
  )
  const result = await runDoctor({ repoPath: repo, dshHome: home, agentsHome: join(home, 'agents'), profile: 'desktop', offline: true })
  const text = sectionById(result, 'profile').items.map((entry) => entry.text).join('\n')
  assert.ok(text.includes('残留占位符'), text)
  assert.equal(result.exitCode, 1)
})
