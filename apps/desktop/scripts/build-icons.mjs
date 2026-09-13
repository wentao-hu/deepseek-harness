import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow } from 'electron'

/**
 * 从 assets/icon.svg 生成 macOS 图标集，并打包成 assets/icon.icns，
 * 同时导出一张 1024×1024 的 assets/icon.png 供 Windows 构建使用。
 * 同一页面里还渲染状态栏图标：trayTemplate.png / trayTemplate@2x.png
 * （macOS 模板图）和 trayColor.png / trayColor@2x.png（Windows / Linux 彩色后备图）。
 *
 * 用法：pnpm --filter @deepseek-ai/dsh-desktop build:icons
 *
 * 三处不能改错的地方：
 * 1. 不用 `sips`/`qlmanage` 渲染 SVG —— 它们会把圆角外的透明背景压成白底，
 *    Dock 里就成了白方块。这里借 Electron 的 Chromium 离屏渲染，保留 alpha。
 * 2. **只创建一次离屏窗口**：不管渲染几个源文件都排进同一张页面，再用一次
 *    `capturePage()` 截取；实测同一进程里创建第二个离屏窗口就会 ERR_FAILED。
 * 3. `capturePage()` 返回物理像素，Retina 屏上 1024 CSS px 会渲染成 2048。
 *    降采样必须比较**实际**尺寸：若按常量判断，最大那档会以 2048 写入 iconset，
 *    `iconutil` 发现尺寸对不上会**静默丢弃**它，icns 里从此少掉 1024 档。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ASSETS_DIR = path.join(HERE, '..', 'assets')
const SVG_PATH = path.join(ASSETS_DIR, 'icon.svg')
const ICONSET_DIR = path.join(ASSETS_DIR, 'icon.iconset')
const ICNS_PATH = path.join(ASSETS_DIR, 'icon.icns')
const PNG_PATH = path.join(ASSETS_DIR, 'icon.png')

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

    fs.rmSync(ICONSET_DIR, { recursive: true, force: true })
    fs.mkdirSync(ICONSET_DIR, { recursive: true })

    for (const [name, size] of ICONSET) {
      fs.writeFileSync(path.join(ICONSET_DIR, name), resizeExact(base, size, name).toPNG())
    }

    execFileSync('iconutil', ['-c', 'icns', ICONSET_DIR, '-o', ICNS_PATH])
    fs.writeFileSync(PNG_PATH, resizeExact(base, 1024, 'icon.png').toPNG())
    fs.rmSync(ICONSET_DIR, { recursive: true, force: true })

    console.log(`已生成 ${ICNS_PATH}（${fs.statSync(ICNS_PATH).size} bytes）`)
    console.log(`已生成 ${PNG_PATH}（${fs.statSync(PNG_PATH).size} bytes）`)

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
