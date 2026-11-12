# Roadmap: what a long-lived dsh-syn-config still needs

Written 2026-11-12 against `0.8.7`. The split is deliberate: **necessary** means “without this, the
plugin cannot be maintained by anyone other than its author, or cannot be trusted on a second
machine”; **nice to have** means “improves the experience but no fundamental risk is carried if it
never ships”.

## Necessity test for this plugin

Three properties make a sync plugin different from a normal utility:

1. **It writes to the user's only copy of their configuration.** A bad write is data loss, not a bug.
2. **It is the thing that carries its own future updates.** If a release is wrong, users get the wrong
   version on every machine at once.
3. **It must be identical on two operating systems.** A macOS-only fix is a latent Windows failure.

Anything that weakens one of those three is necessary. Everything else is optional.

---

## Necessary for long-term maintenance

### N1. Continuous integration on both systems — landed in 0.8.9

CI now runs the unit suite, the release gate and a packaging smoke test on
`ubuntu-latest`, `macos-latest` and `windows-latest` across Node 20 and 22
(`.github/workflows/ci.yml`). `parity.mjs` and `verify.mjs` remain local gates
because they need a sibling `dsh-config` checkout. Windows real-hardware
acceptance is still pending (`docs/WINDOWS-TEST.md`).
A GitHub Actions matrix (`macos-latest`, `windows-latest`, `ubuntu-latest`) running
`node --test`, `parity.mjs`, and a packaging smoke test (`npm pack` → install into a throwaway
profile) is the single cheapest way to stop “works on my Mac” from returning.
**Why necessary:** the Windows path (junction, atomic rename, `windowsHide`) has never run on real
hardware; a matrix is the only repeatable proof.

### N2. Release automation with provenance — landed in 0.8.9

A release is now: bump, commit, `scripts/release-public.sh --yes` (snapshot +
tag). The public snapshot's `publish.yml` re-runs every gate, publishes with
provenance and creates the release with the exact tarball. That is exactly
where the 0.8.3 incident came from (a comment block shipped because the gate's exit code was masked by
a pipe). A tag-triggered workflow that runs `publish-check`, tests, `npm publish --provenance`, then
creates the snapshot and the GitHub release makes the order machine-enforced instead of remembered.
**Why necessary:** the plugin carries its own updates (property 2); a release that skips a gate
reaches every machine.

### N3. Compatibility contract and changelog

`engines.dsh` is declared, but nothing checks the *data* written into a profile. Add: a
`CHANGELOG.md` with a semver policy (“breaking = manifest or config shape”), a `manifestVersion`-style
schema version for the profile files it writes, and a `doctor` check that refuses a profile written by
a newer major. **Why necessary:** users upgrade DSH independently of the plugin; without a contract,
the first incompatibility is discovered as a broken startup, not as an error message.

### N4. A lock around mutating runs

Two sessions (or a session plus the GUI) can push or pull at the same time. `git` will usually
serialize, but the snapshot stage can read half-written files. A per-repository lock file with a
stale-lock timeout turns a rare corruption into a clear “another run is in progress”.
**Why necessary:** property 1 — concurrent writes are how configuration gets lost.

### N5. Recovery, not just backups

Backups exist (`~/.dsh/backups`, `0600`), but there is no supported way back. Add
`/syn-dsh restore [--list] [--at <timestamp>]` that lists snapshots and restores one, and a retention
rule that keeps the last N plus one per day. **Why necessary:** a backup nobody can restore from is a
false sense of safety.

### N6. English UI strings

Chip labels, panel buttons, and command output are hard-coded Chinese while the README is bilingual.
Either localize them or make them locale-aware; until then the plugin is not usable by the English
audience the README now addresses. **Why necessary:** it is a correctness gap against the documented
promise, not a cosmetic one.

### N7. Crash-free startup guarantee

Wrap every registration step (already partially done) and add a `doctor` entry that re-runs the
bundled-skill and route registration in-process; a plugin that can make DSH fail to start is worse
than a plugin that reports “unavailable”. **Why necessary:** property 2 again — the update path must
never be able to brick the host.

---

## Nice to have

| Item | Why it is not necessary |
|---|---|
| Diff preview in the panel (per-file, before a push) | Dry-run already reports counts; a diff is convenience, not correctness. |
| Settings page instead of YAML `config` | The YAML is three keys and documented; a form adds surface without new capability. |
| Multi-profile switcher | Most installs have one profile; `profile` already exists as a config key. |
| Background periodic sync | Conflicts with “a human decides when to write”; a timer that pushes is a risk, not a feature. |
| Startup auto-pull with a toast | Nice ergonomics; the chip already makes drift visible; auto-pull can surprise users mid-edit. |
| `status` history / sparkline | Interesting, no decision changes because of it. |
| Marketplace polish (banner, screenshots, catalog entry) | Distribution work; the plugin is installable by name today. |
| Undo last push | Attractive and dangerous; recommendation is to restore from backup (N5) instead. |
| Encrypted secret sync | Contradicts the boundary “secrets are injected by a human”; would need key management and a threat model. |
| Windows installer `.cmd` | `install.mjs` is Node and already cross-platform; a wrapper adds a second path to maintain. |
| Telemetry / crash reporting | Deliberately excluded (no outbound calls); local diagnostics already cover support cases. |

---

## Order I would ship in

1. **N1 + N2** together — CI matrix and tag-triggered release; they make every later change safe.
2. **N3 + N5** — compatibility contract and restore; both are about not losing a user's setup.
3. **N4 + N7** — concurrency lock and startup safety.
4. **N6** — localization, once the surface is stable.
5. Nice-to-haves only when a user asks for a specific one.

## Explicit non-goals

- Storing or transmitting secrets.
- Rewriting git history (`rebase`, `force-push`, `reset --hard`).
- Installing or editing OS schedulers.
- Becoming a general configuration editor for DSH.
