/**
 * Pull: bring this machine up to the repository (`update.sh` in Node).
 *
 * Contract kept from the shell script, plus one deliberate safety change:
 *
 *   - `dryRun` (the tool default) fetches and reports what *would* be pulled
 *     and mirrored, and writes nothing at all. The shell script's `--dry-run`
 *     still performs the pull; this one does not.
 *   - a real run uses `git pull --ff-only`: a divergence stops with instructions
 *     instead of creating a merge commit.
 *   - mirrors never delete local files unless `deleteLocal` is passed, because
 *     a skill that exists only on this machine is usually work in progress.
 *
 * @module dsh-syn-config/core/pull
 */

import { chmodSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { findGit, resolveAgentsHome, resolveDshHome } from './env.js'
import { mirrorDir } from './mirror.js'
import { runGit } from './git.js'

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** Mirror targets the plugin owns. `weekly` scripts need their execute bit. */
function mirrorPlan({ repoPath, dshHome, agentsHome }) {
  return [
    { name: 'skills', src: join(repoPath, 'skills'), dst: join(dshHome, 'skills') },
    { name: 'agents-skills', src: join(repoPath, 'agents-skills'), dst: join(agentsHome, 'skills') },
    { name: 'weekly', src: join(repoPath, 'weekly'), dst: join(dshHome, 'learning', 'scripts'), executable: true },
  ]
}

/** chmod +x for every shell script in a mirrored directory (POSIX only). */
function markExecutables(dir) {
  if (process.platform === 'win32') return
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.endsWith('.sh')) continue
    try {
      chmodSync(join(dir, name), 0o755)
    } catch {
      // a permission failure must not fail the pull
    }
  }
}

/**
 * @param {{ repoPath: string, dshHome?: string, agentsHome?: string, dryRun?: boolean, deleteLocal?: boolean, gitPath?: string, timeoutMs?: number, signal?: AbortSignal }} options
 */
export async function pullRepo(options) {
  const {
    repoPath,
    dshHome: explicitHome,
    agentsHome: explicitAgents,
    dryRun = true,
    deleteLocal = false,
    gitPath = findGit() ?? 'git',
    timeoutMs = 15_000,
    signal,
  } = options

  const dshHome = resolveDshHome(explicitHome)
  const agentsHome = resolveAgentsHome(explicitAgents)
  const warnings = []
  const result = {
    ok: false,
    dryRun,
    repoPath,
    before: '',
    after: '',
    incomingCommits: 0,
    incomingSubjects: [],
    pulled: false,
    changedSkills: [],
    mirrors: [],
    warnings,
    exitCode: 1,
  }

  const old = await runGit(['-C', repoPath, 'rev-parse', 'HEAD'], { gitPath, timeoutMs, signal })
  if (!old.ok) {
    warnings.push(old.missing ? 'git was not found' : `cannot read HEAD: ${old.stderr.trim()}`)
    return result
  }
  result.before = old.stdout.trim()
  result.after = result.before

  const fetchArgs = [
    '-C', repoPath,
    '-c', 'http.version=HTTP/1.1',
    '-c', 'http.connectTimeout=20',
    '-c', 'http.lowSpeedLimit=1000',
    '-c', 'http.lowSpeedTime=15',
    'fetch', '--prune', '-q', 'origin',
  ]
  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  let fetched = await runGit(fetchArgs, { gitPath, timeoutMs: timeoutMs * 2, signal, env: gitEnv })
  if (!fetched.ok) {
    await sleep(1000)
    fetched = await runGit(fetchArgs, { gitPath, timeoutMs: timeoutMs * 2, signal, env: gitEnv })
  }
  if (!fetched.ok) {
    warnings.push(`fetch failed: ${fetched.stderr.trim().split('\n')[0] ?? 'unknown error'}`)
    warnings.push('local state is still usable; update would retry')
    // Report the local mirror plan anyway so the caller sees something useful.
    result.ok = true
    result.exitCode = 2
    result.mirrors = mirrorPlan({ repoPath, dshHome, agentsHome }).map((target) => ({
      name: target.name,
      src: target.src,
      dst: target.dst,
      ...mirrorDir(target.src, target.dst, { dryRun: true, delete: false }),
    }))
    return result
  }

  const branch = await runGit(['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'], { gitPath, timeoutMs, signal })
  const branchName = branch.ok ? branch.stdout.trim() : 'main'
  const upstream = `origin/${branchName}`

  const incoming = await runGit(['-C', repoPath, 'rev-list', '--count', `HEAD..${upstream}`], { gitPath, timeoutMs, signal })
  result.incomingCommits = incoming.ok ? Number.parseInt(incoming.stdout.trim(), 10) || 0 : 0
  if (result.incomingCommits > 0) {
    const subjects = await runGit(['-C', repoPath, 'log', '--oneline', `HEAD..${upstream}`], { gitPath, timeoutMs, signal })
    result.incomingSubjects = subjects.ok
      ? subjects.stdout.split('\n').filter((line) => line.trim() !== '').slice(0, 20)
      : []
  }

  const plan = mirrorPlan({ repoPath, dshHome, agentsHome })
  if (dryRun) {
    result.ok = true
    result.exitCode = result.incomingCommits > 0 ? 2 : 0
    result.mirrors = plan.map((target) => ({
      name: target.name,
      src: target.src,
      dst: target.dst,
      ...mirrorDir(target.src, target.dst, { dryRun: true, delete: false }),
    }))
    return result
  }

  if (result.incomingCommits > 0) {
    const pulled = await runGit(['-C', repoPath, 'pull', '--ff-only', '-q'], { gitPath, timeoutMs: timeoutMs * 3, signal, env: gitEnv })
    if (!pulled.ok) {
      warnings.push('git pull --ff-only failed')
      warnings.push('your local commits were kept; merge by hand, never reset --hard')
      warnings.push(pulled.stderr.trim().split('\n').slice(-2).join(' '))
      result.ok = false
      result.exitCode = 1
      return result
    }
    const after = await runGit(['-C', repoPath, 'rev-parse', 'HEAD'], { gitPath, timeoutMs, signal })
    result.after = after.ok ? after.stdout.trim() : result.before
    result.pulled = result.after !== result.before
    const changed = await runGit(['-C', repoPath, 'diff', '--name-only', result.before, result.after, '--', 'skills', 'agents-skills'], { gitPath, timeoutMs, signal })
    if (changed.ok) {
      const names = new Set()
      for (const line of changed.stdout.split('\n')) {
        const parts = line.split('/')
        if (parts.length >= 2 && parts[0] !== '') names.add(`${parts[0]}/${parts[1]}`)
      }
      result.changedSkills = [...names].sort()
    }
  }

  result.mirrors = plan.map((target) => {
    const mirrored = mirrorDir(target.src, target.dst, { dryRun: false, delete: deleteLocal })
    if (target.executable === true) markExecutables(target.dst)
    return {
      name: target.name,
      src: target.src,
      dst: target.dst,
      ...mirrored,
    }
  })

  result.ok = true
  const changedFiles = result.mirrors.reduce((sum, entry) => sum + entry.planned.added.length + entry.planned.updated.length + entry.planned.deleted.length, 0)
  result.exitCode = changedFiles > 0 || result.pulled ? 0 : 0
  return result
}
