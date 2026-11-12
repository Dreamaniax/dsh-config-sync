# dsh-syn-config

<p align="center"><img src="assets/icon-180.png" width="96" height="96" alt="dsh-syn-config icon"></p>

Keep a DeepSeek Harness setup — skills, profile settings, `AGENTS.md` — in sync across computers
through a private git repository. One codebase for macOS and Windows.
把 DeepSeek Harness 的配置（技能 / profile 设置 / `AGENTS.md`）通过一个私有 git 仓库在多台电脑之间同步。macOS 与 Windows 共用同一份代码。

---

## Features · 功能

| Feature | 功能 | What it does · 说明 |
|---|---|---|
| Status tool | 状态 | Reads branch, upstream, ahead/behind, dirty count. Network is opt-in (`fetch: true`). · 读分支、上游、领先/落后、脏文件数；默认不联网。 |
| Doctor tool | 体检 | Six sections with the same verdicts and exit codes as `doctor.sh` (0 clean / 2 warnings / 1 blocking), returned as structured JSON. · 六节体检，判定与退出码和 `doctor.sh` 一致，返回结构化 JSON。 |
| Pull tool | 拉取 | `git pull --ff-only`, then mirrors `skills/`, `agents-skills/`, `weekly/` into `~/.dsh`. Dry-run by default. · 快进拉取后镜像技能与周报脚本；默认演练。 |
| Push tool | 推送 | Snapshot → lint → redact → scan → commit → push. Dry-run by default; stops on divergence instead of rebasing or forcing. · 快照→lint→脱敏→扫描→提交→推送；默认演练；分叉即停。 |
| Secrets tool | 密钥 | `scan` / `redact` / `inject` / `refresh` / `fingerprint`. Refuses to write a real secret unless the machine explicitly opts in. · 五个动作；除非本机显式开启，否则拒绝写入真实密钥。 |
| Diagnostics tool | 自检 | Reports what actually registered at startup — service availability and the error text of each step. · 报告本次启动真正注册了什么：服务可用性与每一步的错误原文。 |
| Slash command | 斜杠命令 | `/syn-dsh status · doctor · pull · push · secrets`; writes need the word `now`. · 写操作必须带 `now`。 |
| Status chip + panel | 状态灯与面板 | A dot above the input box, with a read-only panel behind it (see UI below). · 输入框上方的圆点，点开是只读面板（见下）。 |
| Bundled skill | 随包技能 | `syn-dsh` ships inside the package, so the instructions travel with the plugin. · 技能随包分发，不依赖配置仓库。 |

## UI · 界面

Three surfaces, all inside DeepSeek Harness. There is no separate web app, no settings window, and no
tray icon.
三个界面，全部在 DeepSeek Harness 内。没有独立网页、没有设置窗、没有托盘图标。

### 1. Status chip · 状态圆点

Above the composer, always visible. Colour answers “am I in sync?”.

| Colour | Label | Meaning |
|---|---|---|
| 🟢 green | `main 已同步` | Clean, nothing ahead/behind. · 干净，无领先/落后。 |
| 🟡 amber | `main ↑2 ±1` | Drift: `↑` ahead, `↓` behind, `±` dirty files. · 有漂移。 |
| 🔴 red | `无仓库` / `读取失败` | `~/dsh-config` missing, or git could not be read. · 仓库缺失或读取失败。 |
| ⚪️ grey | `同步就位` / `检查中…` | Route not exposed in this composition, or still loading. Never painted red for that. · 路由不可用或加载中，不误报为故障。 |

### 2. Panel · 面板

Click the chip. Width ≈360 px, four actions, each a read-only `GET`:

| Button | 按钮 | Shows · 展示 | Acts via · 真正的写操作 |
|---|---|---|---|
| 体检 | Doctor | Section marks (`✅⚠️❌`) + blocking/warning counts | `/syn-dsh doctor` |
| 拉取计划 | Pull plan | Incoming commits, `before → after`, per-mirror `+add ~update -delete` | `/syn-dsh pull now` |
| 推送计划 | Push plan | Change counts, gate results (`lint / redact / scan`), commit state | `/syn-dsh push now` |
| 密钥扫描 | Secrets scan | Number of plaintext hits | `/syn-dsh secrets scan` |

Every result has a **复制命令** button that copies the exact command that would perform the write; the
panel itself cannot write.
每个结果旁有「复制命令」，复制的是真正执行写入的那条命令；面板本身不能写。

### 3. Command output · 命令输出

`/syn-dsh` renders compact tables (status row, doctor six rows with counts, plan diff rows). The same
data is available as JSON from the six tools, so agents can act on it without parsing prose.
`/syn-dsh` 输出紧凑表格；同样的数据也能从六个工具以 JSON 取得，模型不必解析自然语言。

## Boundaries · 边界

| Boundary | 边界 | Detail · 细节 |
|---|---|---|
| No GUI writes | 面板不写 | All four panel actions are `GET` on read-only routes; every other method returns 405. · 四个面板动作都是只读 GET，其它方法 405。 |
| Dry-run by default | 默认演练 | `pull`, `push`, and all secret writes do nothing until an explicit flag or the word `now`. · 未显式确认前不产生任何写入。 |
| Git is never rewritten | 不改写历史 | No `rebase`, no `push --force`, no `reset --hard`. Divergence stops and asks a human to merge. · 分叉时停下交给人合并。 |
| Secrets stay human-injected | 密钥由人注入 | `inject` / `refresh` are refused unless the profile opts in with `allowSecretInject: true`. The documented path is running `apply.sh --yes` yourself. · 默认拒绝，推荐人工执行。 |
| No telemetry, no outbound calls | 无遥测、无外联 | Only the git remote you configured; one loopback-bound HTTP server for the panel. · 只连你自己配置的 git 远端；面板只走本机回环。 |
| Upload scope is explicit | 上传范围明确 | `skills/`, `agents-skills/`, `AGENTS.md`, five profile files. `.dsh-market/` is opt-in; `sessions/`, `secrets.env`, credentials are never uploaded. · 会话、密钥、凭据永不上传。 |
| The plugin is not the bootstrap | 插件不是引导 | On a brand-new machine the plugin does not exist yet; `dsh-config/scripts/apply.sh` is what installs it. · 新机第一条命令仍是 `apply.sh`。 |
| Not a scheduler | 不是调度器 | It syncs `weekly/` scripts but never installs or edits cron / launchd / Task Scheduler entries. · 只同步脚本，不装定时任务。 |

## Install · 安装

Production (npm):

```bash
dsh plugin --profile desktop add dsh-syn-config
```

From GitHub:

```bash
dsh plugin --profile desktop add github:Dreamaniax/dsh-syn-config
```

`dsh plugin add` writes `dependencies` + lock but **not** `dsh.profile.bundles`; the GUI path
(Settings → Plugins) writes both. After installing, fully quit and reopen DeepSeek Harness.
`dsh plugin add` 只写依赖与 lock，不写 bundles；GUI 安装会写全。装完完全退出重开。

Development / offline (link install):

```bash
node scripts/install.mjs --dry-run
node scripts/install.mjs
node scripts/verify.mjs
```

Uninstall:

```bash
node scripts/uninstall.mjs --dry-run
node scripts/uninstall.mjs
```

The uninstaller removes only the projection (symlink / junction, never following it into the target)
and the two manifest entries; backups are kept.
卸载只删投影与清单两处条目，保留备份。

## Command reference · 命令参考

| Command | 命令 | Meaning · 含义 |
|---|---|---|
| `/syn-dsh status` | 状态 | Same data as the chip, as text. · 与状态灯同源。 |
| `/syn-dsh doctor` | 体检 | Six sections; add `online` to allow `git fetch`. · 六节体检，`online` 才联网。 |
| `/syn-dsh pull` | 拉取 | Dry-run; `pull now` performs the fast-forward pull + mirror. · 默认演练。 |
| `/syn-dsh push` | 推送 | Dry-run; `push now` performs snapshot → gates → commit → push. · 默认演练。 |
| `/syn-dsh secrets` | 密钥 | `scan` or `fingerprint`; write actions are refused here. · 只读动作。 |

## Configuration · 配置

Add `config` to the plugin row in the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-syn-config
      name: 'dsh-syn-config'
      config:
        repoPath: '~/dsh-config'
        gitTimeoutMs: 15000
        fetchOnStatus: false
        allowSecretInject: false
```

| Key | Default | Meaning · 含义 |
|---|---|---|
| `repoPath` | `~/dsh-config` | Checkout to read and write. · 仓库路径。 |
| `gitTimeoutMs` | 15000 | Timeout for a single git call. · 单次 git 调用超时。 |
| `fetchOnStatus` | `false` | Let status reach the network by default. · 状态默认是否联网。 |
| `profile` | `desktop` | Profile inspected by doctor. · 体检的 profile。 |
| `dshHome` | `~/.dsh` | Where the live configuration lives. · 本机配置根目录。 |
| `allowSecretInject` | `false` | Allow tools to write real secrets. Leave off. · 是否允许工具写真实密钥，建议保持关闭。 |

## Privacy · 隐私

| Surface | 面 | Behaviour · 行为 |
|---|---|---|
| Redaction | 脱敏 | Literal replacement, real value → `__KEY__`; backups are `0600`. · 字面量替换，备份 0600。 |
| Injection | 注入 | Refused if any placeholder would remain; always written with a backup. · 有残留占位符则拒绝写盘。 |
| Scanning | 扫描 | Working tree, plus the last 200 commits with `deep:true`; provider-prefixed shapes are decisive. · 工作树 + 最近 200 条提交。 |
| Reporting | 报告 | Findings show a commit and a masked prefix, never the value; absolute paths collapse to `~/…`. · 只给掩码，不回传原值。 |
| Commit messages | 提交信息 | Messages containing a URL or credential shape are rejected before commit. · 含 URL/凭据特征直接拒绝。 |
| Local routes | 本机路由 | Only counts and branch names; no file names; `Cache-Control: no-store`. · 不含文件名。 |
| Release gate | 发布闸门 | `node scripts/publish-check.mjs` scans the tracked tree; `--deep` also reports private tokens in old commits. · 发布前必跑。 |

## Development · 开发

```bash
node --test "test/*.test.mjs"    # 101 tests: parsing, redaction, scanning, doctor sections,
                                 # real git repositories, plugin contract, HTTP routes
node scripts/parity.mjs          # doctor parity with scripts/doctor.sh
node scripts/verify.mjs          # manifest / projection / module / tools / repository
node scripts/publish-check.mjs   # release hygiene gate
```

The browser half is plain JavaScript with no build step; the module table supplies React.
浏览器半是纯 JavaScript，无构建步骤。

## License · 许可

MIT. The Windows projection and atomic-write logic are adapted from `dsh-model-effort-chips` (MIT).
MIT。Windows 投影与原子写逻辑改编自 `dsh-model-effort-chips`（MIT）。
