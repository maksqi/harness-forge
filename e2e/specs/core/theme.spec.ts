// Theme (docs/UI.md 4, ADR-006): dark is the default even when the OS prefers light, it is on <html> before the first
// paint (no light flash), and the sidebar toggle persists Light and System across reloads.
import type { Page } from '@playwright/test'
import {
  expect,
  installThemeProbe,
  readThemeProbe,
  storedColorMode,
  test,
  testIds,
} from '../../helpers/index.ts'

// The OS prefers light: dark must still win on a first visit.
test.use({ colorScheme: 'light' })

function classTokens(value: string | null): string[] {
  return (value ?? '').split(/\s+/).filter(token => token !== '')
}

async function expectFirstFrame(page: Page, mode: 'dark' | 'light'): Promise<void> {
  const other = mode === 'dark' ? 'light' : 'dark'
  const probe = await readThemeProbe(page)
  expect(classTokens(probe.firstFrame), 'class of <html> before the first paint').toContain(mode)
  expect(probe.history.flatMap(classTokens), 'every class <html> ever had').not.toContain(other)
}

test.describe('theme', () => {
  test('dark is the default before the first paint with a light OS and empty storage @smoke', async ({ page }) => {
    const html = page.locator('html')
    await installThemeProbe(page)
    await page.goto('/')

    await expectFirstFrame(page, 'dark')
    await expect(page.getByTestId(testIds.emptyGreeting)).toBeVisible()
    await expect(html).toContainClass('dark')
    await expect(html).not.toContainClass('light')
    await expect(page.getByTestId(testIds.themeDark)).toHaveAttribute('data-state', 'on')
    expect(await storedColorMode(page)).not.toBe('light')
  })

  test('the theme toggle persists light and system across reloads @smoke', async ({ page }) => {
    const html = page.locator('html')
    await installThemeProbe(page)
    await page.goto('/')
    await expect(page.getByTestId(testIds.themeDark)).toHaveAttribute('data-state', 'on')

    await page.getByTestId(testIds.themeLight).click()
    await expect(html).toContainClass('light')
    await expect(html).not.toContainClass('dark')
    await expect(page.getByTestId(testIds.themeLight)).toHaveAttribute('data-state', 'on')
    expect(await storedColorMode(page)).toBe('light')

    await page.reload()
    await expectFirstFrame(page, 'light')
    await expect(page.getByTestId(testIds.themeLight)).toHaveAttribute('data-state', 'on')
    await expect(html).toContainClass('light')

    // System follows the OS: light now, dark as soon as the OS switches.
    await page.getByTestId(testIds.themeSystem).click()
    await expect(page.getByTestId(testIds.themeSystem)).toHaveAttribute('data-state', 'on')
    expect(await storedColorMode(page)).toBe('system')
    await expect(html).toContainClass('light')

    await page.reload()
    await expectFirstFrame(page, 'light')
    await expect(page.getByTestId(testIds.themeSystem)).toHaveAttribute('data-state', 'on')
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect(html).toContainClass('dark')
    await expect(html).not.toContainClass('light')

    // And back to Dark, which stays dark under a light OS.
    await page.emulateMedia({ colorScheme: 'light' })
    await page.getByTestId(testIds.themeDark).click()
    await expect(html).toContainClass('dark')
    await page.reload()
    await expectFirstFrame(page, 'dark')
    await expect(page.getByTestId(testIds.themeDark)).toHaveAttribute('data-state', 'on')
  })
})
