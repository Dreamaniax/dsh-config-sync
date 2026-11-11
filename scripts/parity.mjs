#!/usr/bin/env node
/**
 * Parity check: run the shell doctor and the plugin's doctor on the same
 * machine state and compare the facts both are supposed to report.
 *
 * This is the acceptance harness for P1 — "same state, same findings". It
 * compares exit codes plus the individual findings, not prose: each row maps a
 * line the shell script prints to a field of the structured result.
 *
 * Usage:
 *   node scripts/parity.mjs [--repo <path>] [--offline]
 *
 * Exit code 0 when every comparable row matches, 1 otherwise.
 */

import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'

import { runDoctor } from '../lib/core/doctor.js'
import { DEFAULT_REPO_PATH } from '../lib/index.js'

const argv = process.argv.slice(2)
let repoPath = DEFAULT_REPO_PATH
let offline = false
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === '--repo') {
    repoPath = resolve(argv[index + 1] ?? '')
    index += 1
  } else if (argv[index] === '--offline') offline = true
}

const script = join(repoPath, 'scripts', 'doctor.sh')

/** Run the shell doctor and return its text plus exit code. */
function runShellDoctor() {
  try {
    const stdout = execFileSync('bash', [script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { text: stdout, exitCode: 0, ok: true }
  } catch (error) {
    return {
      text: `${error.stdout ?? ''}${error.stderr ?? ''}`,
      exitCode: typeof error.status === 'number' ? error.status : 1,
      ok: false,
    }
  }
}

const shell = runShellDoctor()
const result = await runDoctor({ repoPath, offline })

const sections = Object.fromEntries(result.sections.map((section) => [section.id, section]))
const texts = (id) => sections[id].items.map((entry) => entry.text).join('\n')
const has = (id, fragment) => texts(id).includes(fragment)

const skillsCounts = sections.skills.counts ?? {}
const rows = [
  {
    name: 'exit code',
    shell: `exit ${shell.exitCode}`,
    plugin: `exit ${result.exitCode}`,
    match: shell.exitCode === result.exitCode,
  },
  {
    name: '工作区干净',
    shell: shell.text.includes('工作区干净'),
    plugin: result.repoFacts.dirty === 0,
    match: shell.text.includes('工作区干净') === (result.repoFacts.dirty === 0),
  },
  {
    name: '技能数一致',
    shell: shell.text.includes('仓库') && /仓库 (\d+) 个 \/ 本机 (\d+) 个/u.test(shell.text),
    plugin: skillsCounts.repo === skillsCounts.local,
    match: (() => {
      const match = shell.text.match(/仓库 (\d+) 个 \/ 本机 (\d+) 个/u)
      if (match === null) return false
      return Number(match[1]) === skillsCounts.repo && Number(match[2]) === skillsCounts.local
    })(),
  },
  {
    name: '无未入库技能',
    shell: shell.text.includes('没有未入库的技能'),
    plugin: has('skills', '没有未入库的技能'),
    match: shell.text.includes('没有未入库的技能') === has('skills', '没有未入库的技能'),
  },
  {
    name: '无未拉取技能',
    shell: shell.text.includes('没有未拉取的技能'),
    plugin: has('skills', '没有未拉取的技能'),
    match: shell.text.includes('没有未拉取的技能') === has('skills', '没有未拉取的技能'),
  },
  {
    name: '技能都有 SKILL.md',
    shell: shell.text.includes('本机技能目录都有 SKILL.md'),
    plugin: has('skills', '本机技能目录都有 SKILL.md'),
    match: shell.text.includes('本机技能目录都有 SKILL.md') === has('skills', '本机技能目录都有 SKILL.md'),
  },
  {
    name: '仓库无明文密钥',
    shell: shell.text.includes('仓库无明文密钥'),
    plugin: has('secrets', '仓库无明文密钥'),
    match: shell.text.includes('仓库无明文密钥') === has('secrets', '仓库无明文密钥'),
  },
  {
    name: 'secrets.env 权限 600',
    shell: shell.text.includes('secrets.env 权限 600'),
    plugin: has('secrets', 'secrets.env 权限 600'),
    match: shell.text.includes('secrets.env 权限 600') === has('secrets', 'secrets.env 权限 600'),
  },
  {
    name: '设置与仓库一致',
    shell: shell.text.includes('cordis.patch.yml 与仓库一致'),
    plugin: sections.profile.settingsDrift === 0,
    match: shell.text.includes('cordis.patch.yml 与仓库一致') === (sections.profile.settingsDrift === 0),
  },
  {
    name: '插件清单一致',
    shell: shell.text.includes('package.json（插件清单）与仓库一致'),
    plugin: has('profile', 'package.json（插件清单）与仓库一致'),
    match: shell.text.includes('package.json（插件清单）与仓库一致') === has('profile', 'package.json（插件清单）与仓库一致'),
  },
  {
    name: '插件依赖齐全',
    shell: shell.text.includes('插件依赖齐全'),
    plugin: has('profile', '插件依赖齐全'),
    match: shell.text.includes('插件依赖齐全') === has('profile', '插件依赖齐全'),
  },
  {
    name: '周报脚本一致',
    shell: shell.text.includes('learning/scripts 与仓库 weekly/ 一致'),
    plugin: has('weekly', 'learning/scripts 与仓库 weekly/ 一致'),
    match: shell.text.includes('learning/scripts 与仓库 weekly/ 一致') === has('weekly', 'learning/scripts 与仓库 weekly/ 一致'),
  },
  {
    name: '定时任务状态',
    shell: shell.text.includes('定时任务已安装'),
    plugin: has('weekly', '定时任务已安装'),
    match: shell.text.includes('定时任务已安装') === has('weekly', '定时任务已安装'),
  },
]

let failed = 0
console.log('| 比对项 | shell doctor | plugin doctor | 一致 |')
console.log('| --- | --- | --- | --- |')
for (const row of rows) {
  if (!row.match) failed += 1
  console.log(`| ${row.name} | ${row.shell} | ${row.plugin} | ${row.match ? 'yes' : 'NO'} |`)
}
console.log('')
console.log(`compared ${rows.length} rows, ${rows.length - failed} matched, ${failed} mismatched`)
if (!offline) console.log(`shell doctor: exit ${shell.exitCode} · plugin doctor: exit ${result.exitCode}`)

if (failed > 0) {
  console.error('[parity] FAILED — the two doctors disagree; inspect the rows marked NO.')
  process.exit(1)
}
console.log('[parity] OK — plugin doctor reports the same facts as scripts/doctor.sh.')
