# 发布到 DSH 插件市场（dsh-market）的完整路径

> 结论：**dsh-market 没有“上传接口”。** 它读的是精选列表 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 的目录
> （`https://awesome-dsh-plugin.com/plugins.json`，国内走 npm 镜像的同一份）。上架 = 往那个仓库提一个 YAML 文件的 PR。
> 合并后目录 CI 每日刷新，通常一天内出现在市场的“发现”页与宿主 Discover 索引里。

## 0. 发布前检查（本仓库已通过）

```bash
node scripts/publish-check.mjs     # 不允许：账号名/私有仓库 URL/launchd 标签/家目录路径
node --test "test/*.test.mjs"      # 81 例
node scripts/verify.mjs            # 安装形态
```

## 1. 发布包（任选其一；推荐两个都做）

**A. npm（安装更顺，免 `allowBuilds`）**

```bash
npm login                          # 本机当前未登录
# package.json: "private": false, 补 "publishConfig": { "access": "public" }
npm publish --access public        # 名称 dsh-syn-config（已确认未被占用）
```

**B. GitHub Release tarball（不发 npm 时的兜底，市场会优先展示它）**

```bash
npm pack                           # dsh-syn-config-0.7.0.tgz
gh release create v0.7.0 dsh-syn-config-0.7.0.tgz
```

## 2. 仓库公开（这一步有隐私前提）

市场的维护者会**实际阅读仓库**，所以仓库必须公开。但**历史不能直接公开**：早期提交里带着私有配置仓库的 URL（`assets/syn-dsh.md` 已在新版本里清掉，旧提交仍在）。

推荐做法：**新建一个干净的公开仓库**，只放一个压缩后的初始提交，旧仓库留作私有归档：

```bash
git clone --depth 1 . /tmp/dsh-syn-config-public
cd /tmp/dsh-syn-config-public && rm -rf .git
git init && git add -A && git commit -m "feat: dsh-syn-config 0.7.0"
git branch -M main
gh repo create Dreamaniax/dsh-syn-config --public --source . --remote origin --push
gh repo edit Dreamaniax/dsh-syn-config --add-topic dsh-plugin
```

## 3. 提 PR（一个文件）

仓库 `awesome-dsh-plugin/awesome-dsh-plugin`，新增 `data/plugins/Dreamaniax__dsh-syn-config.yml`：

```yaml
url: https://github.com/Dreamaniax/dsh-syn-config
name: Dreamaniax/dsh-syn-config
category: workflow
description:
  en: 'Syncs DSH skills, profile settings and AGENTS.md with a private git repository: status, six-section health check, pull, secret redaction, and a snapshot-plus-push flow.'
  zh: '把 DSH 技能、profile 设置与 AGENTS.md 与私有 git 仓库双向同步：状态、六节体检、拉取、密钥脱敏，以及快照+推送。'
icon: https://raw.githubusercontent.com/Dreamaniax/dsh-syn-config/main/assets/icon-180.png
```

## 4. 会被 CI 挡住的硬条件

| 条件 | 我们的状态 |
|---|---|
| 仓库声明 `dsh.bundle`（可 `dsh plugin add`） | ✅ `dsh.bundle.patch` |
| 仓库**创建满 1 天** | ⏳ 新仓库刚建，**PR 次日再提**，否则 CI 自动打回 |
| 有真实可用的代码 | ✅ 6 个工具 + 命令 + 状态卡 + 81 例测试 |
| 加 `dsh-plugin` topic | 步骤 2 已带 |
| 描述与代码一致 | 描述里只写真实存在的工具与行为 |
| 官方 `@deepseek-ai/*` 用 peerDependencies | ✅ 本插件不依赖官方包 |

## 5. 合并之后

- 目录 CI 每日重建 `plugins.json` → dsh-market 搜索即可命中；
- 宿主 DSH 0.2.1+ 的「插件 → 发现 → 索引源」也可直接加 `https://awesome-dsh-plugin.com/index.json`；
- 安装走 `dsh plugin add dsh-syn-config`（npm）或市场一键安装（源码/ tarball）。

## 6. 安全边界（写给使用者）

插件以宿主全权运行：能执行 `git`、读写 `~/.dsh`、注册一个本机 HTTP 路由。它**默认不写盘**（`pull`/`push` 的 `dry_run` 默认 true），不接受任何网络上报，密钥只在本机 `secrets.env`。

## 7. 隐私复检（0.7.1）

- **占位值不再误报**：`API_KEY=dummy_test_value_0001` 这类测试夹具被识别为占位值放过；带真实凭据前缀（`as_sk_`/`ghp_`/`sk-`/`AKIA`…）的一律不放过。
- **凭据形状的键**：`*api_key / *token / *secret / *password / Authorization / private_key` 且值 ≥16 位、含字母+数字 → 判为错误（提示改用 `__KEY__`）；`vaultSyncS3Key` 这类标识符不算。
- **历史扫描不再因体积失败**：单次 diff 超过缓冲时，自动收窄到 `profiles/ scripts/ AGENTS.md weekly/` 重试。
- **定时任务标签**：不再硬编码个人反域名——读 `DSH_WEEKLY_LAUNCHD_LABEL` / `learning/schedule.env`，都没有就按 `*.dsh.weekly-retro` 后缀匹配。
- 复检结果：`publish-check` 0 命中；`dsh_sync_doctor` 0 阻塞、2 警告（都是本机与仓库的正常漂移）。
