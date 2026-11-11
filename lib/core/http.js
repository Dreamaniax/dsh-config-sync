/**
 * The read-only HTTP surface the status chip (and its panel) reads.
 *
 * Three GET routes, one shape of answer each. They exist so a browser card can
 * show state without calling a model: `ctx.webServer.register({ resource })`
 * maps a Fetch `Request` to a `Response`, and the server only lets `GET`/`HEAD`
 * through — which is the safety property this whole surface relies on. No
 * route here can write, so no cross-site request can either.
 *
 * - `/status` branch, upstream, ahead/behind, dirty count
 * - `/doctor` the six-section health check, cached for a minute: it spawns git
 *   and reads the filesystem, and a card does not need second-level freshness
 * - `/plan?action=pull|push` the dry-run plan of a real operation: the same
 *   computation `pull now` / `push now` would do, with nothing written
 *
 * Every payload is the read-only projection of the tool result minus every
 * secret and minus file names (a config file name can itself be sensitive).
 *
 * @module dsh-syn-config/core/http
 */

import { runDoctor } from './doctor.js'
import { pullRepo } from './pull.js'
import { pushRepo } from './push.js'
import { runSecretsAction } from './secrets-ops.js'
import { readRepoStatus } from './status.js'

export const STATUS_PATH = '/plugins/dsh-syn-config/status'
export const DOCTOR_PATH = '/plugins/dsh-syn-config/doctor'
export const PLAN_PATH = '/plugins/dsh-syn-config/plan'
export const SECRETS_PATH = '/plugins/dsh-syn-config/secrets'

/** How long a doctor or plan answer may be reused. */
const CACHE_MS = 60_000

/** JSON response with no-store caching. */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** Method gate shared by every route; the server also rejects writes upstream. */
function methodAllowed(request) {
  return request.method === 'GET' || request.method === 'HEAD'
}

/**
 * Build the cached reader.
 *
 * A card that polls every few seconds must not spawn `git` every time: the
 * doctor alone runs a handful of commands. The cache is per-route and holds
 * the *projection*, so nothing secret lingers in memory longer than the answer.
 *
 * @param {() => Promise<object>} read
 * @param {number} ttlMs
 */
export function cached(read, ttlMs = CACHE_MS) {
  let at = 0
  let value
  let inflight
  return async () => {
    const now = Date.now()
    if (value !== undefined && now - at < ttlMs) return { body: value, cached: true }
    if (inflight !== undefined) return { body: await inflight, cached: true }
    inflight = read().then((body) => {
      value = body
      at = Date.now()
      inflight = undefined
      return body
    }, (error) => {
      inflight = undefined
      throw error
    })
    return { body: await inflight, cached: false }
  }
}

/** Project a doctor run down to what a card may see. */
export function doctorPayload(result) {
  return {
    ok: result.fail === 0,
    fail: result.fail,
    warn: result.warn,
    exitCode: result.exitCode,
    profile: result.profile,
    checkedAt: new Date().toISOString(),
    sections: result.sections.map((section) => {
      const blocking = section.items.filter((entry) => entry.level === 'error')
      const warnings = section.items.filter((entry) => entry.level === 'warn')
      const worst = blocking[0] ?? warnings[0]
      return {
        title: section.title,
        status: section.status,
        blocking: blocking.length,
        warnings: warnings.length,
        // The message text is already sanitised by the doctor: paths are
        // shortened and secret values are masked.
        summary: worst === undefined ? '' : String(worst.text).trim().slice(0, 160),
      }
    }),
  }
}

/** Project a dry-run push/pull down to a plan a card may see. */
export function planPayload(action, result) {
  if (action === 'pull') {
    return {
      action,
      ok: result.ok,
      incomingCommits: result.incomingCommits,
      before: String(result.before ?? '').slice(0, 12),
      after: String(result.after ?? '').slice(0, 12),
      mirrors: result.mirrors.map((mirror) => ({
        name: mirror.name,
        added: mirror.planned.added.length,
        updated: mirror.planned.updated.length,
        deleted: mirror.planned.deleted.length,
      })),
      warnings: result.warnings.slice(0, 5).map((line) => String(line).slice(0, 160)),
      checkedAt: new Date().toISOString(),
    }
  }
  return {
    action,
    ok: result.ok,
    changes: {
      added: result.changes.added.length,
      updated: result.changes.updated.length,
      deleted: result.changes.deleted.length,
    },
    gates: {
      lint: result.gates.lint.ok,
      redacted: result.gates.redact.changed.length,
      scan: result.gates.scan.ok,
    },
    commit: { created: result.commit.created, unchanged: result.commit.unchanged === true },
    skills: result.manifest.skills,
    warnings: result.warnings.slice(0, 5).map((line) => String(line).slice(0, 160)),
    checkedAt: new Date().toISOString(),
  }
}

/**
 * Register every read-only route when the composition has a web server.
 *
 * @param {{ get?: (name: string) => unknown, webServer?: object }} ctx
 * @param {{ repoPath: string, profile: string, dshHome?: string, gitTimeoutMs: number }} settings
 * @returns {boolean} whether the routes were registered
 */
export function registerStatusRoute(ctx, settings) {
  const server = ctx.webServer ?? (typeof ctx.get === 'function' ? ctx.get('webServer') : undefined)
  if (server === undefined || server === null || typeof server.register !== 'function') return false

  const readStatus = async () => {
    const status = await readRepoStatus({
      repoPath: settings.repoPath,
      timeoutMs: settings.gitTimeoutMs,
      fetch: false,
    })
    return {
      ok: status.ok,
      repoPath: status.repoPath,
      repoPresent: status.repoPresent,
      branch: status.branch,
      upstream: status.upstream,
      ahead: status.ahead,
      behind: status.behind,
      dirty: status.dirty,
      checkedAt: new Date().toISOString(),
    }
  }

  const readDoctor = cached(async () => doctorPayload(await runDoctor({
    repoPath: settings.repoPath,
    dshHome: settings.dshHome,
    profile: settings.profile,
    offline: true,
    timeoutMs: settings.gitTimeoutMs,
  })))

  const readPlan = (action) => {
    if (action !== 'pull' && action !== 'push') return undefined
    return cached(async () => {
      const result = action === 'pull'
        ? await pullRepo({
          repoPath: settings.repoPath,
          dshHome: settings.dshHome,
          dryRun: true,
          timeoutMs: settings.gitTimeoutMs,
        })
        : await pushRepo({
          repoPath: settings.repoPath,
          dshHome: settings.dshHome,
          profile: settings.profile,
          dryRun: true,
          timeoutMs: settings.gitTimeoutMs,
        })
      return planPayload(action, result)
    })
  }

  const plans = { pull: readPlan('pull'), push: readPlan('push') }

  // Read-only: a scan never mutates, and it returns counts plus masked previews.
  const readSecrets = cached(async () => {
    const result = await runSecretsAction({
      action: 'scan',
      repoPath: settings.repoPath,
      dshHome: settings.dshHome,
      profile: settings.profile,
      dryRun: true,
    })
    return {
      ok: result.ok,
      hits: result.hits.length,
      samples: result.hits.slice(0, 5).map((hit) => ({
        file: String(hit.file).split('/').slice(-2).join('/'),
        line: hit.line,
        masked: String(hit.match).slice(0, 4) + '…',
      })),
      note: result.note ?? '',
      checkedAt: new Date().toISOString(),
    }
  })

  const route = (path, resource) => {
    server.register({ path, resource })
  }

  route(STATUS_PATH, async (request) => {
    if (!methodAllowed(request)) return new Response('method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } })
    try {
      return json(await readStatus())
    } catch (error) {
      return json({ ok: false, error: String(error?.message ?? error) }, 500)
    }
  })

  route(DOCTOR_PATH, async (request) => {
    if (!methodAllowed(request)) return new Response('method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } })
    try {
      const answer = await readDoctor()
      return json({ ...answer.body, cached: answer.cached })
    } catch (error) {
      return json({ ok: false, error: String(error?.message ?? error) }, 500)
    }
  })

  route(SECRETS_PATH, async (request) => {
    if (!methodAllowed(request)) return new Response('method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } })
    try {
      const answer = await readSecrets()
      return json({ ...answer.body, cached: answer.cached })
    } catch (error) {
      return json({ ok: false, error: String(error?.message ?? error) }, 500)
    }
  })

  route(PLAN_PATH, async (request) => {
    if (!methodAllowed(request)) return new Response('method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } })
    const action = new URL(request.url).searchParams.get('action') ?? ''
    const reader = plans[action]
    if (reader === undefined) {
      return json({ ok: false, error: 'action must be pull or push' }, 400)
    }
    try {
      const answer = await reader()
      return json({ ...answer.body, cached: answer.cached })
    } catch (error) {
      return json({ ok: false, error: String(error?.message ?? error) }, 500)
    }
  })

  return true
}
