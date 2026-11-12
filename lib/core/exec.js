/**
 * One process runner for every external command the plugin needs.
 *
 * Like `runGit`, this is `execFile` with an explicit argv (never a shell), so
 * quoting, `$` expansion and Windows path separators cannot break a command.
 * Failures are returned as data: the host process must survive a missing
 * binary or a hung subprocess.
 *
 * @module dsh-syn-config/core/exec
 */

import { execFile } from 'node:child_process'

/** Default budget for a fast local command. */
export const DEFAULT_TIMEOUT_MS = 15_000

/**
 * Run one executable and normalise success and failure.
 *
 * @param {string} file executable path or PATH name
 * @param {string[]} args argv (no shell interpretation)
 * @param {{ timeoutMs?: number, signal?: AbortSignal, env?: NodeJS.ProcessEnv, cwd?: string }} [options]
 * @returns {Promise<{ ok: boolean, status: number | null, stdout: string, stderr: string, timedOut: boolean, missing: boolean, aborted: boolean }>}
 */
export function runCommand(file, args, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, env, cwd } = options

  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const text = (value) => (typeof value === 'string' ? value : '')

    try {
      execFile(
        file,
        args,
        {
          cwd,
          timeout: timeoutMs,
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
          env: env ?? process.env,
          signal,
        },
        (error, stdout, stderr) => {
          if (error === null || error === undefined) {
            finish({
              ok: true,
              status: 0,
              stdout: text(stdout),
              stderr: text(stderr),
              timedOut: false,
              missing: false,
              aborted: false,
            })
            return
          }
          finish({
            ok: false,
            status: typeof error.code === 'number' ? error.code : null,
            stdout: text(stdout ?? error.stdout),
            stderr: text(stderr ?? error.stderr ?? error.message),
            timedOut: error.killed === true || error.code === 'ETIMEDOUT',
            missing: error.code === 'ENOENT',
            aborted: error.name === 'AbortError' || error.code === 'ABORT_ERR',
          })
        },
      )
    } catch (error) {
      finish({
        ok: false,
        status: null,
        stdout: '',
        stderr: String(error?.message ?? error),
        timedOut: false,
        missing: false,
        aborted: false,
      })
    }
  })
}
