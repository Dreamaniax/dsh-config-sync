/**
 * The five secret actions as one callable, shared by the tool and the tests.
 *
 * Two files with opposite directions must not be confused:
 *
 *   repository copy  → redact  (real value becomes `__KEY__`)
 *   deployed copy    → inject  (placeholder becomes the real value)
 *   deployed copy    → refresh (rotate the bearer value)
 *
 * A leftover placeholder after inject is a *hard* failure: that configuration
 * is guaranteed to answer `invalid_api_key`, so nothing is written.
 *
 * @module dsh-syn-config/core/secrets-ops
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'

import { resolveDshHome } from './env.js'
import { scanHistory } from './history.js'
import { findPlaceholders, readTextFile, scanForSecrets, writeFileAtomic } from './files.js'
import { fingerprint, inject, loadSecrets, redact, refreshAuthorization, secretValue } from './secrets.js'

/**
 * Timestamped backup **outside** the repository.
 *
 * A backup taken before redaction still contains the real values, so keeping it
 * inside the checkout would (a) leave plaintext in the working tree and (b) be
 * found by the next plaintext scan, blocking every push. Backups therefore go
 * to `<dshHome>/backups/`, mode 600, named after the file they protect.
 *
 * @param {string} path file to copy
 * @param {{ dshHome: string }} options
 */
export function backupFile(path, options) {
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19)
  const directory = join(options.dshHome, 'backups')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const backup = join(directory, `${basename(path)}.bak-${stamp}`)
  copyFileSync(path, backup)
  try {
    chmodSync(backup, 0o600)
  } catch {
    // Windows has no POSIX mode; the file is still outside the repository
  }
  return backup
}

/**
 * Run one action and report what happened.
 *
 * @param {{ action: 'scan'|'inject'|'redact'|'refresh'|'fingerprint', repoPath: string, dshHome?: string, profile?: string, dryRun?: boolean }} options
 */
export async function runSecretsAction(options) {
  const {
    action,
    repoPath,
    dshHome: explicitHome,
    profile = process.env.DSH_PROFILE ?? 'desktop',
    dryRun = true,
    deep = false,
  } = options

  const dshHome = resolveDshHome(explicitHome)
  const secretsPath = join(dshHome, 'secrets.env')
  const repoConfig = join(repoPath, 'profiles', profile, 'cordis.patch.yml')
  const liveConfig = join(dshHome, 'profiles', profile, 'cordis.patch.yml')
  const entries = loadSecrets(secretsPath)

  const result = {
    ok: true,
    action,
    dryRun,
    target: '',
    changed: [],
    leftover: [],
    hits: [],
    historyHits: [],
    fingerprints: [],
    notes: [],
    exitCode: 0,
  }

  if (action === 'scan') {
    const hits = scanForSecrets([join(repoPath, 'profiles'), join(repoPath, 'AGENTS.md'), join(repoPath, 'scripts')])
    result.hits = hits.map((hit) => ({ file: hit.file, line: hit.line }))
    result.notes.push(hits.length === 0
      ? 'repository has no plaintext secrets in the working tree (profiles / AGENTS.md / scripts)'
      : `${hits.length} plaintext secret(s) found in the working tree — rotate first, then clean history`)

    if (deep) {
      const history = await scanHistory({ repoPath })
      result.historyHits = history.hits.map((hit) => ({
        commit: hit.commit,
        pattern: hit.pattern,
        preview: hit.preview,
      }))
      result.notes.push(history.note)
      if (history.truncated) result.notes.push('history scan was truncated; run it manually for full coverage')
    }

    const clean = result.hits.length === 0 && result.historyHits.length === 0
    result.ok = clean
    result.exitCode = clean ? 0 : 1
    return result
  }

  if (action === 'fingerprint') {
    if (entries.length === 0) {
      result.ok = false
      result.exitCode = 1
      result.notes.push(`no usable keys in ${secretsPath}`)
      return result
    }
    result.fingerprints = fingerprint(entries)
    result.notes.push('sha256 prefix and length only — values are never returned')
    return result
  }

  if (action === 'redact') {
    // Two synchronized files can carry a value: the profile config and AGENTS.md.
    const targets = [repoConfig, join(repoPath, 'AGENTS.md')].filter((path) => existsSync(path))
    result.target = targets.join(', ')
    const changed = []
    for (const target of targets) {
      const text = readTextFile(target)
      if (text === null) continue
      const redacted = redact(text, entries)
      if (redacted.changed.length === 0) continue
      changed.push(...redacted.changed.map((key) => `${key}@${basename(target)}`))
      if (!dryRun) {
        backupFile(target, { dshHome })
        writeFileAtomic(target, redacted.text, { mode: 0o644 })
      }
    }
    result.changed = changed
    result.notes.push(changed.length === 0
      ? 'nothing to redact (no real value found in the repository copy)'
      : dryRun ? 'dry run — repository copies were not written' : 'repository copies redacted')
    return result
  }

  if (action === 'inject') {
    result.target = liveConfig
    const text = readTextFile(liveConfig)
    if (text === null) {
      result.ok = false
      result.exitCode = 1
      result.notes.push(`missing ${liveConfig} (run apply first)`)
      return result
    }
    const injected = inject(text, entries)
    result.changed = injected.injected
    result.leftover = injected.leftover
    if (injected.leftover.length > 0) {
      result.ok = false
      result.exitCode = 1
      result.notes.push(`unresolved placeholders remain: ${injected.leftover.join(' ')}`)
      result.notes.push('nothing was written: that configuration would answer invalid_api_key')
      return result
    }
    if (!dryRun && injected.injected.length > 0) {
      backupFile(liveConfig, { dshHome })
      writeFileAtomic(liveConfig, injected.text, { mode: 0o600 })
    }
    result.notes.push(injected.injected.length === 0
      ? 'nothing to inject (deployed copy has no placeholders)'
      : dryRun ? 'dry run — deployed copy was not written' : 'deployed copy injected')
    return result
  }

  if (action === 'refresh') {
    result.target = liveConfig
    const text = readTextFile(liveConfig)
    if (text === null) {
      result.ok = false
      result.exitCode = 1
      result.notes.push(`missing ${liveConfig}`)
      return result
    }
    const value = secretValue(entries, 'ANYSEARCH_API_KEY')
    if (value === null) {
      result.ok = false
      result.exitCode = 1
      result.notes.push('secrets.env has no ANYSEARCH_API_KEY')
      return result
    }
    const refreshed = refreshAuthorization(text, value)
    result.changed = refreshed.changed ? ['ANYSEARCH_API_KEY'] : []
    if (!dryRun && refreshed.changed) {
      backupFile(liveConfig, { dshHome })
      writeFileAtomic(liveConfig, refreshed.text, { mode: 0o600 })
    }
    result.notes.push(refreshed.changed
      ? (dryRun ? 'dry run — bearer value would be refreshed' : 'bearer value refreshed; restart DSH to reconnect')
      : 'no Authorization bearer line found')
    return result
  }

  result.ok = false
  result.exitCode = 1
  result.notes.push(`unknown action: ${String(action)}`)
  return result
}

/** Whether a path exists, exported for callers that pre-flight targets. */
export function targetExists(path) {
  return existsSync(path)
}

/** Re-exported so the tool can report placeholders without importing files twice. */
export { findPlaceholders }
