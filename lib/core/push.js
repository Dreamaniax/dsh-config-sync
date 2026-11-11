/**
 * Push: snapshot, gate, commit, push (`sync.sh` in Node).
 *
 * The order is the contract, not an implementation detail:
 *
 *   pack → lint gate → redact → scan gate → git add → commit → push
 *
 * Redaction must happen before the scan, otherwise the scan finds the value the
 * redaction still has to replace. A failing lint or a plaintext hit aborts
 * before a commit is created, so a bad snapshot never reaches the remote.
 *
 * Deliberate differences from the shell script:
 *
 *   - **no automatic rebase.** If the remote moved, the push stops and prints
 *     the manual commands. A tool must not rewrite history silently.
 *   - `dryRun` (the tool default) writes nothing at all; the shell `pack.sh`
 *     always writes.
 *   - deletions are reported, not applied, unless `allowDelete` is true.
 *
 * @module dsh-config-sync/core/push
 */

import { findGit } from './env.js'
import { runLint } from './lint.js'
import { snapshot } from './pack.js'
import { runSecretsAction } from './secrets-ops.js'
import { runGit } from './git.js'

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** `sync: 2026-11-11 14:05` in local time. */
export function defaultMessage(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `sync: ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * @param {{ repoPath: string, dshHome?: string, agentsHome?: string, profile?: string, dryRun?: boolean, message?: string, includeProfile?: boolean, allowDelete?: boolean, gitPath?: string, timeoutMs?: number, signal?: AbortSignal }} options
 */
export async function pushRepo(options) {
  const {
    repoPath,
    dshHome,
    agentsHome,
    profile,
    dryRun = true,
    message,
    includeProfile = true,
    allowDelete = false,
    includeMarket = false,
    gitPath = findGit() ?? 'git',
    timeoutMs = 15_000,
    signal,
  } = options

  const warnings = []
  const result = {
    ok: false,
    dryRun,
    repoPath,
    branch: '',
    changes: { added: [], updated: [], deleted: [], files: [] },
    manifest: { skills: 0, agentsSkills: 0, changed: false },
    gates: {
      lint: { ok: false, notes: [] },
      redact: { ok: false, changed: [] },
      scan: { ok: false, hits: [] },
    },
    commit: { created: false, sha: '', subject: '', message: '', pushed: false, unchanged: false },
    warnings,
    exitCode: 1,
  }

  const branch = await runGit(['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'], { gitPath, timeoutMs, signal })
  if (!branch.ok) {
    warnings.push(branch.missing ? 'git was not found' : `cannot read the repository: ${branch.stderr.trim()}`)
    return result
  }
  result.branch = branch.stdout.trim()

  // Gate 1: static checks. Cheap and side-effect free, so it also runs on a dry run.
  const lint = await runLint({ repoPath, timeoutMs, signal })
  result.gates.lint = { ok: lint.ok, notes: lint.checks.flatMap((check) => check.notes) }
  if (!lint.ok) {
    warnings.push('lint failed — nothing was written, committed or pushed')
    result.exitCode = 1
    return result
  }

  // Snapshot (write only when this is a real run).
  const snapshotResult = snapshot({ repoPath, dshHome, agentsHome, profile, dryRun, allowDelete, includeProfile, includeMarket })
  result.changes = snapshotResult.changes
  result.manifest = snapshotResult.manifest
  warnings.push(...snapshotResult.warnings)

  if (dryRun) {
    result.gates.redact = { ok: true, changed: [] }
    result.gates.scan = { ok: true, hits: [] }
    result.ok = true
    result.exitCode = result.changes.files.length > 0 || result.changes.added.length > 0 ? 0 : 0
    return result
  }

  // Gate 2 + 3: redact the repository copy, then prove nothing plaintext remains.
  const redacted = await runSecretsAction({ action: 'redact', repoPath, dshHome, profile, dryRun: false })
  result.gates.redact = { ok: redacted.ok, changed: redacted.changed }
  const scan = await runSecretsAction({ action: 'scan', repoPath, dshHome })
  result.gates.scan = { ok: scan.ok, hits: scan.hits }
  if (!scan.ok) {
    warnings.push('plaintext secret found in the repository — aborted before commit')
    result.exitCode = 1
    return result
  }

  const add = await runGit(['-C', repoPath, 'add', '-A'], { gitPath, timeoutMs, signal })
  if (!add.ok) {
    warnings.push(`git add failed: ${add.stderr.trim()}`)
    return result
  }
  const staged = await runGit(['-C', repoPath, 'diff', '--cached', '--quiet'], { gitPath, timeoutMs, signal })
  if (staged.ok) {
    result.commit.unchanged = true
    result.ok = true
    result.exitCode = 0
    warnings.push('没有变化，无需提交。')
    return result
  }

  const commitMessage = typeof message === 'string' && message.trim() !== '' ? message.trim() : defaultMessage()
  // A commit message is free text and lands in history forever; refuse the
  // obvious ways a secret or a private URL gets in.
  if (/https?:\/\/|as_sk_|ghp_|github_pat_|AKIA[0-9A-Z]{16}|Bearer\s/i.test(commitMessage)) {
    warnings.push('commit message refused: it looks like it carries a URL or a credential')
    result.exitCode = 1
    return result
  }
  result.commit.message = commitMessage
  const commit = await runGit(['-C', repoPath, 'commit', '-q', '-m', commitMessage], { gitPath, timeoutMs, signal })
  if (!commit.ok) {
    warnings.push(`commit failed: ${commit.stderr.trim().split('\n').slice(-2).join(' ')}`)
    warnings.push('check git user.name / user.email in this repository')
    return result
  }
  const head = await runGit(['-C', repoPath, 'log', '-1', '--format=%h%x09%s'], { gitPath, timeoutMs, signal })
  result.commit.created = true
  if (head.ok) {
    const [sha = '', subject = ''] = head.stdout.trim().split('\t')
    result.commit.sha = sha
    result.commit.subject = subject
  }

  const remote = await runGit(['-C', repoPath, 'remote', 'get-url', 'origin'], { gitPath, timeoutMs, signal })
  if (!remote.ok) {
    warnings.push('no remote origin — the commit stays local (publish first)')
    result.ok = true
    result.exitCode = 0
    return result
  }

  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  let fetched = await runGit(['-C', repoPath, 'fetch', '-q', 'origin'], { gitPath, timeoutMs: timeoutMs * 2, signal, env: gitEnv })
  if (!fetched.ok) {
    await sleep(1000)
    fetched = await runGit(['-C', repoPath, 'fetch', '-q', 'origin'], { gitPath, timeoutMs: timeoutMs * 2, signal, env: gitEnv })
  }
  if (fetched.ok) {
    const upstream = `origin/${result.branch}`
    const hasUpstream = await runGit(['-C', repoPath, 'rev-parse', '--verify', '--quiet', upstream], { gitPath, timeoutMs, signal })
    if (hasUpstream.ok) {
      const ancestor = await runGit(['-C', repoPath, 'merge-base', '--is-ancestor', upstream, 'HEAD'], { gitPath, timeoutMs, signal })
      if (!ancestor.ok) {
        warnings.push(`${upstream} has commits this machine does not have — push stopped (no rebase, no force)`)
        warnings.push(`resolve by hand: git -C "${repoPath}" pull --rebase, fix conflicts, then run the push again`)
        warnings.push('the new commit is kept locally: nothing was lost')
        result.exitCode = 1
        return result
      }
    }
  } else {
    warnings.push('fetch failed (weak network?) — trying to push anyway')
  }

  let pushed = false
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const push = await runGit(['-C', repoPath, 'push', '-q'], { gitPath, timeoutMs: timeoutMs * 2, signal, env: gitEnv })
    if (push.ok) {
      pushed = true
      break
    }
    if (attempt < 3) await sleep(2000)
  }
  result.commit.pushed = pushed
  if (!pushed) {
    warnings.push('已同步但未推送：the commit is local only; re-run the push later (it is idempotent)')
    result.exitCode = 1
    return result
  }

  result.ok = true
  result.exitCode = 0
  return result
}
