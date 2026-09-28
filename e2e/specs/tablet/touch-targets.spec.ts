// Touch tablets (docs/UI.md 14.5, 14.7; S9, W6.11), project `tablet` (Galaxy Tab S9 landscape: 1024x640, touch, so
// `pointer: coarse` matches and the sidebar is not a sheet): the collapsed icon rail is 3.5rem (56 px) wide instead of
// 3rem, and every button of it is a touch target of at least 40x40 px, in the chat, plugins and settings modes.
import type { Locator, Page } from '@playwright/test'
import {
  boxOf,
  expect,
  test,
  testIds,
  touchTargetSize,
} from '../../helpers/index.ts'

/** The collapsed rail on touch devices (`pointer-coarse:[--sidebar-width-icon:3.5rem]`). */
const RAIL_WIDTH = 56
const MIN_TARGET = 40

interface RailMode {
  path: string
  /** Visible once the page rendered. */
  ready: (page: Page) => Locator
  /** Rail buttons that must be there (by test id), besides every other visible button or link of the rail. */
  buttons: readonly string[]
}

const MODES: readonly RailMode[] = [
  {
    path: '/',
    ready: page => page.getByTestId(testIds.emptyGreeting),
    buttons: [testIds.sidebarTrigger, testIds.modeTabChat, testIds.modeTabPlugins, testIds.newChat, testIds.searchChats, testIds.settingsLink, testIds.themeToggle],
  },
  {
    path: '/plugins',
    ready: page => page.getByTestId(testIds.pluginCard).first(),
    buttons: [testIds.sidebarTrigger, testIds.modeTabChat, testIds.modeTabPlugins, testIds.pluginsNew, testIds.pluginsInstall, testIds.settingsLink, testIds.themeToggle],
  },
  {
    path: '/settings/providers',
    ready: page => page.getByTestId(testIds.pageHeader),
    buttons: [testIds.sidebarTrigger, testIds.backToApp, testIds.settingsNavProviders, testIds.settingsNavModels, testIds.settingsNavMedia, testIds.settingsNavGeneral, testIds.settingsNavAppearance, testIds.settingsNavData, testIds.settingsNavAbout, testIds.themeToggle],
  },
]

/** The rail takes exactly `RAIL_WIDTH` px: the page starts right after it, and the sidebar fills it (inside its border). */
async function expectRailWidth(page: Page, where: string): Promise<void> {
  await expect.poll(async () => Math.round((await boxOf(page.getByRole('main'))).x), { message: `${where}: the page starts after the rail` }).toBe(RAIL_WIDTH)
  const rail = await boxOf(page.getByTestId(testIds.sidebar))
  expect(Math.round(rail.x), `${where}: the rail starts at the left edge`).toBe(0)
  const right = Math.round(rail.x + rail.width)
  expect(right, `${where}: the sidebar fills the rail (inside its 1 px border)`).toBeGreaterThanOrEqual(RAIL_WIDTH - 1)
  expect(right, `${where}: the sidebar fits the rail`).toBeLessThanOrEqual(RAIL_WIDTH)
}

/** Every visible button and link of the rail is at least 40x40 px; the named ones are among them. */
async function expectRailTargets(page: Page, mode: RailMode): Promise<void> {
  const sidebar = page.getByTestId(testIds.sidebar)
  for (const id of mode.buttons)
    await expect(sidebar.getByTestId(id), `${mode.path}: ${id} is in the rail`).toBeVisible()
  const targets = sidebar.getByRole('button').or(sidebar.getByRole('link'))
  let checked = 0
  for (const target of await targets.all()) {
    if (!(await target.isVisible()))
      continue
    const name = `${mode.path}: ${await target.getAttribute('data-testid') ?? await target.getAttribute('aria-label') ?? 'a rail button'}`
    const size = await touchTargetSize(target)
    expect(size.width, `${name} width`).toBeGreaterThanOrEqual(MIN_TARGET)
    expect(size.height, `${name} height`).toBeGreaterThanOrEqual(MIN_TARGET)
    // Inside the rail, not cut off by it.
    const box = await boxOf(target)
    expect(box.x, `${name} left edge`).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width, `${name} right edge`).toBeLessThanOrEqual(RAIL_WIDTH)
    checked += 1
  }
  expect(checked, `${mode.path}: rail buttons checked`).toBeGreaterThanOrEqual(mode.buttons.length)
}

test.describe('tablet touch targets', () => {
  test('the collapsed rail is 56 px wide and every button in it is at least 40x40 px', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId(testIds.emptyGreeting)).toBeVisible()
    expect(await page.evaluate<boolean>('matchMedia("(pointer: coarse)").matches'), 'a coarse pointer').toBe(true)
    const sidebar = page.getByTestId(testIds.sidebar)
    // Wider than the sheet breakpoint: the sidebar is part of the page, not a dialog.
    await expect(sidebar).toHaveAttribute('data-state', 'expanded')
    await expect(page.getByRole('dialog').filter({ has: sidebar })).toHaveCount(0)

    // The expanded sidebar's trigger is a 40 px touch target too (UI.md 14.5).
    const expandedTrigger = await touchTargetSize(sidebar.getByTestId(testIds.sidebarTrigger))
    expect(expandedTrigger.width, 'expanded trigger width').toBeGreaterThanOrEqual(MIN_TARGET)
    expect(expandedTrigger.height, 'expanded trigger height').toBeGreaterThanOrEqual(MIN_TARGET)

    // Collapse it with its own trigger.
    await sidebar.getByTestId(testIds.sidebarTrigger).tap()
    await expect(sidebar).toHaveAttribute('data-state', 'collapsed')
    await expect(sidebar.getByTestId(testIds.sidebarTrigger)).toHaveAccessibleName('Expand sidebar')

    // The rail keeps its size and its targets in every mode (the collapsed state is kept across pages).
    for (const mode of MODES) {
      if (mode.path !== '/')
        await page.goto(mode.path)
      await expect(mode.ready(page), `${mode.path} rendered`).toBeVisible()
      await expect(sidebar).toHaveAttribute('data-state', 'collapsed')
      await expectRailWidth(page, mode.path)
      await expectRailTargets(page, mode)
    }

    // The rail's trigger expands the sidebar again.
    await sidebar.getByTestId(testIds.sidebarTrigger).tap()
    await expect(sidebar).toHaveAttribute('data-state', 'expanded')
    await expect.poll(async () => Math.round((await boxOf(page.getByRole('main'))).x)).toBeGreaterThan(RAIL_WIDTH)
  })
})
