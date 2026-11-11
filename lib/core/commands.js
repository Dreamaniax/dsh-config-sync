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

/** One-line status summary. */
function formatStatus(status) {
  if (!status.repoPresent) return `${status.repoPath}: no repository found`
  if (!status.ok) return `${status.repoPath}: ${status.notes[0] ?? 'cannot read status'}`
  const tracking = status.upstream === '' ? 'no upstream' : `${status.ahead} ahead / ${status.behind} behind ${status.upstream}`
  const tree = status.dirty === 0 ? 'clean worktree' : `${status.dirty} changed file(s)`
  return `${status.branch || '(detached)'} · ${tracking} · ${tree}`
}

/** Doctor summary: one line per section, only the worst finding. */
function formatDoctor(result) {
  const lines = [`health: ${result.fail} blocking / ${result.warn} warnings · exit ${result.exitCode}`]
  for (const section of result.sections) {
    const finding = section.items.find((entry) => entry.level === 'error')
      ?? section.items.find((entry) => entry.level === 'warn')
    lines.push(`${section.status.toUpperCase().padEnd(5)} ${section.title}${finding === undefined ? '' : ` — ${finding.text.trim()}`}`)
  }
  return lines.join('\n')
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
          const mirrors = result.mirrors
            .map((mirror) => `${mirror.name} +${mirror.planned.added.length} ~${mirror.planned.updated.length} -${mirror.planned.deleted.length}`)
            .join(' · ')
          const head = real
            ? `${result.pulled ? 'pulled' : 'already up to date'} ${result.before.slice(0, 7)} → ${result.after.slice(0, 7)}`
            : `dry run: ${result.incomingCommits} incoming commit(s)`
          const warnings = result.warnings.length === 0 ? '' : `\n${result.warnings.join('\n')}`
          return { kind: result.ok ? 'success' : 'error', text: `${head}\n${mirrors}${warnings}` }
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
          const gates = `lint ${result.gates.lint.ok ? 'ok' : 'FAIL'} · redact ${result.gates.redact.changed.length} · scan ${result.gates.scan.ok ? 'ok' : 'FAIL'}`
          const summary = result.commit.created
            ? `commit ${result.commit.sha}${result.commit.pushed ? ' pushed' : ' NOT pushed'}`
            : result.commit.unchanged ? 'no changes to commit' : (real ? 'not committed' : 'dry run: nothing written')
          const warnings = result.warnings.length === 0 ? '' : `\n${result.warnings.slice(0, 5).join('\n')}`
          return {
            kind: result.ok ? 'success' : 'error',
            text: `changes +${result.changes.added.length} ~${result.changes.updated.length} -${result.changes.deleted.length} · skills ${result.manifest.skills}\n${gates}\n${summary}${warnings}`,
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
export { formatDoctor, formatStatus }
