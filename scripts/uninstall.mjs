#!/usr/bin/env node
/**
 * Remove dsh-syn-config from a DSH profile.
 *
 * The reverse of install.mjs: drop the projection, remove the dependency and
 * the bundle entry, and keep a manifest backup. The checkout itself (and its
 * development `node_modules` link) is left untouched so the repository can be
 * reinstalled with one command.
 *
 * Usage:
 *   node scripts/uninstall.mjs [--profile desktop] [--home <dsh-home>] [--dry-run]
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  PKG,
  backupManifest,
  parseCommonArgs,
  pathKind,
  profilePaths,
  readJson,
  removeProjection,
  restartHint,
  serializeManifest,
  writeFileAtomic,
} from './lib/profile.mjs'

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function fail(message) {
  console.error(`\n[uninstall] FAILED: ${message}\n`)
  process.exit(1)
}

async function main() {
  let options
  try {
    options = parseCommonArgs(process.argv.slice(2))
  } catch (error) {
    fail(error.message)
  }
  if (options.help) {
    console.log('Usage: node scripts/uninstall.mjs [--profile desktop] [--home <dir>] [--dry-run]')
    return
  }
  if (options.rest.length > 0) fail(`unknown argument(s): ${options.rest.join(' ')}`)

  const { manifestPath, linkPath, profileDir, profileName } = profilePaths(options)
  if (!existsSync(manifestPath)) fail(`profile manifest not found: ${manifestPath}`)

  const before = readFileSync(manifestPath, 'utf8')
  const manifest = readJson(manifestPath)
  const hadDependency = manifest.dependencies !== undefined && PKG in manifest.dependencies
  const bundles = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
  const hadBundle = bundles.includes(PKG)

  if (hadDependency) delete manifest.dependencies[PKG]
  if (hadBundle && manifest.dsh?.profile !== undefined) {
    manifest.dsh.profile.bundles = bundles.filter((entry) => entry !== PKG)
  }
  const next = serializeManifest(manifest)

  console.log(`[uninstall] package: ${PKG}`)
  console.log(`[uninstall] profile: ${profileName} (${profileDir})`)
  console.log(`[uninstall] link:    ${pathKind(linkPath)} at ${linkPath}`)
  console.log(`[uninstall] manifest: dependency=${hadDependency ? 'remove' : 'absent'}, bundle=${hadBundle ? 'remove' : 'absent'}`)

  if (options.dryRun) {
    console.log('\n[uninstall] dry run — would write:')
    console.log(next)
    return
  }

  try {
    const removal = removeProjection(linkPath)
    console.log(`[uninstall] projection: ${removal.outcome}${removal.backup === undefined ? '' : ` (kept at ${removal.backup})`}`)
  } catch (error) {
    fail(`could not remove ${linkPath}: ${error?.message ?? error}\n  The manifest was not changed.`)
  }

  if (before !== next) {
    console.log(`[uninstall] backup: ${backupManifest(manifestPath)}`)
    await writeFileAtomic(manifestPath, next)
  }
  console.log('[uninstall] manifest updated')
  console.log(`[uninstall] ${restartHint()}`)
  console.log(`[uninstall] Reinstall later with: node ${join(here, 'scripts', 'install.mjs')}`)
}

await main()
