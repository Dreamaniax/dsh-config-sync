import assert from 'node:assert/strict'
import { test } from 'node:test'

import { fingerprint, inject, redact, refreshAuthorization, secretValue } from '../lib/core/secrets.js'

const entries = [
  { key: 'ANYSEARCH_API_KEY', value: 'as_sk_REALVALUE123456' },
  { key: 'ODD_KEY', value: 'p|q&r\\s.t' },
]

test('inject replaces placeholders literally, including metacharacter values', () => {
  const { text, injected, leftover } = inject('a: __ANYSEARCH_API_KEY__\nb: __ODD_KEY__\n', entries)
  assert.equal(text, 'a: as_sk_REALVALUE123456\nb: p|q&r\\s.t\n')
  assert.deepEqual(injected, ['ANYSEARCH_API_KEY', 'ODD_KEY'])
  assert.deepEqual(leftover, [])
})

test('inject reports placeholders that have no secret and leaves them intact', () => {
  const { text, injected, leftover } = inject('a: __ANYSEARCH_API_KEY__\nb: __MISSING__\n', entries)
  assert.deepEqual(injected, ['ANYSEARCH_API_KEY'])
  assert.deepEqual(leftover, ['__MISSING__'])
  assert.ok(text.includes('__MISSING__'))
})

test('redact replaces real values with placeholders and survives metacharacters', () => {
  const { text, changed } = redact('a: as_sk_REALVALUE123456\nb: p|q&r\\s.t\n', entries)
  assert.equal(text, 'a: __ANYSEARCH_API_KEY__\nb: __ODD_KEY__\n')
  assert.deepEqual(changed, ['ANYSEARCH_API_KEY', 'ODD_KEY'])
})

test('redact and inject round-trip', () => {
  const original = 'auth: "Bearer as_sk_REALVALUE123456"\n'
  const redacted = redact(original, entries).text
  assert.ok(!redacted.includes('as_sk_REALVALUE123456'))
  assert.equal(inject(redacted, entries).text, original)
})

test('refreshAuthorization rewrites only the bearer line', () => {
  const text = 'model: x\nAuthorization: "Bearer old-token"\nother: keep\n'
  const refreshed = refreshAuthorization(text, 'new-token')
  assert.equal(refreshed.changed, true)
  assert.ok(refreshed.text.includes('Authorization: "Bearer new-token"'))
  assert.ok(refreshed.text.includes('other: keep'))
  assert.equal(refreshAuthorization('model: x\n', 'new').changed, false)
})

test('fingerprint exposes a sha256 prefix and length, never the value', () => {
  const prints = fingerprint(entries)
  assert.equal(prints.length, 2)
  for (const entry of prints) {
    assert.equal(entry.sha256.length, 8)
    assert.ok(Number.isInteger(entry.length))
  }
  const serialized = JSON.stringify(prints)
  assert.ok(!serialized.includes('as_sk_REALVALUE123456'))
  assert.ok(!serialized.includes('p|q&r'))
})

test('secretValue finds one key and returns null otherwise', () => {
  assert.equal(secretValue(entries, 'ANYSEARCH_API_KEY'), 'as_sk_REALVALUE123456')
  assert.equal(secretValue(entries, 'NOPE'), null)
})
