import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { defaultMessage, pushRepo } from '../lib/core/push.js'

const scratch = mkdtempSync(join(tmpdir(), 'dsh-config-sync-push-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function write(path, text) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

/** A repository cloned from a bare origin, plus a machine home. */
function fixture(name) {
  const root = join(scratch, name)
  mkdirSync(root, { recursive: true })
  const bare = join(root, 'origin.git')
  const seed = join(root, 'seed')
  const repo = join(root, 'repo')
  const home = join(root, 'home')
  const agents = join(root, 'agents')

  git(root, ['init', '--quiet', '--bare', bare])
  git(root, ['clone', '--quiet', bare, seed])
  git(seed, ['config', 'user.email', 't@e.c'])
  git(seed, ['config', 'user.name', 'T'])
  write(join(seed, 'skills', 'alpha', 'SKILL.md'), '# alpha v1\n')
  write(join(seed, 'profiles', 'desktop', 'cordis.patch.yml'), 'agent-default-model:\n  model: deepseek-chat\n')
  write(join(seed, 'profiles', 'desktop', 'package.json'), JSON.stringify({ name: 'p', dependencies: {} }, null, 2))
  write(join(seed, 'AGENTS.md'), '# agents v1\n')
  write(join(seed, '.gitignore'), 'MANIFEST.local.md\n')
  git(seed, ['add', '-A'])
  git(seed, ['commit', '--quiet', '-m', 'init'])
  git(seed, ['push', '--quiet', '-u', 'origin', 'HEAD:main'])

  git(root, ['clone', '--quiet', '-b', 'main', bare, repo])
  git(repo, ['config', 'user.email', 't@e.c'])
  git(repo, ['config', 'user.name', 'T'])

  write(join(home, 'skills', 'alpha', 'SKILL.md'), '# alpha v2\n')
  write(join(home, 'AGENTS.md'), '# agents v2\n')
  write(join(home, 'profiles', 'desktop', 'cordis.patch.yml'), 'agent-default-model:\n  model: deepseek-chat\n')
  write(join(home, 'profiles', 'desktop', 'package.json'), JSON.stringify({ name: 'p', dependencies: {} }, null, 2))

  return { root, bare, seed, repo, home, agents }
}

function headOf(repo) {
  return git(repo, ['rev-parse', 'HEAD']).trim()
}

function remoteHead(bare) {
  return git(bare, ['rev-parse', 'main']).trim()
}

test('defaultMessage uses the local clock', () => {
  const message = defaultMessage(new Date(2026, 10, 11, 14, 5))
  assert.equal(message, 'sync: 2026-11-11 14:05')
})

test('push dry run writes nothing and reports the plan', async () => {
  const { repo, home, agents, bare } = fixture('dry')
  const before = headOf(repo)
  const result = await pushRepo({ repoPath: repo, dshHome: home, agentsHome: agents, dryRun: true })
  assert.equal(result.ok, true)
  assert.equal(result.dryRun, true)
  assert.equal(headOf(repo), before)
  assert.equal(remoteHead(bare), before)
  assert.equal(result.commit.created, false)
  assert.ok(result.changes.updated.includes('AGENTS.md'))
})

test('push commits once and pushes to origin', async () => {
  const { repo, home, agents, bare } = fixture('real')
  const before = headOf(repo)
  const result = await pushRepo({ repoPath: repo, dshHome: home, agentsHome: agents, dryRun: false, message: 'sync: test' })
  assert.equal(result.ok, true, result.warnings.join(' | '))
  assert.equal(result.commit.created, true)
  assert.equal(result.commit.pushed, true)
  assert.equal(result.commit.subject, 'sync: test')
  assert.notEqual(headOf(repo), before)
  assert.equal(remoteHead(bare), headOf(repo))
  assert.equal(readFileSync(join(repo, 'AGENTS.md'), 'utf8'), '# agents v2\n')
})

test('a second push finds nothing to commit', async () => {
  const { repo, home, agents } = fixture('idempotent')
  await pushRepo({ repoPath: repo, dshHome: home, agentsHome: agents, dryRun: false, message: 'sync: first' })
  const result = await pushRepo({ repoPath: repo, dshHome: home, agentsHome: agents, dryRun: false, message: 'sync: second' })
  assert.equal(result.ok, true)
  assert.equal(result.commit.unchanged, true)
  assert.equal(result.exitCode, 0)
})

test('push stops without rebasing when the remote moved ahead', async () => {
  const { repo, seed, home, agents, bare } = fixture('diverge')
  const remoteBefore = remoteHead(bare)

  // The remote gains a commit the local clone does not have.
  write(join(seed, 'skills', 'alpha', 'SKILL.md'), '# alpha v3\n')
  git(seed, ['add', '-A'])
  git(seed, ['commit', '--quiet', '-m', 'remote advance'])
  git(seed, ['push', '--quiet', 'origin', 'main'])

  const result = await pushRepo({ repoPath: repo, dshHome: home, agentsHome: agents, dryRun: false, message: 'sync: local' })
  assert.equal(result.ok, false)
  assert.equal(result.exitCode, 1)
  assert.equal(result.commit.created, true)
  assert.equal(result.commit.pushed, false)
  assert.ok(result.warnings.some((warning) => warning.includes('no rebase')))
  // Nothing was rewritten: the remote still points where it did, and the local
  // commit that carried the snapshot is preserved.
  assert.equal(remoteHead(bare), git(seed, ['rev-parse', 'HEAD']).trim())
  assert.notEqual(remoteHead(bare), remoteBefore)
  assert.equal(git(repo, ['log', '-1', '--format=%s']).trim(), 'sync: local')
})

test('push aborts before committing when a plaintext secret is present', async () => {
  const { repo, home, agents } = fixture('secret')
  write(join(repo, 'profiles', 'desktop', 'leak.yml'), 'auth: "Bearer ghp_abcdefghijklmnopqrstuvwxyz0123"\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '--quiet', '-m', 'leak'])
  const before = headOf(repo)

  const result = await pushRepo({ repoPath: repo, dshHome: home, agentsHome: agents, dryRun: false })
  assert.equal(result.ok, false)
  assert.equal(result.gates.scan.ok, false)
  assert.equal(result.commit.created, false)
  assert.equal(headOf(repo), before)
})

test('push runs the lint gate and refuses a glued variable', async () => {
  const { repo, home, agents } = fixture('lint')
  mkdirSync(join(repo, 'scripts'), { recursive: true })
  writeFileSync(join(repo, 'scripts', 'bad.sh'), 'echo "$VAR中文"\n')
  const before = headOf(repo)
  const result = await pushRepo({ repoPath: repo, dshHome: home, agentsHome: agents, dryRun: false })
  assert.equal(result.ok, false)
  assert.equal(result.gates.lint.ok, false)
  assert.equal(headOf(repo), before)
  assert.equal(existsSync(join(repo, 'AGENTS.md')), true, 'the repository already had AGENTS.md from the seed')
})
