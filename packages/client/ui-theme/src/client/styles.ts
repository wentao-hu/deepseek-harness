import type { Context } from '@deepseek-ai/cordis'
import base from '../styles/base.css?inline'
import cornerShape from '../styles/corner-shape.css?inline'
import designPlatform from '../styles/design-platform.css?inline'
import focus from '../styles/focus.css?inline'
import onboarding from '../styles/onboarding.css?inline'
import scrollbar from '../styles/scrollbar.css?inline'
import gradientShadowText from '../styles/gradient-shadow-text.css?inline'
import shiki from '../styles/shiki.css?inline'
import claudeDesktop from '../styles/claude-desktop.css?inline'
import type { ThemeSkin } from '../theme-settings.ts'

const PLUGIN_ID = '@deepseek-ai/dsh-client-ui-theme'
const HAIRLINE_WIDTH = '--dsh-hairline-width'

/** Sheets mounted for every skin, in cascade order (later sheets win at equal specificity). */
const BASE_STYLES = [
  ['base.css', base],
  ['corner-shape.css', cornerShape],
  ['design-platform.css', designPlatform],
  ['focus.css', focus],
  ['onboarding.css', onboarding],
  ['scrollbar.css', scrollbar],
  ['gradient-shadow-text.css', gradientShadowText],
  ['shiki.css', shiki],
] as const

/** Sheets mounted only while their skin is selected (fork addition). */
const SKIN_STYLES: Partial<Record<ThemeSkin, string>> = {
  claude: claudeDesktop,
}

/**
 * Mount the global theme sheets for exactly the owning plugin lifetime. Base
 * sheets mount unconditionally; the fork's skin sheet mounts and unmounts with
 * the persisted skin so the Appearance row can switch back to the stock look.
 * Window-backed documents also publish the DPR-aware stroke width.
 * @param ctx - Owning plugin context.
 * @param readSkin - Reads the currently persisted conversation skin.
 */
export function installThemeStyles(ctx: Context, readSkin: () => ThemeSkin): void {
  if (typeof document === 'undefined') return
  const view = document.defaultView
  if (view !== null) ctx.effect(() => {
    const root = document.documentElement
    const previousWidth = root.style.getPropertyValue(HAIRLINE_WIDTH)
    const previousPriority = root.style.getPropertyPriority(HAIRLINE_WIDTH)
    const matchMedia = typeof view.matchMedia === 'function' ? view.matchMedia.bind(view) : undefined
    let resolution: MediaQueryList | undefined
    const updateStroke = (): void => {
      // Positive borders round down to whole device pixels, with a one-pixel minimum.
      const dpr = view.devicePixelRatio
      const width = Math.max(1, Math.floor(0.5 * dpr)) / dpr
      root.style.setProperty(HAIRLINE_WIDTH, `${width}px`)
      resolution?.removeEventListener('change', updateStroke)
      resolution = matchMedia?.(`(resolution: ${dpr}dppx)`)
      resolution?.addEventListener('change', updateStroke)
    }
    updateStroke()
    return () => {
      resolution?.removeEventListener('change', updateStroke)
      if (previousWidth === '') root.style.removeProperty(HAIRLINE_WIDTH)
      else root.style.setProperty(HAIRLINE_WIDTH, previousWidth, previousPriority)
    }
  }, 'ui-theme: DPR-aware hairline width')
  for (const [name, css] of BASE_STYLES) {
    ctx.effect(() => {
      const tag = document.createElement('style')
      tag.dataset.plugin = PLUGIN_ID
      tag.dataset.pluginCss = `${PLUGIN_ID}/${name}`
      tag.textContent = css
      document.head.appendChild(tag)
      return () => { tag.remove() }
    }, `ui-theme: ${name} stylesheet`)
  }
  ctx.effect(() => {
    let tag: HTMLStyleElement | undefined
    const apply = (): void => {
      const css = SKIN_STYLES[readSkin()]
      if (css !== undefined && tag === undefined) {
        tag = document.createElement('style')
        tag.dataset.plugin = PLUGIN_ID
        tag.dataset.pluginCss = `${PLUGIN_ID}/claude-desktop.css`
        tag.textContent = css
        document.head.appendChild(tag)
      } else if (css === undefined && tag !== undefined) {
        tag.remove()
        tag = undefined
      }
    }
    const off = ctx.on('theme/change', apply)
    apply()
    return () => {
      off()
      tag?.remove()
    }
  }, 'ui-theme: skin stylesheet')
}
