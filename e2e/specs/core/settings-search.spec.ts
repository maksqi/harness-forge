// Settings -> Web search (Phase 14, ADR-062, ADR-063; docs/UI.md 2.20, 9.15; docs/API.md 4.39, 5.40): the two global
// switches ("Use the model's own web search when it has one" = `webSearchNative`, "Turn on web search in new chats" =
// `webSearchDefault`), the search API select (Brave Search, Tavily, Exa: the `core-search` settings), one write-only key
// row per backend (Save, then "Key saved" with Replace and Remove; the key never comes back to the page), Max results,
// and Test search against the fake remote (`HF_TEST_REMOTE_URL`): a result line, and "Tavily rejected the key." for the
// key `invalid-key`. The configuration is global: `useWebSearchConfig` restores it (and removes every key).
import {
  byTestId,
  expect,
  fakeRemoteLog,
  INVALID_KEY,
  test,
  testIds,
  toastWith,
  uniqueId,
  useWebSearchConfig,
} from '../../helpers/index.ts'

test.describe('Settings -> Web search', () => {
  test('the switches, the search API, a write-only key, Test search and a rejected key @smoke', async ({ page, api, cleanup }) => {
    await useWebSearchConfig(api, cleanup, { native: true, defaultMode: 'off', backend: 'brave', maxResults: 5 })
    await page.goto('/settings')
    await page.getByTestId(testIds.settingsNavSearch).click()
    await expect(page).toHaveURL(/\/settings\/search$/)
    const settings = page.getByTestId(testIds.webSearchSettings)
    await expect(settings).toBeVisible()

    // The two switches are global settings.
    const native = page.getByTestId(testIds.settingsSearchNative)
    const defaultOn = page.getByTestId(testIds.settingsSearchDefault)
    await expect(native).toHaveAttribute('data-state', 'checked')
    await expect(defaultOn).toHaveAttribute('data-state', 'unchecked')
    await defaultOn.click()
    await expect(defaultOn).toHaveAttribute('data-state', 'checked')
    await expect.poll(async () => (await api.getSettings()).webSearchDefault).toBe('auto')
    await native.click()
    await expect(native).toHaveAttribute('data-state', 'unchecked')
    await expect.poll(async () => (await api.getSettings()).webSearchNative).toBe(false)

    // The search API: Tavily, whose key row moves first.
    const backend = page.getByTestId(testIds.settingsSearchBackend)
    await expect(backend).toHaveAttribute('data-value', 'brave')
    await expect(page.getByTestId(testIds.settingsSearchTest)).toBeDisabled()
    await backend.click()
    await page.getByRole('option', { name: 'Tavily' }).click()
    await expect(backend).toHaveAttribute('data-value', 'tavily')
    await expect.poll(async () => (await api.client.plugins.getSettings({ params: { id: 'core-search' } })).values.backend).toBe('tavily')
    await expect(page.getByTestId(testIds.settingsSearchKey).first()).toHaveAttribute('data-backend', 'tavily')

    // A key: write-only. Saved, the row reads "Key saved" and the page never holds the value.
    const key = `tvly-${uniqueId('key')}`
    const tavily = byTestId(page, testIds.settingsSearchKey, { 'data-backend': 'tavily' })
    await expect(tavily).toHaveAttribute('data-state', 'missing')
    const input = tavily.getByTestId(testIds.settingsSearchKeyInput)
    await expect(input).toHaveAttribute('type', 'password')
    await input.fill(key)
    await tavily.getByTestId(testIds.settingsSearchKeySave).click()
    await expect(toastWith(page, 'Saved the Tavily key')).toBeVisible()
    await expect(tavily).toHaveAttribute('data-state', 'set')
    await expect(tavily).toContainText('Key saved')
    await expect(tavily.getByTestId(testIds.settingsSearchKeyInput)).toHaveCount(0)
    expect(await page.content(), 'the page never holds the key').not.toContain(key)
    expect(JSON.stringify(await api.client.plugins.getSettings({ params: { id: 'core-search' } })), 'the API never answers the key').not.toContain(key)

    // Test search: one fixed query against the fake Tavily (POST with a JSON body; the key only in a header).
    await page.getByTestId(testIds.settingsSearchTest).click()
    const result = page.getByTestId(testIds.settingsSearchTestResult)
    await expect(result).toHaveAttribute('data-state', 'ok')
    await expect(result).toHaveText(/^\d+ results? from Tavily in [\d,]+ ms$/)
    const posts = (await fakeRemoteLog()).filter(entry => entry.host === 'api.tavily.com')
    expect(posts.length).toBeGreaterThan(0)
    expect(posts.at(-1)).toMatchObject({ method: 'POST', path: '/search', status: 200, body: expect.objectContaining({ query: expect.any(String) }) })
    expect(JSON.stringify(posts), 'the fake remote never saw the key in a body').not.toContain(key)

    // Replace with a key the search API rejects: Test search says so.
    await tavily.getByRole('button', { name: 'Replace the Tavily key' }).click()
    await expect(tavily.getByTestId(testIds.settingsSearchKeyInput)).toBeFocused()
    await tavily.getByTestId(testIds.settingsSearchKeyInput).fill(INVALID_KEY)
    await tavily.getByTestId(testIds.settingsSearchKeySave).click()
    await expect(tavily).toHaveAttribute('data-state', 'set')
    await page.getByTestId(testIds.settingsSearchTest).click()
    await expect(result).toHaveAttribute('data-state', 'error')
    await expect(result).toHaveText('Tavily rejected the key.')

    // Remove: the row asks for a key again.
    await tavily.getByTestId(testIds.settingsSearchKeyRemove).click()
    await expect(toastWith(page, 'Removed the Tavily key')).toBeVisible()
    await expect(tavily).toHaveAttribute('data-state', 'missing')
    await expect(tavily.getByTestId(testIds.settingsSearchKeyInput)).toBeVisible()
    expect((await api.client.plugins.getSettings({ params: { id: 'core-search' } })).secrets.tavilyApiKey?.set).toBe(false)
  })

  test('Max results accepts 1 to 10 and is stored', async ({ page, api, cleanup }) => {
    await useWebSearchConfig(api, cleanup, { maxResults: 5 })
    await page.goto('/settings/search')
    const max = page.getByTestId(testIds.settingsSearchMaxResults)
    await expect(max).toHaveValue('5')
    await max.fill('12')
    await max.press('Enter')
    await expect(max).toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByText('Enter a whole number from 1 to 10.')).toBeVisible()
    await max.fill('8')
    await max.press('Enter')
    await expect(max).not.toHaveAttribute('aria-invalid', 'true')
    await expect.poll(async () => (await api.client.plugins.getSettings({ params: { id: 'core-search' } })).values.maxResults).toBe(8)
  })
})
