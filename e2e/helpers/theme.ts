// Theme helpers (docs/UI.md 4): the color mode lives in `localStorage['hf-color-mode']` and the head script of the
// generated HTML puts `dark` / `light` on <html> before the first paint. `installThemeProbe()` records the class of
// <html> at the first animation frame (which runs before the first paint) and every class it ever had, so a spec can
// prove there was no light flash.
import type { Page } from '@playwright/test'

/** The `@nuxtjs/color-mode` storage key (DECISIONS.md "Global settings keys"). */
export const COLOR_MODE_STORAGE_KEY = 'hf-color-mode'

export type ColorModePreference = 'dark' | 'light' | 'system'

export interface ThemeProbe {
  /** `class` of <html> in the first animation frame of the document (before its first paint). */
  firstFrame: string | null
  /** Every distinct `class` value <html> had, in order (from mutation records, so none is missed). */
  history: string[]
}

// Plain JavaScript, injected with `addInitScript` (it runs before any script of every new document).
const PROBE_SCRIPT = `(() => {
  const probe = { firstFrame: null, history: [] }
  const push = (value) => {
    const text = value || ''
    if (probe.history[probe.history.length - 1] !== text)
      probe.history.push(text)
  }
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes' && record.target === document.documentElement)
        push(record.oldValue)
    }
    if (document.documentElement)
      push(document.documentElement.className)
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true })
  requestAnimationFrame(() => {
    probe.firstFrame = document.documentElement ? document.documentElement.className : null
  })
  Object.defineProperty(window, '__hfThemeProbe', { value: probe })
})()`

/** Records the <html> class of every document this page loads from now on (read it with `readThemeProbe`). */
export async function installThemeProbe(page: Page): Promise<void> {
  await page.addInitScript({ content: PROBE_SCRIPT })
}

/** What the probe recorded for the current document (after the first frame). */
export async function readThemeProbe(page: Page): Promise<ThemeProbe> {
  return page.evaluate<ThemeProbe>(`(async () => {
    const probe = window.__hfThemeProbe
    if (!probe)
      throw new Error('installThemeProbe() was not called before the navigation.')
    while (probe.firstFrame === null)
      await new Promise(resolve => requestAnimationFrame(resolve))
    return { firstFrame: probe.firstFrame, history: [...probe.history] }
  })()`)
}

/** The stored color-mode preference of the page's origin (`null` when nothing is stored). */
export async function storedColorMode(page: Page): Promise<string | null> {
  const origin = new URL(page.url()).origin
  const state = await page.context().storageState()
  const entry = state.origins.find(item => item.origin === origin)
  return entry?.localStorage.find(item => item.name === COLOR_MODE_STORAGE_KEY)?.value ?? null
}
