/**
 * Git plumbing for dsh-config-sync.
 *
 * Deliberately dependency-free and platform-neutral: every call is
 * `execFile(git, argv)` with an explicit argument vector — never a shell — so
 * the same code runs on macOS (Apple git) and Windows (Git for Windows, or a
 * `gitPath` the user configures). The command environment is inherited as-is:
 * credential helpers must work exactly as they do in the user's terminal.
 *
 * Every failure is returned, never thrown: a missing git, a timeout, or a
 * non-zero exit all become a result object so the tool layer can report them
 * as data instead of crashing the host process (an uncaught rejection would
 * take the whole DeepSeek Harness down).
 *
 * @module dsh-config-sync/core/git
 */

import { execFile } from 'node:child_process'

/** Seconds-sized default; a slow fetch can override it at the call site. */
export const DEFAULT_TIMEOUT_MS = 15_000

/**
 * Run git and normalise both success and failure into one shape.
 *
 * @param {string[]} args argv after the executable (never a command string).
 * @param {{ gitPath?: string, cwd?: string, timeoutMs?: number, signal?: AbortSignal, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<{ ok: boolean, status: number | null, stdout: string, stderr: string, timedOut: boolean, missing: boolean, aborted: boolean }>}
 */
export async function runGit(args, options = {}) {
  const {
    gitPath = 'git',
    cwd,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
    env,
  } = options

  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    let child
    try {
      child = execFile(
        gitPath,
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
          const text = (value) => (typeof value === 'string' ? value : '')
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

          const code = typeof error.code === 'number' ? error.code : null
          const missing = error.code === 'ENOENT'
          const timedOut = error.killed === true || error.code === 'ETIMEDOUT'
          const aborted = error.name === 'AbortError' || error.code === 'ABORT_ERR'
          finish({
            ok: false,
            status: code,
            stdout: text(stdout ?? error.stdout),
            stderr: text(stderr ?? error.stderr ?? error.message),
            timedOut,
            missing,
            aborted,
          })
        },
      )
    } catch (error) {
      // execFile itself can throw synchronously (bad options, invalid argv).
      finish({
        ok: false,
        status: null,
        stdout: '',
        stderr: String(error?.message ?? error),
        timedOut: false,
        missing: false,
        aborted: false,
      })
      return
    }

    // `execFile` already applies the timeout and the signal; nothing else is
    // attached here on purpose so no timer outlives the call.
    child.on('error', () => {})
  })
}

/**
 * Turn a failed git result into one human sentence.
 *
 * @param {{ status: number | null, stderr: string, timedOut: boolean, missing: boolean }} result
 * @param {string} gitPath
 * @returns {string}
 */
export function describeGitFailure(result, gitPath = 'git') {
  if (result.missing) {
    return process.platform === 'win32'
      ? `git was not found (looked for "${gitPath}"). Install Git for Windows and make sure git.exe is on PATH, or set gitPath in the plugin config.`
      : `git was not found (looked for "${gitPath}"). Install the Xcode command line tools or set gitPath in the plugin config.`
  }
  if (result.aborted) return 'git was cancelled.'
  if (result.timedOut) return `git did not finish within the timeout (${gitPath}).`
  const detail = result.stderr.trim().split('\n').slice(-3).join(' ').trim()
  const code = result.status === null ? 'an unknown status' : `exit code ${result.status}`
  return detail === '' ? `git failed with ${code}.` : `git failed with ${code}: ${detail}`
}
