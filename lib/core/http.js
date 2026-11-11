/**
 * The one HTTP route the status card reads.
 *
 * `ctx.webServer.register({ resource })` maps a Fetch `Request` to a
 * `Response`; the server only lets `GET`/`HEAD` through, so one function is
 * all that is needed. The payload is the same read-only status the model tool
 * returns minus every secret: branch, upstream, ahead/behind, dirty count and
 * the file names (which are configuration paths, not secrets).
 *
 * The route answers only on the loopback-bound GUI server and sets
 * `Cache-Control: no-store`, so a stale card cannot outlive a real state
 * change.
 *
 * @module dsh-syn-config/core/http
 */

import { readRepoStatus } from './status.js'

export const STATUS_PATH = '/plugins/dsh-syn-config/status'

/** JSON response with no-store caching. */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * Register the status route when the composition has a web server.
 *
 * @param {{ get?: (name: string) => unknown, webServer?: object }} ctx
 * @param {{ repoPath: string, gitTimeoutMs: number }} settings
 */
export function registerStatusRoute(ctx, settings) {
  const server = ctx.webServer ?? (typeof ctx.get === 'function' ? ctx.get('webServer') : undefined)
  if (server === undefined || server === null || typeof server.register !== 'function') return false

  server.register({
    path: STATUS_PATH,
    resource: async (request) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } })
      }
      try {
        const status = await readRepoStatus({
          repoPath: settings.repoPath,
          timeoutMs: settings.gitTimeoutMs,
          fetch: false,
        })
        return json({
          ok: status.ok,
          repoPath: status.repoPath,
          repoPresent: status.repoPresent,
          branch: status.branch,
          upstream: status.upstream,
          ahead: status.ahead,
          behind: status.behind,
          dirty: status.dirty,
          // File names stay out of the browser payload: any local process can
          // read this route, and a config file name can itself be sensitive.
          checkedAt: new Date().toISOString(),
        })
      } catch (error) {
        return json({ ok: false, error: String(error?.message ?? error) }, 500)
      }
    },
  })
  return true
}
