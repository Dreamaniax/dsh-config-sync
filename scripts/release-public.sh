#!/usr/bin/env bash
# 把当前 checkout 压成**单个提交**推到公开仓库（历史不进公开侧）。
#
#   scripts/release-public.sh            # 预览
#   scripts/release-public.sh --yes      # 真推（force，公开仓库只保留快照）
#
# 公开仓库：https://github.com/Dreamaniax/dsh-syn-config
set -euo pipefail
cd "$(dirname "$0")/.."

PUBLIC_REMOTE="${PUBLIC_REMOTE:-public}"
VERSION="$(node -p "require('./package.json').version")"
MSG="feat: dsh-syn-config ${VERSION}"

if [ "${1:-}" != "--yes" ]; then
  echo "would create a snapshot of $(pwd) at v${VERSION} and force-push it to '${PUBLIC_REMOTE}'"
  echo "run with --yes to actually publish the snapshot"
  exit 0
fi

# 前置检查：密钥扫描与测试都必须通过
node scripts/publish-check.mjs >/dev/null
node --test "test/*.test.mjs" >/dev/null

TMP="$(mktemp -d)"
git ls-files -z | tar --null -T - -cf - | tar -xf - -C "$TMP"
cd "$TMP"
git init -q -b main
git add -A
git -c user.name="Dreamaniax" -c user.email="dreamaniax@users.noreply.github.com" commit -q -m "$MSG"
git remote add public "https://github.com/Dreamaniax/dsh-syn-config.git"
git push --force public main
echo "published snapshot v${VERSION} to Dreamaniax/dsh-syn-config"
