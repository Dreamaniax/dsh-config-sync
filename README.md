# dsh-config-sync

跨电脑同步 DSH 配置（技能 / profile 设置 / AGENTS.md）的 DeepSeek Harness 插件，**macOS 与 Windows 同一份代码**。

> 状态：**P1（只读体检对等）**。当前暴露两个只读工具：
> - `dsh_sync_status`：仓库分支 / 上游 / 领先落后 / 脏文件数（默认不联网）。
> - `dsh_sync_doctor`：`dsh-config/scripts/doctor.sh` 的 Node 移植，六节体检（工具链 / 仓库 / 技能 / 密钥 / profile / 周报），退出码 0-2-1 与脚本一致。唯一副作用是 `git fetch`（`offline: true` 可跳过）。
>
> 不写盘、不推送。
>
> 设计理由与后续阶段见主仓库的调研文档：`../research/syn-dsh-plugin/PLAN.md`。

## 为什么是插件，而不是又一层 shell

| | 现状（`~/dsh-config/scripts/*.sh`） | 本插件 |
|---|---|---|
| Windows | 需要 Git Bash 兜底（12 个 `.cmd`） | 原生 Node，无 shell 依赖 |
| 模型拿到的东西 | 中文日志文本，需要自己解析 | 结构化 JSON（分支/领先/落后/脏文件），工具 schema 强制校验 |
| 跨平台差异 | rsync / sed / chmod / od 各自分支 | 一个 `execFile('git', argv)`，两边一致 |
| 引导（新机第一条命令） | 脚本仍是唯一入口 | **仍由脚本负责**——插件装不上时它不存在 |

分工：**插件当手**（日常读写本机与仓库）、**脚本当门**（引导、提交闸门、CI 回归）、**技能当脑**（`/syn-dsh` 决定先做什么）。

## 安装

### 开发 / 离线（link 安装，本仓库直接生效）

```bash
node scripts/install.mjs --dry-run    # 先看会改什么
node scripts/install.mjs              # 写 profile manifest + 建 link
node scripts/verify.mjs               # 校验 manifest / link / 模块 / 工具 / 仓库
```

它会：备份 `~/.dsh/profiles/desktop/package.json`（`.bak-dsh-config-sync`）→ 写 `link:` 依赖 → 把 `dsh-config-sync` 追加进 `dsh.profile.bundles` → 在 `profile/node_modules/` 建 **symlink（macOS）/ junction（Windows）** → 重新读盘逐项校验。

安装后**完全退出并重开 DeepSeek Harness**（macOS `Cmd+Q` / Windows 托盘 → 退出），新会话里才会有 `dsh_sync_status`。

### 生产（正式分发）

```bash
dsh plugin --profile desktop add github:OWNER/dsh-config-sync
```

注意：`dsh plugin add` 只写 `dependencies` + lock，**不写** `dsh.profile.bundles`；只有 GUI 的「设置 → 插件」安装会写 bundles。所以走 CLI 时要么再手工补一行 bundles，要么用 GUI 安装。

### 卸载

```bash
node scripts/uninstall.mjs --dry-run
node scripts/uninstall.mjs
```

只删投影（link/junction，绝不穿过 link 删目标）与 manifest 里的两处条目，保留备份；仓库本身不受影响。

## 工具

### `dsh_sync_doctor`

`dsh-config/scripts/doctor.sh` 的结构化版本：同样的六节、同样的判定、同样的退出码（0 干净 / 2 有警告 / 1 有阻塞），但返回的是 JSON 分节而不是中文日志。

| 参数 | 类型 | 说明 |
|---|---|---|
| `repo` | string（可选） | 仓库路径，支持 `~`；默认取配置 |
| `offline` | boolean（可选） | 跳过 `git fetch` 与远端比对 |
| `profile` | string（可选） | 要体检的 profile，默认 `desktop` |

每节返回 `{ id, title, status: ok|warn|error, items: [{ level, text }] }`。与脚本的对等性由 `node scripts/parity.mjs` 逐项比对（当前 13/13 一致）。

### `dsh_sync_status`

| 参数 | 类型 | 说明 |
|---|---|---|
| `repo` | string（可选） | 仓库路径，支持 `~/dsh-config`；默认取配置里的 `repoPath` |
| `fetch` | boolean（可选） | 先 `git fetch --prune`，再算领先/落后；默认取配置（关） |

返回（`output.schema` 强制）：

```json
{
  "ok": true,
  "repoPath": "/Users/you/dsh-config",
  "repoPresent": true,
  "branch": "main",
  "upstream": "origin/main",
  "ahead": 2,
  "behind": 0,
  "dirty": 1,
  "dirtyFiles": [" M AGENTS.md"],
  "notes": []
}
```

边界情况全部**以数据返回、不抛异常**（抛异常会让宿主把工具调用判错）：仓库不存在 → `repoPresent:false`；不是 git 仓库 → `ok:false` + `notes`；没有上游 → `notes` 说明并停止计算领先/落后；git 缺失（含 Windows 的安装提示）→ `notes` 给出可操作建议。

## 配置

在 profile 的 `cordis.patch.yml` 里那行插件下加 `config`（注释示例见本仓库 `cordis.patch.yml`）：

```yaml
- insert:
    - id: dsh-config-sync
      name: 'dsh-config-sync'
      config:
        repoPath: '~/dsh-config'
        gitTimeoutMs: 15000
        fetchOnStatus: false
```

P0 没有导出 Config schema（避免依赖 schemastery，见下），所以 `config` 未做 schema 校验——`apply()` 里逐字段自检并回退默认值。

## 为什么宿主半不 import 任何 `@deepseek-ai/*`

`link:` 安装时插件真实文件在 checkout 里，Node 按真实路径解析裸导入；而 profile 的 `node_modules` 并不含 `@deepseek-ai/dsh-tools`（它们在应用打包内），于是 `import '@deepseek-ai/dsh-tools'` 会在 link 安装下解析失败。因此宿主半只用 `ctx` 注入的服务 + Node 内置模块：

- 工具定义直接用**编译后的 JSON Schema**（`ctx.tools.register` 校验的就是这个形状：必须有 `output.render`，且属性不能写 `required: true` 那种 authoring 简写，要用 `required: [...]` 数组）。
- 代价：失去 `defineTool` 的参数预校验 → 我们在 `execute()` 里自己收窄参数并把失败作为数据返回。

这条也顺带让测试能在裸 Node 下跑，不需要任何安装步骤。

## 平台差异（已在代码里处理）

| 关注点 | macOS | Windows |
|---|---|---|
| profile 投影 | symlink | **junction**（不需要管理员权限 / 开发者模式），失败再退 dir symlink |
| manifest 原子写 | rename | 同名 rename；遇到杀软/索引器占用（`EACCES`/`EBUSY`/`EPERM`）退避重试 |
| 路径 | `~/…`、`/` | `~\…` 同样支持；`isAbsolute`/`join` 处理盘符 |
| git | Apple git | Git for Windows 的 `git.exe`（不在 PATH 时 `notes` 会给安装提示） |
| 换行 | LF | `.gitattributes` 固定 `*.sh`/`*.js` LF、`*.cmd`/`*.ps1` CRLF |
| 控制台 | 直接输出 | `execFile(..., { windowsHide: true })`，不弹黑框 |

## 开发

```bash
node --test "test/*.test.mjs"     # 26 个用例：解析/脱敏/扫描/体检分节 + 真 git 仓库 + 插件契约
node scripts/parity.mjs           # 与 scripts/doctor.sh 逐项比对（同状态、同退出码）
node scripts/install.mjs --dry-run
node scripts/verify.mjs
```

`test/status.test.mjs` 在临时目录里 `git init` 真仓库来断言；`test/plugin.test.mjs` 用假 `ctx` 断言注册形态与 `execute` 返回值形状。

## 验收清单

| # | 验收项 | 命令 / 判据 |
|---|---|---|
| 1 | manifest 依赖 + bundles 条目 | `node scripts/verify.mjs` 前两项 `ok` |
| 2 | 投影是 link 且指向本 checkout | `verify.mjs` 的 projection 两项 |
| 3 | 模块可被宿主加载 | `verify.mjs` 的 load/export 四项 |
| 4 | 只注册一个工具且 schema 合法 | `verify.mjs` 的 tool 三项 |
| 5 | 能读真实仓库状态 | `verify.mjs` 打印 branch/upstream/ahead/behind/dirty |
| 6 | 宿主启动时组合进该行 | `dsh --profile desktop --dump-config \| grep dsh-config-sync` |
| 7 | 新会话工具可见 | 重启客户端后问答一次「dsh 配置同步了吗」 |
| 8 | 三种仓库状态结果正确 | 干净 / 落后 / 脏（本地真仓库或临时仓库） |
| 9 | 体检与脚本对等 | `node scripts/parity.mjs` → 13/13，退出码一致 |
| 10 | 报告不含明文密钥 | `test/doctor.test.mjs` 的 redaction 用例 |

## 许可

MIT。Windows 投影与原子写逻辑改编自同作者的 `dsh-model-effort-chips`（MIT）。
