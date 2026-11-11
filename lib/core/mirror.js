/**
 * Directory mirroring — the Node replacement for `rsync -a [--delete]`.
 *
 * The shell implementation falls back to `cp -a` + `find -delete` when rsync
 * is missing (Windows), which is why the two platforms behave differently.
 * This module implements one semantic for both:
 *
 *   - copy every entry of `src` into `dst`
 *   - update a file when its size or its mtime (whole seconds, like rsync)
 *     differs; identical files are left untouched
 *   - copy symlinks as symlinks, never follow them
 *   - with `delete`, remove entries of `dst` that no longer exist in `src`,
 *     deepest first, and prune the directories that become empty
 *   - with `dryRun`, compute the same plan and report it without writing
 *
 * @module dsh-config-sync/core/mirror
 */

import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
} from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

/** Turn a name pattern into a matcher; `*` is the only wildcard supported. */
function excludeMatcher(exclude) {
  if (exclude === null || exclude === undefined || exclude === '') return () => false
  const patterns = Array.isArray(exclude) ? exclude : [exclude]
  const tests = patterns.map((pattern) => {
    if (pattern.includes('*')) {
      const source = `^${pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('.*')}$`
      return new RegExp(source, 'u')
    }
    return pattern
  })
  return (name) => tests.some((test) => (typeof test === 'string' ? name === test : test.test(name)))
}

/** Recursively list a tree into a map of posix-style relative paths. */
function walk(root, exclude, accept = () => true) {
  const entries = new Map()
  const visit = (dir) => {
    let children
    try {
      children = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const child of children) {
      if (exclude(child.name)) continue
      const full = join(dir, child.name)
      const rel = relative(root, full).split(sep).join('/')
      if (!accept(rel)) continue
      let stat
      try {
        stat = lstatSync(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        entries.set(rel, { type: 'dir', mode: stat.mode & 0o777, mtimeMs: stat.mtimeMs })
        visit(full)
      } else if (stat.isSymbolicLink()) {
        let target = ''
        try {
          target = readlinkSync(full)
        } catch {
          target = ''
        }
        entries.set(rel, { type: 'link', target, mtimeMs: stat.mtimeMs })
      } else if (stat.isFile()) {
        entries.set(rel, { type: 'file', size: stat.size, mode: stat.mode & 0o777, mtimeMs: stat.mtimeMs })
      }
    }
  }
  visit(root)
  return entries
}

/** rsync compares modification time in whole seconds. */
function sameSecond(left, right) {
  return Math.floor(left / 1000) === Math.floor(right / 1000)
}

/**
 * Mirror `src` into `dst`.
 *
 * @param {string} src
 * @param {string} dst
 * @param {{ delete?: boolean, dryRun?: boolean, exclude?: string | string[] | null }} [options]
 * @returns {{ src: string, dst: string, dryRun: boolean, delete: boolean, planned: { added: string[], updated: string[], deleted: string[] }, applied: boolean, unchanged: number }}
 */
export function mirrorDir(src, dst, options = {}) {
  const { delete: del = false, dryRun = false, exclude = null } = options
  const isExcluded = excludeMatcher(exclude)
  const source = walk(src, isExcluded)
  const target = walk(dst, isExcluded)

  const added = []
  const updated = []
  const deleted = []
  let unchanged = 0

  for (const [rel, entry] of [...source.entries()].sort()) {
    const existing = target.get(rel)
    if (existing === undefined) {
      added.push(rel)
      continue
    }
    if (entry.type !== existing.type) {
      updated.push(rel)
      continue
    }
    if (entry.type === 'file') {
      const changed = entry.size !== existing.size || !sameSecond(entry.mtimeMs, existing.mtimeMs)
      if (changed) updated.push(rel)
      else unchanged += 1
    } else if (entry.type === 'link') {
      if (entry.target !== existing.target) updated.push(rel)
      else unchanged += 1
    } else {
      unchanged += 1
    }
  }

  if (del) {
    for (const rel of target.keys()) {
      if (!source.has(rel)) deleted.push(rel)
    }
    deleted.sort()
  }

  const planned = { added, updated, deleted }
  if (dryRun) {
    return { src, dst, dryRun: true, delete: del, planned, applied: false, unchanged }
  }

  mkdirSync(dst, { recursive: true })

  // Directories first so files have a home.
  for (const [rel, entry] of [...source.entries()].sort()) {
    if (entry.type !== 'dir') continue
    const full = join(dst, rel)
    mkdirSync(full, { recursive: true })
    try {
      chmodSync(full, entry.mode)
    } catch {
      // permissions are advisory on Windows
    }
  }

  for (const rel of [...added, ...updated]) {
    const entry = source.get(rel)
    if (entry === undefined) continue
    const full = join(dst, rel)
    mkdirSync(dirname(full), { recursive: true })
    if (entry.type === 'dir') continue
    if (entry.type === 'link') {
      try {
        unlinkSync(full)
      } catch {
        // nothing to replace
      }
      symlinkSync(entry.target, full)
      continue
    }
    copyFileSync(join(src, rel), full)
    try {
      chmodSync(full, entry.mode)
      utimesSync(full, entry.mtimeMs / 1000, entry.mtimeMs / 1000)
    } catch {
      // Windows may refuse utimes on some volumes; content is already correct
    }
  }

  if (del) {
    // Files and links first, then directories deepest-first.
    for (const rel of deleted) {
      const entry = target.get(rel)
      if (entry === undefined || entry.type === 'dir') continue
      try {
        unlinkSync(join(dst, rel))
      } catch {
        // already gone
      }
    }
    const directories = deleted.filter((rel) => target.get(rel)?.type === 'dir').sort((left, right) => right.length - left.length)
    for (const rel of directories) {
      try {
        rmdirSync(join(dst, rel))
      } catch {
        // not empty (an excluded file lives there) — leave it
      }
    }
  }

  return { src, dst, dryRun: false, delete: del, planned, applied: true, unchanged }
}
