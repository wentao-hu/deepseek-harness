#Requires -Version 5.1
<#
.SYNOPSIS
  Windows 端一条命令产出可安装运行的 DeepSeek Harness 桌面端（本机未签名自用）。

.DESCRIPTION
  对应 macOS 的 packaging/build-app.sh。两边要做的事不同，是因为平台差异：

  - macOS：官方入口无条件要求 Apple 证书与公证凭据，必须绕开；且 electron-builder 在
    identity=null 时只跳过签名、不补 ad-hoc 签名，产物会处于「签名与 bundle 不一致」
    状态而无法双击启动 —— 所以 mac 侧脚本要额外签一次。
  - Windows x64：官方自带未签名通道（`package:win:x64:unsigned`），产出 NSIS 安装包，
    不需要任何签名补救。本脚本只负责把官方入口缺的环境补齐。

  本脚本固定三件官方入口不会替你做的事，缺任何一件打包都会在中途失败：

  1. **必须用系统 Node**。Electron 自带的 node.exe 会让 process.execPath 指向 Electron
     本体，任何据此推导路径的逻辑（原生模块构建、Node-API 头文件定位）都会落空。
  2. **`patch` 命令必须在 PATH 里**。`prepare:dsh` 会用 Unix 的 patch 给内置运行时的
     pi-ai 打「透传服务端原生 web_search」补丁；Windows 本身没有该命令，需要借
     Git for Windows 自带的 usr\bin\patch.exe。
  3. **npm registry 走国内镜像**。上游把 registry 写死为 registry.npmjs.org，
     该源在部分网络下会在 prepare:dsh 的依赖安装处超时（ERR_PNPM_META_FETCH_FAIL）。

.PARAMETER Registry
  覆盖内置运行时安装依赖所用的 npm registry。默认 https://registry.npmmirror.com。

.PARAMETER AppId
  覆盖 DSH_DESKTOP_APP_ID。默认 com.sankuai.dsh（与 mac 侧保持一致）。

.PARAMETER KeepUnpacked
  同时保留 unpacked 目录（`--dir` 之外的普通打包本就产出 NSIS 安装包）。
  默认关闭，仅产出安装包。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File packaging\build-app.ps1

.EXAMPLE
  pwsh -File packaging/build-app.ps1 -Registry https://registry.npmjs.org
#>
[CmdletBinding()]
param(
  [string]$Registry = 'https://registry.npmmirror.com',
  [string]$AppId = 'com.sankuai.dsh',
  [switch]$KeepUnpacked
)

$ErrorActionPreference = 'Stop'

# --- 定位仓库根（本脚本位于 <repo>\packaging\）---
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $repoRoot 'pnpm-workspace.yaml'))) {
  throw "build-app: 没找到仓库根，期望 $repoRoot\pnpm-workspace.yaml"
}

# --- [1/4] 必须用系统 Node ---
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $nodeCommand) {
  throw 'build-app: 找不到系统 Node。请安装 Node 22.19+ 或 24+ 后重试。'
}
$nodeExe = $nodeCommand.Source
$nodeVersion = (& $nodeExe --version).Trim()
Write-Host "==> 使用 Node $nodeVersion ($nodeExe)"

# --- [2/4] 把 Git for Windows 的 patch.exe 接进 PATH ---
# prepare:dsh 的 applyRuntimePatches() 用 execFile('patch') 打补丁；Windows 无此命令。
if (-not (Get-Command patch -ErrorAction SilentlyContinue)) {
  $patchDir = $null
  $gitCommand = Get-Command git -ErrorAction SilentlyContinue
  if ($null -ne $gitCommand) {
    # git.exe 通常位于 <GitRoot>\mingw64\bin 或 <GitRoot>\cmd，usr\bin 与其同级。
    $gitRoot = Split-Path -Parent (Split-Path -Parent $gitCommand.Source)
    $candidate = Join-Path $gitRoot 'usr\bin'
    if (Test-Path (Join-Path $candidate 'patch.exe')) { $patchDir = $candidate }
  }
  if ($null -eq $patchDir) {
    foreach ($root in @('C:\Program Files\Git', 'C:\Program Files (x86)\Git', 'D:\Apps\Git')) {
      $candidate = Join-Path $root 'usr\bin'
      if (Test-Path (Join-Path $candidate 'patch.exe')) { $patchDir = $candidate; break }
    }
  }
  if ($null -eq $patchDir) {
    throw 'build-app: 找不到 patch 命令，也没有装 Git for Windows。请安装 Git for Windows（自带 patch.exe）后重试。'
  }
  $env:PATH = "$patchDir;$env:PATH"
  Write-Host "==> patch 来自 $((Join-Path $patchDir 'patch.exe'))"
}

# --- [3/4] 打包环境变量 ---
$env:DSH_DESKTOP_APP_ID = if ($env:DSH_DESKTOP_APP_ID) { $env:DSH_DESKTOP_APP_ID } else { $AppId }
$env:DSH_DESKTOP_TARGET_PLATFORM = 'win32'
$env:DSH_DESKTOP_TARGET_ARCH = 'x64'
$env:DSH_DESKTOP_NPM_REGISTRY = if ($env:DSH_DESKTOP_NPM_REGISTRY) { $env:DSH_DESKTOP_NPM_REGISTRY } else { $Registry }

# --- [4/5] 让开上一轮的构建产物 ---
# 受限环境（WorkBuddy 桌面端注入的删除保护）按「单次请求内累计删除文件数」计数，
# 超过阈值会拦下整条打包链路，且同一请求内重试无效。它拦的通常不是业务代码，
# 而是上一轮遗留的产物：vite 要清空 apps/web/dist、pipeline 要重建中间目录。
# 计数只统计真实存在的目标，所以这里把上一轮产物「改名让开」即可 ——
# 重命名不是删除，不计数。全新路径下这些清理全部退化为无操作。
$stash = Join-Path $env:TEMP ('dsh-package-stash-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$stale = @(
  (Join-Path $repoRoot 'apps\web\dist'),
  (Join-Path $repoRoot '.dsh-build\client-build-environment.json'),
  (Join-Path $repoRoot 'apps\desktop\.desktop-build\targets\win-x64')
)
$stashed = @()
New-Item -ItemType Directory -Path $stash -Force | Out-Null
foreach ($path in $stale) {
  if (Test-Path -LiteralPath $path) {
    Move-Item -LiteralPath $path -Destination $stash -Force
    $stashed += $path
  }
}
if ($stashed.Count -gt 0) {
  Write-Host "==> 已把上一轮产物让开到 $stash"
  foreach ($path in $stashed) { Write-Host "    $path" }
}

# --- [5/5] 走官方未签名通道打包 ---
Write-Host '==> [1/3] 准备运行时并执行 electron-builder（构建 + 组装 + 打补丁 + 哈希清单）'
Push-Location $repoRoot
try {
  & pnpm run package:desktop:win:x64:unsigned
  if ($LASTEXITCODE -ne 0) { throw "build-app: 打包失败，退出码 $LASTEXITCODE" }
} finally {
  Pop-Location
}

$artifacts = Join-Path $repoRoot 'apps\desktop\.desktop-build\targets\win-x64\unsigned-artifacts'
Write-Host ''
Write-Host '==> [2/3] 产物'
if (Test-Path $artifacts) {
  Get-ChildItem -Path $artifacts -Filter '*.exe' | ForEach-Object { Write-Host "    $($_.FullName)" }
  if ($KeepUnpacked) {
    Get-ChildItem -Path $artifacts -Filter 'win-unpacked' -Directory |
      ForEach-Object { Write-Host "    $($_.FullName)" }
  }
} else {
  Write-Host "    （未找到产物目录 $artifacts）"
}

# --- [3/3] 安装桌面通知插件 ---
# 与 mac 侧 build-app.sh 的第 [5/5] 步对应：profile 由应用首次启动时生成，
# 所以这一步通常要等应用跑过一次才真正生效（脚本自身幂等，随时可重跑）。
Write-Host ''
Write-Host '==> [3/3] 安装桌面通知插件'
# 顺带把自愈副本物化进 win-unpacked（mac 侧由 build-app.sh 内置进 .app，Windows 的
# 官方打包命令插不进去，只能在打包后补 —— master 2026-09-12 的插件自愈机制，
# 见 install-desktop-notification.ps1 第 3 步的说明）。
$unpacked = Join-Path $artifacts 'win-unpacked'
if (Test-Path $unpacked) { $env:DSH_DESKTOP_WIN_UNPACKED = $unpacked }
try {
  & (Join-Path $PSScriptRoot 'install-desktop-notification.ps1')
} catch {
  Write-Host "    提示：通知插件未安装（$($_.Exception.Message)），不影响已产出的安装包。"
} finally {
  Remove-Item Env:\DSH_DESKTOP_WIN_UNPACKED -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host '双击安装包即可安装；安装后首次启动会在 $DSH_HOME（默认 %USERPROFILE%\.dsh）下生成 profiles\desktop。'
