/**
 * Pre-commit checks, ported from `scripts/lint.sh`.
 *
 * Only the checks that silently break a script are kept:
 *
 *   1. `bash -n` on every shell script (skipped with a note when no bash exists);
 *   2. `$VAR` glued to a non-ASCII character — bash 3.2 eats it into the name;
 *   3. `.sh` must be LF (CRLF makes Git Bash report `$'\r'`);
 *   4. Windows launchers must be CRLF;
 *   5. `node --check` on the weekly `.mjs` files.
 *
 * Everything except `bash -n` and `node --check` is plain byte inspection, so
 * it works on Windows without Git Bash.
 *
 * @module dsh-syn-config/core/lint
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { which } from './env.js'
import { runCommand } from './exec.js'

/** Files matching one directory glob, sorted. */
function list(dir, suffix) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
      .map((entry) => join(dir, entry.name))
      .sort()
  } catch {
    return []
  }
}

/** Whole-file byte test for CRLF. */
function hasCrlf(path) {
  const bytes = readFileSync(path)
  for (let index = 0; index < bytes.length - 1; index += 1) {
    if (bytes[index] === 0x0d && bytes[index + 1] === 0x0a) return true
  }
  return false
}

/** `$VAR` immediately followed by a non-ASCII byte, per line. */
function findGluedVariables(path) {
  const text = readFileSync(path, 'utf8')
  const hits = []
  const lines = text.split(/\r?\n/u)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const match = line.match(/\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7f]/u)
    if (match !== null && !line.includes('${')) hits.push(`${path}:${index + 1}: ${line.trim().slice(0, 120)}`)
  }
  return hits
}

/**
 * Run every check.
 *
 * @param {{ repoPath: string, timeoutMs?: number, signal?: AbortSignal }} options
 * @returns {Promise<{ ok: boolean, checks: { name: string, ok: boolean, notes: string[] }[] }>}
 */
export async function runLint(options) {
  const { repoPath, timeoutMs = 15_000, signal } = options
  const shellFiles = [...list(join(repoPath, 'scripts'), '.sh'), ...list(join(repoPath, 'weekly'), '.sh')]
  const mjsFiles = list(join(repoPath, 'weekly'), '.mjs')
  const winFiles = list(join(repoPath, 'scripts', 'win'), '.cmd')
  const bash = which('bash')
  const checks = []

  const syntaxNotes = []
  if (bash === null) {
    syntaxNotes.push('bash not found — syntax check skipped (byte checks still ran)')
  } else {
    for (const file of shellFiles) {
      const result = await runCommand(bash, ['-n', file], { timeoutMs, signal })
      if (!result.ok) syntaxNotes.push(`${file}: ${result.stderr.trim().split('\n').slice(-2).join(' ')}`)
    }
  }
  checks.push({ name: 'bash syntax', ok: syntaxNotes.every((note) => note.includes('skipped')), notes: syntaxNotes })

  const glued = shellFiles.flatMap((file) => findGluedVariables(file))
  checks.push({
    name: '$VAR glued to non-ASCII',
    ok: glued.length === 0,
    notes: glued.length === 0 ? [] : [...glued.slice(0, 10), 'fix: wrap the variable as ${VAR}'],
  })

  const crlfShell = shellFiles.filter((file) => hasCrlf(file))
  checks.push({ name: '.sh uses LF', ok: crlfShell.length === 0, notes: crlfShell.map((file) => `${file} has CRLF`) })

  const lfCmd = winFiles.filter((file) => !hasCrlf(file))
  checks.push({ name: '.cmd uses CRLF', ok: lfCmd.length === 0, notes: lfCmd.map((file) => `${file} lacks CRLF`) })

  const nodeNotes = []
  for (const file of mjsFiles) {
    const result = await runCommand(process.execPath, ['--check', file], { timeoutMs, signal })
    if (!result.ok) nodeNotes.push(`${file}: ${result.stderr.trim().split('\n').slice(-2).join(' ')}`)
  }
  checks.push({ name: 'node syntax', ok: nodeNotes.length === 0, notes: nodeNotes })

  return { ok: checks.every((check) => check.ok), checks }
}
