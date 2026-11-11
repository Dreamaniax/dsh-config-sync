#!/usr/bin/env node
/**
 * Publish hygiene check.
 *
 * The plugin contains no user data at runtime, but a repository prepared on a
 * personal machine accumulates identifiers: an account name in install
 * commands, a private repository URL inside the bundled skill, a launchd label,
 * absolute home paths. Publishing under someone else's account is fine; leaking
 * the author's private infrastructure is not.
 *
 * This script scans the tracked files and prints what a public release would
 * expose. It exits 1 when anything is found, so it can gate a release.
 *
 * Usage:
 *   node scripts/publish-check.mjs [--repo <path>] [--allow <substring>]...
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
let repo = here
// Documented examples that are intentionally generic.
const allowed = ['/Users/you/', 'Dreamaniax']
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === '--repo') {
    repo = resolve(argv[index + 1] ?? '')
    index += 1
  } else if (argv[index] === '--allow') {
    allowed.push(argv[index + 1] ?? '')
    index += 1
  }
}

const checks = [
  { name: 'account name in a GitHub spec', pattern: /github\.com\/[A-Za-z0-9-]+/gu },
  { name: 'absolute home path', pattern: /\/Users\/[A-Za-z0-9_.-]+\//gu },
  { name: 'Windows home path', pattern: /[A-Za-z]:\\Users\\[A-Za-z0-9_.-]+\\/gu },
  { name: 'launchd or scheduler label with a personal reverse domain', pattern: /com\.[a-z0-9-]+\.dsh\.[a-z0-9-]+/gu },
  { name: 'private repository mention', pattern: /dsh-config\.git/gu },
  { name: 'email address', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu },
]

let files = []
try {
  files = execFileSync('git', ['-C', repo, 'ls-files'], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.trim() !== '')
} catch {
  console.error('[publish-check] not a git checkout, or git is missing')
  process.exit(1)
}

const findings = []
for (const file of files) {
  if (file.startsWith('package-lock') || file.startsWith('pnpm-lock')) continue
  let text = ''
  try {
    text = readFileSync(join(repo, file), 'utf8')
  } catch {
    continue
  }
  for (const check of checks) {
    // Test fixtures intentionally contain synthetic paths and emails.
    if (file.startsWith('test/') && (check.name === 'absolute home path' || check.name === 'email address')) continue
    check.pattern.lastIndex = 0
    let match
    while ((match = check.pattern.exec(text)) !== null) {
      const value = match[0]
      if (allowed.some((entry) => value.includes(entry))) continue
      findings.push({ file, check: check.name, value })
    }
  }
}

if (findings.length === 0) {
  console.log(`[publish-check] OK — ${files.length} tracked files, no personal identifiers found.`)
  console.log('')
  console.log('Release checklist:')
  console.log('  1. parameterise the owner in install instructions (README, scripts/install.mjs)')
  console.log('  2. remove private repository URLs from assets/syn-dsh.md')
  console.log('  3. tag a release (vX.Y.Z) and tell users to pin that tag, not the branch')
  console.log('  4. add SECURITY.md describing what the plugin can do (git, ~/.dsh, local HTTP route)')
  process.exit(0)
}

console.log(`[publish-check] ${findings.length} identifier(s) found in tracked files:`)
for (const finding of findings.slice(0, 40)) {
  console.log(`  ${finding.file}: ${finding.check} → ${finding.value}`)
}
if (findings.length > 40) console.log(`  … and ${findings.length - 40} more`)
console.log('')
console.log('Use --allow <substring> for values that are intentionally public.')
process.exit(1)
