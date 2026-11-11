/**
 * `/syn-dsh` — the user-facing slash command.
 *
 * A slash command runs against the agent directly: no model message is
 * created, so it costs nothing and cannot be "misread" by the model. The
 * command is deliberately thin — it calls the same core functions the model
 * tools use, which keeps the two surfaces from drifting.
 *
 * Safety rule for the command: `push` and `pull` default to their dry-run
 * plan. A real mutation needs the word `now`. That is the reverse of the tool
 * default only in wording, not in behaviour: both require an explicit human
 * decision before anything leaves this machine.
 *
 * @module dsh-syn-config/core/commands
 */

import { runDoctor } from './doctor.js'
import { pullRepo } from './pull.js'
import { pushRepo } from './push.js'
import { runSecretsAction } from './secrets-ops.js'
import { readRepoStatus } from './status.js'

/** Status icons: the command output is Markdown, so the scan is visual. */
const ICON = { ok: '✅', warn: '⚠️', error: '❌', skip: '➖' }

/** Escape a cell so a path or a message cannot break the table. */
function cell(value) {
  return String(value ?? '').replace(/\|/gu, '\\|').replace(/\r?\n/gu, ' ').trim()
}

/**
 * Status as a two-column table.
 *
 * A slash command's output is Markdown, and a table reads faster than a line
 * with five separators in it — the card and the command then agree at a glance.
 */
function formatStatus(status) {
  if (!status.repoPresent) return `**${cell(status.repoPath)}**: no repository found`
  if (!status.ok) {
    return `**${cell(status.repoPath)}**\n\n| 项 | 值 |\n| --- | --- |\n| 状态 | ${ICON.error} 无法读取 |\n| 原因 | ${cell(status.notes[0] ?? 'unknown')} |`
  }
  const tracking = status.upstream === '' ? 'no upstream' : cell(status.upstream)
  return [
    '| 项 | 值 |',
    '| --- | --- |',
    `| 仓库 | \`${cell(status.repoPath)}\` |`,
    `| 分支 | ${cell(status.branch) || '(detached)'} |`,
    `| 上游 | ${tracking} |`,
    `| 领先 / 落后 | ${status.ahead} / ${status.behind} |`,
    `| 工作树 | ${status.dirty === 0 ? `${ICON.ok} clean worktree` : `${ICON.warn} ${status.dirty} changed file(s)`} |`,
  ].join('\n')
}

/**
 * Doctor as a table: one row per section, the worst finding in the last column.
 *
 * The blocking line stays above the table because it is the number that decides
 * whether anything else is worth reading.
 */
function formatDoctor(result) {
  const head = result.fail === 0
    ? `${ICON.ok} health: 0 blocking / ${result.warn} warnings · exit ${result.exitCode}`
    : `${ICON.error} health: ${result.fail} blocking / ${result.warn} warnings · exit ${result.exitCode}`
  const rows = result.sections.map((section, index) => {
    const finding = section.items.find((entry) => entry.level === 'error')
      ?? section.items.find((entry) => entry.level === 'warn')
    const icon = ICON[section.status] ?? section.status
    return `| ${index + 1} | ${cell(section.title)} | ${icon} ${cell(section.status)} | ${cell(finding?.text ?? '')} |`
  })
  return [
    head,
    '',
    '| # | 检查 | 状态 | 最差一处 |',
    '| --- | --- | --- | --- |',
    ...rows,
  ].join('\n')
}

/** A dry-run plan as a table, so "what would change" is scannable. */
function formatPlan(action, result) {
  if (action === 'pull') {
    const mirrors = result.mirrors.map((mirror) => `${cell(mirror.name)} +${mirror.planned.added.length} ~${mirror.planned.updated.length} -${mirror.planned.deleted.length}`).join('<br>')
    const rows = [
      ['远端提交', `${result.incomingCommits}`],
      ['before → after', `${cell(result.before).slice(0, 7)} → ${cell(result.after).slice(0, 7)}`],
      ['镜像变更', mirrors || '(none)'],
    ]
    if (result.warnings.length > 0) rows.push(['注意', result.warnings.map(cell).join('<br>')])
    return ['| 项 | 值 |', '| --- | --- |', ...rows.map(([key, value]) => `| ${key} | ${value} |`)].join('\n')
  }
  const rows = [
    ['变更', `+${result.changes.added.length} ~${result.changes.updated.length} -${result.changes.deleted.length}`],
    ['技能数', `${result.manifest.skills}`],
    ['门禁', `lint ${result.gates.lint.ok ? ICON.ok : ICON.error} · redact ${result.gates.redact.changed.length} · scan ${result.gates.scan.ok ? ICON.ok : ICON.error}`],
    ['提交', result.commit.created ? `created ${cell(result.commit.sha)}` : result.commit.unchanged ? '无变更可提交' : 'dry run：未写入'],
  ]
  if (result.warnings.length > 0) rows.push(['注意', result.warnings.slice(0, 5).map(cell).join('<br>')])
  return ['| 项 | 值 |', '| --- | --- |', ...rows.map(([key, value]) => `| ${key} | ${value} |`)].join('\n')
}

/**
 * Register the command.
 *
 * @param {{ commands: { register(definition: object): unknown } }} ctx
 * @param {{ repoPath: string, profile: string, dshHome?: string, gitTimeoutMs: number }} settings
 */
export function registerCommands(ctx, settings) {
  if (ctx.commands === undefined || typeof ctx.commands.register !== 'function') return

  ctx.commands.register({
    // A stable, plugin-namespaced identity: optional for the registry, but it
    // lets a UI pair the definition with its executions across reloads.
    definitionId: 'dsh-syn-config/syn-dsh',
    name: 'syn-dsh',
    description: '同步 DSH 配置：status / doctor / pull / push / secrets（写操作默认 dry-run，加 now 才执行）',
    input: { hint: 'status | doctor [online] | pull [now] | push [now] | secrets scan|fingerprint' },
    async handler({ rawInput }) {
      const tokens = String(rawInput ?? '').trim().split(/\s+/u).filter((token) => token !== '')
      const subcommand = (tokens[0] ?? 'status').toLowerCase()
      const flag = (tokens[1] ?? '').toLowerCase()
      const repoPath = typeof settings.repoPath === 'string' ? settings.repoPath : ''
      try {
        if (subcommand === 'status') {
          const status = await readRepoStatus({ repoPath, timeoutMs: settings.gitTimeoutMs })
          return { kind: status.ok || status.repoPresent ? 'success' : 'error', text: formatStatus(status) }
        }

        if (subcommand === 'doctor' || subcommand === 'check') {
          const result = await runDoctor({
            repoPath,
            dshHome: settings.dshHome,
            profile: settings.profile,
            offline: flag !== 'online',
            timeoutMs: settings.gitTimeoutMs,
          })
          return { kind: result.exitCode === 1 ? 'error' : 'success', text: formatDoctor(result) }
        }

        if (subcommand === 'pull') {
          const real = flag === 'now'
          const result = await pullRepo({
            repoPath,
            dshHome: settings.dshHome,
            dryRun: !real,
            timeoutMs: settings.gitTimeoutMs,
          })
          const table = formatPlan('pull', result)
          const head = real
            ? `**${result.pulled ? 'pulled' : 'already up to date'}** ${result.before.slice(0, 7)} → ${result.after.slice(0, 7)}`
            : `**dry run** — ${result.incomingCommits} incoming commit(s)`
          return { kind: result.ok ? 'success' : 'error', text: `${head}\n\n${table}${real ? '' : '\n\n要执行就加 `now`：`/syn-dsh pull now`'}` }
        }

        if (subcommand === 'push') {
          const real = flag === 'now'
          const result = await pushRepo({
            repoPath,
            dshHome: settings.dshHome,
            profile: settings.profile,
            dryRun: !real,
            timeoutMs: settings.gitTimeoutMs,
          })
          const table = formatPlan('push', result)
          const head = real
            ? `**${result.commit.created ? `committed ${result.commit.sha}` : 'nothing to commit'}**${result.commit.pushed ? ' · pushed' : ''}`
            : '**dry run** — nothing written'
          return {
            kind: result.ok ? 'success' : 'error',
            text: `${head}\n\n${table}${real ? '' : '\n\n要执行就加 `now`：`/syn-dsh push now`'}`,
          }
        }

        if (subcommand === 'secrets') {
          const action = (tokens[1] ?? 'scan').toLowerCase()
          const readOnly = action === 'scan' || action === 'fingerprint'
          const result = await runSecretsAction({
            action,
            repoPath,
            dshHome: settings.dshHome,
            profile: settings.profile,
            dryRun: true,
          })
          const detail = readOnly
            ? (action === 'scan'
              ? `${result.hits.length} plaintext hit(s)`
              : result.fingerprints.map((entry) => `${entry.key} sha256:${entry.sha256} len=${entry.length}`).join('\n'))
            : `would change: ${result.changed.join(', ') || '(nothing)'}`
          return { kind: result.ok ? 'success' : 'error', text: `${action}: ${result.ok ? 'ok' : 'FAILED'}\n${detail}` }
        }

        return { kind: 'error', text: `unknown subcommand "${subcommand}" — use status | doctor | pull | push | secrets` }
      } catch (error) {
        return { kind: 'error', text: `syn-dsh ${subcommand} failed: ${String(error?.message ?? error)}` }
      }
    },
  })
}

/** Re-exported for callers that only need the formatter. */
export { formatDoctor, formatPlan, formatStatus }
