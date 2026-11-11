/**
 * Snapshot this machine into the repository (`pack.sh` in Node).
 *
 * What one snapshot covers, exactly as the shell script does:
 *
 *   ~/.dsh/skills            → <repo>/skills
 *   ~/.agents/skills         → <repo>/agents-skills
 *   ~/.dsh/profiles/<p>/*    → <repo>/profiles/<p>/*   (package.json, patch, lock…)
 *   ~/.dsh/AGENTS.md         → <repo>/AGENTS.md
 *   <repo>/MANIFEST.md       regenerated (machine-independent)
 *   <repo>/MANIFEST.local.md regenerated (gitignored: host/time/platform)
 *
 * Two deliberate safety changes over the shell version:
 *
 *   1. deletions are *reported*, never performed, unless `allowDelete` is true.
 *      A machine that happens to be missing a skill must not delete it from the
 *      repository and therefore from every other machine.
 *   2. `link:` dependencies are normalised generically (the shell script
 *      hard-codes one package name), so any local checkout path becomes a
 *      relative path that resolves on both macOS and Windows.
 *
 * @module dsh-config-sync/core/pack
 */

import { existsSync, readdirSync } from 'node:fs'
import { hostname } from 'node:os'
import { join, relative, sep } from 'node:path'

import { resolveAgentsHome, resolveDshHome } from './env.js'
import { isFile, readTextFile, writeFileAtomic } from './files.js'
import { mirrorDir } from './mirror.js'
import { adoptReasoningEffort } from './patch.js'

/** Files mirrored from the profile directory; everything else stays local. */
const PROFILE_FILES = ['package.json', 'cordis.patch.yml', 'cordis.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']

/** Count immediate subdirectories (0 when the path is missing). */
function countDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length
  } catch {
    return 0
  }
}

/** Windows drive letter or POSIX absolute path. */
function isAbsolutePath(value) {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value)
}

/**
 * Rewrite every absolute `link:` path as a path relative to the profile dir.
 *
 * The profile lives at `<home>/profiles/<profile>`, so a relative spec keeps
 * working after the repository is cloned into a different user directory. A
 * different Windows drive cannot be expressed relatively and is reported.
 *
 * @param {string} text package.json text
 * @param {string} profileDir absolute profile directory
 * @returns {{ text: string, rewritten: { from: string, to: string }[], warnings: string[] }}
 */
export function normalizeLinks(text, profileDir) {
  const rewritten = []
  const warnings = []
  const output = text.replace(/"link:([^"]+)"/gu, (match, target) => {
    if (!isAbsolutePath(target)) return match
    const relativePath = relative(profileDir, target)
    if (relativePath === '' || /^[A-Za-z]:/u.test(relativePath)) {
      warnings.push(`cannot express ${target} relative to ${profileDir}`)
      return match
    }
    const value = `link:${relativePath.split(sep).join('/')}`
    if (`link:${target}` !== value) rewritten.push({ from: target, to: value })
    return `"${value}"`
  })
  return { text: output, rewritten, warnings }
}

/** MANIFEST.md content, matching the shell script's shape. */
function manifestBody(profile, skills, agentsSkills, packageJsonText) {
  let dependencyBlock = '{}'
  const match = packageJsonText === null ? null : packageJsonText.match(/"dependencies"\s*:\s*\{[\s\S]*?\n {2}\}/u)
  if (match !== null) dependencyBlock = match[0]
  return [
    '# 配置快照（内容跨机一致，机器信息见本地 MANIFEST.local.md）',
    '',
    `- profile：${profile}`,
    `- 技能数：${skills}`,
    `- 跨 agent 技能数：${agentsSkills}`,
    '',
    '## 已安装插件',
    '```json',
    dependencyBlock,
    '```',
    '',
  ].join('\n')
}

/** MANIFEST.local.md content (gitignored). */
function localManifestBody(profile) {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  return [
    '# 本机快照信息（.gitignore，不提交）',
    `- 生成时间：${stamp}`,
    `- 来源平台：${process.platform}-${process.arch}`,
    `- 来源主机：${hostname()}`,
    `- profile：${profile}`,
    '',
  ].join('\n')
}

/**
 * Build (and optionally write) one snapshot.
 *
 * @param {{ repoPath: string, dshHome?: string, agentsHome?: string, profile?: string, dryRun?: boolean, allowDelete?: boolean, includeProfile?: boolean }} options
 */
export function snapshot(options) {
  const {
    repoPath,
    dshHome: explicitHome,
    agentsHome: explicitAgents,
    profile = process.env.DSH_PROFILE ?? 'desktop',
    dryRun = true,
    allowDelete = false,
    includeProfile = true,
    includeMarket = false,
  } = options

  const dshHome = resolveDshHome(explicitHome)
  const agentsHome = resolveAgentsHome(explicitAgents)
  const profileDir = join(dshHome, 'profiles', profile)
  const repoProfile = join(repoPath, 'profiles', profile)
  const warnings = []
  const changes = { added: [], updated: [], deleted: [], files: [] }
  const mirrors = []

  // --- skills / agents-skills (deletions only when explicitly allowed) -----
  for (const [name, src, dst] of [
    ['skills', join(dshHome, 'skills'), join(repoPath, 'skills')],
    ['agents-skills', join(agentsHome, 'skills'), join(repoPath, 'agents-skills')],
  ]) {
    if (!existsSync(src)) continue
    // Always plan with delete enabled so the report can name what pack.sh
    // would have removed; only `allowDelete` actually removes anything.
    const result = mirrorDir(src, dst, { dryRun: true, delete: true })
    mirrors.push({ name, src, dst, added: result.planned.added, updated: result.planned.updated, deleted: result.planned.deleted })
    if (!allowDelete && result.planned.deleted.length > 0) {
      warnings.push(`${name}: ${result.planned.deleted.length} entr(ies) exist only in the repository — kept (pass allow_delete to mirror pack.sh's --delete behaviour)`)
    }
    changes.added.push(...result.planned.added)
    changes.updated.push(...result.planned.updated)
  }

  // --- profile --------------------------------------------------------------
  const profileWrites = []
  if (includeProfile && existsSync(profileDir)) {
    const previousPatch = readTextFile(join(repoProfile, 'cordis.patch.yml'))
    for (const name of PROFILE_FILES) {
      const source = join(profileDir, name)
      if (!isFile(source)) continue
      let next = readTextFile(source)
      if (next === null) continue
      if (name === 'package.json') {
        const normalized = normalizeLinks(next, profileDir)
        next = normalized.text
        warnings.push(...normalized.warnings)
        if (normalized.rewritten.length > 0) {
          changes.files.push(`profiles/${profile}/package.json (links normalised: ${normalized.rewritten.length})`)
        }
      }
      if (name === 'cordis.patch.yml' && previousPatch !== null) {
        // Keep the value already stored in the repository: reasoningEffort is
        // local machine state and must never travel.
        next = adoptReasoningEffort(next, previousPatch)
      }
      const current = readTextFile(join(repoProfile, name))
      if (current !== next) {
        profileWrites.push({ name, text: next })
        changes.updated.push(`profiles/${profile}/${name}`)
        changes.files.push(`profiles/${profile}/${name}`)
      }
    }

    // .dsh-market: opt-in, because it carries marketplace state (pending
    // updates, discovery compatibility) that nobody needs on another machine.
    const marketSrc = join(profileDir, '.dsh-market')
    if (!includeMarket && existsSync(marketSrc)) {
      warnings.push('.dsh-market/ skipped (marketplace state is machine-local; pass include_market to sync it)')
    }
    if (includeMarket && existsSync(marketSrc)) {
      const marketDst = join(repoProfile, '.dsh-market')
      const result = mirrorDir(marketSrc, marketDst, { dryRun: true, delete: false, exclude: 'log.ndjson' })
      mirrors.push({ name: '.dsh-market', src: marketSrc, dst: marketDst, added: result.planned.added, updated: result.planned.updated, deleted: [] })
      changes.added.push(...result.planned.added)
      changes.updated.push(...result.planned.updated)
    }
  }

  // --- AGENTS.md ------------------------------------------------------------
  const agentsSource = join(dshHome, 'AGENTS.md')
  const agentsTarget = join(repoPath, 'AGENTS.md')
  if (isFile(agentsSource)) {
    const sourceText = readTextFile(agentsSource)
    if (sourceText !== readTextFile(agentsTarget)) {
      profileWrites.push({ name: 'AGENTS.md', text: sourceText, absolute: agentsTarget })
      changes.updated.push('AGENTS.md')
      changes.files.push('AGENTS.md')
    }
  }

  // --- MANIFEST -------------------------------------------------------------
  if (allowDelete) changes.deleted.push(...mirrors.flatMap((mirror) => mirror.deleted))

  /** Counts and body must describe the repository as it will be after writing. */
  const buildManifest = () => {
    const packageJsonText = readTextFile(join(repoProfile, 'package.json'))
    const skillsCount = countDirs(join(repoPath, 'skills'))
    const agentsSkillsCount = countDirs(join(repoPath, 'agents-skills'))
    return {
      skills: skillsCount,
      agentsSkills: agentsSkillsCount,
      text: manifestBody(profile, skillsCount, agentsSkillsCount, packageJsonText),
    }
  }

  if (dryRun) {
    const planned = buildManifest()
    const manifestChanged = readTextFile(join(repoPath, 'MANIFEST.md')) !== planned.text
    if (manifestChanged) {
      changes.updated.push('MANIFEST.md')
      changes.files.push('MANIFEST.md')
    }
    return {
      ok: true,
      dryRun: true,
      repoPath,
      profile,
      changes,
      mirrors,
      manifest: { changed: manifestChanged, skills: planned.skills, agentsSkills: planned.agentsSkills },
      warnings,
    }
  }

  for (const mirror of mirrors) {
    if (mirror.name === '.dsh-market') {
      mirrorDir(mirror.src, mirror.dst, { dryRun: false, delete: false, exclude: 'log.ndjson' })
      continue
    }
    mirrorDir(mirror.src, mirror.dst, { dryRun: false, delete: allowDelete })
  }
  for (const write of profileWrites) {
    const target = write.absolute ?? join(repoPath, 'profiles', profile, write.name)
    writeFileAtomic(target, write.text, { mode: 0o644 })
  }

  const finalManifest = buildManifest()
  const manifestChanged = readTextFile(join(repoPath, 'MANIFEST.md')) !== finalManifest.text
  if (manifestChanged) {
    writeFileAtomic(join(repoPath, 'MANIFEST.md'), finalManifest.text, { mode: 0o644 })
    changes.updated.push('MANIFEST.md')
    changes.files.push('MANIFEST.md')
  }
  writeFileAtomic(join(repoPath, 'MANIFEST.local.md'), localManifestBody(profile), { mode: 0o644 })

  return {
    ok: true,
    dryRun: false,
    repoPath,
    profile,
    changes,
    mirrors,
    manifest: { changed: manifestChanged, skills: finalManifest.skills, agentsSkills: finalManifest.agentsSkills },
    warnings,
  }
}
