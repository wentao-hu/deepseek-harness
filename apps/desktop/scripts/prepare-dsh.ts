/** Materialize the complete production runtime before publishing Desktop resources. */

import { spawn, execFile, execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, relative, resolve } from 'node:path'
import { createRuntimeProjectMetadata } from '../src/project-manager.ts'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'
import { parseDesktopRelease, type DesktopRelease } from '../src/release.ts'
import {
  DESKTOP_HOST_PACKAGE,
  DESKTOP_HOST_RUNTIME_FILES,
  DESKTOP_PACKAGES_DIR,
  DESKTOP_PACKAGE_SET_FILE,
  readDesktopCorePackageSet,
  verifyDesktopCoreLockfile,
} from '../src/core-package-set.ts'
import { smokeDesktopRuntime } from './smoke-runtime.ts'
import { writeDesktopRuntime, verifyDesktopRuntime } from '../src/runtime-tree.ts'
import {
  resolveDesktopAppId,
  resolveMacOSSigningEnvironment,
} from './desktop-release-environment.mjs'
import {
  signMacOSRuntime,
} from './macos-runtime.ts'
import { resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { desktopRuntimeFileExclusion } from './runtime-file-policy.ts'

const APP_ROOT = resolve(import.meta.dirname, '..')
const BUILD_PATHS = resolveDesktopTargetBuildPaths()
const DSH_OUTPUT_ROOT = BUILD_PATHS.dsh
const BUILD_ROOT = mkdtempSync(join(tmpdir(), 'dsh-desktop-runtime-'))
const STORE_ROOT = join(BUILD_ROOT, 'store')
const RUNTIME_ROOT = BUILD_PATHS.runtime
const PNPM_BUILD_STATE = BUILD_PATHS.dshPnpm
const PACKAGE_SET_ROOT = BUILD_PATHS.packageSet
const NODE = join(RUNTIME_ROOT, 'node', process.platform === 'win32' ? 'node.exe' : 'node')
const PNPM = join(RUNTIME_ROOT, 'pnpm', 'bin', 'pnpm.mjs')

/**
 * Registry the bundled pnpm resolves the core package set from.
 *
 * 二次开发：上游把它写死为 registry.npmjs.org，在访问该源不稳定或不可达的网络里，
 * 这一步会以 ERR_PNPM_META_FETCH_FAIL 超时失败，从而完全无法产出桌面端。
 * 允许用 DSH_DESKTOP_NPM_REGISTRY 覆盖；未设置时仍是上游的官方源，行为不变。
 */
const REGISTRY = process.env.DSH_DESKTOP_NPM_REGISTRY?.trim() || 'https://registry.npmjs.org/'

function manifestVersion(path: string, subject: string): string {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string') throw new Error(`desktop runtime: ${subject} has no version`)
  return manifest.version
}

function desktopRelease(): DesktopRelease {
  const version = manifestVersion(join(APP_ROOT, 'package.json'), 'desktop package')
  const dshVersion = manifestVersion(resolve(APP_ROOT, '..', '..', 'package.json'), 'root dsh package')
  if (version !== dshVersion) {
    throw new Error(`desktop runtime: Electron ${version} must bind the same version of @deepseek-ai/dsh, found ${dshVersion}`)
  }
  const runtime = JSON.parse(readFileSync(join(RUNTIME_ROOT, 'versions.json'), 'utf8')) as Record<string, unknown>
  return parseDesktopRelease({
    schemaVersion: 1,
    version,
    hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
    nodeVersion: runtime.node,
    pnpmVersion: runtime.pnpm,
  })
}

function runPnpm(args: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const [command, ...commandArgs] = args
    if (command === undefined) throw new Error('desktop runtime: pnpm command is required')
    const config = join(PNPM_BUILD_STATE, 'config')
    const userConfig = join(config, 'npmrc')
    mkdirSync(config, { recursive: true })
    writeFileSync(userConfig, '')
    const child = spawn(NODE, [
      PNPM,
      `--config.registry=${REGISTRY}`,
      `--config.store-dir=${STORE_ROOT}`,
      '--config.enable-global-virtual-store=false',
      `--config.userconfig=${userConfig}`,
      command,
      ...commandArgs,
    ], {
      cwd: BUILD_ROOT,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([name]) => (
          name !== 'NODE_OPTIONS' && name !== 'NODE_PATH' && !/^DSH_DESKTOP_/u.test(name) && !/^(?:npm|pnpm|corepack)_/iu.test(name)
        ))),
        NPM_CONFIG_REGISTRY: REGISTRY,
        NPM_CONFIG_STORE_DIR: STORE_ROOT,
        NPM_CONFIG_USERCONFIG: userConfig,
        PATH: `${dirname(NODE)}${delimiter}${process.env.PATH ?? ''}`,
        XDG_CACHE_HOME: join(PNPM_BUILD_STATE, 'cache'),
        XDG_CONFIG_HOME: config,
        XDG_STATE_HOME: join(PNPM_BUILD_STATE, 'state'),
      },
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`desktop runtime: pnpm exited with ${String(code ?? signal)}`))
    })
  })
}

/**
 * 二次开发：需要传导到内置运行时的仓库补丁。
 *
 * 桌面运行时的 node_modules 是 pnpm 在临时目录里做的一次独立 prod 安装，仓库
 * pnpm-workspace.yaml 的 patchedDependencies 只作用于仓库自身，不会传导过去。
 * 名单只列真正属于运行时产物的包：node-pty 等补丁按上游做法不进运行时。
 */
const RUNTIME_PATCH_PACKAGES = new Set(['@earendil-works/pi-ai'])

/**
 * Apply the repository patches that must reach the bundled desktop runtime.
 *
 * 不在此处补上，打包出的桌面端就缺少本地补丁带来的能力——当前是 openai-responses
 * 路由透传服务端原生 web_search 工具。补丁必须在 writeDesktopRuntime 计算文件哈希
 * 之前应用，否则资源清单与实际内容不一致，启动时的运行时完整性校验会判定资源被篡改。
 * 版本不匹配时明确跳过并打印，避免把补丁打到错误的实现上。
 * @param runtimeRoot - the assembled runtime root about to be described and verified.
 */
function applyRuntimePatches(runtimeRoot: string): void {
  const patchDir = join(resolve(APP_ROOT, '..', '..'), 'patches')
  if (!existsSync(patchDir)) return
  for (const name of readdirSync(patchDir).filter(entry => entry.endsWith('.patch')).sort()) {
    const stem = name.slice(0, -'.patch'.length)
    const separator = stem.lastIndexOf('@')
    if (separator <= 0) continue
    const packageName = stem.slice(0, separator).replace('__', '/')
    if (!RUNTIME_PATCH_PACKAGES.has(packageName)) continue
    const version = stem.slice(separator + 1)
    const packageDir = join(runtimeRoot, 'node_modules', packageName)
    const manifestPath = join(packageDir, 'package.json')
    if (!existsSync(manifestPath)) continue
    const installed = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown }
    if (installed.version !== version) {
      process.stdout.write(`desktop runtime: ${packageName} is ${String(installed.version)}, not ${version}; skipped ${name}\n`)
      continue
    }
    execFileSync('patch', ['-p1', '-i', join(patchDir, name)], { cwd: packageDir, stdio: 'pipe' })
    process.stdout.write(`desktop runtime: applied ${name}\n`)
  }
}

async function main(): Promise<void> {
  rmSync(DSH_OUTPUT_ROOT, { recursive: true, force: true })
  rmSync(PNPM_BUILD_STATE, { recursive: true, force: true })
  mkdirSync(STORE_ROOT, { recursive: true })
  try {
    const release = desktopRelease()
    copyFileSync(join(PACKAGE_SET_ROOT, DESKTOP_PACKAGE_SET_FILE), join(BUILD_ROOT, DESKTOP_PACKAGE_SET_FILE))
    cpSync(join(PACKAGE_SET_ROOT, DESKTOP_PACKAGES_DIR), join(BUILD_ROOT, DESKTOP_PACKAGES_DIR), { recursive: true })
    createRuntimeProjectMetadata(BUILD_ROOT, release)
    await runPnpm(['install', '--lockfile-only'])
    verifyDesktopCoreLockfile(
      readFileSync(join(BUILD_ROOT, 'pnpm-lock.yaml'), 'utf8'),
      readDesktopCorePackageSet(BUILD_ROOT, release.version),
    )
    await runPnpm(['install', '--prod', '--frozen-lockfile', '--trust-lockfile'])
    const packageSet = readDesktopCorePackageSet(BUILD_ROOT, release.version)
    const targetName = resolveDesktopBuildTarget()
    const target = { platform: process.platform, arch: targetName.endsWith('arm64') ? 'arm64' : 'x64' }
    const modules = join(BUILD_ROOT, 'node_modules')
    mkdirSync(DSH_OUTPUT_ROOT, { recursive: true })
    cpSync(modules, join(DSH_OUTPUT_ROOT, 'node_modules'), {
      recursive: true, dereference: true,
      filter: source => desktopRuntimeFileExclusion(relative(modules, source), target) === undefined,
    })
    writeFileSync(join(DSH_OUTPUT_ROOT, 'package.json'), `${JSON.stringify({
      name: '@deepseek-ai/dsh-desktop-runtime', private: true, version: release.version, type: 'module',
      dependencies: Object.fromEntries(packageSet.packages.map(entry => [entry.name, entry.version])),
    }, undefined, 2)}\n`)
    for (const file of DESKTOP_HOST_RUNTIME_FILES) {
      if (!existsSync(join(DSH_OUTPUT_ROOT, 'node_modules', DESKTOP_HOST_PACKAGE, file))) {
        throw new Error(`desktop runtime: missing private Host file ${file}`)
      }
    }
    // 必须在 writeDesktopRuntime 生成哈希清单之前执行。
    applyRuntimePatches(DSH_OUTPUT_ROOT)
    // 二次开发：仅在配置了签名身份时才预签名运行时。
    // 上游在 macOS 上无条件签名并要求 Apple 证书；本机自用（不签名、不公证、不分发）
    // 时该步骤无法完成也并非必需——本地构建的文件不带 quarantine 属性，可直接双击运行，
    // 且 electron-builder 配置的 signIgnore 本就跳过 /Contents/Resources/dsh。
    // 设置了 DSH_DESKTOP_MACOS_SIGNING_IDENTITY 时行为与上游完全一致。
    const configuredSigningIdentity = process.env.DSH_DESKTOP_MACOS_SIGNING_IDENTITY?.trim()
    if (process.platform === 'darwin' && configuredSigningIdentity !== undefined && configuredSigningIdentity !== '') {
      await signMacOSRuntime(DSH_OUTPUT_ROOT, resolveDesktopAppId(process.env), resolveMacOSSigningEnvironment(process.env))
    }
    writeDesktopRuntime(DSH_OUTPUT_ROOT, release, packageSet.packages.map(entry => entry.name), target)
    const descriptor = await verifyDesktopRuntime(DSH_OUTPUT_ROOT, release.version, target)
    await new Promise<void>((accept, reject) => {
      execFile(NODE, [join(APP_ROOT, 'tests/fixtures/runtime-payload-smoke.mjs'), DSH_OUTPUT_ROOT],
        { timeout: 120_000, env: { ...process.env, NODE_OPTIONS: '' } }, (error, stdout, stderr) => {
          if (error !== null) reject(new Error(`desktop native payload smoke failed: ${stderr}`, { cause: error }))
          else { process.stdout.write(stdout); accept() }
        })
    })
    await smokeDesktopRuntime(DSH_OUTPUT_ROOT, NODE, descriptor)
    await verifyDesktopRuntime(DSH_OUTPUT_ROOT, release.version, target)
  } catch (error) {
    rmSync(DSH_OUTPUT_ROOT, { recursive: true, force: true })
    throw error
  } finally {
    rmSync(BUILD_ROOT, { recursive: true, force: true })
    rmSync(PNPM_BUILD_STATE, { recursive: true, force: true })
  }
}

await main()
