/**
 * Which binaries and homes this machine actually has.
 *
 * The shell scripts discover these with `command -v` plus a list of known
 * install locations (macOS app bundle, Windows Program Files, DSH runtimes).
 * This module does the same without a shell, on all three platforms.
 *
 * @module dsh-syn-config/core/env
 */

import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

export const IS_WIN = process.platform === 'win32'
export const IS_MAC = process.platform === 'darwin'
export const IS_LINUX = process.platform === 'linux'

/** `$DSH_HOME` (or `~/.dsh`), matching how DSH resolves its own home. */
export function resolveDshHome(explicit) {
  let value = explicit ?? process.env.DSH_HOME
  if (typeof value !== 'string' || value.trim() === '') value = join(homedir(), '.dsh')
  value = value.trim()
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return resolve(join(homedir(), value.slice(2)))
  return resolve(value)
}

/** `$DSH_AGENTS_HOME` (or `~/.agents`). */
export function resolveAgentsHome(explicit) {
  let value = explicit ?? process.env.DSH_AGENTS_HOME
  if (typeof value !== 'string' || value.trim() === '') value = join(homedir(), '.agents')
  return resolve(value.trim())
}

/** True when the path exists and is executable (POSIX) or a file (Windows). */
export function isExecutable(path) {
  if (typeof path !== 'string' || path === '' || !existsSync(path)) return false
  try {
    if (IS_WIN) return true
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Resolve a bare name against PATH without spawning a shell. */
export function which(name) {
  if (typeof name !== 'string' || name === '') return null
  const pathValue = process.env.PATH ?? ''
  const suffixes = IS_WIN ? ['', '.exe', '.cmd', '.bat'] : ['']
  for (const segment of pathValue.split(delimiter)) {
    if (segment === '') continue
    for (const suffix of suffixes) {
      const candidate = join(segment, name + suffix)
      if (isExecutable(candidate)) return candidate
    }
  }
  return null
}

/** First executable candidate, in order. */
function first(candidates) {
  for (const candidate of candidates) {
    if (isExecutable(candidate)) return candidate
  }
  return null
}

/** git, preferring an explicit override and the Xcode copy (which avoids exit 69). */
export function findGit() {
  return first([
    process.env.DSH_GIT,
    which('git'),
    IS_MAC ? '/Applications/Xcode.app/Contents/Developer/usr/bin/git' : null,
    '/opt/homebrew/bin/git',
    '/usr/local/bin/git',
    '/usr/bin/git',
  ].filter((value) => typeof value === 'string' && value !== ''))
}

/** A node that can run the weekly pipeline (the desktop runtime counts). */
export function findNode() {
  const home = homedir()
  return first([
    process.env.DSH_NODE,
    process.execPath,
    which('node'),
    '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node',
    join(home, 'Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node'),
    IS_WIN ? 'C:\\Program Files\\DeepSeek Harness\\resources\\runtime\\primary-runtime\\dependencies\\node\\bin\\node.exe' : null,
    IS_WIN ? join(process.env.LOCALAPPDATA ?? '', 'Programs/DeepSeek Harness/resources/runtime/primary-runtime/dependencies/node/bin/node.exe') : null,
    IS_WIN ? 'C:\\Program Files\\nodejs\\node.exe' : null,
    IS_WIN ? join(process.env.LOCALAPPDATA ?? '', 'Programs/nodejs/node.exe') : null,
  ].filter((value) => typeof value === 'string' && value !== ''))
}

/** zstd, which the weekly pipeline needs and Windows rarely has on PATH. */
export function findZstd() {
  const home = homedir()
  const localAppData = process.env.LOCALAPPDATA ?? ''
  return first([
    process.env.DSH_ZSTD,
    which('zstd'),
    join(home, 'scoop/shims/zstd.exe'),
    'C:\\ProgramData\\chocolatey\\bin\\zstd.exe',
    localAppData === '' ? null : join(localAppData, 'Microsoft/WinGet/Links/zstd.exe'),
    '/opt/homebrew/bin/zstd',
    '/usr/local/bin/zstd',
  ].filter((value) => typeof value === 'string' && value !== ''))
}

/** The DSH CLI that owns this profile (`DSH_CLI` wins). */
export function findDshCli() {
  const home = homedir()
  return first([
    process.env.DSH_CLI,
    which('dsh'),
    '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh',
    join(home, 'Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'),
    'C:\\Program Files\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd',
    join(process.env.LOCALAPPDATA ?? '', 'Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd'),
  ].filter((value) => typeof value === 'string' && value !== ''))
}

/** Human platform label, matching the shape doctor.sh prints. */
export function platformLabel() {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x86_64' : process.arch
  const name = IS_WIN ? 'Windows' : IS_MAC ? 'Darwin' : IS_LINUX ? 'Linux' : process.platform
  return `${name}-${arch}`
}

/** Whether a path is a directory (symlinks to directories count). */
export function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
