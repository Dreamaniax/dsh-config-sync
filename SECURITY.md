# Security

`dsh-syn-config` runs with the full privileges of the DSH host that loads it, which is why its
boundaries are written down rather than assumed.

## What the plugin can reach

| Surface | Reach | Boundary |
| --- | --- | --- |
| Filesystem | reads `~/.dsh` (profile config, skills, `secrets.env`) and the configured git checkout | never writes `secrets.env`; backups go to `~/.dsh/backups` with mode 0600 |
| git | `git status/log/fetch/pull --ff-only/add/commit/push` in that checkout | never `rebase`, never `push --force`, never `reset --hard` |
| Network | the remote of the configured repository only | no telemetry, no third-party endpoints, no uploads |
| HTTP | one loopback-bound server, four **read-only** `GET` routes (`/status`, `/doctor`, `/secrets`, `/plan`) | the server rejects every other method upstream, so no route can write |
| Secrets | in-process only, to compare/redact/inject locally | never returned by a tool, never logged, never sent anywhere |

## Write defaults

`pull`, `push` and the secret actions are **dry-run by default**; a real mutation needs an explicit
flag or the word `now`. `inject` and `refresh` — the two actions that write a real secret into the
deployed configuration — are **refused** unless the machine opts in with `allowSecretInject: true`.

## What a release contains

The npm tarball and the public snapshot are built **from the tracked tree only**. Both are checked
before every release:

```bash
node scripts/publish-check.mjs          # tracked files: no home paths, emails, scheduler labels, private repo URLs
node scripts/publish-check.mjs --deep   # also reports private tokens in old commits
```

`--deep` is a report, not a gate: history is not shipped, because the public repository is a single
clean snapshot commit. Old commits of the development repository do contain two private tokens (a private repository URL
and a personal scheduler label); if that repository is ever made public, rewrite its history first. Nothing in the published package or snapshot comes from those commits.

## Reporting a vulnerability

Open a private security advisory on https://github.com/Dreamaniax/dsh-syn-config, or a normal issue
if the report contains nothing sensitive. Please include the version (`dsh_sync_diag` prints it) and
the smallest reproduction you have. Do not paste real credentials — a masked prefix is enough.
