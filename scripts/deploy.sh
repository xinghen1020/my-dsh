#!/usr/bin/env bash
# my-dsh 一键部署：把本仓库软链为 $DSH_HOME 的事实源
# 用法: bash scripts/deploy.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"

[ -d "$DSH_HOME" ] || { echo "错误: $DSH_HOME 不存在, 请先安装 dsh"; exit 1; }

mkdir -p "$DSH_HOME/profiles/web"

ln -sf "$REPO/cordis.patch.yml"             "$DSH_HOME/cordis.patch.yml"
ln -sf "$REPO/settings.yaml"                "$DSH_HOME/settings.yaml"
ln -sf "$REPO/profiles/web/package.json"    "$DSH_HOME/profiles/web/package.json"
ln -sf "$REPO/profiles/web/cordis.patch.yml" "$DSH_HOME/profiles/web/cordis.patch.yml"

echo "已部署: $DSH_HOME 的配置现在指向 $REPO"
echo "重启生效: kill \$(pgrep -f 'dsh web' | head -1) && dsh web"
