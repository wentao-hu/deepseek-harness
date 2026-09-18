import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow } from 'electron'

/**
 * 从 assets/icon.svg 生成各平台打包所需的图标，并在同一张离屏页面里渲染状态栏图标：
 *
 * - `icon.icns`：macOS 打包必需（**仅 darwin 生成**，`iconutil` 是 macOS 自带命令）。
 * - `icon.ico`：Windows 打包与窗口图标（所有平台都可生成，纯 JS 写 ICO 容器）。
 * - `icon.png`：1024×1024 源图，Windows / Linux / 运行时窗口图标使用。
 * - `trayTemplate.png` / `trayTemplate@2x.png`：macOS 模板图（源 `tray.svg`）。
 * - `trayColor.png` / `trayColor@2x.png`：Windows / Linux 彩色后备图（源 `tray-color.svg`）。
 *
 * 用法：pnpm --filter @deepseek-ai/dsh-desktop build:icons
 *
 * 四处不能改错的地方：
 * 1. 不用 `sips`/`qlmanage` 渲染 SVG —— 它们会把圆角外的透明背景压成白底，
 *    Dock 里就成了白方块（Windows 快捷方式同理，会变成「白方块包圆角矩形」）。
 *    这里借 Electron 的 Chromium 离屏渲染，保留 alpha。
 * 2. **只创建一次离屏窗口**：不管渲染几个源文件都排进同一张页面，再用一次
 *    `capturePage()` 截取；实测同一进程里创建第二个离屏窗口就会 ERR_FAILED。
 * 3. `capturePage()` 返回物理像素，Retina 屏上 1024 CSS px 会渲染成 2048。
 *    降采样必须比较**实际**尺寸：若按常量判断，最大那档会以 2048 写入 iconset，
 *    `iconutil` 发现尺寸对不上会**静默丢弃**它，icns 里从此少掉 1024 档。
 * 4. `iconutil` 只在 macOS 存在 —— 非 darwin 必须跳过 icns，否则整个脚本以
 *    ENOENT 失败、连 `.ico` 都生成不出来。但 `.ico` **不能**一并跳过：Windows 打包
 *    （`electron-builder` 的 `win.icon`）与窗口图标都要用它，且必须自己控制尺寸档位
 *    与 alpha，所以由本脚本用纯 Node 写出。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ASSETS_DIR = path.join(HERE, '..', 'assets')
const SVG_PATH = path.join(ASSETS_DIR, 'icon.svg')
const ICONSET_DIR = path.join(ASSETS_DIR, 'icon.iconset')
const ICNS_PATH = path.join(ASSETS_DIR, 'icon.icns')
const PNG_PATH = path.join(ASSETS_DIR, 'icon.png')
const ICO_PATH = path.join(ASSETS_DIR, 'icon.ico')

const BASE_SIZE = 1024

/** `iconutil` 要求的固定文件名与尺寸，少一个都会被拒。 */
const ICONSET = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
]

/**
 * Windows `.ico` 内嵌的尺寸档位。
 * 16/32 用于任务栏与资源管理器小图标，48/64 用于中等视图，128/256 用于大图标与
 * 「按 Alt+Tab 切换」的高分屏场景 —— 缺档时 Windows 会拿最近的一档硬缩放而发虚。
 */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

/** 状态栏图标以 18pt 渲染；@2x 文件固定为 36px。 */
const TRAY_POINT_SIZE = 18
const TRAY_RETINA_SIZE = TRAY_POINT_SIZE * 2

/** 同一张离屏页面里的三个渲染区域；坐标单位为 CSS 像素。 */
const APP_ICON_LAYOUT = { x: 0, y: 0, size: BASE_SIZE }
const TRAY_LAYOUT = [
  { name: 'tray.svg', x: 0, y: BASE_SIZE, size: TRAY_RETINA_SIZE },
  { name: 'tray-color.svg', x: TRAY_RETINA_SIZE + 16, y: BASE_SIZE, size: TRAY_RETINA_SIZE },
]
const PAGE_WIDTH = BASE_SIZE
const PAGE_HEIGHT = BASE_SIZE + TRAY_RETINA_SIZE + 8

/** 等待时长：离屏渲染要画完一帧 `capturePage` 才拿得到内容。 */
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 把三个 SVG 排进同一张离屏页面并截一张图。
 * @param appIconSvg - `icon.svg` 的完整内容。
 * @param traySvgs - 状态栏图标源文件的完整内容，按 TRAY_LAYOUT 顺序排列。
 * @returns 完整页面截图，Retina 屏上可能是两倍物理像素。
 */
async function renderIconPage (appIconSvg, traySvgs) {
  const canvases = [
    `<div class="canvas" style="left:${APP_ICON_LAYOUT.x}px;top:${APP_ICON_LAYOUT.y}px;` +
      `width:${APP_ICON_LAYOUT.size}px;height:${APP_ICON_LAYOUT.size}px">${appIconSvg}</div>`,
    ...TRAY_LAYOUT.map((slot, index) =>
      `<div class="canvas" style="left:${slot.x}px;top:${slot.y}px;` +
        `width:${slot.size}px;height:${slot.size}px">${traySvgs[index]}</div>`),
  ].join('')

  const html = `<!doctype html><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; width: ${PAGE_WIDTH}px; height: ${PAGE_HEIGHT}px;
                 overflow: hidden; background: transparent; }
    .canvas { position: absolute; overflow: hidden; }
    .canvas svg { display: block; width: 100%; height: 100%; }
  </style>${canvases}`

  const htmlPath = path.join(app.getPath('temp'), `dsh-icon-${Date.now()}.html`)
  fs.writeFileSync(htmlPath, html)

  const win = new BrowserWindow({
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true },
  })

  try {
    await win.loadFile(htmlPath)
    await wait(700)
    const image = await win.webContents.capturePage()
    if (image.isEmpty()) throw new Error('capturePage 返回了空图')
    return image
  } finally {
    win.destroy()
    try {
      fs.unlinkSync(htmlPath)
    } catch {
      // 临时文件删不掉不影响产物
    }
  }
}

/**
 * 把一张基准位图缩到精确边长，尺寸不符时立刻报错。
 * @param image - 基准位图。
 * @param size - 目标边长。
 * @param label - 报错时使用的产物名。
 * @returns 目标尺寸的位图。
 */
function resizeExact (image, size, label) {
  const resized = image.getSize().width === size
    ? image
    : image.resize({ width: size, height: size, quality: 'best' })
  const actual = resized.getSize()
  if (actual.width !== size || actual.height !== size) {
    throw new Error(`${label} 尺寸不对：期望 ${size}x${size}，实际 ${actual.width}x${actual.height}`)
  }
  return resized
}

/**
 * 从整页截图里按 CSS 坐标裁出一个区域，并换算 Retina 物理像素。
 * @param page - `capturePage()` 的整页结果。
 * @param rect - 目标区域，单位为 CSS 像素。
 * @returns 裁剪结果。
 */
function cropRegion (page, rect) {
  const scale = page.getSize().width / PAGE_WIDTH
  return page.crop({
    x: Math.round(rect.x * scale),
    y: Math.round(rect.y * scale),
    width: Math.round(rect.width * scale),
    height: Math.round(rect.height * scale),
  })
}

/**
 * 把若干张 PNG 打包成一个 `.ico` 容器。
 *
 * 用的是 ICO 的「PNG 直嵌」形态（Vista 起支持）：每档直接放 PNG 字节，
 * 不再转 BMP/DIB，因此 256 档的 alpha 通道原样保留。
 * @param entries - 每档的尺寸与 PNG 字节。
 * @returns 完整的 .ico 文件内容。
 */
function encodeIco (entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: 1 = icon
  header.writeUInt16LE(entries.length, 4)

  const directory = Buffer.alloc(16 * entries.length)
  let offset = header.length + directory.length
  entries.forEach((entry, index) => {
    const at = index * 16
    // 目录项里宽高各占 1 字节，0 表示 256。
    const dimension = entry.size >= 256 ? 0 : entry.size
    directory.writeUInt8(dimension, at)
    directory.writeUInt8(dimension, at + 1)
    directory.writeUInt8(0, at + 2) // 调色板颜色数（32 位真彩不用）
    directory.writeUInt8(0, at + 3) // reserved
    directory.writeUInt16LE(1, at + 4) // color planes
    directory.writeUInt16LE(32, at + 6) // bits per pixel
    directory.writeUInt32LE(entry.data.length, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += entry.data.length
  })

  return Buffer.concat([header, directory, ...entries.map(entry => entry.data)])
}

app.whenReady().then(async () => {
  try {
    if (!fs.existsSync(SVG_PATH)) throw new Error(`找不到图标源文件：${SVG_PATH}`)
    const trayPaths = TRAY_LAYOUT.map(slot => path.join(ASSETS_DIR, slot.name))
    for (const trayPath of trayPaths) {
      if (!fs.existsSync(trayPath)) throw new Error(`找不到状态栏图标源文件：${trayPath}`)
    }

    const page = await renderIconPage(
      fs.readFileSync(SVG_PATH, 'utf8'),
      trayPaths.map(trayPath => fs.readFileSync(trayPath, 'utf8')),
    )
    console.log(`整页截图：${page.getSize().width}x${page.getSize().height}`)

    const base = cropRegion(page, {
      x: APP_ICON_LAYOUT.x,
      y: APP_ICON_LAYOUT.y,
      width: APP_ICON_LAYOUT.size,
      height: APP_ICON_LAYOUT.size,
    })

    // --- icon.icns（仅 macOS；iconutil 在别的平台不存在）---
    if (process.platform === 'darwin') {
      fs.rmSync(ICONSET_DIR, { recursive: true, force: true })
      fs.mkdirSync(ICONSET_DIR, { recursive: true })
      for (const [name, size] of ICONSET) {
        fs.writeFileSync(path.join(ICONSET_DIR, name), resizeExact(base, size, name).toPNG())
      }
      execFileSync('iconutil', ['-c', 'icns', ICONSET_DIR, '-o', ICNS_PATH])
      fs.rmSync(ICONSET_DIR, { recursive: true, force: true })
      console.log(`已生成 ${ICNS_PATH}（${fs.statSync(ICNS_PATH).size} bytes）`)
    } else {
      console.log(`跳过 icon.icns：iconutil 只在 macOS 可用（当前 ${process.platform}）`)
    }

    // --- icon.png（Windows / Linux / 运行时窗口图标）---
    fs.writeFileSync(PNG_PATH, resizeExact(base, 1024, 'icon.png').toPNG())
    console.log(`已生成 ${PNG_PATH}（${fs.statSync(PNG_PATH).size} bytes）`)

    // --- icon.ico（Windows 打包与窗口图标，所有平台都可生成）---
    const entries = ICO_SIZES.map(size => ({
      size,
      data: resizeExact(base, size, `icon.ico@${size}`).toPNG(),
    }))
    fs.writeFileSync(ICO_PATH, encodeIco(entries))
    console.log(`已生成 ${ICO_PATH}（${fs.statSync(ICO_PATH).size} bytes，含 ${ICO_SIZES.join('/')}）`)

    // --- 状态栏图标（macOS 模板图 + Windows/Linux 彩色后备图）---
    for (const slot of TRAY_LAYOUT) {
      const trayBase = cropRegion(page, { x: slot.x, y: slot.y, width: slot.size, height: slot.size })
      const stem = slot.name === 'tray.svg' ? 'trayTemplate' : 'trayColor'
      const pngPath = path.join(ASSETS_DIR, `${stem}.png`)
      const retinaPath = path.join(ASSETS_DIR, `${stem}@2x.png`)
      fs.writeFileSync(pngPath, resizeExact(trayBase, TRAY_POINT_SIZE, path.basename(pngPath)).toPNG())
      fs.writeFileSync(retinaPath, resizeExact(trayBase, TRAY_RETINA_SIZE, path.basename(retinaPath)).toPNG())
      console.log(`已生成 ${pngPath} / ${retinaPath}`)
    }

    app.exit(0)
  } catch (err) {
    console.error('生成图标失败：', err && err.message ? err.message : err)
    app.exit(1)
  }
})
