/**
 * Read-only repository status for dsh-config-sync.
 *
 * This is the P0 slice of `doctor.sh`: prove the plugin can observe the
 * `dsh-config` checkout without touching it. Only `git status`, `git
 * rev-parse` and `git rev-list` run here; `fetch` is opt-in because the
 * doctor path must stay usable offline.
 *
 * The return value is always schema-shaped: strings are strings (never null)
 * and counters are integers, so the tool layer can hand it straight to the
 * model without a second validation pass.
 *
 * @module dsh-config-sync/core/status
 */

import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve, join } from 'node:path'

import { shortenPath } from './files.js'
import { DEFAULT_TIMEOUT_MS, describeGitFailure, runGit } from './git.js'

/** Cap the file list so one broken checkout cannot flood the context. */
export const MAX_DIRTY_FILES = 20

/**
 * Expand a leading `~` and make the path absolute.
 *
 * Windows accepts both separators, so `~\dsh-config` and `~/dsh-config` both
 * work; a bare `~` means the home directory itself.
 *
 * @param {string} value
 * @param {string} [home]
 * @returns {string}
 */
export function expandPath(value, home = homedir()) {
  if (typeof value !== 'string' || value.trim() === '') return home
  const trimmed = value.trim()
  if (trimmed === '~') return home
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return join(home, trimmed.slice(2))
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(trimmed)
}

/**
 * Count and describe working-tree changes from `git status --porcelain -z`.
 *
 * Rename/copy records occupy two NUL-separated tokens (destination then
 * source); counting them once keeps `dirty` equal to the number of changed
 * paths rather than the number of tokens.
 *
 * @param {string} stdout
 * @returns {{ dirty: number, dirtyFiles: string[] }}
 */
export function parsePorcelain(stdout) {
  const tokens = stdout.split('\0').filter((token) => token !== '')
  const files = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.length < 4) continue
    const code = token.slice(0, 2)
    const path = token.slice(3)
    files.push(`${code} ${path}`)
    if (code[0] === 'R' || code[0] === 'C') index += 1
  }
  return {
    dirty: files.length,
    dirtyFiles: files.slice(0, MAX_DIRTY_FILES),
  }
}

/**
 * Read the state of one checkout.
 *
 * @param {{ repoPath: string, gitPath?: string, timeoutMs?: number, fetch?: boolean, signal?: AbortSignal }} options
 * @returns {Promise<{ ok: boolean, repoPath: string, repoPresent: boolean, branch: string, upstream: string, ahead: number, behind: number, dirty: number, dirtyFiles: string[], notes: string[] }>}
 */
export async function readRepoStatus(options) {
  const {
    repoPath,
    gitPath = 'git',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetch = false,
    signal,
  } = options

  const resolved = expandPath(repoPath)
  const notes = []
  const result = {
    ok: false,
    repoPath: resolved,
    repoPresent: false,
    branch: '',
    upstream: '',
    ahead: 0,
    behind: 0,
    dirty: 0,
    dirtyFiles: [],
    notes,
  }

  let present = false
  try {
    present = statSync(resolved).isDirectory()
  } catch {
    present = false
  }
  result.repoPresent = present
  if (!present) {
    notes.push(`Repository not found at ${shortenPath(resolved)}. Set repoPath in the plugin config or clone the repository there.`)
    return result
  }

  const inside = await runGit(['-C', resolved, 'rev-parse', '--is-inside-work-tree'], {
    gitPath,
    timeoutMs,
    signal,
  })
  if (!inside.ok) {
    // A plain directory and a broken repository fail differently; say which.
    notes.push(
      /not a git repository/i.test(inside.stderr)
        ? `${shortenPath(resolved)} is not a git repository.`
        : describeGitFailure(inside, gitPath),
    )
    return result
  }
  if (inside.stdout.trim() !== 'true') {
    notes.push(`${shortenPath(resolved)} is not a git working tree.`)
    return result
  }

  if (fetch) {
    const fetched = await runGit(['-C', resolved, 'fetch', '--prune', '--quiet'], {
      gitPath,
      // A fetch is the one network call here; give it four times the budget.
      timeoutMs: timeoutMs * 4,
      signal,
    })
    if (!fetched.ok) notes.push(`fetch failed (${describeGitFailure(fetched, gitPath)}) — reporting the local view.`)
  }

  const head = await runGit(['-C', resolved, 'rev-parse', '--abbrev-ref', 'HEAD'], {
    gitPath,
    timeoutMs,
    signal,
  })
  result.branch = head.ok ? head.stdout.trim() : ''
  if (!head.ok) notes.push(describeGitFailure(head, gitPath))
  if (result.branch === 'HEAD') {
    result.branch = ''
    notes.push('HEAD is detached; no branch is checked out.')
  }

  const status = await runGit(['-C', resolved, 'status', '--porcelain', '-z', '--untracked-files=normal'], {
    gitPath,
    timeoutMs,
    signal,
  })
  if (status.ok) {
    const parsed = parsePorcelain(status.stdout)
    result.dirty = parsed.dirty
    result.dirtyFiles = parsed.dirtyFiles
  } else {
    notes.push(describeGitFailure(status, gitPath))
  }

  const upstream = await runGit(
    ['-C', resolved, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    { gitPath, timeoutMs, signal },
  )
  if (!upstream.ok) {
    notes.push('No upstream branch is configured; ahead/behind cannot be computed.')
    result.ok = true
    return result
  }
  result.upstream = upstream.stdout.trim()

  const counts = await runGit(
    ['-C', resolved, 'rev-list', '--left-right', '--count', '@{upstream}...HEAD'],
    { gitPath, timeoutMs, signal },
  )
  if (counts.ok) {
    const [behind = '0', ahead = '0'] = counts.stdout.trim().split(/\s+/u)
    result.behind = Number.parseInt(behind, 10) || 0
    result.ahead = Number.parseInt(ahead, 10) || 0
  } else {
    notes.push(describeGitFailure(counts, gitPath))
  }

  result.ok = true
  return result
}
