#!/usr/bin/env node
/**
 * Install dsh-syn-config into a DSH profile by linking this checkout.
 *
 * This is the offline / development route, mirroring what the GUI plugin
 * manager does for a published package:
 *
 *   1. back up the profile manifest (once)
 *   2. write a `link:` dependency pointing at this checkout
 *   3. append the package name to `dsh.profile.bundles` (deduplicated)
 *   4. create profile/node_modules/dsh-syn-config — symlink on POSIX,
 *      junction on Windows
 *   5. re-read the profile and check every fact
 *
 * The preferred end-user route on DSH Desktop 0.2.x is a package install:
 *
 *   dsh plugin --profile desktop add github:Dreamaniax/dsh-syn-config
 *
 * Usage:
 *   node scripts/install.mjs [--profile desktop] [--home <dsh-home>] [--dry-run]
 *   node scripts/install.mjs --git github:Owner/repo   # production route
 *
 * Environment: DSH_HOME overrides the default ~/.dsh home.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  PKG,
  backupManifest,
  createProjection,
  linkValueFor,
  parseCommonArgs,
  pathKind,
  profilePaths,
  readJson,
  restartHint,
  samePath,
  serializeManifest,
  writeFileAtomic,
} from './lib/profile.mjs'

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const USAGE = `Install ${PKG} into a DSH profile by linking this checkout.

Usage: node scripts/install.mjs [options]

  --profile <name>  profile to install into (default: desktop)
  --home <dir>      DSH home (default: $DSH_HOME or ~/.dsh)
  --dry-run         print the manifest changes without writing anything
  --git <spec>      register a production spec (github:Owner/repo, tarball, or
                    name@version) instead of linking this checkout. The package
                    is materialized afterwards with:
                      dsh plugin --profile <name> install
  -h, --help        show this help

A production install does not use this script:
  dsh plugin --profile desktop add github:Dreamaniax/dsh-syn-config
`

function fail(message) {
  console.error(`\n[install] FAILED: ${message}\n`)
  process.exit(1)
}

function dedupe(list) {
  return list.filter((entry, index) => list.indexOf(entry) === index)
}

async function main() {
  let options
  try {
    options = parseCommonArgs(process.argv.slice(2))
  } catch (error) {
    fail(error.message)
  }
  if (options.help) {
    console.log(USAGE)
    return
  }

  // `--git` is this script's own flag, so pull it out of the shared parser's
  // "unknown argument" bucket before rejecting leftovers.
  let gitSpec = null
  const rest = []
  for (let index = 0; index < options.rest.length; index += 1) {
    const argument = options.rest[index]
    if (argument === '--git') {
      const value = options.rest[index + 1]
      if (value === undefined || value.trim() === '') fail('--git needs a package spec')
      gitSpec = value.trim()
      index += 1
    } else if (argument.startsWith('--git=')) {
      gitSpec = argument.slice('--git='.length).trim()
      if (gitSpec === '') fail('--git needs a package spec')
    } else {
      rest.push(argument)
    }
  }
  if (rest.length > 0) fail(`unknown argument(s): ${rest.join(' ')} (see --help)`)

  const paths = profilePaths(options)
  const { manifestPath, linkPath, profileDir, profileName, dshHome } = paths
  const linkValue = gitSpec ?? linkValueFor(here)
  const linkKind = gitSpec === null
    ? (process.platform === 'win32' ? 'junction' : 'symlink')
    : 'pnpm-installed package'

  if (!existsSync(manifestPath)) {
    fail(
      `profile manifest not found: ${manifestPath}\n` +
        `  Run DeepSeek Harness Desktop once as the "${profileName}" profile, then retry.` +
        (options.home === null && process.env.DSH_HOME === undefined
          ? '\n  If DSH lives elsewhere, pass --home <dir> or set DSH_HOME.'
          : ''),
    )
  }

  const before = readFileSync(manifestPath, 'utf8')
  let manifest
  try {
    manifest = JSON.parse(before)
  } catch (error) {
    fail(`profile package.json is not valid JSON: ${manifestPath}\n  ${error?.message ?? error}`)
  }
  manifest.dependencies ??= {}
  manifest.dsh ??= {}
  manifest.dsh.profile ??= {}
  const previousValue = manifest.dependencies[PKG]
  manifest.dependencies[PKG] = linkValue

  const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
  manifest.dsh.profile.bundles = dedupe([...bundles, PKG])
  const next = serializeManifest(manifest)

  console.log(`[install] package:  ${PKG}`)
  console.log(`[install] checkout: ${here}`)
  console.log(`[install] home:     ${dshHome}`)
  console.log(`[install] profile:  ${profileName} (${profileDir})`)
  console.log(`[install] link:     ${linkKind} at ${join('node_modules', PKG)}`)
  if (previousValue !== undefined && previousValue !== linkValue) {
    console.log(`[install] replacing existing dependency: ${previousValue}`)
  }

  if (options.dryRun) {
    console.log('\n[install] dry run — would write:')
    console.log(next)
    if (gitSpec !== null) {
      console.log(`[install] dry run — production spec ${gitSpec}; materialize with: dsh plugin --profile ${profileName} install`)
      return
    }
    if (pathKind(linkPath) !== 'missing') {
      console.log(`[install] dry run — would replace ${linkPath} (${pathKind(linkPath)})`)
    } else {
      console.log(`[install] dry run — would create ${linkPath}`)
    }
    return
  }

  // Create the projection first: a failed junction (OneDrive, a network share,
  // a locked node_modules) must not leave the manifest pointing at a bundle
  // that was never linked. Nothing is written until the link exists.
  // A production spec skips this: pnpm materializes the package on install.
  if (gitSpec === null) {
    try {
      const projection = createProjection(linkPath, here)
      console.log(`[install] ${projection.kind}: ${linkPath} -> ${here}`)
    } catch (error) {
      fail(`${error.message}\n  The profile manifest was not changed; fix the link and retry.`)
    }
  }

  if (before !== next) {
    const backupPath = backupManifest(manifestPath)
    console.log(`[install] backup:   ${backupPath}`)
    try {
      await writeFileAtomic(manifestPath, next)
      console.log('[install] manifest: dependency + bundle entry written')
    } catch (error) {
      fail(
        `could not write ${manifestPath}: ${error?.message ?? error}\n` +
          '  Close DeepSeek Harness and any antivirus/indexer holding the file, then retry.',
      )
    }
  } else {
    console.log('[install] manifest: already up to date')
  }

  // Re-read from disk: the check must pass on what the host will actually see.
  const check = readJson(manifestPath)
  if (check.dependencies?.[PKG] !== linkValue) fail('dependency entry missing after write')
  if (!Array.isArray(check.dsh?.profile?.bundles) || !check.dsh.profile.bundles.includes(PKG)) {
    fail('bundle entry missing after write')
  }
  if (gitSpec === null) {
    if (pathKind(linkPath) !== 'link') fail(`node_modules entry is not a link or junction: ${pathKind(linkPath)}`)
    if (!existsSync(join(linkPath, 'package.json'))) fail('link target has no package.json')
    if (!existsSync(join(linkPath, 'lib', 'index.js'))) fail('link target has no lib/index.js')
    if (!existsSync(join(linkPath, 'cordis.patch.yml'))) fail('link target has no cordis.patch.yml')
    if (!samePath(linkPath, here)) fail(`link target does not resolve to this checkout: ${linkPath}`)
    console.log('\n[install] OK — manifest, bundle list and link all check out.')
  } else {
    console.log('\n[install] OK — production spec and bundle entry written.')
    console.log(`[install] Next: materialize the package with`)
    console.log(`[install]   dsh plugin --profile ${profileName} install`)
    console.log(`[install] Then run node scripts/verify.mjs and restart DeepSeek Harness.`)
  }
  console.log(`[install] ${restartHint()}`)
  const verifyCommand = process.platform === 'win32' ? 'node scripts\\verify.mjs' : 'node scripts/verify.mjs'
  console.log(`[install] Then confirm the live install with: ${verifyCommand}`)
}

await main()
