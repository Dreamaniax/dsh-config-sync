import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { expandPath, parsePorcelain, readRepoStatus } from '../lib/core/status.js'

const scratch = mkdtempSync(join(tmpdir(), 'dsh-config-sync-test-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** A repository with one commit and no upstream, so the status reader is offline-exact. */
function makeRepo(name) {
  const dir = join(scratch, name)
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '--quiet', '--initial-branch', 'main'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'Test'])
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  git(dir, ['add', 'README.md'])
  git(dir, ['commit', '--quiet', '-m', 'init'])
  return dir
}

test('expandPath expands a leading tilde for both separators', () => {
  assert.equal(expandPath('~/dsh-config', '/home/u'), join('/home/u', 'dsh-config'))
  assert.equal(expandPath('~\\dsh-config', 'C:\\Users\\u'), join('C:\\Users\\u', 'dsh-config'))
  assert.equal(expandPath('~', '/home/u'), '/home/u')
  assert.equal(expandPath('', '/home/u'), '/home/u')
  assert.equal(expandPath('/abs/path', '/home/u'), '/abs/path')
})

test('parsePorcelain counts paths, not NUL tokens', () => {
  const porcelain = ' M src/a.js\0?? new.md\0R  old.md\0src/new.md\0'
  const parsed = parsePorcelain(porcelain)
  assert.equal(parsed.dirty, 3)
  assert.deepEqual(parsed.dirtyFiles, [' M src/a.js', '?? new.md', 'R  old.md'])
})

test('parsePorcelain keeps the file list bounded', () => {
  const porcelain = Array.from({ length: 40 }, (_, index) => `?? f${index}.md\0`).join('')
  const parsed = parsePorcelain(porcelain)
  assert.equal(parsed.dirty, 40)
  assert.equal(parsed.dirtyFiles.length, 20)
})

test('readRepoStatus reports a missing checkout without throwing', async () => {
  const status = await readRepoStatus({ repoPath: join(scratch, 'nope') })
  assert.equal(status.ok, false)
  assert.equal(status.repoPresent, false)
  assert.equal(status.dirty, 0)
  assert.ok(status.notes.length >= 1)
  assert.equal(typeof status.branch, 'string')
})

test('readRepoStatus reports a non-repository directory', async () => {
  const dir = join(scratch, 'plain')
  mkdirSync(dir, { recursive: true })
  const status = await readRepoStatus({ repoPath: dir })
  assert.equal(status.repoPresent, true)
  assert.equal(status.ok, false)
  assert.ok(status.notes.some((note) => note.includes('not a git repository')))
})

test('readRepoStatus reads branch, cleanliness and a missing upstream', async () => {
  const repo = makeRepo('clean')
  const status = await readRepoStatus({ repoPath: repo })
  assert.equal(status.ok, true)
  assert.equal(status.branch, 'main')
  assert.equal(status.dirty, 0)
  assert.equal(status.ahead, 0)
  assert.equal(status.behind, 0)
  assert.equal(status.upstream, '')
  assert.ok(status.notes.some((note) => note.includes('No upstream')))
})

test('readRepoStatus counts modified and untracked files', async () => {
  const repo = makeRepo('dirty')
  writeFileSync(join(repo, 'README.md'), '# fixture changed\n')
  writeFileSync(join(repo, 'extra.md'), 'new\n')
  const status = await readRepoStatus({ repoPath: repo })
  assert.equal(status.ok, true)
  assert.equal(status.dirty, 2)
  assert.ok(status.dirtyFiles.some((entry) => entry.includes('README.md')))
  assert.ok(status.dirtyFiles.some((entry) => entry.includes('extra.md')))
})
