#!/bin/bash
# 把仓库源码里的「共用组件」分发到其它前端的运行副本。
#
# 为什么需要：DSH 两个前端共用同一批注入组件，但运行副本各自独立。
#   Electron：app 内置 <app>/Contents/Resources/dsh/node_modules/@deepseek-ai/dsh-agent-presets/presets/standard/
#             —— 由 build-app.sh 打包时从 packages/ 带过去，本脚本不处理（改 app 内文件会破坏签名）
#   dsh-tui ：~/.dsh/.agent-presets/liangshen/
#             —— TUI 包安装时生成的副本，改仓库源码不会自动更新，需要本脚本补齐
# 漏同步的后果：同一个组件在两端口径不一致，排查时容易误判。实例：skill-search 的
# 中文分词补丁先只落到 Electron 侧，TUI 侧仍是旧版，中文查询退化成返回全量目录。
#
# 用法：bash packaging/sync-shared-components.sh
# 幂等：内容相同则跳过；目标目录不存在（换机后 TUI 尚未安装）则跳过并提示，不算失败。
set -euo pipefail

# --- 定位仓库根（解析软链接）---
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  SOURCE_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  case "$SOURCE" in
    /*) ;;
    *) SOURCE="$SOURCE_DIR/$SOURCE" ;;
  esac
done
REPO_ROOT="$(cd -P "$(dirname "$SOURCE")/.." && pwd)"

# 权威源：仓库源码里的 standard preset
SRC_DIR="$REPO_ROOT/packages/preset/agent-presets/presets/standard"
# 分发目标：TUI 的运行副本
TUI_PRESET_DIR="${DSH_HOME:-$HOME/.dsh}/.agent-presets/liangshen"
# 共用组件清单（两侧同源、必须保持一致的文件）
COMPONENTS=(skill-search.mjs)

updated=0
for name in "${COMPONENTS[@]}"; do
  src="$SRC_DIR/$name"
  dst="$TUI_PRESET_DIR/$name"
  if [ ! -f "$src" ]; then
    echo "跳过 $name：源文件不存在（$src）"
    continue
  fi
  if [ ! -d "$TUI_PRESET_DIR" ]; then
    echo "跳过 $name：TUI preset 目录不存在（$TUI_PRESET_DIR，TUI 未安装？）"
    continue
  fi
  if cmp -s "$src" "$dst"; then
    echo "已是最新：$name"
    continue
  fi
  cp "$src" "$dst"
  echo "已同步：$name → $TUI_PRESET_DIR/"
  updated=$((updated + 1))
done

echo "共用组件分发完成：更新 $updated 个（清单：${COMPONENTS[*]}）"
