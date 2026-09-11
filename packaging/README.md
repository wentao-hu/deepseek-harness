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

**完成通知**：任务跑完且窗口不在前台时弹 macOS 原生通知（标题为会话标题，正文形如「第 3 回合已完成」）。由 `packaging/desktop-notification/` 插件提供，`build-app.sh` 打包后自动装入 profile —— 首次加载会弹一条「通知已启用」确认，macOS 正是靠这次成功发送把应用登记进「系统设置 → 通知」（见坑 12）。

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
| `packages/llm/llm-pi-ai/src/stream.ts`、`packages/llm/llm-pi-ai/tests/convert.spec.ts` | **新增**（坑 10）：`toolcall_end` 处剔除模型给提权字段填的占位词（`null`/`none`/`nil`/`undefined`）。该包在本仓库是 **workspace 源码包**，`patchedDependencies` 对它不生效，必须直接改源码 |
| `packages/llm/llm-pi-ai/src/stream.ts`、`packages/llm/llm-pi-ai/tests/convert.spec.ts` | **新增**（坑 13）：`classifyPiAiError` 把配额判定提到 401/403 之前，并把 403 从 `AUTH` 拆成独立的 `FORBIDDEN`——公司网关把配额耗尽也渲染成 403，先判状态码会把配额问题误报成 key 失效 |
| `packages/sandbox/sandbox/src/escalation.ts`、`packages/sandbox/sandbox/tests/escalation.spec.ts`、`packages/shell/tool-bash/tests/tools.spec.ts`、`packages/shell/tool-pwsh/tests/tools.spec.ts` | **新增**（坑 14）：`approveEscalation` 在请求模式**等于**当前模式时直接放行，不再抛 `not strictly wider`。同族两个测试文件把「相等即报错」的用例换成真正的更窄场景 |
| `apps/desktop/scripts/prepare-dsh.ts` | **3 处小改**：注册表可覆盖 / 未配置签名身份时跳过运行时预签名 / 组装后把补丁传导进运行时 |
| `apps/desktop/tests/fixtures/runtime-payload-smoke.mjs` | **1 处**：`fs-ext` 缺席时跳过该项校验 |
| `apps/desktop/electron-builder.config.mjs` | **3 行**：mac/win/linux 各加一个 `icon` 字段（原配置未设图标，打包产物一直用 Electron 默认图标） |
| `apps/desktop/src/main.ts`、`apps/desktop/src/locale.ts`、`apps/desktop/tests/main-startup.spec.ts` | **新增 View 菜单**：绑定系统缩放 role（`resetZoom`/`zoomIn`/`zoomOut`）。上游用自定义菜单整体替换了 Electron 默认菜单却未补 View 菜单，导致 `Cmd +/-/0` 完全无响应。菜单文案走 locale 字典 |
| `apps/desktop/src/main.ts`、`apps/desktop/src/locale.ts`、`apps/desktop/tests/main-startup.spec.ts` | **新增 Edit 菜单**：绑定系统剪贴板 role（`undo`/`redo`/`cut`/`copy`/`paste`/`selectAll`）。与上面 View 菜单同一根因——上游自定义菜单整体替换了默认菜单却未补 Edit 菜单，macOS 上 `Cmd+C/V/X/A/Z` 因此全部无响应。菜单文案走 locale 字典 |
| `apps/desktop/src/main.ts`、`apps/desktop/src/locale.ts`、`apps/desktop/tests/main-startup.spec.ts` | **新增 File 与 Window 菜单**（坑 15）：File 绑 `close`（`Cmd+W` 关窗）、Window 用系统 `windowMenu`（`Cmd+M` 最小化 / Zoom）。这是同一根因的第三、四次——上游自定义菜单替换默认菜单后，View / Edit / File / Window **四组 role 全部缺失**。`Cmd+W` 可用也是「关窗不退出」体验的前提：关窗后后端仍在跑，点 Dock 重开是秒开 |
| `apps/desktop/src/main.ts` | **标题栏变白**（坑 16）：`nativeTheme.themeSource = 'light'` 强制应用使用浅色外观，macOS 原生标题栏随之由深灰变为白色。做法借鉴 `~/MyApps/DSChat` |
| `apps/desktop/src/main.ts`、`apps/desktop/tests/main-startup.spec.ts` | **标题栏文字留空**（坑 16）：窗口标题不再跟随页面 `document.title`——harness 把当前对话名写进 `<title>`，标题栏会多出一行与界面内对话标题重复的小字。做法是 `title: ''` + 监听 `page-title-updated` 阻止改写，**布局不变**（不用 `titleBarStyle`，那会改布局） |
| `apps/desktop/assets/`（新增目录） | 应用图标：`icon.svg` 源文件 + `icon.icns` / `icon.png` 产物 |
| `apps/desktop/scripts/build-icons.mjs`（新增） | `icon.svg` → 10 档 PNG → `icon.icns` 的生成脚本；接在 `build:icons` |
| `packaging/`（新增目录） | `dsh` 启动器、`dsh-tui` 交互式终端启动器、`build-app.sh` 一键打包、`electron-builder.unsigned.config.mjs` 未签名配置 |
| `packaging/desktop-notification/`、`packaging/install-desktop-notification.sh`（新增） | **桌面完成通知插件**：浏览器半订阅 `turn/end` 事件流，窗口失焦时弹 Electron 原生通知；安装脚本幂等写入 `profiles/desktop`，`build-app.sh` 末尾自动调用。**零上游文件改动** |
| `scripts/translation-pairing.manifest.json`、`docs/i18n/README.md`、`docs/i18n/README.zh.md` | **排除登记**：把 `packaging/README.md` 加入翻译配对排除列表（它是本 fork 的本地运维说明，只以中文维护）。manifest 与中英两版 README 需同改，改后重跑 `pnpm run verify-translation-pairing --write docs/i18n/README.md` 记录配对 |
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

### 坑 12：桌面端不弹通知，系统设置里也找不到这个应用

- **现象**：插件装好、app 重启过，但「系统设置 → 通知」列表里根本没有 `DeepSeek Harness`。
- **根因（两条叠加）**：
  1. **macOS 只在应用第一次成功发出通知之后，才把它登记进通知列表**。没成功发过，设置里就不会有这一项 —— 这不是权限被拒，而是压根还没注册。
  2. 插件按设计**只在窗口失焦时**才提醒（正看着窗口就不打扰），于是「盯着窗口等结果」这种最常见的用法，永远触发不了那个第一次。
- **取证方式**（系统层，不必读代码）：
  ```bash
  # 通知库里有没有登记（无输出＝没登记）
  defaults read com.apple.ncprefs apps | grep -i sankuai
  # LaunchServices 是否认可它有通知能力（出现 NOTIFICATION#: 即认可）
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -dump | grep -A2 com.sankuai.dsh
  ```
  实测结论：LaunchServices 有 `NOTIFICATION#:com.sankuai.dsh`，而通知库里没有它 —— 即「系统认可该应用能发通知，但它一次都没发过」。
- **修复**：插件首次加载时主动弹一条「DeepSeek Harness 通知已启用」确认；只有确认真的显示过才用 `localStorage` 记账，否则下次启动重试。重启一次即可在设置里看到本应用，且不会反复打扰。

### 坑 13：403 一律被读成「认证失败」

- **现象**（在 dsh-desktop 上观察到）：网关返回 403 时错误码一律是 `AUTH`，读起来像 API key 失效。
- **根因**：`packages/llm/llm-pi-ai/src/stream.ts` 的 `classifyPiAiError` 用 `/\b(?:401|403)\b/` 一条正则同时匹配 401 与 403，都返回 `AUTH`；而 403 是「已认证但无权访问」，与 401 的「认证失败」是两类问题。
- **修复**：配额判定（`isQuotaExceededError`）提到状态码之前，401 仍归 `AUTH`，403 拆成独立的 `FORBIDDEN`。
- **验证**：`convert.spec.ts` 新增两条断言（`HTTP 403: Forbidden` → `FORBIDDEN`、`HTTP 403: insufficient_quota` → `QUOTA`），与原有 95 项合跑全通过；`pnpm run typecheck` 退出码 0。**尚未在真实网关上验过 403 场景。**
- **注**：`FORBIDDEN` 是 0.1.5-rc.2 里没有的新错误码——界面直接展示码文本，默认重试列表不含它（与 `AUTH` 同样不重试）。来源是 dsh-desktop 的 `@deepseek-ai+dsh-llm-pi-ai` 补丁。

### 坑 14：预设模式与模型请求的模式相同时报 `not strictly wider`

- **现象**（在 dsh-desktop 上观察到）：模型带着 `sandbox_permissions` 调用 bash，返回 `sandbox escalation to "workspace-write" is not strictly wider than this call's current "workspace-write" mode`，命令没有执行。
- **根因**：`packages/sandbox/sandbox/src/escalation.ts` 的 `approveEscalation` 只认「严格变宽」——`WIDER_MODES[effectiveMode]` 不含 `effectiveMode` 自身，请求与当前模式相等时被判为非法。
- **修复**：`mode === effectiveMode` 时直接返回 `effectiveMode`，权限边界不变，也不再抛错。
- **验证**：`escalation.spec.ts` 新增「相等即放行、不询问用户」用例；`tool-bash` / `tool-pwsh` 的用例改用真正的更窄场景（`danger-full-access` 预设请求 `workspace-write`），三个文件合跑 146 项全通过；`pnpm run typecheck` 退出码 0。**尚未在真实会话里验过模型触发路径。**
- **注**：与 `docs/换机恢复指南.md` 里「报 `not strictly wider` → 权限预设是最高档 `danger-full-access`」是同一报错的两个来源——那条修的是预设过高，本条修的是预设与模型请求相等。来源是 dsh-desktop 的 `@deepseek-ai+dsh-sandbox` 补丁。
- **顺带排除的怀疑**：本机 app 是 ad-hoc 签名（`codesign --force --sign -`，必要性见 build-app.sh 注释），实测**不影响通知发送**；被 macOS 拒绝的是完全未签名的二进制。

### 坑 15：`Cmd+W` / `Cmd+M` 完全无响应

- **现象**：按 `Cmd+W` 关窗没有任何反应，只能点窗口左上角的红叉；`Cmd+M` 同样无效。
- **根因**：与 View、Edit 菜单**是同一个根因的延续**——上游用自定义菜单整体替换了 Electron 默认菜单，替换后 View / Edit / File / Window 四组 role 全部缺失。`Cmd+W` 的标准绑定是 File 菜单的 `close` role、`Cmd+M` 是 Window 菜单的 `minimize`，两者都不存在，按键自然无声无息。
- **修复**：加 File 菜单（`close` role）与 Window 菜单（系统 `windowMenu`，自带 Minimize / Zoom）。
- **为什么值得修**：`Cmd+W` 可用是「关窗不退出」体验的前提——macOS 上关窗后 app 进程不退出（`apps/desktop/src/main.ts` 的 `window-all-closed` 只在非 darwin 才调 `app.quit()`），后端保持就绪，此时点 Dock 重开是**秒开**（实测验证过），完全跳过下面那 4 秒启动；只有 `Cmd+Q` 才需要重新付这个成本。

### 坑 16：界面是浅色、标题栏却跟着深色系统走

- **现象**：系统是深色模式、应用界面选了浅色主题，但窗口顶部的原生标题栏是深灰，与界面不搭。
- **根因**：macOS 的原生标题栏由**系统外观**绘制，与应用自己的界面主题无关；Electron 也没有「只改标题栏颜色」的 API（`titleBarOverlay` 只对 Windows / Linux 生效）。
- **修复**：`apps/desktop/src/main.ts` 里 `nativeTheme.themeSource = 'light'` 强制应用使用浅色外观（做法借鉴 `~/MyApps/DSChat` 的 `syncWindowTheme`）。
- **为什么本机没有副作用**：`themeSource` 影响的是 Chromium 的 `prefers-color-scheme`，而本机 `~/.dsh/settings.yaml` 的 `ui-theme.preference` 是 `light`；只有 `system` 才会去读 `prefers-color-scheme`（`packages/client/ui-theme/src/boot-theme.ts:17`），所以界面主题不受影响。**注意：若把主题改回「跟随系统」，界面会跟着标题栏一起变浅色。**
- **启动耗时的实测结论**（顺带记录，含一条被推翻的假设）：启动页 0.31 秒出现、主界面 4.4 秒——其中 profile 准备 0.53 秒、后端 boot 加载 189 个包 / 40+ 插件约 3.5 秒。已排除网络阻塞（后端启动全程 TCP 连接数 0）。**曾假设 JS 解析是瓶颈并试过 `NODE_COMPILE_CACHE`（经 Info.plist 的 `LSEnvironment` 注入），但用 `open` 走 LaunchServices 做三次对照实测（4.02 / 3.91 / 4.21 秒）显示无差异，已移除**——那 3.5 秒是插件初始化的实际工作量，不是解析开销。
- **真正的「秒开」路径**：关窗（`Cmd+W`）而非退出（`Cmd+Q`）——macOS 上关窗不退出进程，后端保持就绪，点 Dock 重开直接跳过整个启动流程（实测秒开）。
- **顺带修掉的第二条**：标题栏里那行小字原本是**窗口标题**——Electron 默认让它跟随页面的 `document.title`，而 harness 写入的是「当前对话名 — DeepSeek Harness」，于是与界面内的对话标题重复。它一直都在，只是此前标题栏是深灰、字不显眼，**改成白色后才暴露出来**。修法是 `title: ''` + 监听 `page-title-updated` 阻止改写，布局不变。

### 坑 17：打包慢，**别去查网络**（附实测耗时地图）

- **现象**：一次 `bash packaging/build-app.sh` 约 4 分钟。日志里 pnpm 频繁打印 `downloaded 265` 和 `below 50 KiB/s`，看起来像网络瓶颈。
- **三条排查结论（全部实测，下次别重复走）**：
  1. **真正走网络的只有 9 个包**——判据是日志里 `below 50 KiB/s` 警告的**条数**（9 条），不是 pnpm 的 `downloaded` 数字；后者把「从本地 store 取包」也算进去了。
  2. **`npmmirror` 不慢**：实测 320 KB/s，比官方源 npmjs（70 KB/s）**快 4.5 倍**。`build-app.sh` 的默认源已是最优，**换源无效**。
  3. **构建是增量的**：`build:official` 热态仅 **13 秒**，不是瓶颈。
- **耗时地图**（`prepare:desktop` 实测 154 秒，加上 electron-builder 共约 4 分钟）：

  | 阶段 | 耗时 | 性质 |
  |---|---|---|
  | `release:pack` ×2（275 个 tarball） | **~87 秒** | **最大头**，每次全量重打 |
  | `prepare:dsh`（组装运行时 + 装依赖） | 48 秒 | 脚本每次 `rmSync` 后重建 |
  | `build:official` | 13 秒 | 增量，热态很快 |
  | `prepare:runtime` + `prepare:packages` | 6 秒 | |
  | electron-builder（含下载 electron zip） | ~1–2 分钟 | |

- **结论：目前没有零风险的加速手段**。唯一可省的是 `release:pack` 那 ~87 秒，但它每次重打 275 个 tarball 是有意设计（运行时靠 tarball 固化），要跳过就得改上游的 `apps/desktop/scripts/package-target.ts` 加缓存判断——冲突面 +1，而且判断失误会打出**过期的包**（源码改了却复用旧 tarball）。**权衡后暂不改**，记录在此备查。

## 五、换机恢复清单

1. **基础工具**：Node 22.19+/24+、pnpm 11.7.0（`corepack enable --install-directory ~/.local/bin && corepack pnpm -v` 应输出 11.7.0）、Xcode Command Line Tools。
2. **克隆并构建**：
   ```bash
   git clone <你的 fork> ~/MyApps/deepseek-harness && cd ~/MyApps/deepseek-harness
   pnpm install && pnpm run build:official
   ```
   重建 `CLAUDE.local.md`（二开规则，被 `.gitignore` 排除故不进仓库）：按第八节全文 `cat > CLAUDE.local.md` 粘贴。
3. **装 CLI 启动器**：`ln -sf "$PWD/packaging/dsh" ~/.local/bin/dsh && dsh --version`
4. **恢复 `~/.dsh` 配置**（独立私有仓库 `git@github.com:wentao-hu/.dsh.git`，含密钥，已同步）：
   ```bash
   git clone git@github.com:wentao-hu/.dsh.git ~/.dsh   # ~/.dsh 已存在时照该仓库 README 的「情形 B」处理，勿整目录覆盖
   bash ~/.dsh/machine/install.sh   # 一并恢复 ~/.zshrc 的 DSH 段与每周一上游追踪任务
   ```
   仓库内含 `settings.yaml`、`.env`、`.agent-presets/liangshen/`、`machine/`；排除项（`.credentials.yaml`、`profiles/`、`sessions/`、`storages/`）及原因见该仓库 README。配置要点：
   - `~/.dsh/settings.yaml`：`llm-pi-ai.providers.sankuai`（`api: openai-responses`、`baseURL: https://aigc.sankuai.com/agentic/v1`、`apiKeyEnv: SANKUAI_API_KEY`、`contextWindow: 1000000`、`maxTokens: 393216`、`input: [text, image]`、`reasoningEfforts` 映射）+ `agent-default-model` 指向该路由
   - `~/.dsh/.env`：`SANKUAI_API_KEY=<AppID>`、`RESPONSES_NATIVE_TOOLS=web_search`
   - ⚠️ 变量名**不能**用 `DSH_` 前缀：app-boot 的 `BOOTSTRAP_PREFIXES` 会拒绝 `.env` 里的 `DSH_*`
   - ⚠️ YAML 里 `"off"` **必须加引号**：YAML 1.1 会把裸 `off` 解析成布尔 false
   - ⚠️ **`~/.zshrc` 里的 `SANKUAI_API_KEY` 优先于 `.env`**：`process.loadEnvFile` 不覆盖已存在的环境变量（实测）。CLI 从终端启动时用 shell 那个、桌面端从 Finder 启动时用 `.env` 那个，两个 AppID 不同。当前两者都返回 HTTP 200，但换机后若只恢复 `.env`，CLI 会静默换号
   - ⚠️ **`DSH_RESPONSES_NATIVE_TOOLS`（带前缀）是无效配置**：补丁读的是不带前缀的 `RESPONSES_NATIVE_TOOLS`（`patches/@earendil-works__pi-ai@0.85.1.patch`），只有 `.env` 那一行生效
   - **技能来源**：`~/.agents/skills`（harness 的 user-agents skill 根）由 `link-skills.sh` 从 `~/.skills-manager`（另一个私有仓库）软链而来，换机需一并 clone 并跑一次 `bash ~/Library/Application\ Support/dsh-sync/link-skills.sh`
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

   通知链路：首次启动应弹一条「DeepSeek Harness 通知已启用」；切到别的应用后发一条消息，跑完应弹「第 N 回合已完成」。此时「系统设置 → 通知」里能看到本应用。
   profile 由应用首次启动时生成，插件装不进去时隔一层排查：`bash packaging/install-desktop-notification.sh`（幂等，可随时重跑）。

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

## 八、二开规则（`CLAUDE.local.md`）

仓库根 `CLAUDE.local.md` 是 Claude Code 每次会话自动加载的项目规则，写的是本 fork 的两条最高约束（**每周一上游追踪链路必须可用**、**换机后二开功能必须完整可用**）与改功能时的收敛要求。它被上游 `.gitignore` 第 1 行排除、不进 git——换机后按下方全文重建（`cat > CLAUDE.local.md` 粘贴即可），规则改了就同步改本节的副本。

````markdown
# 本项目二开规则

本仓库是 `deepseek-ai/deepseek-harness` 的 fork。**与上游保持可同步、且二开成果不丢失，是两条最高约束。**

## 一、每周一自动追踪上游，链路必须保持可用

launchd 任务 `com.steven.dsh-upstream-check` 每周一 10:17 执行 `~/Library/Application Support/dsh-sync/check-upstream.sh`，检查上游 `deepseek-ai/deepseek-harness` 的新提交与本 fork 落后多少；有更新则写报告到桌面并弹通知，无更新静默退出。

**做任何功能改动时不得破坏这条链路**：

- 不碰 `.github/workflows/`、根 `scripts/`、`AGENTS.md`（含 `CLAUDE.md` 符号链接，`packages/` 下同）
- 不 `--force` 重写 `master`，不改 `origin` / `upstream` 指向——脚本靠它们算落后量
- 二开规则只写在本文件，不要写进上游的 `AGENTS.md`
- **自检**：`bash ~/Library/Application\ Support/dsh-sync/check-upstream.sh --force` 能正常出报告，即为链路完好（脚本走 GitHub API，不依赖本地工作区状态）

## 二、换机后二开功能必须完整可用

换新 Mac 时按 `packaging/README.md` 第五节「换机恢复清单」操作（含 `~/.dsh` 私有仓库恢复、每周一追踪任务重建）。**恢复完必须逐项实测二开功能**：

| 二开功能 | 怎么验 |
|---|---|
| CLI 启动器 | `dsh --version` 输出 `0.1.5-rc.2` |
| Edit / View / File / Window 菜单 | app 里 `Cmd+C/V/X/A/Z`、`Cmd +/-/0` 有响应，`Cmd+W` 能关窗、`Cmd+M` 能最小化（上游自定义菜单把 View / Edit / File / Window 四组 role 全漏了，是本 fork 补的） |
| 标题栏 | 白色底、无文字（只剩红黄绿按钮）——即使在深色系统下也应是白的（`nativeTheme.themeSource = 'light'`） |
| 应用图标 | Dock 里不是 Electron 默认图标 |
| 桌面完成通知 | 窗口失焦时跑完一回合，弹「第 N 回合已完成」 |
| 服务端原生搜索 | app 里问「今天的一条科技新闻」，能给出当日真实新闻 |
| 沙箱提权放行 | 模型把提权字段填成当前模式时不再报 `not strictly wider` |
| 403 错误分类 | 网关返 403 时显示 `FORBIDDEN` 而非 `AUTH` |
| **本规则文件** | 本文件存在。它被上游 `.gitignore` 排除、不进 git，需按 `packaging/README.md` 第八节全文重建 |

## 三、改功能时的约束（保护上面两条）

1. **改动收敛**：能放 `packaging/`（本 fork 专属区）就不动上游源码；必须改上游源码时，改动点写进 `packaging/README.md` 第三节「改动清单」——那是 `git merge upstream/master` 时唯一的冲突面清单，漏登记等于下次合并时丢改动。
2. **被忽略但必需的文件**：`packaging/desktop-notification/lib/` 是手写源码（不是构建产物），却被上游 `lib/` 的忽略规则命中，提交时必须 `git add -f`——**不要改上游 `.gitignore`**。
3. **打包慢先查台账**：`packaging/README.md` 坑 17 有实测耗时地图——**别去查网络**（真正走网络的只有 9 个包，npmmirror 实测比官方源快 4.5 倍），耗时大头是 `release:pack` 每次重打 275 个 tarball（约 87 秒）。这是打包的固定成本，没有零风险的加速手段，别再花时间重新排查。

## 四、二开产物位置

- 打包与启动器：`packaging/`（其中 `README.md` 是二开总台账：改动清单、踩坑记录、换机恢复、上游追踪说明）
- 桌面端改动：`apps/desktop/`
- 桌面通知插件：`packaging/desktop-notification/`（零上游文件改动）
````

**为什么放 `CLAUDE.local.md` 而不是 `AGENTS.md`**：`AGENTS.md` 是上游文件（根 `CLAUDE.md` 与 `packages/CLAUDE.md` 都是它的符号链接），往里写规则会扩大跟随上游 `git merge` 的冲突面，与规则本身要保护的目标相悖。
