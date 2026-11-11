/**
 * Read-only file facts the doctor needs: directory listings, env-file parsing,
 * secret redaction, settings comparison and plaintext scanning.
 *
 * Everything here is deliberately pure (text in, text out) except the few
 * functions that read a path, so the behaviour is directly testable and the
 * same on macOS and Windows.
 *
 * @module dsh-config-sync/core/files
 */

import { readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { isDirectory } from './env.js'

/** Names of the immediate subdirectories of `dir`, sorted like the shell's `sort`. */
export function listChildDirNames(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const names = []
  for (const entry of entries) {
    if (entry.isDirectory()) names.push(entry.name)
    else if (entry.isSymbolicLink() && isDirectory(join(dir, entry.name))) names.push(entry.name)
  }
  return names.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

/** How many immediate subdirectories `dir` has (0 when it does not exist). */
export function countChildDirs(dir) {
  return listChildDirNames(dir).length
}

/** File contents, or null when unreadable. */
export function readTextFile(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** POSIX permission bits as three octal digits ("600"), or null when unavailable. */
export function fileModeOctal(path) {
  try {
    const stat = statSync(path)
    return (stat.mode & 0o777).toString(8).padStart(3, '0')
  } catch {
    return null
  }
}

/** Whether a path exists as a regular file (symlinks followed). */
export function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Parse a `KEY=value` env file the way `secrets.sh` does.
 *
 * Rules kept from the shell implementation: whole-line comments and blank
 * lines are skipped, the split happens at the first `=`, the key loses all
 * whitespace, the value loses trailing whitespace, and entries with an empty
 * key or value are dropped. A missing trailing newline must not drop the last
 * entry — splitting the text directly already guarantees that.
 *
 * @param {string} text
 * @returns {{ key: string, value: string }[]}
 */
export function parseEnvFile(text) {
  if (typeof text !== 'string' || text === '') return []
  const entries = []
  for (const rawLine of text.split(/\r?\n/u)) {
    if (rawLine.trim() === '' || rawLine.trimStart().startsWith('#')) continue
    const split = rawLine.indexOf('=')
    if (split === -1) continue
    const key = rawLine.slice(0, split).replace(/\s+/gu, '')
    const value = rawLine.slice(split + 1).replace(/\s+$/u, '')
    if (key === '' || value === '') continue
    entries.push({ key, value })
  }
  return entries
}

/**
 * Replace every secret value with its placeholder.
 *
 * Uses literal replacement, not a pattern: a key containing `|`, `&`, `\` or
 * `.` must not corrupt the text (the historical `sed` implementation could).
 *
 * @param {string} text
 * @param {{ key: string, value: string }[]} secrets
 * @returns {string}
 */
export function redactText(text, secrets) {
  let output = text
  for (const { key, value } of secrets) {
    if (value === '') continue
    output = output.split(value).join(`__${key}__`)
  }
  return output
}

/** Drop `reasoningEffort:` lines — that setting never crosses machines. */
export function filterReasoningEffort(text) {
  if (typeof text !== 'string') return ''
  return text
    .split(/\r?\n/u)
    .filter((line) => !/^\s*reasoningEffort:/u.test(line))
    .join('\n')
}

/**
 * How many lines differ between two texts.
 *
 * This is a multiset difference (lines present only on one side, counted),
 * which equals the number of `diff` `<`/`>` lines for ordinary local edits and
 * differs only when a file's lines were reordered.
 *
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
export function countLineChanges(left, right) {
  const counts = new Map()
  for (const line of left.split(/\r?\n/u)) counts.set(line, (counts.get(line) ?? 0) + 1)
  let changes = 0
  for (const line of right.split(/\r?\n/u)) {
    const remaining = counts.get(line) ?? 0
    if (remaining > 0) counts.set(line, remaining - 1)
    else changes += 1
  }
  for (const remaining of counts.values()) changes += remaining
  return changes
}

/** Unresolved `__KEY__` placeholders, sorted and unique. */
export function findPlaceholders(text) {
  const found = new Set()
  for (const match of (text ?? '').matchAll(/__[A-Za-z0-9_]+__/gu)) found.add(match[0])
  return [...found].sort()
}

/** Names used by `apiKeyEnv:` in a profile config. */
export function findApiKeyEnvNames(text) {
  const found = new Set()
  for (const match of (text ?? '').matchAll(/apiKeyEnv:\s*([A-Za-z_][A-Za-z0-9_]*)/gu)) found.add(match[1])
  return [...found].sort()
}

/**
 * Credential shapes worth flagging.
 *
 * The shell ancestor only knew four prefixes; these cover the providers that
 * show up in practice (AWS, OpenAI project keys, Google, Slack, JWTs, private
 * keys) plus the generic `api_key = <value>` assignment.
 */
export const SECRET_PATTERNS = [
  /as_sk_[A-Za-z0-9]{10,}/gu,
  /ghp_[A-Za-z0-9]{20,}/gu,
  /github_pat_[A-Za-z0-9_]{20,}/gu,
  /sk-[A-Za-z0-9]{24,}/gu,
  /sk-proj-[A-Za-z0-9_-]{20,}/gu,
  /AKIA[0-9A-Z]{16}/gu,
  /AIza[0-9A-Za-z_-]{20,}/gu,
  /xox[baprs]-[A-Za-z0-9-]{10,}/gu,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/gu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/gu,
  /Bearer [A-Za-z0-9._-]{20,}/gu,
  /(?:api[_-]?key|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9_-]{20,}/giu,
]

/**
 * Values that only pretend to be credentials.
 *
 * Fixtures and docs legitimately contain `API_KEY=dummy_test_value_0001`;
 * flagging those turns the guard into noise and trains people to ignore it.
 */
const PLACEHOLDER_VALUE = /(?:dummy|test|example|sample|fake|placeholder|changeme|redacted|invalid|notreal|xxx)/iu

/** Whether a matched credential line is a placeholder the author meant to write. */
export function isPlaceholderMatch(value) {
  // Provider-prefixed shapes are decisive: `as_sk_TESTONLY…` is a fixture *and*
  // a credential shape, so the heuristic must not excuse it.
  if (/^(?:as_sk_|ghp_|github_pat_|sk-|AKIA|AIza|xox|eyJ|-----BEGIN|Bearer )/u.test(value)) return false
  return PLACEHOLDER_VALUE.test(value) || value.length < 24
}

/** Files under `roots` (skipping .git and node_modules), bounded and deterministic. */
export function listScannableFiles(roots) {
  const files = []
  const walk = (path, depth) => {
    if (depth > 8 || files.length > 20_000) return
    let entries
    try {
      entries = readdirSync(path, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const child = join(path, entry.name)
      if (entry.isDirectory()) walk(child, depth + 1)
      else if (entry.isFile()) files.push(child)
    }
  }
  for (const root of roots) {
    if (root === null || root === undefined) continue
    if (isFile(root)) files.push(root)
    else if (isDirectory(root)) walk(root, 0)
  }
  return files
}

/**
 * Find plaintext secrets in the given roots.
 *
 * A line that still carries a `__PLACEHOLDER__` is not a hit: the placeholder
 * pattern is what the repository is supposed to contain.
 *
 * @param {string[]} roots
 * @returns {{ file: string, line: number, match: string }[]}
 */
export function scanForSecrets(roots) {
  const hits = []
  for (const file of listScannableFiles(roots)) {
    const text = readTextFile(file)
    if (text === null) continue
    const lines = text.split(/\r?\n/u)
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (/__[A-Z0-9_]+__/u.test(line)) continue
      for (const pattern of SECRET_PATTERNS) {
        pattern.lastIndex = 0
        const match = pattern.exec(line)
        if (match === null) continue
        // An explicit ignore marker wins, then the placeholder heuristic.
        if (/dsh-sync:\s*ignore-secret/u.test(line)) continue
        if (isPlaceholderMatch(match[0])) continue
        hits.push({ file, line: index + 1, match: match[0] })
        break
      }
    }
  }
  return hits
}

/** Files in a directory mapped to their basename (non-recursive), sorted. */
export function listFilesByName(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => ({ name: entry.name, path: join(dir, entry.name) }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
}

/** Whether two files have identical bytes. */
export function sameFileContent(left, right) {
  if (!isFile(left) || !isFile(right)) return false
  return readFileSync(left).equals(readFileSync(right))
}

/**
 * Replace a file atomically: write a sibling temp file, then rename it.
 *
 * Windows can transiently refuse the rename while an antivirus or the search
 * indexer holds the target, so the rename is retried with backoff there.
 *
 * @param {string} path
 * @param {string} text
 * @param {{ mode?: number }} [options]
 */
export function writeFileAtomic(path, text, options = {}) {
  const { mode = 0o600 } = options
  const temp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`
  writeFileSync(temp, text, { mode })
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(temp, path)
      return path
    } catch (error) {
      const transient = process.platform === 'win32' && ['EACCES', 'EBUSY', 'EPERM'].includes(error?.code ?? '')
      if (transient && attempt < 8) {
        const until = Date.now() + 20 * 2 ** attempt
        while (Date.now() < until) {
          // bounded synchronous backoff: callers are tool invocations, not a hot path
        }
        continue
      }
      try {
        rmSync(temp, { force: true })
      } catch {
        // the temp file is already gone
      }
      throw error
    }
  }
}

/**
 * Replace the user's home directory with `~` so reports and tool output do not
 * carry an absolute account path.
 *
 * @param {string} value
 * @param {string} [home]
 * @returns {string}
 */
export function shortenPath(value, home) {
  if (typeof value !== 'string') return value
  const base = home ?? homedirSafe()
  if (base === '' || !value.startsWith(base)) return value
  return `~${value.slice(base.length)}`
}

/** `os.homedir()` without importing os at module top (kept tiny for tests). */
function homedirSafe() {
  try {
    // eslint-disable-next-line global-require -- one-shot, keeps the import list flat
    return process.env.HOME ?? process.env.USERPROFILE ?? ''
  } catch {
    return ''
  }
}

/** Basename helper re-exported for callers that only need the label. */
export { basename }
