/**
 * 本机未签名打包配置：产出可直接双击运行的 macOS .app。
 *
 * 为什么需要这个文件：
 * 官方 `apps/desktop/electron-builder.config.mjs` 在 macOS 上**无条件**要求
 * Apple 签名证书、Team ID 与公证凭据（`desktop-release-environment.mjs` 的
 * `resolveMacOSSigningEnvironment` / `resolveMacOSNotarizationEnvironment` 用
 * `requireEnvironmentValue` 直接抛错），并且 `package-target.ts` 的 `--unsigned`
 * 只允许 win-x64。因此官方入口无法在本机（无开发者证书）产出 .app。
 *
 * 做法：在导入官方配置之前补齐这些变量的占位值，让官方配置函数能正常求值，
 * 随后把签名、公证与自动更新字段覆盖为本机未签名构建所需的值。
 * **不修改官方任何文件**，只在 electron-builder 加载本配置时生效。
 */

// 官方 createElectronBuilderConfig() 在模块求值阶段就校验这些变量，
// 因此必须在 import 官方模块之前提供占位值。已存在的真实值不会被覆盖。
process.env.DSH_DESKTOP_APP_ID ??= 'com.sankuai.dsh'
process.env.DSH_DESKTOP_MACOS_SIGNING_IDENTITY ??= 'DSH-LOCAL-UNSIGNED'
process.env.DSH_DESKTOP_MACOS_TEAM_ID ??= '0000000000'
process.env.APPLE_KEYCHAIN_PROFILE ??= 'dsh-local-unsigned'
process.env.DOWNLOAD_TEST_ORIGIN ??= 'https://download.deepseek.com'

const { default: official } = await import('../apps/desktop/electron-builder.config.mjs')

/** @type {Record<string, unknown>} */
const config = { ...official }

// 本机自用：不签名、不公证，只产出可直接打开的 .app。
config.mac = {
  ...official.mac,
  identity: null,
  forceCodeSigning: false,
  hardenedRuntime: false,
  notarize: false,
}

// afterSign 会调用 verifyMacOSSignatureAfterSign 校验签名，未签名时必然失败；
// artifactBuildCompleted 只对 .dmg 做公证，本机构建也不适用。
config.afterSign = undefined
config.artifactBuildCompleted = undefined
config.publish = null

export default config
