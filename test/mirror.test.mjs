import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { mirrorDir } from '../lib/core/mirror.js'

const scratch = mkdtempSync(join(tmpdir(), 'dsh-config-sync-mirror-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
}

function readTree(root) {
  const out = {}
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const rel = prefix === '' ? name : `${prefix}/${name}`
      if (statSync(full).isDirectory()) walk(full, rel)
      else out[rel] = readFileSync(full, 'utf8')
    }
  }
  walk(root, '')
  return out
}

test('mirror copies new files and updates changed ones', () => {
  const src = join(scratch, 'src1')
  const dst = join(scratch, 'dst1')
  writeTree(src, { 'a.txt': 'a', 'sub/b.txt': 'b-new-content', 'sub/c.txt': 'c' })
  writeTree(dst, { 'sub/b.txt': 'b-old', 'keep.txt': 'keep' })
  const result = mirrorDir(src, dst, { dryRun: false })
  assert.equal(result.applied, true)
  assert.deepEqual(result.planned.added.sort(), ['a.txt', 'sub/c.txt'])
  assert.deepEqual(result.planned.updated, ['sub/b.txt'])
  assert.equal(readFileSync(join(dst, 'a.txt'), 'utf8'), 'a')
  assert.equal(readFileSync(join(dst, 'sub/b.txt'), 'utf8'), 'b-new-content')
  // Without delete, an extra destination file survives.
  assert.equal(readFileSync(join(dst, 'keep.txt'), 'utf8'), 'keep')
})

test('mirror --delete removes stale files and prunes empty directories', () => {
  const src = join(scratch, 'src2')
  const dst = join(scratch, 'dst2')
  writeTree(src, { 'a.txt': 'a' })
  writeTree(dst, { 'stale.txt': 'x', 'gone/deep.txt': 'y' })
  const result = mirrorDir(src, dst, { dryRun: false, delete: true })
  assert.deepEqual(result.planned.deleted.sort(), ['gone', 'gone/deep.txt', 'stale.txt'])
  assert.deepEqual(readTree(dst), { 'a.txt': 'a' })
})

test('mirror dry run writes nothing but reports the plan', () => {
  const src = join(scratch, 'src3')
  const dst = join(scratch, 'dst3')
  writeTree(src, { 'a.txt': 'a' })
  const result = mirrorDir(src, dst, { dryRun: true })
  assert.equal(result.applied, false)
  assert.deepEqual(result.planned.added, ['a.txt'])
  assert.throws(() => readFileSync(join(dst, 'a.txt')))
})

test('mirror skips excluded names', () => {
  const src = join(scratch, 'src4')
  const dst = join(scratch, 'dst4')
  writeTree(src, { 'a.txt': 'a', 'log.ndjson': 'noise' })
  mirrorDir(src, dst, { dryRun: false, exclude: 'log.ndjson' })
  assert.equal(readFileSync(join(dst, 'a.txt'), 'utf8'), 'a')
  assert.throws(() => readFileSync(join(dst, 'log.ndjson')))
})

test('mirror produces the same tree as rsync -a --delete', async (t) => {
  const { execFileSync } = await import('node:child_process')
  let rsync = true
  try {
    execFileSync('rsync', ['--version'], { stdio: 'ignore' })
  } catch {
    rsync = false
  }
  if (!rsync) {
    t.skip('rsync is not installed on this machine')
    return
  }
  const src = join(scratch, 'src5')
  const viaRsync = join(scratch, 'rsync5')
  const viaPlugin = join(scratch, 'plugin5')
  writeTree(src, { 'a.txt': 'a', 'nested/b.md': '# b', 'nested/deep/c.txt': 'c' })
  writeTree(viaPlugin, { 'stale.txt': 'stale', 'nested/old.txt': 'old' })
  writeTree(viaRsync, { 'stale.txt': 'stale', 'nested/old.txt': 'old' })

  execFileSync('rsync', ['-a', '--delete', `${src}/`, `${viaRsync}/`])
  mirrorDir(src, viaPlugin, { dryRun: false, delete: true })

  assert.deepEqual(readTree(viaPlugin), readTree(viaRsync))
  assert.deepEqual(readTree(viaPlugin), readTree(src))
})
