/**
 * What actually registered, and why it did not.
 *
 * A host plugin can fail in ways that are invisible from outside: reading a
 * service without declaring it throws, a command registration can be rejected,
 * a slot name can be wrong. Every registration step in `apply()` therefore
 * records its outcome here, and the `dsh_sync_diag` tool reports it — so
 * "is it loaded?" is a question the agent can answer instead of guess.
 *
 * @module dsh-syn-config/core/diagnostics
 */

const state = {
  version: '',
  startedAt: '',
  services: {},
  steps: [],
  tools: [],
}

/** Reset for a fresh activation (a reload runs `apply()` again). */
export function resetDiagnostics(version) {
  state.version = version
  state.startedAt = new Date().toISOString()
  state.services = {}
  state.steps = []
  state.tools = []
}

/** Record one registered tool name. */
export function recordTool(name) {
  if (!state.tools.includes(name)) state.tools.push(name)
}

/** Record that a service was or was not available. */
export function recordService(name, value) {
  state.services[name] = value === undefined || value === null ? 'missing' : 'available'
}

/** Record one registration step. */
export function recordStep(name, ok, detail = '') {
  state.steps.push({ name, ok, detail: String(detail).slice(0, 200) })
}

/** A snapshot the tool can return. */
export function readDiagnostics() {
  return {
    version: state.version,
    startedAt: state.startedAt,
    services: { ...state.services },
    tools: [...state.tools],
    steps: state.steps.map((step) => ({ ...step })),
  }
}
