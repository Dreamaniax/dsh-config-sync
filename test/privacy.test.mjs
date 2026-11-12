import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { scanHistory } from '../lib/core/history.js'
import { snapshot } from '../lib/core/pack.js'
import { pushRepo } from '../lib/core/push.js'
import { runSecretsAction } from '../lib/core/secrets-ops.js'

const scratch = mkdtempSync(join(tmpdir(), 'dsh-config-sync-privacy-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

const FAKE_AWS = 'AKIAIOSFODNN7EXAMPLE'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function write(path, text) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

/** Repository whose history contains a key that the working tree no longer has. */
function repoWithHistoricalSecret(name) {
  const root = join(scratch, name)
  const repo = join(root, 'repo')
  mkdirSync(repo, { recursive: true })
  git(repo, ['init', '--quiet', '--initial-branch', 'main'])
  git(repo, ['config', 'user.email', 't@e.c'])
  git(repo, ['config', 'user.name', 'T'])
  write(join(repo, 'profiles', 'desktop', 'cordis.patch.yml'), `aws: "${FAKE_AWS}"\n`)
  git(repo, ['add', '-A'])
  git(repo, ['commit', '--quiet', '-m', 'oops'])
  write(join(repo, 'profiles', 'desktop', 'cordis.patch.yml'), 'aws: "__AWS_KEY__"\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '--quiet', '-m', 'redact'])
  return { root, repo }
}

test('history scan finds a key that the working tree no longer shows', async () => {
  const { repo } = repoWithHistoricalSecret('history')
  const result = await scanHistory({ repoPath: repo })
  assert.equal(result.ok, true)
  assert.equal(result.hits.length, 1)
  assert.equal(result.hits[0].commit.length >= 7, true)
  // The preview is masked: the value must not be reusable from the report.
  assert.ok(!result.hits[0].preview.includes(FAKE_AWS))
  assert.ok(result.hits[0].preview.includes('…'))
})

test('a clean history reports no hits', async () => {
  const root = join(scratch, 'clean-history')
  const repo = join(root, 'repo')
  mkdirSync(repo, { recursive: true })
  git(repo, ['init', '--quiet', '--initial-branch', 'main'])
  git(repo, ['config', 'user.email', 't@e.c'])
  git(repo, ['config', 'user.name', 'T'])
  write(join(repo, 'README.md'), '# hello\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '--quiet', '-m', 'init'])
  const result = await scanHistory({ repoPath: repo })
  assert.equal(result.hits.length, 0)
  assert.ok(result.note.includes('no plaintext credential'))
})

test('deep scan fails on a historical credential even when the tree is clean', async () => {
  const { root, repo } = repoWithHistoricalSecret('deep')
  const dshHome = join(root, 'home')
  mkdirSync(join(dshHome, 'profiles', 'desktop'), { recursive: true })
  writeFileSync(join(dshHome, 'secrets.env'), 'AWS_KEY=whatever\n')
  const result = await runSecretsAction({ action: 'scan', repoPath: repo, dshHome, deep: true })
  assert.equal(result.ok, false)
  assert.equal(result.hits.length, 0)
  assert.equal(result.historyHits.length, 1)
})

test('push refuses a commit message that carries a URL or a credential', async () => {
  const root = join(scratch, 'message-guard')
  const bare = join(root, 'origin.git')
  const repo = join(root, 'repo')
  mkdirSync(root, { recursive: true })
  git(root, ['init', '--quiet', '--bare', bare])
  git(root, ['-c', 'core.autocrlf=false', 'clone', '--quiet', bare, repo])
  git(repo, ['config', 'user.email', 't@e.c'])
  git(repo, ['config', 'user.name', 'T'])
  write(join(repo, 'README.md'), '# seed\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '--quiet', '-m', 'seed'])
  git(repo, ['push', '--quiet', '-u', 'origin', 'HEAD:main'])

  const home = join(root, 'home')
  const agents = join(root, 'agents')
  mkdirSync(join(home, 'skills'), { recursive: true })
  write(join(home, 'skills', 'x', 'SKILL.md'), '# x\n')
  const before = git(repo, ['rev-parse', 'HEAD']).trim()
  const result = await pushRepo({
    repoPath: repo,
    dshHome: home,
    agentsHome: agents,
    dryRun: false,
    message: 'sync: see https://internal.example/secret',
  })
  assert.equal(result.ok, false)
  assert.equal(result.commit.created, false)
  assert.equal(git(repo, ['rev-parse', 'HEAD']).trim(), before)
})

test('pack skips .dsh-market by default and includes it on request', () => {
  const root = join(scratch, 'market')
  const repo = join(root, 'repo')
  const home = join(root, 'home')
  const agents = join(root, 'agents')
  mkdirSync(join(repo, 'profiles', 'desktop'), { recursive: true })
  writeFileSync(join(repo, 'profiles', 'desktop', 'package.json'), '{}\n')
  write(join(home, 'profiles', 'desktop', '.dsh-market', 'state.json'), '{}\n')
  write(join(home, 'skills', 'a', 'SKILL.md'), '# a\n')

  const skipped = snapshot({ repoPath: repo, dshHome: home, agentsHome: agents, dryRun: true })
  assert.ok(skipped.warnings.some((warning) => warning.includes('.dsh-market/ skipped')))
  assert.equal(skipped.changes.added.some((entry) => entry.includes('.dsh-market')), false)

  const included = snapshot({ repoPath: repo, dshHome: home, agentsHome: agents, dryRun: true, includeMarket: true })
  assert.equal(included.mirrors.some((mirror) => mirror.name === '.dsh-market'), true)
  assert.equal(skipped.mirrors.some((mirror) => mirror.name === '.dsh-market'), false)
})

test('redact also rewrites the synchronized AGENTS.md', async () => {
  const root = join(scratch, 'redact-agents')
  const repo = join(root, 'repo')
  const home = join(root, 'home')
  mkdirSync(join(repo, 'profiles', 'desktop'), { recursive: true })
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'secrets.env'), 'MY_KEY=super-secret-value\n')
  writeFileSync(join(repo, 'AGENTS.md'), 'token: super-secret-value\n')
  const result = await runSecretsAction({ action: 'redact', repoPath: repo, dshHome: home, dryRun: false })
  assert.equal(result.ok, true)
  assert.equal(readFileSync(join(repo, 'AGENTS.md'), 'utf8'), 'token: __MY_KEY__\n')
})
