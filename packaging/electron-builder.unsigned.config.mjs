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
// 因此必须在 import 官方模块之前提供占位值。已有非空真实值时不会被覆盖。
// 注意用「非空」判断而不是 `??=`：上游把 .env.macos 里的空值原样注入 process.env，
// `??=` 对空串无效，占位值补不上，配置求值会以
// `... requires an HTTPS origin` / `must be set to a non-empty value` 直接失败。
const placeholder = (name, value) => {
  const current = process.env[name]
  if (current === undefined || current.trim() === '') process.env[name] = value
}
placeholder('DSH_DESKTOP_APP_ID', 'com.sankuai.dsh')
placeholder('DSH_DESKTOP_MACOS_SIGNING_IDENTITY', 'DSH-LOCAL-UNSIGNED')
placeholder('DSH_DESKTOP_MACOS_TEAM_ID', '0000000000')
placeholder('APPLE_KEYCHAIN_PROFILE', 'dsh-local-unsigned')
// 上游 0.1.6-alpha.2 起在 electron-builder 配置求值阶段就解析自动更新与强制更新策略
// （desktop-auto-update-environment.mjs / desktop-policy-environment.mjs），缺值直接抛错。
// 上游 0.1.6-alpha.2 的 afterPack 只要配置里存在更新源就会写 App 内更新 feed，
// 而 feed 的 origin 来自这里；本机自用不发布，只求「配置能求值」。
// 选 production 部署：它的下载 origin 是写死的 HTTPS 常量，不依赖本机 dotenv 里
// 为空的 DOWNLOAD_TEST_ORIGIN。
process.env.DSH_DESKTOP_AUTO_UPDATE_ENV = 'production'
placeholder('DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN', 'https://harness-test.deepseek.com')
placeholder('DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN', 'https://harness.deepseek.com')
// 声明未签名构建：官方配置据此跳过签名、公证与自动更新产物（`update === undefined`），
// 否则 afterPack 会在 publish 已置空的情况下仍去解析更新 feed。
process.env.DSH_DESKTOP_UNSIGNED = '0'

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
// 本机自用不发布：保留官方解析出的更新源（afterPack 用它写 App 内更新 feed，置空会
// 抛 `publish must contain exactly one provider`），实际不发布由上层的
// `--publish never` 保证——官方入口也是靠它，而不是靠把 publish 置空。

export default config
