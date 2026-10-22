// Web search in the chat (Phase 14, ADR-062, ADR-063; docs/UI.md 2.20, 7.35, 12; docs/API.md 4.39; docs/PROVIDERS.md 8):
// the composer's Search toggle (`composer-web-search`) turns the chat's web search on.
// - Native: `mock:search` searches with its own provider-executed `web_search`: the row "Searched the web" with the
//   query (no approval card), the sources row with its domain chips, and `Search done: 2 sources`; the choice is stored
//   on the chat.
// - Builtin: with a Brave Search key saved in Settings -> Web search, `mock:search-tool` calls `search_web` against the
//   fake remote (`HF_TEST_REMOTE_URL`): the row "Searched the web" with "5 results", its body lists the results, the
//   sources follow, and the reply names the result titles.
// - Unavailable: no search API key for a model without its own search ("Set up web search" leads to Settings -> Web
//   search), tools off ("Tools are off in this chat.", "Turn off web search"); a turn sent anyway answers `Search off`
//   with the notice `web-search-unavailable`.
// - Alt+W toggles it from the composer (announced); on an unavailable toggle it opens the popover.
// The search configuration is global: `useWebSearchConfig` restores it (and removes every key) after each test.
import type { Page } from '@playwright/test'
import {
  byTestId,
  CHAT_URL_PATTERN,
  chatIdFromUrl,
  composerAnnouncement,
  expect,
  expectMessageStatus,
  fakeRemoteLog,
  fakeResultTitles,
  lastAssistantMessage,
  MOCK_SEARCH_DONE,
  MOCK_SEARCH_MODEL,
  MOCK_SEARCH_OFF,
  MOCK_SEARCH_SOURCES,
  MOCK_SEARCH_TOOL_MODEL,
  mockSearchToolText,
  noticeLine,
  openNewChat,
  selectModel,
  selectPermissionMode,
  sendMessage,
  test,
  testIds,
  uniqueId,
  useWebSearchConfig,
  webSearchToggle,
  webSearchUnavailable,
} from '../../helpers/index.ts'

/** The search row of the last reply (`web_search` native, `search_web` builtin). */
function searchRow(page: Page, toolName: 'web_search' | 'search_web') {
  return byTestId(lastAssistantMessage(page), testIds.toolRow, { 'data-tool-name': toolName })
}

test.describe('web search in the chat', () => {
  test('the Search toggle with a model\'s own search: the provider-executed row and the sources chips @smoke', async ({ page, api, cleanup }) => {
    await useWebSearchConfig(api, cleanup)
    await openNewChat(page)
    await selectModel(page, MOCK_SEARCH_MODEL)
    const toggle = webSearchToggle(page)
    await expect(toggle).toHaveAttribute('data-state', 'off')
    await expect(toggle).toHaveAttribute('data-mode', 'native')
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await expect(toggle).toHaveAccessibleName('Web search')
    await toggle.click()
    await expect(toggle).toHaveAttribute('data-state', 'on')
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')

    const query = `release notes ${uniqueId('q')}`
    await sendMessage(page, query)
    await expect(page).toHaveURL(CHAT_URL_PATTERN)
    const chatId = chatIdFromUrl(page)
    cleanup(api => api.removeChat(chatId))
    const reply = lastAssistantMessage(page)
    await expectMessageStatus(reply, 'done')
    await expect(reply).toContainText(MOCK_SEARCH_DONE)
    const row = searchRow(page, 'web_search')
    await expect(row.locator('[data-slot="web-search-row-label"]')).toHaveText('Searched the web')
    await expect(row.locator('[data-slot="web-search-row-query"]')).toHaveText(`"${query}"`)
    await expect(row.getByRole('button').first()).toHaveAccessibleName(`Searched the web, ${query}`)
    await expect(reply.getByTestId(testIds.toolApproval)).toHaveCount(0)
    await expect(reply).not.toContainText('Needs approval')

    const sources = reply.getByTestId(testIds.sourcesRow)
    await expect(sources).toContainText('2 sources')
    for (const source of MOCK_SEARCH_SOURCES)
      await expect(byTestId(sources, testIds.sourcesChip, { 'data-domain': source.domain })).toBeVisible()
    await sources.click()
    for (const source of MOCK_SEARCH_SOURCES)
      await expect(byTestId(reply, testIds.sourceItem, { 'data-domain': source.domain })).toContainText(source.title)

    // The choice belongs to the chat: stored, and still on after a reload.
    expect((await api.getChat(chatId)).settings.webSearch).toBe('auto')
    await page.reload()
    await expect(webSearchToggle(page)).toHaveAttribute('data-state', 'on')
  })

  test('with a Brave Search key, mock:search-tool searches through search_web: results, sources and the titles', async ({ page, api, cleanup }) => {
    await useWebSearchConfig(api, cleanup)
    // The key is saved through Settings -> Web search (write-only).
    await page.goto('/settings/search')
    const brave = byTestId(page, testIds.settingsSearchKey, { 'data-backend': 'brave' })
    await expect(brave).toHaveAttribute('data-state', 'missing')
    await brave.getByTestId(testIds.settingsSearchKeyInput).fill(`brave-${uniqueId('key')}`)
    await brave.getByTestId(testIds.settingsSearchKeySave).click()
    await expect(brave).toHaveAttribute('data-state', 'set')

    await openNewChat(page)
    await selectModel(page, MOCK_SEARCH_TOOL_MODEL)
    const toggle = webSearchToggle(page)
    await expect(toggle).toHaveAttribute('data-mode', 'builtin')
    await toggle.click()
    await expect(toggle).toHaveAttribute('data-state', 'on')
    const query = `open source ${uniqueId('q')}`
    await sendMessage(page, query)
    await expect(page).toHaveURL(CHAT_URL_PATTERN)
    const chatId = chatIdFromUrl(page)
    cleanup(api => api.removeChat(chatId))
    const reply = lastAssistantMessage(page)
    await expectMessageStatus(reply, 'done')
    await expect(reply).toContainText(mockSearchToolText(5))

    const row = searchRow(page, 'search_web')
    await expect(row).toHaveAttribute('data-state', 'output-available')
    await expect(row.locator('[data-slot="web-search-row-label"]')).toHaveText('Searched the web')
    await expect(row.locator('[data-slot="web-search-row-count"]')).toHaveText('5 results')
    await row.getByRole('button').first().click()
    const body = byTestId(reply, testIds.webSearchTool, { 'data-mode': 'builtin' })
    await expect(body).toHaveAttribute('data-state', 'done')
    await expect(body.locator('[data-slot="web-search-query"]')).toContainText(query)
    const results = body.getByTestId(testIds.webSearchResult)
    await expect(results).toHaveCount(5)
    for (const [index, title] of fakeResultTitles(5).entries())
      await expect(results.nth(index)).toContainText(title)
    await expect(results.first()).toHaveAttribute('data-domain', 'example.com')
    await expect(byTestId(reply.getByTestId(testIds.sourcesRow), testIds.sourcesChip, { 'data-domain': 'example.org' })).toBeVisible()

    // The search went to the fake Brave Search with the query (never the key in the log).
    const searches = (await fakeRemoteLog()).filter(entry => entry.host === 'api.search.brave.com' && entry.path.includes(encodeURIComponent(query).replace(/%20/g, '+')))
    expect(searches).toHaveLength(1)
    expect(searches[0]).toMatchObject({ method: 'GET', status: 200 })
  })

  test('unavailable: no search API key, tools off; a turn sent anyway answers without search', async ({ page, api, cleanup }) => {
    await useWebSearchConfig(api, cleanup)
    // No key and no search of its own: the popover leads to Settings -> Web search.
    await openNewChat(page)
    await selectModel(page, MOCK_SEARCH_TOOL_MODEL)
    const toggle = webSearchToggle(page)
    await expect(toggle).toHaveAttribute('data-state', 'unavailable')
    await expect(toggle).toHaveAttribute('aria-disabled', 'true')
    // `aria-disabled` keeps it focusable and clickable (Playwright counts it as disabled: `force`).
    await toggle.click({ force: true })
    const popover = webSearchUnavailable(page)
    await expect(popover).toHaveAttribute('data-reason', 'no-backend')
    await expect(popover).toContainText('This model has no web search of its own. Add a search key in Settings → Web search.')
    await expect(popover.locator('[data-slot="web-search-turn-off"]')).toHaveCount(0)
    await popover.getByTestId(testIds.webSearchSetup).click()
    await expect(page).toHaveURL(/\/settings\/search$/)
    await expect(page.getByTestId(testIds.webSearchSettings)).toBeVisible()

    // Tools off: search on first, then the mode Off; the popover offers to turn it off.
    await openNewChat(page)
    await selectModel(page, MOCK_SEARCH_MODEL)
    await webSearchToggle(page).click()
    await expect(webSearchToggle(page)).toHaveAttribute('data-state', 'on')
    await selectPermissionMode(page, 'off')
    // The permission menu is gone (a modal menu blocks pointer events while it closes).
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(page.locator('body')).not.toHaveCSS('pointer-events', 'none')
    await expect(webSearchToggle(page)).toHaveAttribute('data-state', 'unavailable')
    await expect(webSearchToggle(page)).toHaveAttribute('aria-pressed', 'true')
    await webSearchToggle(page).click({ force: true })
    await expect(popover).toHaveAttribute('data-reason', 'tool-mode-off')
    await expect(popover).toContainText('Tools are off in this chat.')
    await expect(popover.locator('[data-slot="web-search-turn-off"]')).toHaveText('Turn off web search')
    await page.keyboard.press('Escape')
    await expect(popover).toHaveCount(0)

    // Sent anyway: no search, and the notice says why (once).
    await sendMessage(page, 'what changed this week?')
    await expect(page).toHaveURL(CHAT_URL_PATTERN)
    const chatId = chatIdFromUrl(page)
    cleanup(api => api.removeChat(chatId))
    const reply = lastAssistantMessage(page)
    await expectMessageStatus(reply, 'done')
    await expect(reply).toContainText(MOCK_SEARCH_OFF)
    await expect(noticeLine(page, 'web-search-unavailable')).toHaveCount(1)

    // "Turn off web search" in the popover.
    await webSearchToggle(page).click({ force: true })
    await popover.locator('[data-slot="web-search-turn-off"]').click()
    await expect(webSearchToggle(page)).toHaveAttribute('aria-pressed', 'false')
    await expect.poll(async () => (await api.getChat(chatId)).settings.webSearch).toBe('off')
  })

  test('Alt+W toggles web search from the composer and opens the popover when it is unavailable', async ({ page, api, cleanup }) => {
    await useWebSearchConfig(api, cleanup)
    await openNewChat(page)
    await selectModel(page, MOCK_SEARCH_MODEL)
    const input = page.getByTestId(testIds.composerInput)
    await input.focus()
    await page.keyboard.press('Alt+KeyW')
    await expect(webSearchToggle(page)).toHaveAttribute('aria-pressed', 'true')
    await expect(composerAnnouncement(page, 'Web search on')).toHaveCount(1)
    await expect(input).toBeFocused()
    await page.keyboard.press('Alt+KeyW')
    await expect(webSearchToggle(page)).toHaveAttribute('aria-pressed', 'false')
    await expect(composerAnnouncement(page, 'Web search off')).toHaveCount(1)

    // Unavailable: Alt+W opens the popover; Escape gives the focus back to the message.
    await selectModel(page, MOCK_SEARCH_TOOL_MODEL)
    await input.focus()
    await page.keyboard.press('Alt+KeyW')
    await expect(webSearchUnavailable(page)).toHaveAttribute('data-reason', 'no-backend')
    await page.keyboard.press('Escape')
    await expect(webSearchUnavailable(page)).toHaveCount(0)
    await expect(input).toBeFocused()
  })
})
