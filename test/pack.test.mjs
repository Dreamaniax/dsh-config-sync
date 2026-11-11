import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'

import { normalizeLinks, snapshot } from '../lib/core/pack.js'

const scratch = mkdtempSync(join(tmpdir(), 'dsh-config-sync-pack-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function write(path, text) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

/** A machine plus a repository that already holds one skill the machine lacks. */
function fixture(name) {
  const root = join(scratch, name)
  const repo = join(root, 'repo')
  const home = join(root, 'home')
  const agents = join(root, 'agents')

  write(join(repo, 'skills', 'oldskill', 'SKILL.md'), '# old\n')
  write(join(repo, 'profiles', 'desktop', 'cordis.patch.yml'), 'agent-default-model:\n  model: deepseek-chat\ncwd: /repo\n')
  write(join(repo, 'profiles', 'desktop', 'package.json'), JSON.stringify({ name: 'p', dependencies: { a: '1.0.0' } }, null, 2))
  git(repo, ['init', '--quiet', '--initial-branch', 'main'])
  git(repo, ['config', 'user.email', 't@e.c'])
  git(repo, ['config', 'user.name', 'T'])
  git(repo, ['add', '-A'])
  git(repo, ['commit', '--quiet', '-m', 'repo init'])

  write(join(home, 'skills', 'alpha', 'SKILL.md'), '# alpha\n')
  write(join(agents, 'skills', 'beta', 'SKILL.md'), '# beta\n')
  write(join(home, 'AGENTS.md'), '# agents local\n')
  write(join(home, 'profiles', 'desktop', 'cordis.patch.yml'), 'agent-default-model:\n  model: deepseek-chat\n  reasoningEffort: high\ncwd: /local\n')
  write(join(home, 'profiles', 'desktop', 'package.json'), JSON.stringify({
    name: 'p',
    dependencies: {
      a: '1.0.0',
      local: 'link:/Users/me/code/local-plugin',
    },
  }, null, 2))

  return { root, repo, home, agents }
}

test('normalizeLinks rewrites absolute link specs to relative ones', () => {
  const profileDir = '/Users/me/.dsh/profiles/desktop'
  const result = normalizeLinks('{"x": "link:/Users/me/code/plug"}', profileDir)
  assert.deepEqual(result.rewritten, [{ from: '/Users/me/code/plug', to: 'link:../../../code/plug' }])
  assert.ok(result.text.includes('"link:../../../code/plug"'))
  // already relative stays untouched
  const stable = normalizeLinks('{"x": "link:../../../code/plug"}', profileDir)
  assert.equal(stable.rewritten.length, 0)
  assert.equal(stable.text, '{"x": "link:../../../code/plug"}')
})

test('snapshot dry run reports changes without writing', () => {
  const { repo, home, agents } = fixture('dry')
  const before = readFileSync(join(repo, 'profiles', 'desktop', 'package.json'), 'utf8')
  const result = snapshot({ repoPath: repo, dshHome: home, agentsHome: agents, dryRun: true })
  assert.equal(result.dryRun, true)
  assert.ok(result.changes.added.includes('alpha/SKILL.md'))
  assert.equal(readFileSync(join(repo, 'profiles', 'desktop', 'package.json'), 'utf8'), before)
  assert.equal(existsSync(join(repo, 'AGENTS.md')), false)
})

test('snapshot writes skills, AGENTS.md, MANIFEST and normalised links', () => {
  const { repo, home, agents } = fixture('write')
  const result = snapshot({ repoPath: repo, dshHome: home, agentsHome: agents, dryRun: false })
  assert.equal(result.dryRun, false)
  assert.equal(readFileSync(join(repo, 'skills', 'alpha', 'SKILL.md'), 'utf8'), '# alpha\n')
  assert.equal(readFileSync(join(repo, 'agents-skills', 'beta', 'SKILL.md'), 'utf8'), '# beta\n')
  assert.equal(readFileSync(join(repo, 'AGENTS.md'), 'utf8'), '# agents local\n')

  const manifest = readFileSync(join(repo, 'MANIFEST.md'), 'utf8')
  assert.ok(manifest.includes('- 技能数：2'))
  assert.ok(manifest.includes('- 跨 agent 技能数：1'))
  assert.ok(existsSync(join(repo, 'MANIFEST.local.md')))

  const pkg = JSON.parse(readFileSync(join(repo, 'profiles', 'desktop', 'package.json'), 'utf8'))
  // The spec must be relative now, and it must still resolve to the original path.
  assert.ok(pkg.dependencies.local.startsWith('link:..'))
  const resolved = resolve(join(home, 'profiles', 'desktop'), pkg.dependencies.local.slice('link:'.length))
  assert.equal(resolved, '/Users/me/code/local-plugin')
})

test('snapshot keeps the repository reasoningEffort instead of the local one', () => {
  const { repo, home, agents } = fixture('reasoning')
  snapshot({ repoPath: repo, dshHome: home, agentsHome: agents, dryRun: false })
  const patch = readFileSync(join(repo, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8')
  assert.ok(!patch.includes('reasoningEffort'))
  assert.ok(patch.includes('cwd: /local'))
})

test('snapshot reports repository-only entries instead of deleting them', () => {
  const { repo, home, agents } = fixture('nodelete')
  const result = snapshot({ repoPath: repo, dshHome: home, agentsHome: agents, dryRun: false })
  assert.equal(existsSync(join(repo, 'skills', 'oldskill', 'SKILL.md')), true)
  assert.ok(result.warnings.some((warning) => warning.includes('exist only in the repository')))
})

test('snapshot deletes repository-only entries only when allowDelete is set', () => {
  const { repo, home, agents } = fixture('delete')
  snapshot({ repoPath: repo, dshHome: home, agentsHome: agents, dryRun: false, allowDelete: true })
  assert.equal(existsSync(join(repo, 'skills', 'oldskill')), false)
})
