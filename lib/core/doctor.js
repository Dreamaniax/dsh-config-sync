/**
 * Read-only health check — the Node port of `dsh-config/scripts/doctor.sh`.
 *
 * Six sections, the same ordering and the same findings the shell script
 * reports, but every result is structured so the model does not have to parse
 * Chinese log lines:
 *
 *   1. toolchain — git / rsync / platform / node / zstd
 *   2. repository — branch, head, dirty tree, remote, fetch, ahead/behind
 *   3. skills — repository vs local counts, both set differences, missing SKILL.md
 *   4. secrets — secrets.env presence and mode, key names, plaintext scan
 *   5. profile — deployed vs repository config, placeholders, plugin manifest
 *   6. weekly — pipeline script drift and scheduler state
 *
 * The one side effect is `git fetch --prune`, exactly as in `doctor.sh`: it
 * refreshes remote refs so ahead/behind are real. Skip it with `offline: true`.
 *
 * Exit-code contract kept from the shell script: 0 clean, 2 warnings, 1 any
 * blocking error.
 *
 * @module dsh-config-sync/core/doctor
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { findApiKeyEnvNames, countChildDirs, countLineChanges, fileModeOctal, findPlaceholders, filterReasoningEffort, isFile, listChildDirNames, listFilesByName, parseEnvFile, readTextFile, redactText, sameFileContent, scanForSecrets } from './files.js'
import { findDshCli, findGit, findNode, findZstd, isDirectory, platformLabel, resolveAgentsHome, resolveDshHome, IS_WIN, which } from './env.js'
import { runGit } from './git.js'
import { runCommand } from './exec.js'

/** One line in a section. `level` drives both rendering and the exit code. */
function item(level, text) {
  return { level, text }
}

/** Build a section and compute its own status from the strongest item. */
function section(id, title, items, extra = {}) {
  const levels = new Set(items.map((entry) => entry.level))
  const status = levels.has('error') ? 'error' : levels.has('warn') ? 'warn' : 'ok'
  return { id, title, status, items, ...extra }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/**
 * Run the full check.
 *
 * @param {{ repoPath: string, dshHome?: string, agentsHome?: string, profile?: string, offline?: boolean, timeoutMs?: number, signal?: AbortSignal }} options
 */
export async function runDoctor(options) {
  const {
    repoPath,
    dshHome: explicitHome,
    agentsHome: explicitAgents,
    profile = process.env.DSH_PROFILE ?? 'desktop',
    offline = false,
    timeoutMs = 15_000,
    signal,
    launchdLabel = process.env.DSH_WEEKLY_LAUNCHD_LABEL ?? '',
    windowsTask = process.env.DSH_WEEKLY_WINDOWS_TASK ?? 'DSH-WeeklyRetro',
  } = options

  const repo = repoPath
  const dshHome = resolveDshHome(explicitHome)
  const agentsHome = resolveAgentsHome(explicitAgents)
  const localSkills = join(dshHome, 'skills')
  const localAgentSkills = join(agentsHome, 'skills')
  const secretsPath = join(dshHome, 'secrets.env')
  const profileDir = join(dshHome, 'profiles', profile)
  const repoProfile = join(repo, 'profiles', profile)
  const livePatch = join(profileDir, 'cordis.patch.yml')
  const repoPatch = join(repoProfile, 'cordis.patch.yml')
  const liveManifest = join(profileDir, 'package.json')
  const repoManifest = join(repoProfile, 'package.json')

  const gitPath = findGit()
  const sections = []

  /** Machine-local scheduler label: config, env file, or feature suffix match. */
  const resolveSchedulerLabel = (fallback) => {
    if (launchdLabel !== '') return launchdLabel
    const envText = readTextFile(join(dshHome, 'learning', 'schedule.env')) ?? ''
    const declared = envText.match(/^DSH_WEEKLY_LAUNCHD_LABEL=(.+)$/mu)
    if (declared !== null) return declared[1].trim()
    return fallback
  }

  // ---- 1. toolchain -------------------------------------------------------
  {
    const items = []
    if (gitPath === null) {
      items.push(item('error', IS_WIN
        ? '找不到可用 git：安装 Git for Windows 并确保 git.exe 在 PATH，或设 DSH_GIT'
        : '找不到可用 git：macOS 先 sudo xcodebuild -license accept，或 brew install git'))
    } else {
      const version = await runCommand(gitPath, ['--version'], { timeoutMs, signal })
      const number = version.ok ? (version.stdout.trim().split(/\s+/u).pop() ?? '?') : '?'
      items.push(item('ok', `git：${gitPath} (${number})`))
    }
    const rsync = which('rsync')
    items.push(item('ok', rsync === null
      ? 'rsync：无（插件不依赖 rsync，镜像用 Node 原生实现）'
      : `rsync：${rsync}`))
    items.push(item('ok', `平台：${platformLabel()}${IS_WIN ? '（Windows）' : ''}`))
    const node = findNode()
    items.push(node === null
      ? item('warn', '找不到 node（周报流水线需要；设 DSH_NODE 或装 node）')
      : item('ok', `node：${node}（${process.version}）`))
    const zstd = findZstd()
    items.push(zstd === null
      ? item('warn', '缺 zstd（周报采集要多帧解压）：macOS brew install zstd / Windows winget install Meta.Zstandard / 或设 DSH_ZSTD')
      : item('ok', `zstd：${zstd}`))
    sections.push(section('toolchain', '1/6 工具链', items))
  }

  // ---- 2. repository ------------------------------------------------------
  const repoFacts = { branch: '', headSha: '', dirty: 0, behind: 0, ahead: 0, remote: '', fetched: false }
  {
    const items = []
    if (!isDirectory(repo)) {
      items.push(item('error', `仓库不存在：${repo}`))
    } else if (!isDirectory(join(repo, '.git'))) {
      items.push(item('error', `不是 git 仓库：${repo}`))
    } else {
      items.push(item('ok', `仓库：${repo}`))
      const branch = await runGit(['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD'], { gitPath: gitPath ?? 'git', timeoutMs, signal })
      repoFacts.branch = branch.ok ? branch.stdout.trim() : '?'
      const head = await runGit(['-C', repo, 'rev-parse', '--short', 'HEAD'], { gitPath: gitPath ?? 'git', timeoutMs, signal })
      repoFacts.headSha = head.ok ? head.stdout.trim() : '?'
      const subject = await runGit(['-C', repo, 'log', '-1', '--format=%s'], { gitPath: gitPath ?? 'git', timeoutMs, signal })
      items.push(item('ok', `分支：${repoFacts.branch} @ ${repoFacts.headSha}`))
      if (subject.ok && subject.stdout.trim() !== '') items.push(item('info', `最新提交：${subject.stdout.trim()}`))

      const status = await runGit(['-C', repo, 'status', '--porcelain'], { gitPath: gitPath ?? 'git', timeoutMs, signal })
      repoFacts.dirty = status.ok ? status.stdout.split('\n').filter((line) => line.trim() !== '').length : 0
      items.push(repoFacts.dirty === 0
        ? item('ok', '工作区干净')
        : item('warn', `工作区有 ${repoFacts.dirty} 处未提交改动（→ 用 sync 推送）`))

      const remote = await runGit(['-C', repo, 'remote', 'get-url', 'origin'], { gitPath: gitPath ?? 'git', timeoutMs, signal })
      if (!remote.ok || remote.stdout.trim() === '') {
        items.push(item('error', '没有 remote origin（先 publish 或 git remote add）'))
      } else {
        repoFacts.remote = remote.stdout.trim()
        items.push(item('ok', `remote：${repoFacts.remote}`))
        if (offline) {
          items.push(item('ok', '（offline：跳过远端比对）'))
        } else {
          const fetchArgs = [
            '-c', 'http.version=HTTP/1.1',
            '-c', 'http.connectTimeout=20',
            '-c', 'http.lowSpeedLimit=1000',
            '-c', 'http.lowSpeedTime=15',
            'fetch', '--prune', '-q', 'origin',
          ]
          const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
          let fetched = await runGit(['-C', repo, ...fetchArgs], { gitPath: gitPath ?? 'git', timeoutMs: timeoutMs * 2, signal, env: gitEnv })
          if (!fetched.ok) {
            await sleep(1000)
            fetched = await runGit(['-C', repo, ...fetchArgs], { gitPath: gitPath ?? 'git', timeoutMs: timeoutMs * 2, signal, env: gitEnv })
          }
          if (fetched.ok) {
            repoFacts.fetched = true
            const upstream = `origin/${repoFacts.branch}`
            const counts = await runGit(['-C', repo, 'rev-list', '--left-right', '--count', `${upstream}...HEAD`], { gitPath: gitPath ?? 'git', timeoutMs, signal })
            if (counts.ok) {
              const [behind = '0', ahead = '0'] = counts.stdout.trim().split(/\s+/u)
              repoFacts.behind = Number.parseInt(behind, 10) || 0
              repoFacts.ahead = Number.parseInt(ahead, 10) || 0
              items.push(item('ok', `远端可达：落后 ${repoFacts.behind} / 领先 ${repoFacts.ahead}`))
              if (repoFacts.behind !== 0) items.push(item('warn', `远端有 ${repoFacts.behind} 个新提交（→ 用 update 拉取）`))
              if (repoFacts.ahead !== 0) items.push(item('warn', `本机有 ${repoFacts.ahead} 个提交未推送（→ 用 sync 推送）`))
            } else {
              items.push(item('warn', `远端还没有 ${upstream} 分支（首次推送用 publish）`))
            }
          } else {
            const firstLine = fetched.stderr.trim().split('\n')[0] ?? 'unknown error'
            items.push(item('warn', `连不上远端：${firstLine}`))
            items.push(item('warn', '  本机状态仍可同步（update/sync 会重试），只是无法比对远端'))
          }
        }
      }
    }
    sections.push(section('repository', '2/6 仓库', items))
  }

  // ---- 3. skills ----------------------------------------------------------
  {
    const items = []
    const repoSkills = countChildDirs(join(repo, 'skills'))
    const localSkillDirs = listChildDirNames(localSkills)
    if (repoSkills === localSkillDirs.length) {
      items.push(item('ok', `仓库 ${repoSkills} 个 / 本机 ${localSkillDirs.length} 个`))
    } else {
      items.push(item('warn', `技能数不一致：仓库 ${repoSkills} 个 / 本机 ${localSkillDirs.length} 个`))
    }
    const repoSkillNames = listChildDirNames(join(repo, 'skills'))
    const onlyLocal = localSkillDirs.filter((name) => !repoSkillNames.includes(name))
    const onlyRepo = repoSkillNames.filter((name) => !localSkillDirs.includes(name))
    items.push(onlyLocal.length === 0
      ? item('ok', '没有未入库的技能')
      : item('warn', `仅本机有（未入库）：${onlyLocal.join(' ')}`))
    items.push(onlyRepo.length === 0
      ? item('ok', '没有未拉取的技能')
      : item('warn', `仅仓库有（未拉取）：${onlyRepo.join(' ')}`))
    const missing = localSkillDirs.filter((name) => !isFile(join(localSkills, name, 'SKILL.md')))
    items.push(missing.length === 0
      ? item('ok', '本机技能目录都有 SKILL.md')
      : item('warn', `${missing.length} 个技能缺 SKILL.md（DSH 不会加载）：${missing.join(' ')}`))
    const repoAgentSkills = countChildDirs(join(repo, 'agents-skills'))
    const localAgents = countChildDirs(localAgentSkills)
    items.push(repoAgentSkills === localAgents
      ? item('ok', `跨 agent 技能：仓库 ${repoAgentSkills} / 本机 ${localAgents}`)
      : item('warn', `跨 agent 技能不一致：仓库 ${repoAgentSkills} / 本机 ${localAgents}`))
    sections.push(section('skills', '3/6 技能', items, {
      counts: { repo: repoSkills, local: localSkillDirs.length, agentsRepo: repoAgentSkills, agentsLocal: localAgents },
    }))
  }

  // ---- 4. secrets ---------------------------------------------------------
  {
    const items = []
    const secretsText = readTextFile(secretsPath)
    const secrets = secretsText === null ? [] : parseEnvFile(secretsText)
    if (secretsText === null) {
      items.push(item('warn', `没有 ${secretsPath}（新机需手工创建 secrets.env 并 chmod 600）`))
    } else {
      if (IS_WIN) {
        items.push(item('ok', 'secrets.env 存在（Windows 靠 NTFS ACL，不做 600 检查；别放共享目录）'))
      } else {
        const mode = fileModeOctal(secretsPath)
        items.push(mode === '600'
          ? item('ok', 'secrets.env 权限 600')
          : item('warn', `secrets.env 权限是 ${mode ?? '?'}（应 600：chmod 600 ~/.dsh/secrets.env）`))
      }
      const names = secrets.map((entry) => entry.key)
      items.push(names.length > 0
        ? item('ok', `已配置键名：${names.join(' ')}`)
        : item('warn', 'secrets.env 里没有有效键'))
    }
    // Beyond value matching: a credential-shaped key that holds a literal is a
    // leak even when its value matches none of the known provider prefixes.
    const literalKeys = []
    for (const file of [join(repo, 'profiles', profile, 'cordis.patch.yml'), join(repo, 'AGENTS.md')]) {
      const text = readTextFile(file)
      if (text === null) continue
      for (const line of text.split(/\r?\n/u)) {
        // Only credential-shaped names. `vaultSyncS3Key` or `cacheKey` are
        // identifiers, not secrets; API keys, tokens, passwords and
        // Authorization headers are.
        const match = line.match(/^\s*[-]?\s*((?:[A-Za-z0-9_]*?(?:api[_-]?key|access[_-]?key|token|secret|password|authorization|private[_-]?key)[A-Za-z0-9_]*))\s*:\s*(\S.*)$/iu)
        if (match === null) continue
        const value = match[2].trim().replace(/^["']|["']$/gu, '')
        if (value === '' || value.includes('__') || value.startsWith('${') || value === 'null' || value === '~') continue
        // A real credential is long and mixed; a bucket name or a path is not.
        if (value.length < 16 || !/[A-Za-z]/u.test(value) || !/[0-9]/u.test(value) || /\s/u.test(value)) continue
        literalKeys.push(`${match[1]} @ ${file.split('/').slice(-1)[0]}`)
      }
    }
    if (literalKeys.length > 0) {
      items.push(item('error', `凭据形状的键里是字面值：${literalKeys.slice(0, 5).join('，')}（改成 __KEY__ 占位符，值放 secrets.env）`))
    }

    const hits = scanForSecrets([join(repo, 'profiles'), join(repo, 'AGENTS.md'), join(repo, 'scripts')])
    if (hits.length === 0) {
      items.push(item('ok', '仓库无明文密钥（profiles/AGENTS.md/scripts）'))
    } else {
      items.push(item('error', `仓库发现明文密钥 ${hits.length} 处（先轮换再清理历史）`))
      for (const hit of hits.slice(0, 5)) {
        items.push(item('error', `  ${hit.file}:${hit.line} 命中 ${hit.match.slice(0, 12)}…`))
      }
    }
    sections.push(section('secrets', '4/6 密钥', items, {
      keyNames: secrets.map((entry) => entry.key),
      plaintextHits: hits.length,
    }))
  }

  // ---- 5. profile ---------------------------------------------------------
  {
    const items = []
    for (const name of ['package.json', 'cordis.patch.yml']) {
      items.push(isFile(join(repoProfile, name))
        ? item('ok', name)
        : item('warn', `仓库缺 profiles/${profile}/${name}`))
    }

    const liveText = readTextFile(livePatch)
    const repoText = readTextFile(repoPatch)
    if (liveText === null) {
      items.push(item('warn', `本机还没有 profiles/${profile}/cordis.patch.yml（新机需 apply）`))
    } else {
      items.push(item('ok', '本机 profile 已存在'))
      const left = findPlaceholders(liveText)
      if (left.length > 0) {
        items.push(item('error', `本机 live 配置残留占位符：${left.join(' ')}`))
        items.push(item('error', '  → 对应功能必然返回 invalid_api_key（把值写进 secrets.env 后重跑 apply）'))
      } else {
        items.push(item('ok', '本机 live 配置无占位符（密钥已注入）'))
      }
    }
    if (repoText !== null && findPlaceholders(repoText).length > 0) {
      items.push(item('ok', '配置里是占位符（真实值只在 secrets.env）'))
    }

    const apiKeyNames = findApiKeyEnvNames(repoText ?? '')
    for (const name of apiKeyNames) {
      const present = (process.env[name] ?? '') !== ''
      items.push(present
        ? item('ok', `供应商环境变量 ${name} 已设置`)
        : item('info', `供应商环境变量 ${name} 未设置（配置用 apiKeyEnv 读进程环境；不用该模型可忽略）`))
    }

    let settingsDrift = null
    if (liveText !== null && repoText !== null) {
      const redactedLive = redactText(liveText, parseEnvFile(readTextFile(secretsPath) ?? ''))
      const changes = countLineChanges(filterReasoningEffort(repoText), filterReasoningEffort(redactedLive))
      settingsDrift = changes
      items.push(changes === 0
        ? item('ok', 'cordis.patch.yml 与仓库一致（reasoningEffort 按本机保留，不参与比较）')
        : item('warn', `cordis.patch.yml 与仓库差 ${changes} 行（本机改了设置：要推用 sync / 要拉用 update；reasoningEffort 不计）`))
    }

    const liveManifestText = readTextFile(liveManifest)
    const repoManifestText = readTextFile(repoManifest)
    if (liveManifestText !== null && repoManifestText !== null) {
      const same = liveManifestText.replace(/\s+$/u, '') === repoManifestText.replace(/\s+$/u, '')
      items.push(same
        ? item('ok', 'package.json（插件清单）与仓库一致')
        : item('warn', 'package.json（插件清单）与仓库不同（装/卸了插件：sync 推送 / update 拉取）'))
      try {
        const parsed = JSON.parse(liveManifestText)
        const dependencies = Object.keys(parsed.dependencies ?? {})
        const missing = dependencies.filter((name) => !isFile(join(profileDir, 'node_modules', name, 'package.json')))
        items.push(missing.length === 0
          ? item('ok', '插件依赖齐全（node_modules 里都在）')
          : item('error', `插件未安装：${missing.join(' ')}（跑 apply；缺 dsh 时它会返回退出码 3）`))
      } catch {
        items.push(item('error', '本机 package.json 不是合法 JSON'))
      }
    }

    const dshCli = findDshCli()
    let runtimeVersion = ''
    if (dshCli === null) {
      items.push(item('warn', '找不到 dsh CLI（插件安装会返回退出码 3；可设 DSH_CLI=/path/to/dsh）'))
    } else {
      const version = await runCommand(dshCli, ['--version'], { timeoutMs, signal })
      runtimeVersion = version.ok ? (version.stdout.trim().split('\n')[0] ?? '').trim() : ''
      items.push(item('ok', `dsh CLI：${dshCli}（${runtimeVersion === '' ? '版本未知' : runtimeVersion}）`))
      if (runtimeVersion !== '' && isDirectory(join(profileDir, 'node_modules'))) {
        const base = join(profileDir, 'node_modules', '@deepseek-ai')
        const mismatched = []
        for (const name of listFilesByName(base).map((entry) => entry.name)) {
          if (!name.startsWith('dsh-')) continue
          const manifest = JSON.parse(readTextFile(join(base, name, 'package.json')) ?? '{}')
          if (manifest.version !== undefined && manifest.version !== runtimeVersion) mismatched.push(`${name}@${manifest.version}`)
        }
        items.push(mismatched.length === 0
          ? item('ok', `@deepseek-ai/dsh-* 插件与运行时版本一致（${runtimeVersion}）`)
          : item('warn', `插件与运行时 ${runtimeVersion} 版本不一致：${mismatched.join(' ')}`))
      }
    }

    sections.push(section('profile', `5/6 profile（${profile}）`, items, {
      settingsDrift,
      runtimeVersion,
    }))
  }

  // ---- 6. weekly ----------------------------------------------------------
  {
    const items = []
    const weeklyRepo = join(repo, 'weekly')
    const weeklyLocal = join(dshHome, 'learning', 'scripts')
    if (!isDirectory(weeklyRepo)) {
      items.push(item('warn', '仓库缺 weekly/ 目录'))
    } else {
      const drift = []
      for (const { name, path } of listFilesByName(weeklyRepo)) {
        const target = join(weeklyLocal, name)
        if (!isFile(target)) drift.push(`未部署：${name}`)
        else if (!sameFileContent(path, target)) drift.push(`版本不一致：${name}`)
      }
      items.push(drift.length === 0
        ? item('ok', 'learning/scripts 与仓库 weekly/ 一致')
        : item('warn', `${drift.length} 个周报脚本与仓库不一致（跑 update / apply 部署）：${drift.join('，')}`))
    }

    let schedulerInstalled = false
    let schedulerNote = ''
    if (IS_WIN) {
      const query = await runCommand('schtasks', ['/Query', '/TN', windowsTask], { timeoutMs, signal })
      schedulerInstalled = query.ok
      schedulerNote = `Windows 任务计划程序 ${windowsTask}`
    } else if (process.platform === 'darwin') {
      const list = await runCommand('launchctl', ['list'], { timeoutMs, signal })
      // The label belongs to the machine, not to this plugin: it comes from
      // DSH_WEEKLY_LAUNCHD_LABEL, so no personal reverse domain is baked in.
      const label = resolveSchedulerLabel('')
      if (label !== '') {
        schedulerInstalled = list.ok && list.stdout.includes(label)
        schedulerNote = `launchd ${label}`
      } else {
        // No configured label: accept any installed job whose name ends with the
        // feature suffix. That keeps the check useful without baking one
        // person's reverse domain into the source.
        const suffix = /\.dsh\.weekly-retro\s*$/mu
        schedulerInstalled = list.ok && suffix.test(list.stdout)
        schedulerNote = 'launchd *.dsh.weekly-retro（未配置具体标签）'
      }
    } else {
      const cron = await runCommand('crontab', ['-l'], { timeoutMs, signal })
      schedulerInstalled = cron.ok && cron.stdout.includes('run-weekly.sh')
      schedulerNote = 'crontab run-weekly.sh'
    }
    items.push(schedulerInstalled
      ? item('ok', `定时任务已安装（${schedulerNote}）`)
      : item('warn', `周报定时任务未安装（${schedulerNote}；用 schedule 安装，未装则只能手动跑）`))

    const scheduleEnv = readTextFile(join(dshHome, 'learning', 'schedule.env'))
    items.push(scheduleEnv === null
      ? item('info', '没有 schedule.env（默认 7 天；安装定时任务时会写）')
      : item('ok', `采集窗口：${scheduleEnv.replace(/\r?\n/gu, ' ').trim()}`))

    sections.push(section('weekly', '6/6 周报', items, { schedulerInstalled }))
  }

  const fail = sections.reduce((sum, entry) => sum + entry.items.filter((line) => line.level === 'error').length, 0)
  const warn = sections.reduce((sum, entry) => sum + entry.items.filter((line) => line.level === 'warn').length, 0)
  const exitCode = fail > 0 ? 1 : warn > 0 ? 2 : 0

  return {
    ok: fail === 0,
    exitCode,
    fail,
    warn,
    repoPath: repo,
    dshHome,
    profile,
    platform: platformLabel(),
    repoFacts,
    sections,
  }
}

/** Convenience: the default repo path used when the caller supplies none. */
export const DEFAULT_REPO = join(homedir(), 'dsh-config')
