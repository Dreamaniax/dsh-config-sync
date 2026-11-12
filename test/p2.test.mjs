import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { pullRepo } from '../lib/core/pull.js'
import { runSecretsAction } from '../lib/core/secrets-ops.js'

const scratch = mkdtempSync(join(tmpdir(), 'dsh-config-sync-p2-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** A repository + two clones, standing in for two machines and one remote. */
function makeRemoteFixture(name) {
  const root = join(scratch, name)
  mkdirSync(root, { recursive: true })
  const bare = join(root, 'origin.git')
  const seed = join(root, 'seed')
  git(root, ['init', '--quiet', '--bare', bare])
  git(root, ['clone', '--quiet', bare, seed])
  git(seed, ['config', 'user.email', 't@e.c'])
  git(seed, ['config', 'user.name', 'T'])
  git(seed, ['config', 'core.autocrlf', 'false'])
  mkdirSync(join(seed, 'skills', 'alpha'), { recursive: true })
  writeFileSync(join(seed, 'skills', 'alpha', 'SKILL.md'), '# alpha\n')
  mkdirSync(join(seed, 'agents-skills', 'beta'), { recursive: true })
  writeFileSync(join(seed, 'agents-skills', 'beta', 'SKILL.md'), '# beta\n')
  mkdirSync(join(seed, 'weekly'), { recursive: true })
  writeFileSync(join(seed, 'weekly', 'run.sh'), '#!/bin/sh\necho run\n')
  git(seed, ['add', '-A'])
  git(seed, ['commit', '--quiet', '-m', 'init'])
  git(seed, ['branch', '-M', 'main'])
  git(seed, ['push', '--quiet', '-u', 'origin', 'main'])
  return { root, bare, seed }
}

function cloneAs(root, name) {
  const dir = join(root, name)
  git(root, ['-c', 'core.autocrlf=false', 'clone', '--quiet', '-b', 'main', join(root, 'origin.git'), dir])
  git(dir, ['config', 'user.email', 't@e.c'])
  git(dir, ['config', 'user.name', 'T'])
  git(dir, ['config', 'core.autocrlf', 'false'])
  return dir
}

test('pull dry run reports incoming commits and writes nothing', async () => {
  const { root, seed } = makeRemoteFixture('pull-dry')
  const mine = cloneAs(root, 'mine')
  const dshHome = join(root, 'home')
  mkdirSync(join(dshHome, 'skills'), { recursive: true })

  // Another machine advances the remote.
  writeFileSync(join(seed, 'skills', 'alpha', 'SKILL.md'), '# alpha v2\n')
  git(seed, ['add', '-A'])
  git(seed, ['commit', '--quiet', '-m', 'change alpha'])
  git(seed, ['push', '--quiet', 'origin', 'main'])

  const before = git(mine, ['rev-parse', 'HEAD']).trim()
  const result = await pullRepo({ repoPath: mine, dshHome, agentsHome: join(root, 'agents'), dryRun: true })
  assert.equal(result.ok, true)
  assert.equal(result.incomingCommits, 1)
  assert.equal(git(mine, ['rev-parse', 'HEAD']).trim(), before)
  assert.equal(existsSync(join(dshHome, 'skills', 'alpha', 'SKILL.md')), false)
  const skillsMirror = result.mirrors.find((entry) => entry.name === 'skills')
  assert.ok(skillsMirror.planned.added.includes('alpha/SKILL.md'))
})

test('pull fast-forwards and mirrors skills, agents-skills and weekly', async () => {
  const { root, seed } = makeRemoteFixture('pull-real')
  const mine = cloneAs(root, 'mine')
  const dshHome = join(root, 'home')
  const agentsHome = join(root, 'agents-home')

  writeFileSync(join(seed, 'skills', 'alpha', 'SKILL.md'), '# alpha v2\n')
  mkdirSync(join(seed, 'skills', 'gamma'), { recursive: true })
  writeFileSync(join(seed, 'skills', 'gamma', 'SKILL.md'), '# gamma\n')
  git(seed, ['add', '-A'])
  git(seed, ['commit', '--quiet', '-m', 'add gamma'])
  git(seed, ['push', '--quiet', 'origin', 'main'])

  const result = await pullRepo({ repoPath: mine, dshHome, agentsHome, dryRun: false })
  assert.equal(result.ok, true, `pull failed: ${JSON.stringify(result)}`)
  assert.equal(result.pulled, true, `pull did not advance: ${JSON.stringify(result)}`)
  assert.ok(result.changedSkills.includes('skills/gamma'), `changedSkills=${JSON.stringify(result.changedSkills)}`)
  assert.equal(readFileSync(join(dshHome, 'skills', 'gamma', 'SKILL.md'), 'utf8'), '# gamma\n')
  assert.equal(readFileSync(join(dshHome, 'skills', 'alpha', 'SKILL.md'), 'utf8'), '# alpha v2\n')
  assert.equal(existsSync(join(agentsHome, 'skills', 'beta', 'SKILL.md')), true, `agentsHome=${agentsHome} mirrors=${JSON.stringify(result.mirrors.map((m) => ({ name: m.name, src: m.src, dst: m.dst, added: m.added, warnings: m.warnings })))}`)
  assert.equal(existsSync(join(dshHome, 'learning', 'scripts', 'run.sh')), true, `weekly mirror=${JSON.stringify(result.mirrors.find((m) => m.name === 'weekly'))}`)
  if (process.platform !== 'win32') {
    const mode = (await import('node:fs')).statSync(join(dshHome, 'learning', 'scripts', 'run.sh')).mode & 0o777
    assert.equal(mode, 0o755)
  }
})

test('pull refuses to create a merge when the branch diverged', async () => {
  const { root, seed } = makeRemoteFixture('pull-diverge')
  const mine = cloneAs(root, 'mine')
  const dshHome = join(root, 'home')

  writeFileSync(join(mine, 'local.txt'), 'local\n')
  git(mine, ['add', '-A'])
  git(mine, ['commit', '--quiet', '-m', 'local work'])

  git(seed, ['commit', '--quiet', '--allow-empty', '-m', 'remote work'])
  git(seed, ['push', '--quiet', 'origin', 'main'])

  const before = git(mine, ['rev-parse', 'HEAD']).trim()
  const result = await pullRepo({ repoPath: mine, dshHome, agentsHome: join(root, 'agents'), dryRun: false })
  assert.equal(result.ok, false)
  assert.equal(git(mine, ['rev-parse', 'HEAD']).trim(), before)
  assert.ok(result.warnings.some((warning) => warning.includes('pull --ff-only failed')))
})

test('secrets inject refuses to write while a placeholder would remain', async () => {
  const root = join(scratch, 'inject-leftover')
  const dshHome = join(root, 'home')
  mkdirSync(join(dshHome, 'profiles', 'desktop'), { recursive: true })
  writeFileSync(join(dshHome, 'secrets.env'), 'ANYSEARCH_API_KEY=as_sk_X\n')
  if (process.platform !== 'win32') chmodSync(join(dshHome, 'secrets.env'), 0o600)
  const live = join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml')
  writeFileSync(live, 'a: __ANYSEARCH_API_KEY__\nb: __NOT_SET__\n')
  const result = await runSecretsAction({ action: 'inject', repoPath: join(root, 'repo'), dshHome, profile: 'desktop', dryRun: false })
  assert.equal(result.ok, false)
  assert.deepEqual(result.leftover, ['__NOT_SET__'])
  assert.equal(readFileSync(live, 'utf8'), 'a: __ANYSEARCH_API_KEY__\nb: __NOT_SET__\n')
})

test('secrets inject writes the deployed copy and keeps a backup', async () => {
  const root = join(scratch, 'inject-ok')
  const dshHome = join(root, 'home')
  mkdirSync(join(dshHome, 'profiles', 'desktop'), { recursive: true })
  writeFileSync(join(dshHome, 'secrets.env'), 'ANYSEARCH_API_KEY=as_sk_X\n')
  const live = join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml')
  writeFileSync(live, 'a: __ANYSEARCH_API_KEY__\n')

  const dry = await runSecretsAction({ action: 'inject', repoPath: join(root, 'repo'), dshHome, dryRun: true })
  assert.equal(dry.ok, true)
  assert.equal(readFileSync(live, 'utf8'), 'a: __ANYSEARCH_API_KEY__\n')

  const real = await runSecretsAction({ action: 'inject', repoPath: join(root, 'repo'), dshHome, dryRun: false })
  assert.equal(real.ok, true)
  assert.equal(readFileSync(live, 'utf8'), 'a: as_sk_X\n')
  // The backup holds the pre-injection text, so it must live outside the repo.
  const backups = readdirSync(join(dshHome, 'backups'))
  assert.ok(backups.some((name) => name.includes('.bak-')))
  assert.equal(readdirSync(join(dshHome, 'profiles', 'desktop')).some((name) => name.includes('.bak-')), false)
})

test('secrets redact rewrites the repository copy only', async () => {
  const root = join(scratch, 'redact')
  const dshHome = join(root, 'home')
  const repo = join(root, 'repo')
  mkdirSync(join(dshHome), { recursive: true })
  mkdirSync(join(repo, 'profiles', 'desktop'), { recursive: true })
  writeFileSync(join(dshHome, 'secrets.env'), 'ANYSEARCH_API_KEY=as_sk_REAL\n')
  const repoConfig = join(repo, 'profiles', 'desktop', 'cordis.patch.yml')
  writeFileSync(repoConfig, 'a: "Bearer as_sk_REAL"\n')
  const result = await runSecretsAction({ action: 'redact', repoPath: repo, dshHome, dryRun: false })
  assert.equal(result.ok, true)
  assert.equal(readFileSync(repoConfig, 'utf8'), 'a: "Bearer __ANYSEARCH_API_KEY__"\n')
})

test('secrets scan reports a leaked value as a failure', async () => {
  const root = join(scratch, 'scan')
  const repo = join(root, 'repo')
  mkdirSync(join(repo, 'profiles'), { recursive: true })
  writeFileSync(join(repo, 'profiles', 'leak.yml'), 'a: "Bearer as_sk_LEAKEDVALUE123"\n')
  const result = await runSecretsAction({ action: 'scan', repoPath: repo, dshHome: join(root, 'home') })
  assert.equal(result.ok, false)
  assert.equal(result.exitCode, 1)
  assert.equal(result.hits.length, 1)
})

test('secrets fingerprint never returns a value', async () => {
  const root = join(scratch, 'fingerprint')
  const dshHome = join(root, 'home')
  mkdirSync(dshHome, { recursive: true })
  writeFileSync(join(dshHome, 'secrets.env'), 'ANYSEARCH_API_KEY=as_sk_SECRET\n')
  const result = await runSecretsAction({ action: 'fingerprint', repoPath: join(root, 'repo'), dshHome })
  assert.equal(result.ok, true)
  assert.equal(result.fingerprints[0].sha256.length, 8)
  assert.ok(!JSON.stringify(result).includes('as_sk_SECRET'))
})
