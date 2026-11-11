/**
 * `cordis.patch.yml` surgery, ported from `_lib.sh`.
 *
 * `reasoningEffort` is local machine state, not shared configuration: the
 * model and its thinking effort stay whatever this machine chose. Both
 * directions of the sync therefore carry the *local* value across, and there is
 * one function for that — `adoptReasoningEffort(target, source)` means "give
 * target source's reasoningEffort line, leave everything else alone".
 *
 *   pack  (local → repo): source is the previous repository copy → the value
 *                         already stored in the repository wins, so a local
 *                         change is never published.
 *   apply (repo → local): source is the pre-apply local backup → the local
 *                         value is restored, so the repository never overrides it.
 *
 * @module dsh-config-sync/core/patch
 */

import { filterReasoningEffort } from './files.js'

const REASONING_LINE = /^\s*reasoningEffort:/
const MODEL_LINE = /^\s*model:\s*\S/
const AGENT_MODEL_ID = /^\s*-\s*id:\s*agent-default-model\s*$/

/** The first `reasoningEffort:` line (with its indentation), or null. */
export function reasoningEffortLine(text) {
  if (typeof text !== 'string') return null
  for (const line of text.split(/\r?\n/u)) {
    if (REASONING_LINE.test(line)) return line
  }
  return null
}

/** Split text into lines while remembering whether it ended with a newline. */
function linesOf(text) {
  const endsWithNewline = text.endsWith('\n')
  const lines = text.split(/\r?\n/u)
  if (endsWithNewline) lines.pop()
  return { lines, endsWithNewline }
}

function joinLines(lines, endsWithNewline) {
  return `${lines.join('\n')}${endsWithNewline ? '\n' : ''}`
}

/**
 * Give `targetText` the `reasoningEffort` line of `sourceText`.
 *
 * Ported behaviour, including the three-level fallback for insertion:
 *   1. if the source has a value and the target already has the line, replace
 *      it in place and drop duplicates;
 *   2. otherwise insert it after the `model:` line of the
 *      `- id: agent-default-model` block;
 *   3. failing that, after the first `model:` line anywhere;
 *   4. failing that, append at the end;
 *   5. if the source has no such line, remove every one from the target.
 *
 * @param {string} targetText
 * @param {string} sourceText
 * @returns {string}
 */
export function adoptReasoningEffort(targetText, sourceText) {
  if (typeof targetText !== 'string') return targetText
  const source = reasoningEffortLine(sourceText)
  const { lines, endsWithNewline } = linesOf(targetText)

  if (source === null) {
    return joinLines(lines.filter((line) => !REASONING_LINE.test(line)), endsWithNewline)
  }

  const firstIndex = lines.findIndex((line) => REASONING_LINE.test(line))
  if (firstIndex !== -1) {
    const next = lines.filter((line, index) => index === firstIndex || !REASONING_LINE.test(line))
    next[firstIndex] = source
    return joinLines(next, endsWithNewline)
  }

  // Insertion: prefer the agent-default-model block.
  let inBlock = false
  for (let index = 0; index < lines.length; index += 1) {
    if (AGENT_MODEL_ID.test(lines[index])) inBlock = true
    if (inBlock && MODEL_LINE.test(lines[index])) {
      const next = [...lines]
      next.splice(index + 1, 0, source)
      return joinLines(next, endsWithNewline)
    }
  }

  // Fallback 2: the first model: line anywhere.
  for (let index = 0; index < lines.length; index += 1) {
    if (MODEL_LINE.test(lines[index])) {
      const next = [...lines]
      next.splice(index + 1, 0, source)
      return joinLines(next, endsWithNewline)
    }
  }

  // Fallback 3: append.
  return joinLines([...lines, source], endsWithNewline)
}

/** Drop every `reasoningEffort:` line (doctor comparison helper). */
export function withoutReasoningEffort(text) {
  return filterReasoningEffort(text)
}
