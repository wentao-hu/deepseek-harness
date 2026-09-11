#!/bin/bash
# 一条命令产出可双击运行的 macOS .app（本机未签名自用）。
#
# 为什么需要这个脚本：官方 apps/desktop 的打包入口为「签名分发」设计，
# 在 macOS 上无条件要求 Apple 证书与公证凭据（见 desktop-release-environment.mjs），
# 且 electron-builder 在 identity=null 时只跳过签名、不补 ad-hoc 签名，
# 会留下签名与 bundle 不一致的产物（系统日志报 errSecCSUnsigned -67062），双击无法启动。
# 本脚本把「准备 → 打包 → ad-hoc 签名 → 安装」串成一条命令。
#
# 用法：bash packaging/build-app.sh
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

# --- 必须用系统 Node ---
# Electron 自带的 Node 会让 process.execPath 指向 Helper，
# 任何依赖 execPath 推导路径的逻辑（原生模块构建、Node-API 头文件定位）都会失败。
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:${HOME}/.local/bin:${PATH}"
NODE_BIN="${DSH_NODE:-/opt/homebrew/bin/node}"
[ -x "$NODE_BIN" ] || { echo "build-app: 找不到系统 Node：$NODE_BIN" >&2; exit 1; }

# --- 打包环境变量 ---
export DSH_DESKTOP_APP_ID="${DSH_DESKTOP_APP_ID:-com.sankuai.dsh}"
export DSH_DESKTOP_TARGET_PLATFORM=darwin
export DSH_DESKTOP_TARGET_ARCH=arm64
# 上游把 registry 写死为 registry.npmjs.org；在访问该源不稳定的网络里会在
# prepare:dsh 的依赖安装处超时失败。默认走国内镜像，可用环境变量改回。
export DSH_DESKTOP_NPM_REGISTRY="${DSH_DESKTOP_NPM_REGISTRY:-https://registry.npmmirror.com}"

APP_OUT="$REPO_ROOT/apps/desktop/.desktop-build/targets/mac-arm64/artifacts/mac-arm64/DeepSeek Harness.app"
INSTALLED_APP="/Applications/DeepSeek Harness.app"

echo "==> [1/4] 准备运行时（构建 + 组装 + 打补丁 + 哈希清单）"
cd "$REPO_ROOT"
pnpm run prepare:desktop

echo "==> [2/4] electron-builder 打包（未签名）"
cd "$REPO_ROOT/apps/desktop"
pnpm exec electron-builder \
  --config "$REPO_ROOT/packaging/electron-builder.unsigned.config.mjs" \
  --mac --arm64 --dir --publish never

echo "==> [3/4] 安装到 /Applications"
rm -rf "$INSTALLED_APP"
cp -R "$APP_OUT" "$INSTALLED_APP"

echo "==> [4/4] ad-hoc 签名（必须在最终位置就地进行）"
# 只签最外层 bundle：它会重建 _CodeSignature 并对资源「计算」哈希，不修改文件内容。
# 绝不加 --deep —— 那会重签 Resources/dsh 下的原生文件、改变其字节，
# 使 desktop-runtime.json 记录的哈希与实际不符，启动时的运行时校验会判定资源被篡改。
#
# 顺序很关键：必须「先拷贝到最终位置、再就地签名」。
# 反过来（先签后拷）会让拷贝件的签名失效，codesign --verify 报
# "invalid Info.plist (plist or signature have been modified)"，双击无法启动。
codesign --force --sign - "$INSTALLED_APP"
codesign --verify "$INSTALLED_APP"

echo
echo "完成：$INSTALLED_APP"
echo "双击即可运行；首次启动会在 \$DSH_HOME（默认 ~/.dsh）下生成 profiles/desktop。"
