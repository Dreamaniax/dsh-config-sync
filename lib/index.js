/**
 * dsh-syn-config — host half.
 *
 * P0 slice: one read-only model tool, `dsh_sync_status`, that reports the
 * state of the private `dsh-config` checkout the user syncs skills, profile
 * settings and AGENTS.md with. No writes, no network unless asked.
 *
 * Why this file imports nothing from `@deepseek-ai/*`: a host plugin receives
 * every service through `ctx`, and a `link:`-installed package resolves bare
 * imports from its own checkout, not from the host's bundled tree — so an
 * import-free host half loads identically from a checkout, a pnpm install or a
 * copied directory, on macOS and Windows alike, and the tests run under plain
 * Node. The tool definition below is therefore the compiled JSON-Schema form
 * the registry itself validates (`ctx.tools.register` checks
 * `output.render` and `output.schema`, and rejects a `required: true`
 * property — that shorthand belongs to the authoring DSL, not the wire shape).
 *
 * @module dsh-syn-config
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { registerCommands } from './core/commands.js'
import { readDiagnostics, recordService, recordStep, recordTool, resetDiagnostics } from './core/diagnostics.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Own version, read from the installed package rather than the row config. */
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
})()
import { runDoctor } from './core/doctor.js'
import { registerStatusRoute } from './core/http.js'
import { registerSkill } from './core/skill.js'
import { pullRepo } from './core/pull.js'
import { pushRepo } from './core/push.js'
import { runSecretsAction } from './core/secrets-ops.js'
import { readRepoStatus } from './core/status.js'

/** Plugin row name used by cordis.patch.yml and the profile manifest. */
const name = 'dsh-syn-config'

/**
 * Only `tools` is required: every profile that can call a model tool has it.
 *
 * Everything else is resolved through `ctx.get()`. Reading `ctx.commands` (or
 * any other service) directly without declaring it throws
 * `cannot get property "…" without inject` — and a throw inside `apply` fails
 * the plugin's fiber, which is exactly how a plugin that works under plain
 * Node can still fail to load inside the host.
 */
const inject = ['tools']

/**
 * Look a service up without tripping Cordis's "without inject" guard.
 *
 * @template T
 * @param {object} ctx
 * @param {string} name
 * @returns {T | undefined}
 */
function serviceOf(ctx, name) {
  // 1. the context's own resolution (only sees declared/injected services)
  try {
    if (typeof ctx.get === 'function') {
      const found = ctx.get(name)
      if (found !== undefined && found !== null) return found
    }
  } catch {
    // fall through
  }
  // 2. the root context: bundles mounted above this plugin (the desktop host
  //    mounts the HTTP server there) are visible from the root.
  try {
    const root = ctx.root
    if (root !== undefined && root !== null) {
      if (typeof root.get === 'function') {
        const found = root.get(name)
        if (found !== undefined && found !== null) return found
      }
      const direct = root[name]
      if (direct !== undefined && direct !== null) return direct
    }
  } catch {
    // not provided anywhere this plugin can see
  }
  return undefined
}

/** Run one registration step; a missing or hostile service must not fail the plugin. */
function tryRegister(label, ctx, action) {
  try {
    action()
    recordStep(label, true)
    return true
  } catch (error) {
    const detail = String(error?.message ?? error)
    recordStep(label, false, detail)
    try {
      ctx.logger?.warn?.(`dsh-syn-config: ${label} unavailable — ${detail}`)
    } catch {
      // a host without a reachable logger must not turn this into a failure
    }
    return false
  }
}

/** Default checkout location, identical on macOS and Windows (`~` resolves per user). */
export const DEFAULT_REPO_PATH = join(homedir(), 'dsh-config')

/** Default per-call git budget; a fetch gets four times this. */
export const DEFAULT_TIMEOUT_MS = 15_000

/** Raw JSON Schema of the tool result, kept next to the renderer that uses it. */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    repoPath: { type: 'string' },
    repoPresent: { type: 'boolean' },
    branch: { type: 'string' },
    upstream: { type: 'string' },
    ahead: { type: 'integer' },
    behind: { type: 'integer' },
    dirty: { type: 'integer' },
    dirtyFiles: { type: 'array', items: { type: 'string' } },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['ok', 'repoPath', 'repoPresent', 'branch', 'upstream', 'ahead', 'behind', 'dirty', 'dirtyFiles', 'notes'],
}

const PARAMETERS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    repo: {
      type: 'string',
      description: 'Absolute path or ~/... path to the checkout. Defaults to the configured repoPath (~/dsh-config).',
    },
    fetch: {
      type: 'boolean',
      description: 'Run `git fetch --prune` first so ahead/behind reflect the remote. Defaults to the plugin setting (off).',
    },
  },
}

/**
 * Normalise whatever the profile row (or a caller) supplied into settings.
 *
 * The row's `config` block is not schema-validated in P0 (no Config export),
 * so every field is checked here rather than trusted.
 *
 * @param {{ repoPath?: unknown, gitTimeoutMs?: unknown, fetchOnStatus?: unknown }} [config]
 * @returns {{ repoPath: string, gitTimeoutMs: number, fetchOnStatus: boolean }}
 */
export function resolveSettings(config = {}) {
  const repoPath = typeof config.repoPath === 'string' && config.repoPath.trim() !== ''
    ? config.repoPath.trim()
    : DEFAULT_REPO_PATH
  const gitTimeoutMs = Number.isFinite(config.gitTimeoutMs) && config.gitTimeoutMs > 0
    ? config.gitTimeoutMs
    : DEFAULT_TIMEOUT_MS
  const profile = typeof config.profile === 'string' && config.profile.trim() !== ''
    ? config.profile.trim()
    : (process.env.DSH_PROFILE ?? 'desktop')
  const dshHome = typeof config.dshHome === 'string' && config.dshHome.trim() !== ''
    ? config.dshHome.trim()
    : undefined
  return { repoPath, gitTimeoutMs, fetchOnStatus: config.fetchOnStatus === true, profile, dshHome }
}

/** Result shape of the health-check tool. */
const DOCTOR_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    exitCode: { type: 'integer' },
    fail: { type: 'integer' },
    warn: { type: 'integer' },
    repoPath: { type: 'string' },
    dshHome: { type: 'string' },
    profile: { type: 'string' },
    platform: { type: 'string' },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          status: { type: 'string', enum: ['ok', 'warn', 'error'] },
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                level: { type: 'string', enum: ['ok', 'warn', 'error', 'info'] },
                text: { type: 'string' },
              },
              required: ['level', 'text'],
            },
          },
        },
        required: ['id', 'title', 'status', 'items'],
      },
    },
  },
  required: ['ok', 'exitCode', 'fail', 'warn', 'repoPath', 'dshHome', 'profile', 'platform', 'sections'],
}

const DOCTOR_PARAMETERS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    repo: {
      type: 'string',
      description: 'Absolute or ~/... path to the dsh-config checkout. Defaults to the configured repoPath.',
    },
    offline: { type: 'boolean', description: 'Skip the git fetch and the remote comparison.' },
    profile: { type: 'string', description: 'DSH profile name to check (default: desktop).' },
    fetch: { type: 'boolean', description: 'Deprecated alias kept for symmetry; ignored here — use offline.' },
  },
}

/** Result shape of the pull tool. */
const PULL_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    dryRun: { type: 'boolean' },
    repoPath: { type: 'string' },
    before: { type: 'string' },
    after: { type: 'string' },
    incomingCommits: { type: 'integer' },
    incomingSubjects: { type: 'array', items: { type: 'string' } },
    pulled: { type: 'boolean' },
    changedSkills: { type: 'array', items: { type: 'string' } },
    mirrors: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          src: { type: 'string' },
          dst: { type: 'string' },
          added: { type: 'array', items: { type: 'string' } },
          updated: { type: 'array', items: { type: 'string' } },
          deleted: { type: 'array', items: { type: 'string' } },
          applied: { type: 'boolean' },
          unchanged: { type: 'integer' },
        },
        required: ['name', 'src', 'dst', 'added', 'updated', 'deleted', 'applied', 'unchanged'],
      },
    },
    warnings: { type: 'array', items: { type: 'string' } },
    exitCode: { type: 'integer' },
  },
  required: ['ok', 'dryRun', 'repoPath', 'before', 'after', 'incomingCommits', 'incomingSubjects', 'pulled', 'changedSkills', 'mirrors', 'warnings', 'exitCode'],
}

const PULL_PARAMETERS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    repo: { type: 'string', description: 'Absolute or ~/... path to the dsh-config checkout. Defaults to the configured repoPath.' },
    dry_run: { type: 'boolean', description: 'Default true. Report what would be pulled and mirrored without writing anything.' },
    delete_local: { type: 'boolean', description: 'Also delete local skills that no longer exist in the repository. Off by default: a local-only skill is usually work in progress.' },
  },
}

/** Result shape of the secrets tool. */
const SECRETS_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    action: { type: 'string' },
    dryRun: { type: 'boolean' },
    target: { type: 'string' },
    changed: { type: 'array', items: { type: 'string' } },
    leftover: { type: 'array', items: { type: 'string' } },
    hits: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { file: { type: 'string' }, line: { type: 'integer' } },
        required: ['file', 'line'],
      },
    },
    historyHits: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          commit: { type: 'string' },
          pattern: { type: 'integer' },
          preview: { type: 'string' },
        },
        required: ['commit', 'pattern', 'preview'],
      },
    },
    fingerprints: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { key: { type: 'string' }, sha256: { type: 'string' }, length: { type: 'integer' } },
        required: ['key', 'sha256', 'length'],
      },
    },
    notes: { type: 'array', items: { type: 'string' } },
    exitCode: { type: 'integer' },
  },
  required: ['ok', 'action', 'dryRun', 'target', 'changed', 'leftover', 'hits', 'historyHits', 'fingerprints', 'notes', 'exitCode'],
}

const SECRETS_PARAMETERS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['scan', 'redact', 'inject', 'refresh', 'fingerprint'],
      description: 'scan: look for plaintext secrets in the repository. redact: repository copy, real value → __KEY__. inject: deployed copy, __KEY__ → real value. refresh: rotate the bearer value in the deployed copy. fingerprint: sha256 prefix + length only.',
    },
    dry_run: { type: 'boolean', description: 'Default true. Never write unless this is false.' },
    repo: { type: 'string', description: 'Absolute or ~/... path to the checkout. Defaults to the configured repoPath.' },
    profile: { type: 'string', description: 'DSH profile name (default: desktop).' },
    deep: { type: 'boolean', description: 'On scan, also walk the last 200 commits for credential lines that the working tree no longer shows.' },
  },
  required: ['action'],
}

/** Result shape of the push tool. */
const PUSH_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    dryRun: { type: 'boolean' },
    repoPath: { type: 'string' },
    branch: { type: 'string' },
    changes: {
      type: 'object',
      additionalProperties: false,
      properties: {
        added: { type: 'array', items: { type: 'string' } },
        updated: { type: 'array', items: { type: 'string' } },
        deleted: { type: 'array', items: { type: 'string' } },
        files: { type: 'array', items: { type: 'string' } },
      },
      required: ['added', 'updated', 'deleted', 'files'],
    },
    manifest: {
      type: 'object',
      additionalProperties: false,
      properties: {
        skills: { type: 'integer' },
        agentsSkills: { type: 'integer' },
        changed: { type: 'boolean' },
      },
      required: ['skills', 'agentsSkills', 'changed'],
    },
    gates: {
      type: 'object',
      additionalProperties: false,
      properties: {
        lint: {
          type: 'object',
          additionalProperties: false,
          properties: { ok: { type: 'boolean' }, notes: { type: 'array', items: { type: 'string' } } },
          required: ['ok', 'notes'],
        },
        redact: {
          type: 'object',
          additionalProperties: false,
          properties: { ok: { type: 'boolean' }, changed: { type: 'array', items: { type: 'string' } } },
          required: ['ok', 'changed'],
        },
        scan: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            hits: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: { file: { type: 'string' }, line: { type: 'integer' } },
                required: ['file', 'line'],
              },
            },
          },
          required: ['ok', 'hits'],
        },
      },
      required: ['lint', 'redact', 'scan'],
    },
    commit: {
      type: 'object',
      additionalProperties: false,
      properties: {
        created: { type: 'boolean' },
        sha: { type: 'string' },
        subject: { type: 'string' },
        message: { type: 'string' },
        pushed: { type: 'boolean' },
        unchanged: { type: 'boolean' },
      },
      required: ['created', 'sha', 'subject', 'message', 'pushed', 'unchanged'],
    },
    warnings: { type: 'array', items: { type: 'string' } },
    exitCode: { type: 'integer' },
  },
  required: ['ok', 'dryRun', 'repoPath', 'branch', 'changes', 'manifest', 'gates', 'commit', 'warnings', 'exitCode'],
}

const PUSH_PARAMETERS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    repo: { type: 'string', description: 'Absolute or ~/... path to the dsh-config checkout. Defaults to the configured repoPath.' },
    dry_run: { type: 'boolean', description: 'Default true. Snapshot, lint, redact and scan are computed and reported; nothing is written, committed or pushed.' },
    message: { type: 'string', description: 'Commit message. Defaults to "sync: <local date time>".' },
    include_profile: { type: 'boolean', description: 'Include profile settings and the plugin manifest in the snapshot (default true). false is the --no-profile equivalent.' },
    include_market: { type: 'boolean', description: 'Also snapshot .dsh-market (marketplace state). Off by default: it is machine-local and often larger than the rest combined.' },
    allow_delete: { type: 'boolean', description: 'Also delete repository entries missing on this machine. Off by default: a missing skill is usually a not-yet-pulled machine, not a deletion.' },
  },
}

/** Result shape of the self-diagnosis tool. */
const DIAG_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    version: { type: 'string' },
    startedAt: { type: 'string' },
    tools: { type: 'array', items: { type: 'string' } },
    services: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tools: { type: 'string' },
        commands: { type: 'string' },
        skills: { type: 'string' },
        webServer: { type: 'string' },
      },
      required: ['tools', 'commands', 'skills', 'webServer'],
    },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          ok: { type: 'boolean' },
          detail: { type: 'string' },
        },
        required: ['name', 'ok', 'detail'],
      },
    },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['ok', 'version', 'startedAt', 'tools', 'services', 'steps', 'notes'],
}

/**
 * Register the plugin's tools on the host.
 *
 * @param {{ tools: { register(definition: object): () => void } }} ctx
 * @param {object} [config] the row's `config` block
 */
function apply(ctx, config = {}) {
  const settings = resolveSettings(config)

  resetDiagnostics(VERSION)
  recordService('tools', ctx.tools)
  const commands = serviceOf(ctx, 'commands')
  const skills = serviceOf(ctx, 'skills')
  // Different compositions expose the HTTP server under different names:
  // `webServer` (dsh-host-webserver), `web` (dsh-web), or nothing at all in the
  // Electron build, which serves the UI over IPC. Try each, in order.
  let webServer
  for (const candidate of ['webServer', 'webServerService', 'web']) {
    webServer = serviceOf(ctx, candidate)
    if (webServer !== undefined && webServer !== null) break
  }
  recordService('commands', commands)
  recordService('skills', skills)
  recordService('webServer', webServer)

  /** Register a tool and remember its name for `dsh_sync_diag`. */
  const registerTool = (definition) => {
    ctx.tools.register(definition)
    recordTool(definition.name)
  }

  tryRegister('slash command', ctx, () => {
    if (commands === undefined || commands === null) throw new Error('commands service not provided')
    registerCommands({ commands }, settings)
  })
  tryRegister('bundled skill', ctx, () => {
    if (skills === undefined || skills === null) throw new Error('skills service not provided')
    registerSkill({ skills })
  })
  tryRegister('http routes', ctx, () => {
    if (webServer === undefined || webServer === null) throw new Error('webServer service not provided')
    if (registerStatusRoute({ webServer }, settings) !== true) throw new Error('webServer.register is missing')
  })

  registerTool({
    name: 'dsh_sync_status',
    description:
      'Report the state of the local dsh-config checkout (the private repository that carries DSH skills, profile settings and AGENTS.md across machines). Read-only: branch, upstream, commits ahead/behind, and how many files are modified. Use it before pulling, before pushing, or when the user asks whether their DSH configuration is in sync. It never writes, and it only touches the network when fetch is true.',
    parameters: PARAMETERS_SCHEMA,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        if (value.repoPresent !== true) {
          return [{ type: 'text', text: `${value.repoPath}: no repository found.` }]
        }
        if (value.ok !== true) {
          return [{ type: 'text', text: `${value.repoPath}: cannot read status — ${value.notes[0] ?? 'unknown error'}` }]
        }
        const tracking = value.upstream === ''
          ? 'no upstream'
          : `${value.ahead} ahead / ${value.behind} behind ${value.upstream}`
        const tree = value.dirty === 0 ? 'clean worktree' : `${value.dirty} changed file(s)`
        return [{ type: 'text', text: `${value.branch === '' ? '(detached)' : value.branch} · ${tracking} · ${tree}` }]
      },
    },
    async execute(args, exec) {
      const requested = args !== null && typeof args === 'object' && typeof args.repo === 'string' && args.repo.trim() !== ''
        ? args.repo.trim()
        : settings.repoPath
      const fetch = args !== null && typeof args === 'object' && typeof args.fetch === 'boolean'
        ? args.fetch
        : settings.fetchOnStatus
      try {
        return await readRepoStatus({
          repoPath: requested,
          timeoutMs: settings.gitTimeoutMs,
          fetch,
          signal: exec?.signal,
        })
      } catch (error) {
        // Defensive: the schema still has to be satisfied, and an uncaught
        // rejection would surface as a tool error rather than a usable report.
        return {
          ok: false,
          repoPath: requested,
          repoPresent: false,
          branch: '',
          upstream: '',
          ahead: 0,
          behind: 0,
          dirty: 0,
          dirtyFiles: [],
          notes: [`status failed: ${String(error?.message ?? error)}`],
        }
      }
    },
  })

  registerTool({
    name: 'dsh_sync_doctor',
    description:
      'Run the full read-only health check of the DSH configuration sync, the Node port of dsh-config/scripts/doctor.sh: toolchain (git/rsync/node/zstd), repository state, skill parity between the checkout and this machine, secrets hygiene (file mode, key names, plaintext scan), profile drift (deployed vs repository config, placeholder residue, plugin manifest and versions), and the weekly pipeline (script drift, scheduler). Returns six structured sections plus an exit code: 0 clean, 2 warnings, 1 blocking errors. It only reads; the single side effect is git fetch (skip with offline).',
    parameters: DOCTOR_PARAMETERS_SCHEMA,
    output: {
      schema: DOCTOR_OUTPUT_SCHEMA,
      render: (_args, value) => {
        const icon = { ok: 'OK', warn: 'WARN', error: 'FAIL' }
        const head = `health check: ${value.fail} blocking / ${value.warn} warnings · exit ${value.exitCode} · ${value.profile}`
        const lines = [head]
        for (const section of value.sections) {
          const finding = section.items.find((entry) => entry.level === 'error')
            ?? section.items.find((entry) => entry.level === 'warn')
          lines.push(`${icon[section.status] ?? section.status}  ${section.title}${finding === undefined ? '' : ` — ${finding.text.trim()}`}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const requested = args !== null && typeof args === 'object' && typeof args.repo === 'string' && args.repo.trim() !== ''
        ? args.repo.trim()
        : settings.repoPath
      const profile = args !== null && typeof args === 'object' && typeof args.profile === 'string' && args.profile.trim() !== ''
        ? args.profile.trim()
        : settings.profile
      try {
        const result = await runDoctor({
          repoPath: requested,
          dshHome: settings.dshHome,
          profile,
          offline: args !== null && typeof args === 'object' && args.offline === true,
          timeoutMs: settings.gitTimeoutMs,
          signal: exec?.signal,
        })
        return {
          ok: result.ok,
          exitCode: result.exitCode,
          fail: result.fail,
          warn: result.warn,
          repoPath: result.repoPath,
          dshHome: result.dshHome,
          profile: result.profile,
          platform: result.platform,
          sections: result.sections.map((section) => ({
            id: section.id,
            title: section.title,
            status: section.status,
            items: section.items.map((entry) => ({ level: entry.level, text: entry.text })),
          })),
        }
      } catch (error) {
        return {
          ok: false,
          exitCode: 1,
          fail: 1,
          warn: 0,
          repoPath: requested,
          dshHome: settings.dshHome ?? '',
          profile,
          platform: process.platform,
          sections: [{
            id: 'fatal',
            title: '0/6 体检失败',
            status: 'error',
            items: [{ level: 'error', text: `doctor failed: ${String(error?.message ?? error)}` }],
          }],
        }
      }
    },
  })

  registerTool({
    name: 'dsh_sync_pull',
    description:
      'Pull this machine up to the dsh-config repository: fetch, report incoming commits, then fast-forward-only pull and mirror skills, agents-skills and weekly scripts into the local DSH home. Defaults to dry_run:true, which fetches and reports the plan without writing. It never deletes local-only files unless delete_local is true, and it never force-merges: a divergence stops and tells the user to merge by hand.',
    parameters: PULL_PARAMETERS_SCHEMA,
    output: {
      schema: PULL_OUTPUT_SCHEMA,
      render: (_args, value) => {
        const lines = []
        lines.push(`${value.dryRun ? 'dry run' : 'pull'}: ${value.before.slice(0, 7)} → ${value.after.slice(0, 7)} · ${value.incomingCommits} incoming commit(s)`)
        for (const mirror of value.mirrors) {
          lines.push(`${mirror.name}: +${mirror.added.length} ~${mirror.updated.length} -${mirror.deleted.length}`)
        }
        for (const warning of value.warnings) lines.push(`warning: ${warning}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const requested = typeof args?.repo === 'string' && args.repo.trim() !== '' ? args.repo.trim() : settings.repoPath
      try {
        const result = await pullRepo({
          repoPath: requested,
          dshHome: settings.dshHome,
          dryRun: typeof args?.dry_run === 'boolean' ? args.dry_run : true,
          deleteLocal: args?.delete_local === true,
          timeoutMs: settings.gitTimeoutMs,
          signal: exec?.signal,
        })
        return {
          ok: result.ok,
          dryRun: result.dryRun,
          repoPath: result.repoPath,
          before: result.before,
          after: result.after,
          incomingCommits: result.incomingCommits,
          incomingSubjects: result.incomingSubjects,
          pulled: result.pulled,
          changedSkills: result.changedSkills,
          mirrors: result.mirrors.map((mirror) => ({
            name: mirror.name,
            src: mirror.src,
            dst: mirror.dst,
            added: mirror.planned.added.slice(0, 50),
            updated: mirror.planned.updated.slice(0, 50),
            deleted: mirror.planned.deleted.slice(0, 50),
            applied: mirror.applied === true,
            unchanged: mirror.unchanged,
          })),
          warnings: result.warnings,
          exitCode: result.exitCode,
        }
      } catch (error) {
        return {
          ok: false,
          dryRun: true,
          repoPath: requested,
          before: '',
          after: '',
          incomingCommits: 0,
          incomingSubjects: [],
          pulled: false,
          changedSkills: [],
          mirrors: [],
          warnings: [`pull failed: ${String(error?.message ?? error)}`],
          exitCode: 1,
        }
      }
    },
  })

  registerTool({
    name: 'dsh_sync_secrets',
    description:
      'Handle the DSH secret guardrail: scan the repository for plaintext secrets, redact the repository copy (real value → __KEY__), inject the deployed copy (__KEY__ → real value), refresh a rotated bearer value, or print sha256 fingerprints. Write actions default to dry_run:true. Injection is refused when a placeholder would remain, because that configuration can only answer invalid_api_key. Values are never returned or logged.',
    parameters: SECRETS_PARAMETERS_SCHEMA,
    output: {
      schema: SECRETS_OUTPUT_SCHEMA,
      render: (_args, value) => {
        const lines = [`secrets ${value.action}${value.dryRun ? ' (dry run)' : ''}: ${value.ok ? 'ok' : 'FAILED'}`]
        if (value.changed.length > 0) lines.push(`changed: ${value.changed.join(', ')}`)
        if (value.leftover.length > 0) lines.push(`leftover placeholders: ${value.leftover.join(' ')}`)
        if (value.hits.length > 0) lines.push(`plaintext hits: ${value.hits.length}`)
        if (value.historyHits.length > 0) lines.push(`history hits: ${value.historyHits.length}`)
        for (const entry of value.fingerprints) lines.push(`${entry.key} sha256:${entry.sha256} len=${entry.length}`)
        for (const note of value.notes) lines.push(note)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const requested = typeof args?.repo === 'string' && args.repo.trim() !== '' ? args.repo.trim() : settings.repoPath
      const profile = typeof args?.profile === 'string' && args.profile.trim() !== '' ? args.profile.trim() : settings.profile
      try {
        const result = await runSecretsAction({
          action: args?.action,
          repoPath: requested,
          dshHome: settings.dshHome,
          profile,
          dryRun: typeof args?.dry_run === 'boolean' ? args.dry_run : true,
          deep: args?.deep === true,
        })
        return { ...result, historyHits: result.historyHits ?? [] }
      } catch (error) {
        return {
          ok: false,
          action: String(args?.action ?? ''),
          dryRun: true,
          target: '',
          changed: [],
          leftover: [],
          hits: [],
          historyHits: [],
          fingerprints: [],
          notes: [`secrets action failed: ${String(error?.message ?? error)}`],
          exitCode: 1,
        }
      }
    },
  })

  registerTool({
    name: 'dsh_sync_push',
    description:
      'Snapshot this machine into the dsh-config repository, pass the gates, commit and push: the Node port of scripts/sync.sh. Order is fixed — pack, lint, redact, plaintext scan, commit, push. Defaults to dry_run:true, which reports the whole plan including the redaction and scan results without writing anything. It never rebases and never force-pushes: a diverged branch stops with manual instructions and keeps the local commit.',
    parameters: PUSH_PARAMETERS_SCHEMA,
    output: {
      schema: PUSH_OUTPUT_SCHEMA,
      render: (_args, value) => {
        const lines = []
        lines.push(`push${value.dryRun ? ' (dry run)' : ''}: ${value.ok ? 'ok' : 'FAILED'} · branch ${value.branch || '?'}`)
        lines.push(`changes: +${value.changes.added.length} ~${value.changes.updated.length} -${value.changes.deleted.length} · skills ${value.manifest.skills}`)
        lines.push(`gates: lint ${value.gates.lint.ok ? 'ok' : 'FAIL'} · redact ${value.gates.redact.changed.length} · scan ${value.gates.scan.ok ? 'ok' : 'FAIL'}`)
        if (value.commit.created) lines.push(`commit ${value.commit.sha} ${value.commit.pushed ? 'pushed' : 'NOT pushed'}`)
        if (value.commit.unchanged) lines.push('no changes to commit')
        for (const warning of value.warnings.slice(0, 6)) lines.push(`warning: ${warning}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const requested = typeof args?.repo === 'string' && args.repo.trim() !== '' ? args.repo.trim() : settings.repoPath
      try {
        return await pushRepo({
          repoPath: requested,
          dshHome: settings.dshHome,
          profile: settings.profile,
          dryRun: typeof args?.dry_run === 'boolean' ? args.dry_run : true,
          message: typeof args?.message === 'string' ? args.message : undefined,
          includeProfile: args?.include_profile !== false,
          includeMarket: args?.include_market === true,
          allowDelete: args?.allow_delete === true,
          timeoutMs: settings.gitTimeoutMs,
          signal: exec?.signal,
        })
      } catch (error) {
        return {
          ok: false,
          dryRun: true,
          repoPath: requested,
          branch: '',
          changes: { added: [], updated: [], deleted: [], files: [] },
          manifest: { skills: 0, agentsSkills: 0, changed: false },
          gates: { lint: { ok: false, notes: [] }, redact: { ok: false, changed: [] }, scan: { ok: false, hits: [] } },
          commit: { created: false, sha: '', subject: '', message: '', pushed: false, unchanged: false },
          warnings: [`push failed: ${String(error?.message ?? error)}`],
          exitCode: 1,
        }
      }
    },
  })

  registerTool({
    name: 'dsh_sync_diag',
    description:
      'Report what this plugin actually registered in the running host: version, which services were available (tools/commands/skills/webServer), and the outcome of each registration step with the error text when one failed. Use it when the slash command or the status card is missing, or to confirm a fresh install loaded without restarting the app again.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: DIAG_OUTPUT_SCHEMA,
      render: (_args, value) => {
        const lines = [`dsh-syn-config ${value.version} · started ${value.startedAt}`]
        lines.push(`tools: ${value.tools.join(', ') || '(none)'}`)
        for (const [name, state] of Object.entries(value.services)) lines.push(`${name}: ${state}`)
        for (const step of value.steps) lines.push(`${step.ok ? 'ok  ' : 'FAIL'} ${step.name}${step.detail === '' ? '' : ` — ${step.detail}`}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute() {
      const reported = readDiagnostics()
      return {
        ok: reported.steps.every((step) => step.ok),
        version: reported.version,
        startedAt: reported.startedAt,
        tools: reported.tools ?? [],
        services: {
          tools: reported.services.tools ?? 'missing',
          commands: reported.services.commands ?? 'missing',
          skills: reported.services.skills ?? 'missing',
          webServer: reported.services.webServer ?? 'missing',
        },
        steps: reported.steps,
        notes: reported.steps.filter((step) => !step.ok).map((step) => `${step.name}: ${step.detail}`),
      }
    },
  })
}

export { apply, inject, name }
