/**
 * Secret plumbing: redact, inject, refresh and fingerprint.
 *
 * The invariants this module exists to protect:
 *
 *   1. the repository copy holds `__KEY_NAME__`, never a real value;
 *   2. the deployed copy holds the real value, and a leftover placeholder
 *      there means the feature is guaranteed to fail authentication, so it is
 *      a hard error, not a warning;
 *   3. a value is treated as literal text. The historical `sed
 *      "s|$value|…|g"` broke on values containing `|`, `&`, `\` or `.`;
 *   4. nothing here returns or logs a value — fingerprints are sha256 prefixes.
 *
 * @module dsh-config-sync/core/secrets
 */

import { createHash } from 'node:crypto'

import { findPlaceholders, parseEnvFile, readTextFile } from './files.js'

/** Read `KEY=value` entries; a missing file is an empty list, not an error. */
export function loadSecrets(secretsPath) {
  const text = readTextFile(secretsPath)
  return text === null ? [] : parseEnvFile(text)
}

/**
 * Replace real values with placeholders (repository direction).
 *
 * @param {string} text
 * @param {{ key: string, value: string }[]} entries
 * @returns {{ text: string, changed: string[] }}
 */
export function redact(text, entries) {
  let output = text
  const changed = []
  for (const { key, value } of entries) {
    if (value === '' || !output.includes(value)) continue
    output = output.split(value).join(`__${key}__`)
    changed.push(key)
  }
  return { text: output, changed }
}

/**
 * Replace placeholders with real values (deployed direction).
 *
 * @param {string} text
 * @param {{ key: string, value: string }[]} entries
 * @returns {{ text: string, injected: string[], leftover: string[] }}
 */
export function inject(text, entries) {
  let output = text
  const injected = []
  for (const { key, value } of entries) {
    if (value === '' || !output.includes(`__${key}__`)) continue
    output = output.split(`__${key}__`).join(value)
    injected.push(key)
  }
  return { text: output, injected, leftover: findPlaceholders(output) }
}

/**
 * Rewrite an `Authorization: "Bearer …"` line with the current key.
 *
 * @param {string} text
 * @param {string} value
 * @returns {{ text: string, changed: boolean }}
 */
export function refreshAuthorization(text, value) {
  if (typeof text !== 'string' || value === '') return { text, changed: false }
  const pattern = /Authorization: "Bearer [^"]*"/gu
  if (!pattern.test(text)) return { text, changed: false }
  return { text: text.replace(/Authorization: "Bearer [^"]*"/gu, `Authorization: "Bearer ${value}"`), changed: true }
}

/**
 * One-line fingerprint per key: sha256 prefix and length, never the value.
 *
 * @param {{ key: string, value: string }[]} entries
 * @returns {{ key: string, sha256: string, length: number }[]}
 */
export function fingerprint(entries) {
  return entries.map(({ key, value }) => ({
    key,
    sha256: createHash('sha256').update(value).digest('hex').slice(0, 8),
    length: value.length,
  }))
}

/** Value of one key, or null. */
export function secretValue(entries, key) {
  const found = entries.find((entry) => entry.key === key)
  return found === undefined ? null : found.value
}
