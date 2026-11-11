/**
 * Plaintext secrets in the repository **history**.
 *
 * The working-tree scan answers "is the current snapshot clean?". It cannot
 * answer the question that actually matters after an accident: "did a value
 * ever get committed?" — git keeps it retrievable until the history is
 * rewritten, and a rotated key is the only real fix.
 *
 * The scan is bounded on purpose: the last N commits, a byte cap, and added
 * lines only. It reports commit, pattern name and a short preview with the
 * matched value masked, never the value itself.
 *
 * @module dsh-config-sync/core/history
 */

import { findGit } from './env.js'
import { runCommand } from './exec.js'
import { SECRET_PATTERNS } from './files.js'

/** Mask the middle of a matched value so a hit is recognisable but not usable. */
export function maskValue(value) {
  if (value.length <= 8) return `${value.slice(0, 2)}***`
  return `${value.slice(0, 6)}…${value.slice(-4)}`
}

/**
 * Scan recent commit diffs for added credential lines.
 *
 * @param {{ repoPath: string, gitPath?: string, timeoutMs?: number, signal?: AbortSignal, maxCommits?: number, maxBytes?: number }} options
 * @returns {Promise<{ ok: boolean, commits: number, hits: { commit: string, pattern: number, preview: string }[], truncated: boolean, note: string }>}
 */
export async function scanHistory(options) {
  const {
    repoPath,
    gitPath = findGit() ?? 'git',
    timeoutMs = 30_000,
    signal,
    maxCommits = 200,
    maxBytes = 8 * 1024 * 1024,
  } = options

  const base = ['-C', repoPath, 'log', '-p', '--no-color', '--no-merges', '-n', String(maxCommits), '--format=%x01%H']
  let result = await runCommand(gitPath, base, { timeoutMs, signal })
  // A repository with large binary-ish skills can overflow one buffer; retry
  // over the paths that actually matter for credentials before giving up.
  if (!result.ok && /ENOBUFS|maxBuffer|ERR_CHILD_PROCESS_STDIO_MAXBUFFER/i.test(result.stderr ?? '')) {
    result = await runCommand(
      gitPath,
      [...base, '--', 'profiles', 'scripts', 'AGENTS.md', 'weekly'],
      { timeoutMs, signal },
    )
  }

  if (!result.ok) {
    return {
      ok: false,
      commits: 0,
      hits: [],
      truncated: false,
      note: result.missing ? 'git not found' : `history scan failed: ${result.stderr.trim().split('\n')[0] ?? 'unknown error'}`,
    }
  }

  const text = result.stdout
  const truncated = Buffer.byteLength(text, 'utf8') >= maxBytes
  const lines = text.split('\n')
  const hits = []
  let commits = 0
  let current = ''

  for (const line of lines) {
    if (line.startsWith('\u0001')) {
      current = line.slice(1).trim().slice(0, 12)
      commits += 1
      continue
    }
    if (!line.startsWith('+') || line.startsWith('+++')) continue
    const added = line.slice(1)
    if (/__[A-Z0-9_]+__/u.test(added)) continue
    for (let index = 0; index < SECRET_PATTERNS.length; index += 1) {
      SECRET_PATTERNS[index].lastIndex = 0
      const match = SECRET_PATTERNS[index].exec(added)
      if (match === null) continue
      hits.push({
        commit: current,
        pattern: index,
        preview: added.trim().slice(0, 80).replace(match[0], maskValue(match[0])),
      })
      break
    }
    if (hits.length >= 200) break
  }

  return {
    ok: true,
    commits,
    hits,
    truncated,
    note: hits.length === 0
      ? `no plaintext credential in the last ${commits} commits`
      : `${hits.length} hit(s) in history — rotate the key(s), then decide about rewriting history`,
  }
}
