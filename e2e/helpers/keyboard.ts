// Keyboard shortcuts (docs/UI.md 12): `Mod` is Meta on Apple platforms and Ctrl elsewhere, decided by the app from
// the browser's platform (`navigator.userAgentData.platform`, then `navigator.platform`, then the user agent), like
// `isApplePlatform()` in the web app. The emulated "Desktop Chrome" device reports Windows even on a Mac host, so
// Playwright's host-based `ControlOrMeta` would press the wrong key: always resolve `Mod` through the page.
import type { Page } from '@playwright/test'

const APPLE_PLATFORM_CHECK = `/mac|iphone|ipad|ipod/i.test(
  (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || ''
)`

/** The key the app treats as `Mod` in this page: `Meta` on Apple platforms, else `Control`. */
export async function modKey(page: Page): Promise<'Meta' | 'Control'> {
  return (await page.evaluate<boolean>(APPLE_PLATFORM_CHECK)) ? 'Meta' : 'Control'
}

/** Presses an app shortcut written with `Mod`, e.g. `pressShortcut(page, 'Mod+K')` or `'Mod+Shift+O'`. */
export async function pressShortcut(page: Page, keys: string): Promise<void> {
  const mod = keys.includes('Mod') ? await modKey(page) : null
  await page.keyboard.press(mod ? keys.replace(/\bMod\b/g, mod) : keys)
}
