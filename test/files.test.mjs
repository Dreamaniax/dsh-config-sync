import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import {
  countChildDirs,
  countLineChanges,
  findApiKeyEnvNames,
  findPlaceholders,
  filterReasoningEffort,
  listChildDirNames,
  parseEnvFile,
  redactText,
  scanForSecrets,
} from '../lib/core/files.js'

const scratch = mkdtempSync(join(tmpdir(), 'dsh-config-sync-files-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

test('parseEnvFile keeps secrets.sh semantics', () => {
  const text = [
    '# comment',
    '',
    'A_KEY=value',
    'TRAILING=has spaces   ',
    'WITH_EQUALS=a=b=c',
    'EMPTY=',
    '=nokey',
    ' SPACED_KEY = x',
  ].join('\n')
  assert.deepEqual(parseEnvFile(text), [
    { key: 'A_KEY', value: 'value' },
    { key: 'TRAILING', value: 'has spaces' },
    { key: 'WITH_EQUALS', value: 'a=b=c' },
    { key: 'SPACED_KEY', value: ' x' },
  ])
})

test('parseEnvFile keeps the last line without a trailing newline', () => {
  assert.deepEqual(parseEnvFile('A=1\nB=2'), [
    { key: 'A', value: '1' },
    { key: 'B', value: '2' },
  ])
})

test('redactText replaces values literally, not as patterns', () => {
  const secrets = [
    { key: 'ODD', value: 'a|b&c\\d.e' },
    { key: 'PLAIN', value: 'as_sk_1234567890' },
  ]
  const text = 'Authorization: "Bearer as_sk_1234567890"\nweird: a|b&c\\d.e\n'
  const redacted = redactText(text, secrets)
  assert.equal(redacted, 'Authorization: "Bearer __PLAIN__"\nweird: __ODD__\n')
  // The historical sed implementation treated the value as a regex and could
  // corrupt the file or replace the wrong text; a literal split never does.
  assert.ok(!redacted.includes('as_sk_1234567890'))
})

test('filterReasoningEffort drops only the local-only setting', () => {
  const text = 'model: deepseek\n  reasoningEffort: high\nother: 1\n'
  assert.equal(filterReasoningEffort(text), 'model: deepseek\nother: 1\n')
})

test('countLineChanges counts both sides of a change', () => {
  assert.equal(countLineChanges('a\nb\n', 'a\nb\n'), 0)
  assert.equal(countLineChanges('a\nb\n', 'a\nc\n'), 2)
  assert.equal(countLineChanges('a\n', 'a\nb\n'), 1)
  assert.equal(countLineChanges('a\nb\n', 'a\n'), 1)
})

test('findPlaceholders and findApiKeyEnvNames read only names', () => {
  assert.deepEqual(findPlaceholders('x: "Bearer __A_KEY__"\ny: __B__\n'), ['__A_KEY__', '__B__'])
  assert.deepEqual(findApiKeyEnvNames('apiKeyEnv: DEEPSEEK_KEY\napiKeyEnv: OTHER\n'), ['DEEPSEEK_KEY', 'OTHER'])
})

test('scanForSecrets flags real-looking values and ignores placeholders', () => {
  const dir = join(scratch, 'scan')
  mkdirSync(join(dir, 'profiles'), { recursive: true })
  writeFileSync(join(dir, 'profiles', 'good.yml'), 'auth: "Bearer __ANYSEARCH_API_KEY__"\n')
  writeFileSync(join(dir, 'profiles', 'bad.yml'), 'auth: "Bearer as_sk_abcdefghijkl"\n')
  const hits = scanForSecrets([join(dir, 'profiles')])
  assert.equal(hits.length, 1)
  assert.ok(hits[0].file.endsWith('bad.yml'))
  assert.ok(hits[0].match.startsWith('as_sk_'))
})

test('listChildDirNames and countChildDirs ignore files and sort', () => {
  const dir = join(scratch, 'dirs')
  mkdirSync(join(dir, 'b'), { recursive: true })
  mkdirSync(join(dir, 'a'), { recursive: true })
  writeFileSync(join(dir, 'file.txt'), 'x')
  assert.deepEqual(listChildDirNames(dir), ['a', 'b'])
  assert.equal(countChildDirs(dir), 2)
  assert.equal(countChildDirs(join(scratch, 'missing')), 0)
})
