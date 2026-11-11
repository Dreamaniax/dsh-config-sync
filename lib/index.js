/**
 * dsh-config-sync — host half.
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
 * @module dsh-config-sync
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { readRepoStatus } from './core/status.js'

/** Plugin row name used by cordis.patch.yml and the profile manifest. */
const name = 'dsh-config-sync'

/** Services this plugin consumes; the tool registry is all P0 needs. */
const inject = ['tools']

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
  return { repoPath, gitTimeoutMs, fetchOnStatus: config.fetchOnStatus === true }
}

/**
 * Register the plugin's tools on the host.
 *
 * @param {{ tools: { register(definition: object): () => void } }} ctx
 * @param {object} [config] the row's `config` block
 */
function apply(ctx, config = {}) {
  const settings = resolveSettings(config)

  ctx.tools.register({
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
}

export { apply, inject, name }
