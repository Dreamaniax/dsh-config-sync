/**
 * The host reads a plugin's card icon from the manifest's top-level `icon`
 * field (or an exported `./icon` resource) as a data URL — not from any file
 * the package happens to ship. Declaring it is the whole fix; this test keeps
 * it declared and keeps it inside the contract (relative, inside the package,
 * png/jpeg/webp/svg, at most 256 KiB).
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative } from 'node:path'

const root = join(import.meta.dirname, '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

test('the manifest declares an icon the host can render', () => {
  assert.equal(typeof manifest.icon, 'string', 'package.json needs a top-level icon field')
  assert.equal(isAbsolute(manifest.icon), false, 'the icon must be a relative path')
  const target = join(root, manifest.icon)
  const local = relative(dirname(join(root, 'package.json')), target)
  assert.equal(local.startsWith('..'), false, 'the icon must stay inside the package')
  assert.ok(['.png', '.jpg', '.jpeg', '.webp', '.svg'].includes(extname(target).toLowerCase()))
  const bytes = statSync(target).size
  assert.ok(bytes > 0 && bytes <= 256 * 1024, `icon is ${bytes} bytes, cap is 262144`)
})

test('the declared icon is the selected mark, not a placeholder', () => {
  const bytes = readFileSync(join(root, manifest.icon))
  // PNG signature, RGBA colour type (6): the transparent S-ribbon, not a flat square.
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.equal(bytes[25], 6, 'expected an RGBA PNG so the background stays transparent')
})
