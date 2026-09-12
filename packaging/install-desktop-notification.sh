#!/bin/bash
# 把桌面通知插件装进 desktop profile（幂等，可反复执行）。
#
# 为什么需要这一步：桌面应用的 profile（$DSH_HOME/profiles/desktop）由应用在
# 首次启动时生成，不在仓库里，因此插件必须在应用装好之后单独装一次。
# build-app.sh 会在打包结束时自动调用本脚本；换机或重装应用后也可手动执行。
#
# 用法：bash packaging/install-desktop-notification.sh
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

PKG_SRC="$REPO_ROOT/packaging/desktop-notification"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE="$DSH_HOME_DIR/profiles/desktop"
PKG_NAME="dsh-desktop-notification"
TARGET="$PROFILE/node_modules/$PKG_NAME"

if [ ! -f "$PROFILE/package.json" ]; then
  echo "提示：desktop profile 尚未生成（$PROFILE）。"
  echo "      先启动一次桌面应用，再执行：bash packaging/install-desktop-notification.sh"
  exit 0
fi

# 1) 复制包实体。必须是实体目录：桌面应用启动时会拒绝符号链接的私有包
#    （profile-packages.ts 的 validateDesktopPluginGraph 报 linked private package）。
rm -rf "$TARGET"
mkdir -p "$TARGET/lib"
cp "$PKG_SRC/package.json" "$PKG_SRC/cordis.patch.yml" "$TARGET/"
cp "$PKG_SRC/lib/index.js" "$PKG_SRC/lib/client.js" "$TARGET/lib/"

# 2) 把包名登记进 profile 的 bundles（已在列表里则不重复写）。
python3 - "$PROFILE/package.json" "$PKG_NAME" <<'PY'
import json, sys

path, name = sys.argv[1], sys.argv[2]
with open(path, encoding='utf-8') as handle:
    manifest = json.load(handle)
bundles = manifest.setdefault('dsh', {}).setdefault('profile', {}).setdefault('bundles', [])
if name not in bundles:
    bundles.append(name)
    with open(path, 'w', encoding='utf-8') as handle:
        json.dump(manifest, handle, indent=2, ensure_ascii=False)
        handle.write('\n')
PY

echo "已安装通知插件：$TARGET"
echo "已登记 profile bundles：$PKG_NAME"

# 3) app 内置副本才是权威源：app 每次准备 profile 都会用它覆盖 profile
#    （apps/desktop/src/project-manager.ts 的 materializeLocalPlugins）。
#    所以改了仓库源码却没重新打包时，重跑本脚本是白改——这里直接点破。
APP_DIR="${DSH_DESKTOP_APP:-/Applications/DeepSeek Harness.app}"
APP_COPY="$APP_DIR/Contents/Resources/local-plugins/$PKG_NAME"
if [ -d "$APP_COPY" ]; then
  STALE=""
  for FILE in package.json cordis.patch.yml lib/index.js lib/client.js; do
    cmp -s "$PKG_SRC/$FILE" "$APP_COPY/$FILE" || STALE="$STALE $FILE"
  done
  if [ -n "$STALE" ]; then
    echo
    echo "警告：app 内置的副本与仓库源码不一致（不一致的文件：${STALE# }）。"
    echo "      app 每次准备 profile 都会用内置副本覆盖 profile，上面这次复制会在下次启动时被覆盖。"
    echo "      要让改动生效，必须重新打包：bash packaging/build-app.sh"
  fi
fi

echo "完全退出桌面应用再打开即生效（插件只在启动时加载）。"
