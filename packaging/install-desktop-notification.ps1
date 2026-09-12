#Requires -Version 5.1
<#
.SYNOPSIS
  把桌面通知插件装进 desktop profile（幂等，可反复执行）。

.DESCRIPTION
  对应 macOS 的 packaging/install-desktop-notification.sh。之所以要一个 PowerShell 版本：
  那个 .sh 依赖 Unix 的 bash + python3，而 Windows 上的 python 通常是 python.exe
  （没有 python3 这个名字），`set -e` 会让脚本在改 profile 清单那一步直接失败 ——
  于是插件文件拷进去了、bundle 却没登记，应用启动时静默不加载。

  为什么需要这一步：桌面应用的 profile（$DSH_HOME/profiles/desktop）由应用在
  **首次启动时**生成，不在仓库里，因此插件必须在应用装好、且启动过一次之后单独装一次。
  build-app.ps1 会在打包结束时自动调用本脚本；换机或重装应用后也可手动执行。

  用法：
    powershell -ExecutionPolicy Bypass -File packaging\install-desktop-notification.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# --- 定位仓库根（本脚本位于 <repo>\packaging\）---
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $repoRoot 'pnpm-workspace.yaml'))) {
  throw "install-desktop-notification: 没找到仓库根，期望 $repoRoot\pnpm-workspace.yaml"
}

$pkgSrc = Join-Path $repoRoot 'packaging\desktop-notification'
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profile = Join-Path $dshHome 'profiles\desktop'
$pkgName = 'dsh-desktop-notification'
$target = Join-Path (Join-Path $profile 'node_modules') $pkgName
$manifest = Join-Path $profile 'package.json'

if (-not (Test-Path $manifest)) {
  Write-Host "提示：desktop profile 尚未生成（$profile）。"
  Write-Host "      先启动一次桌面应用，再执行：powershell -ExecutionPolicy Bypass -File packaging\install-desktop-notification.ps1"
  exit 0
}

# 1) 复制包实体。必须是实体目录：桌面应用启动时会拒绝符号链接的私有包
#    （profile-packages.ts 的 validateDesktopPluginGraph 报 linked private package）。
if (Test-Path $target) { Remove-Item -LiteralPath $target -Recurse -Force }
New-Item -ItemType Directory -Path (Join-Path $target 'lib') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $pkgSrc 'package.json') -Destination $target -Force
Copy-Item -LiteralPath (Join-Path $pkgSrc 'cordis.patch.yml') -Destination $target -Force
Copy-Item -LiteralPath (Join-Path $pkgSrc 'lib\index.js') -Destination (Join-Path $target 'lib') -Force
Copy-Item -LiteralPath (Join-Path $pkgSrc 'lib\client.js') -Destination (Join-Path $target 'lib') -Force

# 2) 把包名登记进 profile 的 bundles（已在列表里则不重复写）。
#    用 node 而不是 PowerShell 的 ConvertTo-Json：5.1 的 ConvertTo-Json 会把非 ASCII
#    转义成 \uXXXX、缩进也从 2 空格变 4 空格，把一份 App 生成的清单改得面目全非。
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $nodeCommand) {
  throw 'install-desktop-notification: 找不到 node，无法登记 profile bundles。'
}

$editScript = @'
const fs = require('node:fs')
const manifestPath = process.env.DSH_PROFILE_MANIFEST
const name = process.env.DSH_PLUGIN_NAME
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
if (!manifest.dsh) manifest.dsh = {}
if (!manifest.dsh.profile) manifest.dsh.profile = {}
if (!Array.isArray(manifest.dsh.profile.bundles)) manifest.dsh.profile.bundles = []
if (!manifest.dsh.profile.bundles.includes(name)) {
  manifest.dsh.profile.bundles.push(name)
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
}
'@

$env:DSH_PROFILE_MANIFEST = $manifest
$env:DSH_PLUGIN_NAME = $pkgName
try {
  & $nodeCommand.Source -e $editScript
  if ($LASTEXITCODE -ne 0) { throw "install-desktop-notification: 登记 bundles 失败，退出码 $LASTEXITCODE" }
} finally {
  Remove-Item Env:\DSH_PROFILE_MANIFEST -ErrorAction SilentlyContinue
  Remove-Item Env:\DSH_PLUGIN_NAME -ErrorAction SilentlyContinue
}

Write-Host "已安装通知插件：$target"
Write-Host "已登记 profile bundles：$pkgName"

# 3) 把插件副本物化进应用的 resources\local-plugins，作为 app「自愈」的权威源。
#    背景（master 2026-09-12 的修复，apps/desktop/src/project-manager.ts 的
#    materializeLocalPlugins）：profile 清单只接受 registry 精确版本，本地插件进不了
#    dependencies，于是任何一次 pnpm add/remove/update 都会把它当多余包清掉；
#    app 每次准备 profile 前会用内置副本重新物化，装第三方插件不再误伤通知插件。
#    mac 侧由 build-app.sh 在打包时把副本内置进 Contents/Resources/local-plugins；
#    Windows 走官方 package:desktop:win:x64:unsigned 一条命令到底、插不进去，
#    所以在这里对已安装的应用就地补齐，语义与 mac 对齐。
#    为什么必须放 resources\local-plugins 而不是 resources\dsh：
#    resources\dsh 由 desktop-runtime.json 做全量文件清单校验（runtime-tree.ts 的
#    verifyDesktopRuntime），多一个文件即判「资源被篡改」拒绝启动；local-plugins
#    在校验范围之外，正是官方为这类文件预留的位置。文件集与 profile 安装一致
#    （不带 tests/ —— 留着会被每次启动复制进 profile 的 node_modules）。
$appDirs = @()
if ($env:DSH_DESKTOP_APP_DIR) { $appDirs += $env:DSH_DESKTOP_APP_DIR }
$appDirs += @(
  (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness'),
  (Join-Path $env:LOCALAPPDATA 'Programs\dsh-desktop')
)
if ($env:DSH_DESKTOP_WIN_UNPACKED) { $appDirs += $env:DSH_DESKTOP_WIN_UNPACKED }

$appCopyRoot = $null
foreach ($dir in $appDirs) {
  if ($dir -and (Test-Path (Join-Path $dir 'resources'))) { $appCopyRoot = $dir; break }
}
if ($appCopyRoot) {
  $appCopy = Join-Path (Join-Path $appCopyRoot 'resources') 'local-plugins'
  $dst = Join-Path $appCopy $pkgName
  if (Test-Path $dst) { Remove-Item -LiteralPath $dst -Recurse -Force }
  New-Item -ItemType Directory -Path (Join-Path $dst 'lib') -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $pkgSrc 'package.json') -Destination $dst -Force
  Copy-Item -LiteralPath (Join-Path $pkgSrc 'cordis.patch.yml') -Destination $dst -Force
  Copy-Item -LiteralPath (Join-Path $pkgSrc 'lib\index.js') -Destination (Join-Path $dst 'lib') -Force
  Copy-Item -LiteralPath (Join-Path $pkgSrc 'lib\client.js') -Destination (Join-Path $dst 'lib') -Force
  Write-Host "已把插件副本物化进应用（自愈源）：$dst"
  Write-Host '      改了 packaging\desktop-notification\ 源码后，重跑本脚本即可同步，无需重新打包。'
} else {
  Write-Host '提示：没找到已安装的 DeepSeek Harness（可用 DSH_DESKTOP_APP_DIR 指定安装目录）。'
  Write-Host '      跳过应用内自愈副本 —— 装好应用后重跑本脚本即可补上。'
}

Write-Host '完全退出桌面应用再打开即生效（插件只在启动时加载）。'
