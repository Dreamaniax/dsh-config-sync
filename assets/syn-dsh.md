---
name: syn-dsh
description: "跨电脑同步 DSH 配置（技能 / 插件 / profile 设置 / AGENTS.md）与私有仓库 ~/dsh-config：拉取、推送、新机全量恢复、体检与失败排查。当用户说「同步 dsh」「syn_dsh」「更新另一台机器的配置」「把配置推到仓库」「换电脑恢复配置」「为什么技能没同步」时使用。"
---

# Syn DSH（跨电脑同步 DSH 配置）

把「本机 `~/.dsh`」和「私有配置仓库 `~/dsh-config`」双向对齐。所有命令都在仓库目录里跑。

## 优先用插件（已装 `dsh-syn-config` 时）

插件把日常动作做成了工具与命令，脚本退居「引导 + CI + 提交闸门」：

| 想做的事 | 会话里 | 命令 | 对应脚本（兜底） |
|---|---|---|---|
| 看是否同步 | 问「dsh 同步了吗」/ 调 `dsh_sync_status` | `/syn-dsh status` | `doctor.sh`（只读版） |
| 完整体检 | 调 `dsh_sync_doctor` | `/syn-dsh doctor` | `doctor.sh` |
| 拉取 | 调 `dsh_sync_pull`（默认 dry-run） | `/syn-dsh pull now` | `update.sh` |
| 推送 | 调 `dsh_sync_push`（默认 dry-run） | `/syn-dsh push now` | `pack.sh` + `sync.sh` |
| 密钥 | 调 `dsh_sync_secrets` | `/syn-dsh secrets scan` | `secrets.sh` |
| 新机引导 / CI | —— 插件管不到 | —— | `apply.sh` / `selftest.sh` |

插件铁律：写操作默认 dry-run；推送分叉时**只停不 rebase**；`--delete` 默认降级为「报告 + 显式确认」；`reasoningEffort` 永不同步。

仓库位置：`~/dsh-config`（本机惯例；插件默认也是这个路径，可在配置里改）
远端：`https://github.com/<owner>/dsh-config`（私有）
profile：`desktop`；技能目录：`~/.dsh/skills`；跨 agent 技能：`~/.agents/skills`

## 平台（先判断，再决定用哪条命令）

| 系统 | 日常命令 | 说明 |
|---|---|---|
| macOS / Linux | `./scripts/update.sh` | bash + rsync（有就用 rsync） |
| Windows（推荐） | `scripts\win\update.cmd` | 自动定位 Git for Windows 的 bash；不需要 WSL |
| Windows（Git Bash 里） | `./scripts/update.sh` | 与 macOS 完全一致 |

Windows 首次：`git clone … %USERPROFILE%\dsh-config` → `scripts\win\apply.cmd --yes` → 用 PowerShell 写 `secrets.env` → **再跑一次** `apply --yes` 让密钥注入。

## 何时用

- 用户说「同步 dsh / syn_dsh / 把配置同步一下 / 拉最新配置」
- 换电脑后第一次恢复配置
- 刚改完技能或插件，要推给另一台
- 同步出问题（冲突、推送失败、技能没生效）来排查

## 一句铁律

仓库是唯一真相源。本机 `~/.dsh` 与仓库之间只有两个方向：**拉**（update / apply）和**推**（sync）。
不确定就先体检（只读），不要靠猜，也不要靠记忆里的参数。所有参数以脚本自带 `--help` 为准。

**例外：`reasoningEffort` 永不同步。** 它是本机模型 / 思考强度 chip 的状态，不是跨机配置：
`pack.sh` 保留仓库里的值（不把本机值推上去），`apply.sh` 保留本机值（不把仓库值盖下来），
`doctor.sh` 比较时忽略这一行。手工提交、PR、周报也不要把它带进仓库。

## 第一步永远是体检

```bash
cd ~/dsh-config && ./scripts/doctor.sh        # macOS/Linux
cd %USERPROFILE%\dsh-config && scripts\win\doctor.cmd   # Windows
```

只读（仅 `git fetch`），报告：git/rsync 可用性、工作区是否脏、落后/领先几个提交、仓库与本机技能数及**差集**、缺 `SKILL.md` 的技能、`secrets.env` 权限与键名（不打印值）、仓库明文密钥扫描、**设置与插件清单是否和仓库一致**（把真实密钥换回占位符后比对，只报差异行数）。

退出码：`0` 干净 · `2` 有警告可继续 · `1` 有阻塞（先修再同步）。
`--offline` 不联网；`--quiet` 只打结论。

## 决策表

| 用户的意思 | 动作 | 命令 |
|---|---|---|
| 「同步一下」（默认） | 拉 + 体检 + 本机有漂移就推 | 见下方「默认流程」 |
| 拉 / 更新 / 另一台改了 | 只拉技能（秒级） | `./scripts/update.sh` |
| 连插件、设置、AGENTS.md 一起拉 | 拉 + 恢复 profile + 重装插件 | `./scripts/update.sh --all` |
| 只看会变什么 | 不动文件 | `./scripts/update.sh --dry-run` |
| 推 / 上传 / 这台改好了 | 快照 + 提交 + 推送 | `./scripts/sync.sh "说明"` |
| 新电脑 / 第一次 | clone + 全量恢复 + 补密钥 | 见「新电脑第一次」 |
| 只想看状态 / 排查 | 体检 | `./scripts/doctor.sh` |
| 换了密钥 / 要轮换 | 记指纹 → 换 key → 再记指纹 → apply → verify | `./scripts/secrets.sh fingerprint`（只出 sha256 前缀，不出明文） |
| 「到底能不能用 / 环境闭环了吗」 | 端到端验收（含真实 AnySearch 调用与重启检测） | `./scripts/verify.sh`（`--no-net` 跳过联网） |
| 装/改周报定时任务 | 跨平台调度器 | `./scripts/schedule.sh`（mac launchd / win schtasks / Linux 给 cron 行） |

## 默认流程（用户只说「同步一下」时照这个走）

1. `./scripts/doctor.sh`
   - 退出 `1`：先修阻塞项（没有 remote / 找不到 git / 仓库有明文密钥），**不要继续同步**。
2. 拉：`./scripts/update.sh`
   - 失败（网络/鉴权）：如实报告「拉取失败」+ 错误摘要并停止。**此时不要推**，否则可能覆盖另一台的提交。
3. 判断本机是否有未推送改动 —— **以 `doctor.sh` 为准，不要只看 `git status`**：
   ```bash
   cd ~/dsh-config && ./scripts/doctor.sh --quiet     # 看「仅本机有（未入库）」+「工作区 N 处未提交改动」
   ```
   - 两边都空 → 已一致，跳到第 5 步。
   - 有「仅本机有」→ 那是 `~/.dsh/skills` 里的新/改技能，`git status` 看不到（要先 `pack.sh` 才进仓库），必须走第 4 步推送。
   - 有「cordis.patch.yml 与仓库差 N 行」→ 本机改了设置（模型/UI/MCP），也要推；反过来想在本机应用另一台的设置，用 `update.sh --all`。
   - 有「package.json（插件清单）与仓库不同」→ 本机装了/卸载了插件，同上处理。
   - 工作区脏 → 先看摘要：`git -C ~/dsh-config diff --stat | tail -20`。
4. 推送 `./scripts/sync.sh "sync: <一句话说明>"`
   - 只有 `skills/` `agents-skills/` 变动 → 可直接推。
   - 动了 `profiles/`、`AGENTS.md`、插件清单 → **必须先给用户看 diff 摘要并确认**，这些会影响所有电脑的模型、插件和指令。
   - 用户没说要推、且改动涉及配置/插件时，问一句再推。
5. 验收（必须贴证据，不许说「应该没问题」）：
   - `./scripts/doctor.sh --quiet` 没有 ❌ 和 ⚠️（技能数相等、设置与仓库一致）
   - commit 短哈希 + 是否出现「✅ 已推送」
   - 生效提示：技能要**新开会话**才加载；插件/设置改动要重启客户端

## 新电脑第一次（`/syn-dsh` 还不存在时）

技能本身来自仓库，所以新机上 `/syn-dsh` 还没有——第一次必须手工 bootstrap 一次，跑完技能才会出现：

```bash
# 0) 装同版本 DSH 桌面端，用同一账号登录一次（生成 ~/.dsh）
# 1) 私有仓库先授权：gh auth login / PAT / SSH key（首次 clone 会弹凭据管理器）
git clone https://github.com/<owner>/dsh-config ~/dsh-config
cd ~/dsh-config
./scripts/doctor.sh        # 可选：只读体检
./scripts/apply.sh         # 先 dry-run 看差异
# 2) 先写密钥再 apply --yes：缺 secrets.env 时 apply 检测到未注入占位符会回滚（退出码 1）
printf 'ANYSEARCH_API_KEY=%s\n' '你的key' >> ~/.dsh/secrets.env && chmod 600 ~/.dsh/secrets.env
./scripts/apply.sh --yes   # 全量：技能 + profile + AGENTS.md + 重装插件
# 3) 新开会话 → /syn-dsh 与其余技能就位
```

Windows 用 `scripts\win\doctor.cmd` / `scripts\win\apply.cmd`（参数相同，自动找 Git Bash，不需要 WSL）：

```bat
git clone https://github.com/<owner>/dsh-config %USERPROFILE%\dsh-config
cd %USERPROFILE%\dsh-config
scripts\win\apply.cmd               :: dry-run
echo ANYSEARCH_API_KEY=你的key> %USERPROFILE%\.dsh\secrets.env
scripts\win\apply.cmd --yes
```

注意：

- 仓库是私有的，没凭据第一步就 clone 不下来。
- **顺序不能反**：`secrets.env` 必须在 `apply --yes` 之前存在；若先 apply 失败，补好密钥后重跑同一条 `apply --yes` 即可（它自己会 inject，不必单独跑 `secrets.sh inject`）。
- `apply --yes` 第 5 步会重装插件；仓库里的插件版本与新客户端运行时不一致时这一步会报警，按提示对齐版本，别当成功。
- 首次 clone 约 141 MB，慢是正常的；还没有 remote 时用 `./scripts/publish.sh`。

## 日常拉取

```bash
cd ~/dsh-config && ./scripts/update.sh            # 只技能，秒级
cd ~/dsh-config && ./scripts/update.sh --all      # 连 profile 配置 / AGENTS.md / 重装插件
cd ~/dsh-config && ./scripts/update.sh --mirror   # 额外删除仓库里没有的技能（危险：先问用户 + 先 --dry-run）
```

`update.sh` 会 `git pull --ff-only` → 打印本次变动技能 → rsync 到 `~/.dsh/skills` 与 `~/.agents/skills` → 自检技能数。

## 本机改动推回

```bash
cd ~/dsh-config && ./scripts/sync.sh "sync: 新增 X 技能"
```

等于 `pack.sh`（本机 → 仓库快照）→ `secrets.sh redact` + `scan`（发现明文直接中止，不提交）→ commit → push。
没有变化时输出「没有变化，无需提交。」，不要当失败。

## 密钥轮换

```bash
vim ~/.dsh/secrets.env                          # 改成新值
cd ~/dsh-config && ./scripts/secrets.sh refresh # 本机配置里的旧值 → 新值
# 重启 DSH 生效。key 不贴进对话、提交信息、周报、截图
```

## 失败处置

| 现象 | 原因 | 处理 |
|---|---|---|
| `git pull --ff-only` 失败或冲突 | 两台都改了同一文件（常见 `cordis.patch.yml` / `package.json`） | 先保住本机改动：`git -C ~/dsh-config stash push -m wip` → `update.sh` → `stash pop` 手工合。**绝不** `git checkout -- .`、`git reset --hard`（会丢本机技能改动） |
| 推送失败 | 断网 / 凭据过期 / 非快进 | 回「已落地但未同步」+ 错误摘要，下次会话先补推（`sync.sh` 幂等）。不得声称已同步 |
| `pack.sh` 报「仍有明文密钥，已中止」 | 配置里写了真实 key | 值挪进 `~/.dsh/secrets.env`，配置改 `__KEY_NAME__`，再 `./scripts/secrets.sh redact` |
| 另一台说没变化，但确实改了 | 那台没推成功 | 到那台跑 `doctor.sh` 看「领先 N 个提交」；补推成功后本机再 `update.sh` |
| 技能数不相等 | `--mirror` 未跑 / 缺 `SKILL.md` / rsync 权限 | `doctor.sh` 看差集与「缺 SKILL.md」清单 |
| 拉完新技能不出现 | 技能在**会话启动**时加载 | 新开一个会话；插件变更需重启客户端 |
| `/usr/bin/git` 报 exit 69 | Xcode 许可 | 脚本已自动优先 Xcode 自带 git；或 `sudo xcodebuild -license accept` |
| 脚本报 `xxx: unbound variable` | bash 3.2 把紧跟变量的全角字符吞进变量名 | 输出用 `${VAR}` 而不是 `$VAR`（写脚本时注意；全仓库已扫过一遍） |
| `$'\r': command not found` | Windows 上 `.sh` 被 autocrlf 转成 CRLF | 仓库有 `.gitattributes` 兜底；若仍出现，`git config core.autocrlf false` 后重 clone |
| Windows 报 `rsync: command not found` | 老版本脚本或自建 shim | 直接用 `scripts\win\*.cmd`；新版 `scripts/_lib.sh` 无 rsync 时自动用 cp/find |
| `apply` 报「仍有未解析的密钥占位符」 | `secrets.env` 缺键或没建 | 补键后重跑 `apply --yes`；**已自动回滚**，不会把坏配置激活（DSH 继续用上一份可用配置） |
| `apply` 报「secrets.env 里没有这些键名」但文件肉眼看正常 | 文件末尾缺换行，`read` 丢掉最后一行（Windows `Set-Content -NoNewline` / `echo\|set /p` 易踩） | 已修（`read ... \|\| [ -n "$k" ]`）；写入时用 `printf '...\n'` 或换行结尾 |
| `verify` 报「配置比 DSH 进程新」但功能已经能用 | MCP 配置热加载；时间戳只说明配置新，不说明没生效 | 第 4 项通过时自动降级为提示；只有主题/模型/插件类改动建议重启 |

## Windows 已知差异（脚本已处理，知道就行）

- **没有 rsync**：`scripts/_lib.sh` 用 `cp/find` 实现同样语义（`--delete`/`--dry-run` 都支持），别再手搓 shim。
- **没有 600 权限**：`secrets.env` 靠 NTFS ACL；doctor 在 Windows 上跳过 600 检查，只确认文件存在。
- **换行符**：`.gitattributes` 强制 `*.sh`=LF、`*.cmd`=CRLF。
- **周报流水线**（`~/.dsh/learning/` + launchd）只在 macOS 配置过；Windows 要另建目录 + 任务计划程序，不随仓库同步。
- **`dsh` 命令可能不在 PATH**：`apply` 会提示，改用桌面端「设置 → 插件」按 `MANIFEST.md` 装。
- **平台快照**：`MANIFEST.md` 只放跨机一致的内容；机器名/平台写在本地 `MANIFEST.local.md`（已 gitignore），避免来回 push 产生噪声 diff。

## 一条验收原则（真机踩出来的）

**强证据定结论，弱证据降提示。** 端到端调用（真实 `tools/call`）能证明"能用"时，进程启动时间、文件 mtime 这类弱证据只能作提示，不得推翻实测：
- `verify` 第 4 项通过 → 第 5 项（配置是否比进程新）降为 ⚠️，不计缺口；只有端到端失败时它才升 ❌
- 同一台机器上两个检查给出矛盾信号时，先问"哪个是实测、哪个是推断"，不要让用户自己裁决

## 硬规则

- **永不**把 `~/.dsh/secrets.env`、`.credentials.yaml`、`~/.dsh/sessions/` 提交进仓库；真实 key 只在 `secrets.env`（`chmod 600`）。
- **永不** `git push --force`：会覆盖另一台的历史。冲突一律手工合并。
- `--mirror` 会删本机技能：先问用户，先用 `--dry-run` 看会删什么。
- `apply.sh --yes` 会覆盖本机 `~/.dsh` 配置（旧文件留 `.bak-<时间戳>`）：第一次必须让用户先看 dry-run 输出。
- 推送前必须能说清「改了哪些技能 / 有没有动配置」；说不清就先 `git diff --stat`。
- **reasoningEffort 永不同步**：模型/强度是本机状态。不要用 `sync.sh` 推送它，也不要用 `update.sh --all` 覆盖它；脚本已内置双向保留，别绕过脚本手工改仓库里的这一行。
- 汇报必须带证据：技能数、commit 短哈希、是否已推送。没成功就写「未同步」+ 原因，不许用「应该没问题」代替验收。

## 跨平台回归（改脚本后必跑）

```bash
cd ~/dsh-config && bash scripts/cross-platform-selftest.sh
```

它在临时目录里模拟「两台机器 + 一个本地裸远端」：A（macOS 风格）→ pack/sync → B（HOME 带空格、无 rsync）→ update/apply/doctor → B 反向 push → A 拉取。覆盖绝对 `link:` 归一化、密钥脱敏/注入、`reasoningEffort` 双向保留、CRLF、无 rsync 兜底。GitHub Actions 在 ubuntu / macOS / Windows 三个 runner 上跑同一份；Windows 还会冒烟 `scripts\win\pack.cmd`。

## 汇报格式（中文，≤12 行）

1. **结论**：已一致 / 拉取了 N 个技能 / 推送了 commit `abc1234` / 失败原因
2. **变化**：改动的技能名（超过 10 个只列前 10 + 共几个）；是否动了配置/插件
3. **生效**：新开会话（技能）/ 重启客户端（插件）
4. **待办**：缺密钥、冲突未合、推送失败等
