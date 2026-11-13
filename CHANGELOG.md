# Changelog

## 0.8.11 — 2026-11-13

- Release assets now include a stable `dsh-syn-config.tgz` next to the versioned tarball, so catalog
  entries and install instructions can point at `releases/latest/download/` without going stale.
- Privacy and security pass before release: tracked tree, full history, npm tarball, public snapshot,
  configuration repository and deployed profile all re-scanned; no plaintext credentials, personal
  paths or private repository identifiers found.

## 0.8.10 — 2026-11-12

- The bundled skill is model-only (`userInvocable: false`); `/syn-dsh` is the single slash entry.
- CI runs on ubuntu, macos-15 and windows across Node 20 and 22; releases are tag-driven, publish
  with npm provenance and create the GitHub release themselves.

## 0.8.9 — 2026-11-12

- Packaging smoke test (pack → unpack → import outside the checkout → icon contract).
- `publish-check --deep` reports private tokens in old commits.

## 0.8.8 — 2026-11-12

- Release page rewritten for users, in English and Chinese.
- `docs/ROADMAP.md` separates long-term necessities from nice-to-haves.

## 0.8.7 — 2026-11-12

- Privacy pass: tree gate unchanged, history reported, module docs renamed to the shipping package.

## 0.8.6 — 2026-11-12

- `icon` in the package manifest, so the host renders the shipped artwork on the plugin card.
