# DSH 二次开发：打包与使用指南

> 基线：官方 `git@github.com:deepseek-ai/deepseek-harness.git`，master `0.1.5-rc.2`（2026-09-10）
> 本文档记录本机二次开发的产物、用法、以及踩过的坑，目的是**以后重打包一条命令搞定、不再重复踩坑**。

## 一、产物与核心能力

| 产物 | 位置 | 能力 |
|---|---|---|
| CLI 命令 `dsh` | `~/.local/bin/dsh` → `packaging/dsh` | 默认走公司 AIGC responses 接口，透传服务端原生 `web_search` |
| 交互式终端 `dsh-tui` | `~/.local/bin/dsh-tui` → `packaging/dsh-tui` | **Claude Code 风格的终端对话界面**：像素鲸鱼顶栏、实时工作状态行、流式思考、上下文进度条、TPS 仪表、双击 Esc 会话回溯 |
| 桌面应用 | `/Applications/DeepSeek Harness.app`（586MB，未签名） | 同上，双击运行 |

三者的模型能力是同一套：都由 `~/.dsh/settings.yaml` 决定默认路由，因此都默认走公司网关并具备服务端 `web_search`。

两项核心能力都**实测验证过**：

- **接入公司 responses 接口**：`https://aigc.sankuai.com/agentic/v1`，直接 curl 网关得到 HTTP 200。
- **服务端原生 web search**：命令行实测时，会话日志显示全程只有 `bash` 调用、**没有任何本地搜索工具被调用**，而答案给出了当日时效性新闻——本地同名工具已被补丁剔除，因此搜索只能由网关服务端执行。

## 二、日常使用

### CLI

```bash
dsh --version                       # 0.1.5-rc.2
dsh --profile web                   # 启动 Web UI（默认浏览器打开）
dsh --profile headless "任务描述"    # 一次性执行并打印结果
```

启动器安装在 `~/.local/bin/dsh`（该目录在 PATH 中先于 `/opt/homebrew/bin`，因此覆盖旧的全局安装）。重装：

```bash
ln -sf "$(pwd)/packaging/dsh" ~/.local/bin/dsh
```

> 启动器为什么不直接把构建产物 `npm i -g`：那样它的依赖会从 registry 重新解析，`@earendil-works/pi-ai` 会拿到**未打补丁**的副本，web_search 透传随之失效。指向仓库运行才能让 profile 的共享包链接指向仓库内那份打过补丁的实现。

### 交互式终端 TUI（Claude Code 风格）

```bash
dsh-tui                      # 进入交互式对话界面
dsh-tui --resume             # 恢复上次会话
```

**必须在真实终端里运行**：被管道重定向时（`dsh-tui | tee`）会检测到非 TTY 并给出提示退出，这是刻意设计而不是故障。

实现方式是**社区插件挂载，零核心改动**：`~/.dsh/profiles/dsh-tui/` 把 `@deepseek-harness-tui/dsh-tui` 挂载在官方 `@deepseek-ai/dsh-base` 之上。装法：

```bash
dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui
ln -sf "$(pwd)/packaging/dsh-tui" ~/.local/bin/dsh-tui
```

> **profile 名必须是 `dsh-tui`**：插件自带的启动器按 `$DSH_HOME/profiles/dsh-tui` 委托自己执行，`/update` 自更新也依赖这个约定；换成别的名字会让它的自举与自更新失效。

> **为什么不用官方内置 TUI**：上游已在 0.1.5 线移除了 CLI 内置的 `tui`（`apps/cli/tests/built-bin.e2e.ts` 明确断言 `tui` 已下线），终端交互现在由社区插件提供。

### 桌面应用

双击 `/Applications/DeepSeek Harness.app` 即可。首次启动会在 `$DSH_HOME`（默认 `~/.dsh`）下生成 `profiles/desktop`，并与 CLI 共用同一份 `settings.yaml` 与 `.env`。

⚠️ **不要从已注入 `DSH_HOME` 的终端里直接运行它的可执行文件**（见坑 6）。从 Finder/Dock 启动不受影响。

### 重新打包（一条命令）

```bash
bash packaging/build-app.sh
```

脚本依次执行：准备运行时（构建 + 组装 + 打补丁 + 哈希清单）→ electron-builder 打包 → ad-hoc 签名 → 安装到 `/Applications`。热缓存下约 1 分钟。

### 应用图标

图标语义是「**插件轨道**」：官方鲸鱼（路径直接取自 `packages/client/ui-primitives/src/FishLogo.tsx`，未重绘）+ 环形轨道与四个节点，表示「插件围绕核心编排」。配色为品牌蓝 `#4D6BFE` → 青 `#22D3EE` 对角渐变。

改图标只需替换 `apps/desktop/assets/icon.svg`，然后重新生成：

```bash
pnpm --filter @deepseek-ai/dsh-desktop build:icons
```

脚本渲染出 16 / 32 / 64 / 128 / 256 / 512 / 1024 共 10 档 PNG 并打成 `icon.icns`，同时导出 `icon.png` 供 Windows / Linux 构建使用；中间目录 `icon.iconset` 用完即删。

- `icon.icns`（约 1.4MB）是打包必需资源，直接入库。偏大的原因是图标是大面积渐变 + 抗锯齿边缘，PNG 压缩率天然低；本机没有 pngcrush/optipng 之类的无损压缩工具，实测 `sips` 重编码无效果（反而略增）。
- 图标 SVG 带 alpha，**不能用 `sips`/`qlmanage` 转 PNG**——它们会把圆角外的透明压成白底，Dock 里就是白方块。`build-icons.mjs` 走 Electron 的 Chromium 离屏渲染来保留 alpha。

## 三、改动清单（跟随上游更新的成本面）

改动刻意收敛，上游 `git pull` 时需要处理的只有这几处：

| 文件 | 改动性质 |
|---|---|
| `patches/@earendil-works__pi-ai@0.85.1.patch` | **新增**：openai-responses 路由透传服务端原生工具，并剔除同名 function 工具 |
| `pnpm-workspace.yaml` | **1 行**：声明上面的补丁（`patchedDependencies`） |
| `apps/desktop/scripts/prepare-dsh.ts` | **3 处小改**：注册表可覆盖 / 未配置签名身份时跳过运行时预签名 / 组装后把补丁传导进运行时 |
| `apps/desktop/tests/fixtures/runtime-payload-smoke.mjs` | **1 处**：`fs-ext` 缺席时跳过该项校验 |
| `apps/desktop/electron-builder.config.mjs` | **3 行**：mac/win/linux 各加一个 `icon` 字段（原配置未设图标，打包产物一直用 Electron 默认图标） |
| `apps/desktop/src/main.ts`、`apps/desktop/src/locale.ts`、`apps/desktop/tests/main-startup.spec.ts` | **新增 View 菜单**：绑定系统缩放 role（`resetZoom`/`zoomIn`/`zoomOut`）。上游用自定义菜单整体替换了 Electron 默认菜单却未补 View 菜单，导致 `Cmd +/-/0` 完全无响应。菜单文案走 locale 字典 |
| `apps/desktop/assets/`（新增目录） | 应用图标：`icon.svg` 源文件 + `icon.icns` / `icon.png` 产物 |
| `apps/desktop/scripts/build-icons.mjs`（新增） | `icon.svg` → 10 档 PNG → `icon.icns` 的生成脚本；接在 `build:icons` |
| `packaging/`（新增目录） | `dsh` 启动器、`dsh-tui` 交互式终端启动器、`build-app.sh` 一键打包、`electron-builder.unsigned.config.mjs` 未签名配置 |
| 仓库外配置 | `~/.dsh/settings.yaml`（公司 provider + 默认模型）、`~/.dsh/.env`（`SANKUAI_API_KEY`、`RESPONSES_NATIVE_TOOLS=web_search`） |

## 四、踩坑记录

### 坑 1：构建报 Node-API headers 缺失，路径指向 Electron Helper

- **现象**：`build: Node-API headers missing at .../DSH Desktop Dev Helper.app/Contents/include/node`
- **根因**：执行环境的 `PATH` 首位被注入了 `.desktop-bin`，导致 `node` 解析成 **Electron 自带的 Node**，`process.execPath` 指向 Helper，构建脚本据此推导头文件路径必然落空。
- **修复**：构建一律显式使用系统 Node（`/opt/homebrew/bin/node`，自带 headers）。`packaging/build-app.sh` 与 `packaging/dsh` 都已固定这一点。

### 坑 2：`prepare:dsh` 报 `ERR_PNPM_META_FETCH_FAIL` 超时

- **现象**：`GET https://registry.npmjs.org/negotiator: The operation was aborted due to timeout`
- **根因**：`prepare-dsh.ts` 把 registry **硬编码**为 `registry.npmjs.org`，还会过滤掉继承的 `npm_*`/`pnpm_*` 环境变量，因此无法从外部改源。而该源在本网络下 15 秒超时（同一时刻 npmmirror 仅 0.18 秒），这一步**永远不会成功**。
- **修复**：`prepare-dsh.ts` 增加 `DSH_DESKTOP_NPM_REGISTRY` 覆盖，**默认值仍是上游官方源**，不设置时行为与上游一致。`build-app.sh` 默认用国内镜像。

### 坑 3：macOS 打包无条件要求 Apple 证书

- **现象**：`desktop release environment: DSH_DESKTOP_APP_ID must be set` → 补上后变成 `DSH_DESKTOP_MACOS_SIGNING_IDENTITY must be set`
- **根因**：官方 `electron-builder.config.mjs` 的 `packagesMacOS` 分支**无条件**调用签名与公证环境解析，用 `requireEnvironmentValue` 直接抛错；且 `package-target.ts` 的 `--unsigned` 只允许 `win-x64`。
- **修复**：新增 `packaging/electron-builder.unsigned.config.mjs`——在导入官方配置前补齐占位环境变量使其可求值，随后把 `identity/forceCodeSigning/hardenedRuntime/notarize` 覆盖为本机未签名所需的值，并移除 `afterSign`（它会校验签名）与 `artifactBuildCompleted`（它给 .dmg 做公证）。**没有改动官方任何文件。**

### 坑 4：`prepare:dsh` 报 `DSH_DESKTOP_MACOS_SIGNING_IDENTITY must be set`

- **根因**：该步骤在 macOS 上无条件调用 `signMacOSRuntime`，遍历运行时里所有 Mach-O 逐个签名并验证。
- **修复**：仅在**确实配置了**签名身份时才预签名；未配置则跳过。本机自用（不签名、不公证、不分发）时该步骤既无法完成也非必需，而 electron-builder 配置本就以 `signIgnore` 跳过 `/Contents/Resources/dsh`。设置了该变量时行为与上游完全一致。

### 坑 5：冒烟校验报 `Cannot find module 'fs-ext'`

- **根因**：`fs-ext` **不属于核心包闭包**。遍历 `package-set` 全部 241 个包，`koffi` 被 6 个包声明、`sharp`/`turndown`/`node-pty` 各 1 个，**`fs-ext` 声明数为 0**；全部构建产物里也没有任何消费方。它只是 unzipper / electron-winstaller 这类**构建期**工具的可选加速器。
- **修复**：该模块缺席时明确跳过这一项校验（其余 koffi / sharp / HTML / PTY 四项照常执行），避免把上游自身的不一致当成运行时缺陷。

### 坑 6：`.app` 双击无反应 / 进程 exit 0 且零输出

这是**两个独立原因**叠加，必须都解决：

- **原因 A（签名）**：未签名的产物在系统日志里报 `securityd: MacOS error: -67062`（`errSecCSUnsigned`），`codesign --verify` 报 `code has no resources but signature indicates they must be present`。根因是 `identity: null` 让 electron-builder **删掉了原始的 `_CodeSignature` 却不重建**，bundle 处于签名不一致状态。
  **修复**：对**最外层 bundle** 做 ad-hoc 签名。**绝不能加 `--deep`**——那会重签 `Resources/dsh` 下的原生文件、改变其字节，使 `desktop-runtime.json` 记录的哈希与实际不符，启动时会被判定为资源被篡改。只签外层时 `codesign` 会对资源**计算**哈希而不修改文件，实测补丁计数在签名前后均为 2，证明运行时未被触碰。
- **原因 B（环境变量）**：从**已注入 `DSH_HOME` 的终端**里启动时，应用会继承一个「属于另一个安装的 home」并静默退出（exit 0、无任何输出、连 userData 都不创建）。从 Finder 双击不会继承这些变量，因此不受影响。
  **修复/规避**：日常双击即可；如需命令行测试，用干净环境启动：
  ```bash
  env -i HOME="$HOME" PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
    "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
  ```

### 坑 7（最容易漏）：补丁不会自动进入桌面端运行时

- **现象**：`.app` 打出来了，但内置运行时的 pi-ai 补丁计数为 **0**——桌面端**没有**服务端 web_search 能力。
- **根因**：桌面运行时是 pnpm 在临时目录里做的**一次独立 prod 安装**，仓库 `pnpm-workspace.yaml` 的 `patchedDependencies` 只作用于仓库自身，**不会传导**过去。
- **修复**：在 `prepare-dsh.ts` 组装运行时、**生成哈希清单之前**把补丁应用到运行时。顺序很关键：晚于哈希清单就会造成内容与清单不一致。
- **顺带说明**：只把 `@earendil-works/pi-ai` 列入传导名单；`node-pty` 等仓库补丁按上游做法不进运行时，避免引入无谓偏差。

### 坑 8：插件报 `does not provide an export named ...`

- **现象**：装上 Claude Code 风格 TUI 插件 `dsh-cc-tui` 后，启动报
  `@deepseek-ai/dsh-settings does not provide an export named 'settingsNamespace'`——**连官方内置的 `agent-presets` 也报同一个错**，很容易误判成"插件与框架不兼容"。
- **根因**：该插件把 19 个 `@deepseek-ai/dsh-*` **宿主包写进了 `dependencies`**（而非 `peerDependencies`），pnpm 于是在 profile 内装了一份**旧版框架副本**（实测 `0.1.0-rc.8`，是实体目录），与我们构建的 `0.1.5-rc.2` 同时存在。两代 API 已不兼容：`settingsNamespace`、`resolveSessionPreset` 在 0.1.5 线**已不存在**（已在 `packages/settings/settings/src/index.ts` 与实际导出上核实）。
- **判据（选插件前先跑这一条）**：
  ```bash
  ls ~/.dsh/profiles/<profile名>/node_modules/@deepseek-ai/ 2>/dev/null | wc -l   # 应为 0
  ```
  非 0 就说明插件自带框架副本，迟早与宿主冲突。
- **修复**：改用把宿主包声明为 `peerDependencies` 的插件 —— **`@deepseek-harness-tui/dsh-tui@0.10.x`**，是同一作者的同一个 Claude Code 风格 TUI（像素鲸鱼顶栏、工作状态行、TPS 仪表、双击 Esc 回溯），打包方式正确，peer 范围里**明确列出了 `0.1.5-rc.1`**。装完 profile 内一方包副本数为 **0**，直接可用。
- **教训**：第三方 dsh 插件**先看它有没有把 `@deepseek-ai/dsh-*` 写进 `dependencies`**；写了就别用，或接受版本锁死。

### 坑 9：`dsh plugin` 装到了别人的 home

- **现象**：`dsh plugin --profile cc-tui add ...` 报成功，但 `~/.dsh/profiles/cc-tui` 不存在。
- **根因**：执行 shell 里被注入了 `DSH_HOME`（本机为 `dsh-desktop-dev` 的 home），`dsh` 优先采用它，于是 profile 装到了那个 home；**从你自己的终端跑不会带这个变量**，所以只有自动化/嵌入场景会中招。
- **修复**：需要锁定到默认 home 时显式清掉：`env -u DSH_HOME dsh plugin ...`。

### 坑 10：bash 调用报 `"sandbox_permissions" must be a string`

- **现象**：模型每次执行 bash 都失败重试两三**轮**，报 `ToolArgsError: INVALID_ARGS — "sandbox_permissions" must be a string`；重试一次后变成 `must be one of ["workspace-write","danger-full-access"]`。
- **根因（已坐实，不是推测）**：公司网关会强制给函数工具加 `"strict": true`。OpenAI strict 模式要求**每个属性都出现在 `required` 里**，于是模型必须为「本次用不到」的可选字段填值，无值可填时只能填 `null` 或空串。而 `packages/shell/tool-bash/src/index.ts:244-269` 只把 `command`/`description` 标为必填，`sandbox_permissions`/`justification` 本就是可选的——校验器（`packages/core/tools/src/schema.ts:478` → `json-schema.ts:607`）按 schema 拒绝 `null` 与非枚举值。**即工具定义没错，是网关的 strict 改写与校验器之间的缝隙。**
- **修复**：在 `packages/llm/llm-pi-ai/src/stream.ts` 的 `toolcall_end` 分支——参数进入校验的**最后一道关口**——把对象型参数里的 `null` 与纯空白字符串剔除；只处理对象，数组、标量原样保留，实际剔除时向 stderr 打一行诊断。
- **验证**：改前模型执行 `date` 失败 3 次；改后**第 1 次即成功**，stderr 出现 `dsh: dropped blank tool arguments for bash: sandbox_permissions, justification`，会话日志中 `tool/call` 计数为 **1**。
- **注**：与 dsh-desktop 的修法同源（其 `@deepseek-ai+dsh-llm-pi-ai` 补丁），但那边的 `dsh-llm-pi-ai` 来自 npm，可直接用 `patchedDependencies` 打 `lib/index.js`；**本仓库该包是 workspace 源码包，`patchedDependencies` 对 workspace 包不生效，必须直接改源码。**

### 坑 11：模型名带了过期日期

- **现象**：界面显示 `deepseek-v4.1-flash-expires-on-0910`——名字里就写着 09-10 过期。
- **根因**：`settings.yaml` 里 `id` 是**发给网关的底层模型名**、`name` 才是**界面展示名**。旧配置把过期代号填进了 `id`（这个错误是从 dsh-desktop 的模板里继承来的）。
- **修复**：`id: deepseek-v4-flash`（底层真名）＋ `name: DeepSeek V4.1 Flash`（展示名），`agent-default-model.model` 同步改为 `deepseek-v4-flash`。网关实测两个名字**当前都返回 200**，但过期名随时失效，不要等它挂掉。
- **教训**：换模型时改 `id`，不要改 `name`；名字里带日期的代号一律视为临时。

## 五、换机恢复清单

1. **基础工具**：Node 22.19+/24+、pnpm 11.7.0（`corepack enable --install-directory ~/.local/bin && corepack pnpm -v` 应输出 11.7.0）、Xcode Command Line Tools。
2. **克隆并构建**：
   ```bash
   git clone <你的 fork> ~/MyApps/deepseek-harness && cd ~/MyApps/deepseek-harness
   pnpm install && pnpm run build:official
   ```
3. **装 CLI 启动器**：`ln -sf "$PWD/packaging/dsh" ~/.local/bin/dsh && dsh --version`
4. **写配置**（这两份不在仓库里，含密钥）：
   - `~/.dsh/settings.yaml`：`llm-pi-ai.providers.sankuai`（`api: openai-responses`、`baseURL: https://aigc.sankuai.com/agentic/v1`、`apiKeyEnv: SANKUAI_API_KEY`、`contextWindow: 1000000`、`maxTokens: 393216`、`input: [text, image]`、`reasoningEfforts` 映射）+ `agent-default-model` 指向该路由
   - `~/.dsh/.env`：`SANKUAI_API_KEY=<AppID>`、`RESPONSES_NATIVE_TOOLS=web_search`
   - ⚠️ 变量名**不能**用 `DSH_` 前缀：app-boot 的 `BOOTSTRAP_PREFIXES` 会拒绝 `.env` 里的 `DSH_*`
   - ⚠️ YAML 里 `"off"` **必须加引号**：YAML 1.1 会把裸 `off` 解析成布尔 false
5. **装交互式终端 TUI**（可选，profile 名必须叫 `dsh-tui`）：
   ```bash
   dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui
   ln -sf "$PWD/packaging/dsh-tui" ~/.local/bin/dsh-tui
   dsh-tui                     # 须在真实终端里运行
   ```
6. **打包桌面端**：`bash packaging/build-app.sh`
7. **验证**：
   ```bash
   dsh --version                                  # 应为 0.1.5-rc.2
   grep -c RESPONSES_NATIVE_TOOLS "/Applications/DeepSeek Harness.app/Contents/Resources/dsh/node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js"   # 应为 2
   codesign --verify "/Applications/DeepSeek Harness.app" && echo 签名有效
   ```
   最后双击应用发一句「搜索并总结今天的一条主要科技新闻」——能给出当日真实新闻，即代表服务端搜索生效。

## 六、跟随上游更新

```bash
git fetch upstream && git merge upstream/master     # 或 rebase
pnpm install && pnpm run build:official
bash packaging/build-app.sh
```

冲突面就是第三节表格里那几处。若上游自行修复了坑 2/4/5，可把对应改动撤掉改回上游版本。

`pi-ai` 版本升级时，`patches/@earendil-works__pi-ai@*.patch` 的文件名带版本号，需按新版本重新生成补丁（`pnpm patch @earendil-works/pi-ai@<新版本>` → 改 `dist/api/openai-responses.js` → `pnpm patch-commit`）；`prepare-dsh.ts` 的传导逻辑按版本号匹配，版本不符会明确跳过并打印提示，不会把补丁打到错误实现上。

## 七、上游自动追踪（每周一）

`/Users/steven/Library/Application Support/dsh-sync/check-upstream.sh` 由 launchd 任务
`com.steven.dsh-upstream-check` 在**每周一 10:17** 自动执行，检查两个对象：

| 追踪对象 | 检查内容 |
|---|---|
| `deepseek-ai/deepseek-harness` | 自上次记录以来的新提交、上游 `package.json` 版本、你的 fork 落后多少 |
| `@deepseek-harness-tui/dsh-tui` | npm 最新版 与本机已装版本 的差异 |

**行为**：有更新时把报告写到桌面 `DSH上游追踪-YYYYMMDD.md` 并弹系统通知；**无更新时静默退出**，不产生任何打扰。全程走 GitHub API 与 npm registry，不依赖本地仓库状态。

**为什么不追踪 `dataelement/dsh-desktop` 了**：二次开发已从「包装第三方桌面壳」改为「直接包装官方仓库」，它不再是直接上游；按「只追踪直接上游，底层上游由直接上游传导」的原则移出追踪范围。

**为什么脚本放在 Library 而不是项目或桌面**：macOS 的 TCC 禁止 launchd **读取** `~/Desktop`，脚本不能放桌面、也不能操作桌面的 git 仓库；而报告写到桌面是允许的（写入不受限）。

```bash
# 手动检查（无变化则静默）
bash ~/Library/Application\ Support/dsh-sync/check-upstream.sh
# 强制出报告，用于验证链路
bash ~/Library/Application\ Support/dsh-sync/check-upstream.sh --force
```

**换机后重建**：把 `check-upstream.sh` 放回同一路径并 `chmod +x`；把
`com.steven.dsh-upstream-check.plist` 放进 `~/Library/LaunchAgents/` 后
`launchctl load -w` 它；首次运行只记基线、不发通知。

⚠️ **写这个脚本时的坑**：`$变量` 后面紧跟中文标点时必须写成 `${变量}`。实测 `${SUB:+$SUB；}` 会让 bash 把全角分号并进变量名，报 `unbound variable: SUB；` 并让整个任务以非零码退出。
