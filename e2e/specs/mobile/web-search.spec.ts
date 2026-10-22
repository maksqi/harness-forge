// Web search on a phone (Phase 14, ADR-062, ADR-063; docs/UI.md 2.20, 7.35, 14.5), project `mobile` (Pixel 7 at 390x844,
// touch): the composer's Search toggle is icon-only (a 40 px target; a dot marks it on) and fits the toolbar; a native
// search turn of `mock:search` shows its row and the sources chips without sideways scrolling; the unavailable popover
// (no search API key for `mock:search-tool`) fits the screen and its "Set up web search" is a touch target.
import type { Locator, Page } from '@playwright/test'
import {
  boxOf,
  byTestId,
  documentWidths,
  expect,
  expectMessageStatus,
  lastAssistantMessage,
  MOCK_SEARCH_DONE,
  MOCK_SEARCH_MODEL,
  MOCK_SEARCH_SOURCES,
  MOCK_SEARCH_TOOL_MODEL,
  test,
  testIds,
  touchTargetSize,
  uniqueId,
  useWebSearchConfig,
  webSearchToggle,
  webSearchUnavailable,
} from '../../helpers/index.ts'

const VIEWPORT = { width: 390, height: 844 }

async function expectTouchTarget(target: Locator, name: string): Promise<void> {
  await expect(target, name).toBeVisible()
  await expect.poll(async () => (await touchTargetSize(target)).height, { message: `${name} height` }).toBeGreaterThanOrEqual(40)
  expect((await touchTargetSize(target)).width, `${name} width`).toBeGreaterThanOrEqual(40)
}

async function expectNoSidewaysScroll(page: Page, where: string): Promise<void> {
  await expect.poll(async () => (await documentWidths(page)).scrollWidth, { message: `${where} fits 390 px` }).toBeLessThanOrEqual(VIEWPORT.width)
}

async function expectInsideViewport(target: Locator, name: string): Promise<void> {
  await expect.poll(async () => {
    const box = await boxOf(target)
    return box.x >= 0 && box.y >= 0 && box.x + box.width <= VIEWPORT.width && box.y + box.height <= VIEWPORT.height
  }, { message: `${name} fits the screen` }).toBe(true)
}

test.describe('mobile web search', () => {
  test('the toggle is an icon-only touch target with a dot when on; a native search turn fits 390 px', async ({ page, api, cleanup }) => {
    await useWebSearchConfig(api, cleanup)
    const chat = await api.createChat({ title: `Mobile search ${uniqueId('ws')}`, modelRef: MOCK_SEARCH_MODEL })
    cleanup(api => api.removeChat(chat.id))
    await page.goto(`/chat/${chat.id}`)

    const toggle = webSearchToggle(page)
    await expect(toggle).toHaveAttribute('data-state', 'off')
    await expectTouchTarget(toggle, 'the Search toggle')
    await expect(toggle.getByText('Search', { exact: true })).toBeHidden()
    await expect(toggle.locator('[data-slot="web-search-dot"]')).toHaveCount(0)
    await toggle.tap()
    await expect(toggle).toHaveAttribute('data-state', 'on')
    await expect(toggle.locator('[data-slot="web-search-dot"]')).toBeVisible()
    await expectInsideViewport(toggle, 'the Search toggle')
    await expectNoSidewaysScroll(page, 'the composer with the toggle on')

    await page.getByTestId(testIds.composerInput).fill('phone search')
    await page.getByTestId(testIds.composerSend).tap()
    const reply = lastAssistantMessage(page)
    await expectMessageStatus(reply, 'done')
    await expect(reply).toContainText(MOCK_SEARCH_DONE)
    await expect(byTestId(reply, testIds.toolRow, { 'data-tool-name': 'web_search' }).locator('[data-slot="web-search-row-label"]')).toHaveText('Searched the web')
    const sources = reply.getByTestId(testIds.sourcesRow)
    await expectTouchTarget(sources, 'the sources row')
    for (const source of MOCK_SEARCH_SOURCES)
      await expect(byTestId(sources, testIds.sourcesChip, { 'data-domain': source.domain })).toBeVisible()
    await expectInsideViewport(sources, 'the sources row')
    await expectNoSidewaysScroll(page, 'a search reply')
  })

  test('the unavailable popover fits the screen and "Set up web search" is a touch target', async ({ page, api, cleanup }) => {
    await useWebSearchConfig(api, cleanup)
    const chat = await api.createChat({ title: `Mobile search ${uniqueId('ws')}`, modelRef: MOCK_SEARCH_TOOL_MODEL })
    cleanup(api => api.removeChat(chat.id))
    await page.goto(`/chat/${chat.id}`)

    const toggle = webSearchToggle(page)
    await expect(toggle).toHaveAttribute('data-state', 'unavailable')
    await expectTouchTarget(toggle, 'the unavailable Search toggle')
    await expectNoSidewaysScroll(page, 'the composer with an unavailable toggle')
    // `aria-disabled` keeps it focusable and tappable (Playwright counts it as disabled: `force`).
    await toggle.tap({ force: true })
    const popover = webSearchUnavailable(page)
    await expect(popover).toHaveAttribute('data-reason', 'no-backend')
    await expectInsideViewport(popover, 'the popover')
    const setup = popover.getByTestId(testIds.webSearchSetup)
    await expectTouchTarget(setup, 'Set up web search')
    await setup.tap()
    await expect(page).toHaveURL(/\/settings\/search$/)
    await expect(page.getByTestId(testIds.webSearchSettings)).toBeVisible()
    await expectNoSidewaysScroll(page, 'Settings -> Web search')
  })
})
