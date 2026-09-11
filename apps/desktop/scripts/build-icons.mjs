import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow } from 'electron'

/**
 * 从 assets/icon.svg 生成 macOS 图标集，并打包成 assets/icon.icns，
 * 同时导出一张 1024×1024 的 assets/icon.png 供 Windows 构建使用。
 *
 * 用法：pnpm --filter @deepseek-ai/dsh-desktop build:icons
 *
 * 三处不能改错的地方：
 * 1. 不用 `sips`/`qlmanage` 渲染 SVG —— 它们会把圆角外的透明背景压成白底，
 *    Dock 里就成了白方块。这里借 Electron 的 Chromium 离屏渲染，保留 alpha。
 * 2. 只渲染一次，其余尺寸用 `nativeImage.resize` 降采样 —— 反复创建离屏窗口
 *    不稳定（实测第二张就 `ERR_FAILED`）。
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

/** 等待时长：离屏渲染要画完一帧 `capturePage` 才拿得到内容。 */
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 用离屏窗口把 SVG 渲染成一张 BASE_SIZE 的位图，保留 alpha。
 * @param svgMarkup - `icon.svg` 的完整内容。
 * @returns 渲染结果。
 */
async function renderBase (svgMarkup) {
  const html = `<!doctype html><meta charset="utf-8"><style>
    html, body { margin: 0; padding: 0; width: ${BASE_SIZE}px; height: ${BASE_SIZE}px;
                 overflow: hidden; background: transparent; }
    svg { display: block; width: ${BASE_SIZE}px; height: ${BASE_SIZE}px; }
  </style>${svgMarkup}`

  const htmlPath = path.join(app.getPath('temp'), `dsh-icon-${Date.now()}.html`)
  fs.writeFileSync(htmlPath, html)

  const win = new BrowserWindow({
    width: BASE_SIZE,
    height: BASE_SIZE,
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

app.whenReady().then(async () => {
  try {
    if (!fs.existsSync(SVG_PATH)) throw new Error(`找不到图标源文件：${SVG_PATH}`)

    const base = await renderBase(fs.readFileSync(SVG_PATH, 'utf8'))
    console.log(`基准图：${base.getSize().width}x${base.getSize().height}`)

    fs.rmSync(ICONSET_DIR, { recursive: true, force: true })
    fs.mkdirSync(ICONSET_DIR, { recursive: true })

    for (const [name, size] of ICONSET) {
      const image = base.getSize().width === size
        ? base
        : base.resize({ width: size, height: size, quality: 'best' })

      const actual = image.getSize()
      if (actual.width !== size || actual.height !== size) {
        throw new Error(`${name} 尺寸不对：期望 ${size}x${size}，实际 ${actual.width}x${actual.height}`)
      }
      fs.writeFileSync(path.join(ICONSET_DIR, name), image.toPNG())
    }

    execFileSync('iconutil', ['-c', 'icns', ICONSET_DIR, '-o', ICNS_PATH])
    fs.writeFileSync(PNG_PATH, base.resize({ width: 1024, height: 1024, quality: 'best' }).toPNG())
    fs.rmSync(ICONSET_DIR, { recursive: true, force: true })

    console.log(`已生成 ${ICNS_PATH}（${fs.statSync(ICNS_PATH).size} bytes）`)
    console.log(`已生成 ${PNG_PATH}（${fs.statSync(PNG_PATH).size} bytes）`)
    app.exit(0)
  } catch (err) {
    console.error('生成图标失败：', err && err.message ? err.message : err)
    app.exit(1)
  }
})
