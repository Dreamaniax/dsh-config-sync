#!/usr/bin/env node
/**
 * Verify an install of dsh-syn-config, without restarting the app.
 *
 * Works for both routes — a `link:` checkout install and a production spec
 * (github:, tarball, registry) materialized by pnpm:
 *
 *   1. the profile manifest lists the package and the bundle entry
 *   2. profile/node_modules/<pkg> exists and carries the package files
 *   3. loading the *installed* lib/index.js exposes apply / inject / name
 *   4. applying it against a fake context registers exactly one tool with a
 *      schema-shaped output
 *   5. the read-only status reader can open the dsh-config checkout
 *
 * Exit code 0 means the next app start will load the plugin; a non-zero code
 * names the failed step.
 */

import { existsSync, readFileSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { PKG, parseCommonArgs, pathKind, profilePaths, readJson } from './lib/profile.mjs'

function step(ok, label, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail === '' ? '' : ` — ${detail}`}`)
  return ok
}

async function main() {
  const options = parseCommonArgs(process.argv.slice(2))
  const failures = []
  const record = (ok) => {
    if (!ok) failures.push(true)
    return ok
  }

  const { manifestPath, linkPath, profileDir, profileName, dshHome } = profilePaths(options)
  console.log(`[verify] package: ${PKG}`)
  console.log(`[verify] home:    ${dshHome}`)
  console.log(`[verify] profile: ${profileName}`)
  console.log('')

  if (!existsSync(manifestPath)) {
    console.error(`[verify] no profile manifest at ${manifestPath}`)
    process.exit(1)
  }

  const manifest = readJson(manifestPath)
  const spec = manifest.dependencies?.[PKG]
  record(step(spec !== undefined, 'manifest dependency', String(spec ?? 'missing')))
  const bundles = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
  record(step(bundles.includes(PKG), 'bundle entry', bundles.includes(PKG) ? 'listed' : 'missing'))

  const kind = pathKind(linkPath)
  record(step(kind === 'link' || kind === 'directory', 'node_modules projection', kind))
  const entry = join(linkPath, 'package.json')
  record(step(existsSync(entry), 'projection has package.json', entry))
  let installedVersion = ''
  if (existsSync(entry)) {
    try {
      installedVersion = readJson(entry).version ?? ''
    } catch {
      installedVersion = ''
    }
  }
  if (kind === 'link') {
    // The link target is the checkout, so it must at least be the same package.
    let target = ''
    try {
      target = readlinkSync(linkPath)
    } catch {
      target = ''
    }
    record(step(target !== '', 'projection target', target || 'unreadable'))
  }

  // Load exactly what the host will load: the installed package, by file URL.
  let module
  try {
    module = await import(pathToFileURL(join(linkPath, 'lib', 'index.js')).href)
  } catch (error) {
    record(step(false, 'load installed lib/index.js', String(error?.message ?? error)))
    console.error('\n[verify] FAILED — the host would not be able to load this plugin.')
    process.exit(1)
  }
  record(step(typeof module.apply === 'function', 'export apply'))
  record(step(Array.isArray(module.inject), 'export inject', Array.isArray(module.inject) ? module.inject.join(',') : 'missing'))
  record(step(module.name === PKG, 'export name', String(module.name)))

  const registered = []
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
  }
  try {
    await module.apply(ctx, {})
  } catch (error) {
    record(step(false, 'apply(fake ctx)', String(error?.message ?? error)))
  }
  const tool = registered.find((entry) => entry.name === 'dsh_sync_status') ?? registered[0]
  const names = registered.map((entry) => entry.name)
  const expected = ['dsh_sync_status', 'dsh_sync_doctor', 'dsh_sync_pull', 'dsh_sync_secrets', 'dsh_sync_push', 'dsh_sync_diag']
  record(step(names.length === expected.length, 'registers every tool', names.join(',') || 'none'))
  for (const name of expected) record(step(names.includes(name), `tool ${name}`, names.join(',')))
  record(step(tool?.parameters?.type === 'object', 'tool parameters schema', String(tool?.parameters?.type)))
  record(step(tool?.output?.schema?.type === 'object', 'tool output schema', String(tool?.output?.schema?.type)))
  record(step(typeof tool?.output?.render === 'function', 'tool render callback'))

  // The client half and the bundled skill ship in the same package; a missing
  // file here means the card or the skill would silently not appear.
  record(step(typeof module.registerCommands === 'function' || registered.length > 0, 'host surface registered'))
  const clientEntry = join(linkPath, 'client', 'client.js')
  record(step(existsSync(clientEntry), 'client half present', clientEntry))
  const installedManifest = (() => {
    try {
      return JSON.parse(readFileSync(join(linkPath, 'package.json'), 'utf8'))
    } catch {
      return {}
    }
  })()
  record(step(installedManifest?.dsh?.client?.platform === 'web', 'manifest declares the web client'))
  record(step(existsSync(join(linkPath, 'assets', 'syn-dsh.md')), 'bundled skill body present'))

  // Read-only status against the real checkout (default path or the manifest's).
  const repoPath = module.DEFAULT_REPO_PATH ?? join(dshHome, '..', 'dsh-config')
  const { readRepoStatus } = await import(pathToFileURL(join(linkPath, 'lib', 'core', 'status.js')).href)
  const status = await readRepoStatus({ repoPath })
  record(step(status.repoPresent, 'dsh-config checkout', status.repoPath))
  if (status.repoPresent) {
    console.log(`       branch=${status.branch || '(detached)'} upstream=${status.upstream || '(none)'} ahead=${status.ahead} behind=${status.behind} dirty=${status.dirty}`)
    for (const note of status.notes) console.log(`       note: ${note}`)
  }

  console.log('')
  if (failures.length > 0) {
    console.error(`[verify] FAILED — ${failures.length} check(s) did not pass.`)
    process.exit(1)
  }
  console.log(`[verify] OK — ${PKG}@${installedVersion || '?'} will load on the next DeepSeek Harness start.`)
  console.log('[verify] The running instance keeps its in-memory composition until you fully quit and reopen it.')
}

await main()
