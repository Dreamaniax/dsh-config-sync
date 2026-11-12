/**
 * Packaging smoke test: build the tarball, unpack it, and prove the shipped
 * artefact is loadable and complete. Runs on every OS in CI.
 *
 * It answers three questions the unit tests cannot:
 *   1. does `npm pack` include everything the plugin needs at runtime?
 *   2. does the packed module import outside this checkout (no link, no devDeps)?
 *   3. does the icon obey the host contract (inside the package, <= 256 KiB)?
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'dsh-syn-config-pack-'))

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) {
    console.error(result.stdout ?? '')
    console.error(result.stderr ?? '')
    throw new Error(`${command} ${args.join(' ')} failed with ${result.status}`)
  }
  return result.stdout.trim()
}

try {
  const name = run('npm', ['pack', '--silent', '--pack-destination', dir]).split('\n').pop()
  const tarball = join(dir, name)
  run('tar', ['-xzf', tarball, '-C', dir])

  const packed = join(dir, 'package')
  const manifest = JSON.parse(readFileSync(join(packed, 'package.json'), 'utf8'))

  const required = [
    'lib/index.js',
    'client/client.js',
    'assets/icon-180.png',
    'cordis.patch.yml',
    'docs/RELEASE.md',
    'LICENSE',
  ]
  const missing = required.filter((file) => {
    try {
      statSync(join(packed, file))
      return false
    } catch {
      return true
    }
  })
  if (missing.length > 0) throw new Error(`packed tarball is missing: ${missing.join(', ')}`)

  const icon = readFileSync(join(packed, manifest.icon))
  if (icon.byteLength > 262_144) throw new Error(`icon is ${icon.byteLength} bytes, the host limit is 262144`)

  const module = await import(pathToFileURL(join(packed, 'lib/index.js')).href)
  if (typeof module.apply !== 'function') throw new Error('packed module does not export apply()')
  if (typeof module.inject === 'undefined') throw new Error('packed module does not export inject')

  console.log(`pack smoke ok: ${name} · ${manifest.name}@${manifest.version} · icon ${icon.byteLength} bytes`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
