import assert from 'node:assert/strict'
import { test } from 'node:test'

import { adoptReasoningEffort, reasoningEffortLine } from '../lib/core/patch.js'
import { filterReasoningEffort } from '../lib/core/files.js'

/**
 * The four assertions from `dsh-config/scripts/selftest.sh:26-69`, ported
 * verbatim: pack keeps the repository value, apply keeps the local value, an
 * empty source removes the line, and the doctor comparison ignores it.
 */
const BASE = [
  '- id: agent-default-model',
  '  config:',
  '    provider: deepseek-account',
  '    model: deepseek-flash',
  '    reasoningEffort: high',
  '- id: other',
  '  config:',
  '    model: another',
  '',
].join('\n')

test('pack side: a local change never overrides the repository value', () => {
  const repoPrevious = BASE
  const local = BASE.replace('reasoningEffort: high', 'reasoningEffort: low')
  const adopted = adoptReasoningEffort(local, repoPrevious)
  assert.ok(adopted.includes('reasoningEffort: high'))
  assert.ok(!adopted.includes('reasoningEffort: low'))
})

test('apply side: the repository value never overrides the local value', () => {
  const local = BASE.replace('reasoningEffort: high', 'reasoningEffort: low')
  const adopted = adoptReasoningEffort(BASE, local)
  assert.ok(adopted.includes('reasoningEffort: low'))
  assert.ok(!adopted.includes('reasoningEffort: high'))
})

test('an empty source removes the line instead of writing an empty value', () => {
  const adopted = adoptReasoningEffort(BASE, '')
  assert.ok(!adopted.includes('reasoningEffort'))
})

test('the doctor comparison ignores reasoningEffort on both sides', () => {
  const left = filterReasoningEffort(BASE)
  const right = filterReasoningEffort(BASE.replace('reasoningEffort: high', 'reasoningEffort: low'))
  assert.equal(left, right)
})

test('a missing line is inserted inside the agent-default-model block', () => {
  const withoutLine = BASE.replace('    reasoningEffort: high\n', '')
  const adopted = adoptReasoningEffort(withoutLine, BASE)
  const lines = adopted.split('\n')
  const modelIndex = lines.findIndex((line) => line.includes('model: deepseek-flash'))
  assert.equal(lines[modelIndex + 1], '    reasoningEffort: high')
})

test('duplicate lines collapse to the first position', () => {
  const duplicated = `${BASE}    reasoningEffort: low\n`
  const adopted = adoptReasoningEffort(duplicated, BASE)
  assert.equal(adopted.match(/reasoningEffort/gu)?.length, 1)
  assert.ok(adopted.includes('reasoningEffort: high'))
})

test('reasoningEffortLine reads the first line with its indentation', () => {
  assert.equal(reasoningEffortLine('  model: x\n   reasoningEffort: high\n'), '   reasoningEffort: high')
  assert.equal(reasoningEffortLine('model: x\n'), null)
})
