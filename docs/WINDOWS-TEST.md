# Windows 真机验收（手工，逐条粘贴）

目标：在真实 Windows 主机上验证当前 GitHub CI 覆盖不到的东西——junction 安装、`windowsHide`、
盘符与空格路径、PowerShell 默认编码、Git for Windows 的 `git.exe` 解析，以及卸载时不穿透
junction。**只读窗口 + 一个临时 profile**，不碰你日常的配置。

> 需要：DeepSeek Harness for Windows、Git for Windows（`git --version` 能跑）。
> Node 只在“从源码起服务”的几步需要；用 npm 安装插件时不需要。
> 全程 PowerShell（不要 Git Bash），这样测到的才是真实默认环境。

## 0. 记录环境

```powershell
$PSVersionTable.PSVersion.ToString()
git --version
node --version   # 没有就跳过，后面标注
[Console]::OutputEncoding.WebName
$env:USERPROFILE
```

## 1. 从 npm 安装 + 重启

```powershell
dsh plugin --profile desktop add dsh-syn-config
```

装完**完全退出** DSH（托盘 → 退出），再打开。然后在新会话里问模型：

```text
运行 dsh_sync_diag，把输出原样贴给我
```

期望：`dsh-syn-config <version> · started ...`，`tools/commands/skills/webServer` 四项
`available`，三步 `ok`。**任何一项 error 就把整段输出留证。**

## 2. 状态灯与面板

1. 看输入框上方圆点：灰色 `同步就位` 或红色 `无仓库` 都算正常（看你有没有 `~/dsh-config`）。
2. 点开面板，依次点四个按钮：体检 / 拉取计划 / 推送计划 / 密钥扫描。
3. 每个结果旁点「复制命令」，确认复制出来的是 `/syn-dsh … now`。

期望：面板不写盘；四项都返回（没仓库时应显示失败文本而不是白屏）。

## 3. 仓库与状态（真实 git）

```powershell
$repo = Join-Path $env:TEMP "dsh-sync-win-test"
Remove-Item -Recurse -Force $repo -ErrorAction SilentlyContinue
git init $repo
git -C $repo config user.name "win-test"
git -C $repo config user.email "win-test@localhost"
"# test" | Out-File -Encoding utf8 (Join-Path $repo "AGENTS.md")
git -C $repo add -A
git -C $repo commit -m "init"
```

在会话里让模型执行（把 `<repo>` 换成上面的绝对路径）：

```text
用 dsh_sync_status 看这个仓库：<repo>
```

期望：`repoPresent: true`、`branch: master`（或 main）、`upstream: null`、`notes` 说明没有上游、
**不抛异常**。然后制造脏文件再跑一次：

```powershell
"dirty" | Out-File -Append (Join-Path $repo "AGENTS.md")
```

期望：`dirty: 1`、`dirtyFiles` 里是 ` M AGENTS.md` 这种短状态，不是绝对路径。

## 4. 盘符 + 空格 + 中文路径

```powershell
$odd = Join-Path $env:TEMP "dsh sync 测试 目录"
New-Item -ItemType Directory -Force $odd | Out-Null
git init $odd
git -C $odd config user.name "win-test"
git -C $odd config user.email "win-test@localhost"
"x" | Out-File -Encoding utf8 (Join-Path $odd "AGENTS.md")
git -C $odd add -A; git -C $odd commit -m init
```

让模型对 `$odd` 跑 `dsh_sync_status` 和 `dsh_sync_pull`（dry-run）。

期望：路径不被截断、不被转成 `/c/...`；`pull` 是 dry-run（`pulled: false`）；没有任何黑框弹出
（`windowsHide`）。

## 5. link 安装（junction）与卸载

从源码目录（GitHub 上 clone 一份）：

```powershell
git clone https://github.com/Dreamaniax/dsh-syn-config $env:TEMP\dsh-syn-src
cd $env:TEMP\dsh-syn-src
node scripts/install.mjs --dry-run
node scripts/install.mjs
node scripts/verify.mjs
```

期望：`verify.mjs` 全 ok；`node_modules\dsh-syn-config` 是 **junction**（`Get-Item` 看
`LinkType` 为 `Junction`，不需要管理员权限/开发者模式）。卸载：

```powershell
node scripts/uninstall.mjs --dry-run
node scripts/uninstall.mjs
```

期望：只删 junction 与清单条目，**源目录文件还在**（`git status` 干净）。

## 6. 失败路径（不修，只记录行为）

```powershell
# a) 不是 git 仓库
New-Item -ItemType Directory -Force $env:TEMP\not-a-repo | Out-Null
# b) 不存在的仓库
$env:TEMP\definitely-missing
```

分别让模型跑 `dsh_sync_status`。期望：返回 `ok:false` / `repoPresent:false` + 可操作 `notes`，
**不抛异常**。

如果愿意再测一项：临时把 `git` 从 PATH 拿掉（新开一个 PowerShell，`$env:PATH` 去掉 Git 目录），
跑 `dsh_sync_status`，期望 `notes` 给“安装 Git for Windows”的提示。

## 7. 回贴清单

把下面每一项的输出贴回来（脱敏：路径里用户名可保留，token 不要贴）：

- [ ] `dsh_sync_diag` 全文
- [ ] 第 2 步面板四项各自的结果文本
- [ ] 第 3 步两次 `dsh_sync_status` 的 JSON
- [ ] 第 4 步空格/中文路径的 JSON
- [ ] 第 5 步 `verify.mjs` 与 `uninstall.mjs` 输出
- [ ] 第 6 步两个失败 JSON
- [ ] 任何弹窗、黑框、编码乱码（截图即可）
