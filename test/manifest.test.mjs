/**
 * Plugin-manifest comparison: `link:` specs differ per machine, the plugin
 * identity does not. A noisy warning taught the user to ignore the section, so
 * the comparison is semantic now.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { manifestDrift } from '../lib/core/doctor.js'

const stub = (deps, bundles) => JSON.stringify({ dependencies: deps, dsh: { profile: { bundles } } })

test('link: bases do not count as drift', () => {
  const live = stub({ plug: 'link:/Users/me/code/plug', x: '1.0.0' }, ['a', 'b'])
  const repo = stub({ plug: 'link:../../../code/plug', x: '1.0.0' }, ['b', 'a'])
  assert.deepEqual(manifestDrift(live, repo), [])
})

test('a version change and a bundle change do count', () => {
  const live = stub({ x: '1.0.0', y: 'link:/a/y' }, ['a', 'b'])
  const repo = stub({ x: '2.0.0' }, ['a'])
  const drift = manifestDrift(live, repo)
  assert.ok(drift.some((line) => line.includes('x 1.0.0')))
  assert.ok(drift.some((line) => line.includes('bundle')))
  assert.ok(drift.some((line) => line.includes('y')))
})

test('unparseable manifests degrade to one message, never a throw', () => {
  assert.deepEqual(manifestDrift('{', '{}'), ['清单无法解析'])
})
