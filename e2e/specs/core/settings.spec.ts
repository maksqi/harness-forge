// Settings pages (docs/UI.md 9.3-9.6): General (send key, custom instructions), Appearance (theme and the reading
// attributes on <html>, "Expand thinking by default"), Models (default model, favorite, hide, a custom model) and About
// (Copy diagnostics). Every change is checked where it matters (the composer, the transcript, the stored settings,
// a reload). Each test registers the restore of what it changes before changing it (`cleanup`), so the settings come
// back even when the test fails or times out.
import type { Settings } from '../../../packages/shared/src/index.ts'
import {
  byTestId,
  CHAT_URL_PATTERN,
  chatIdFromUrl,
  composer,
  expect,
  openNewChat,
  pressShortcut,
  selectModel,
  test,
  testIds,
  uniqueId,
  userMessages,
} from '../../helpers/index.ts'

type AppearanceKeys = Pick<Settings, 'readingFont' | 'textSize' | 'density' | 'showThinking'>

function appearanceOf(settings: Settings): AppearanceKeys {
  return { readingFont: settings.readingFont, textSize: settings.textSize, density: settings.density, showThinking: settings.showThinking }
}

/** Every key of a JSON value, at any depth. */
function jsonKeys(value: unknown): string[] {
  if (Array.isArray(value))
    return value.flatMap(jsonKeys)
  if (value !== null && typeof value === 'object')
    return Object.entries(value).flatMap(([key, item]) => [key, ...jsonKeys(item)])
  return []
}

test.describe('settings', () => {
  test('general: the send key decides what Enter does and custom instructions are kept @smoke', async ({ page, api, cleanup }) => {
    const before = await api.getSettings()
    cleanup(api => api.updateSettings({ sendKey: before.sendKey, instructions: before.instructions }))
    const instructions = `Answer in one short paragraph. ${uniqueId('instructions')}`
    if (before.sendKey !== 'enter')
      await api.updateSettings({ sendKey: 'enter' })

    await page.goto('/settings/general')
    await expect(page.getByTestId(testIds.settingsNavGeneral)).toHaveAttribute('data-state', 'active')

    // Send with Mod+Enter.
    const sendKey = page.getByTestId(testIds.settingsSendKey)
    await expect(sendKey.locator('[data-value="enter"]')).toHaveAttribute('data-state', 'on')
    await sendKey.locator('[data-value="mod-enter"]').click()
    await expect(sendKey.locator('[data-value="mod-enter"]')).toHaveAttribute('data-state', 'on')
    await expect.poll(async () => (await api.getSettings()).sendKey).toBe('mod-enter')

    // Custom instructions save when the field is left, and are there after a reload.
    const field = page.getByTestId(testIds.settingsInstructions)
    await field.fill(instructions)
    await field.press('Tab')
    await expect.poll(async () => (await api.getSettings()).instructions).toBe(instructions)
    await page.reload()
    await expect(page.getByTestId(testIds.settingsInstructions)).toHaveValue(instructions)
    await expect(page.getByTestId(testIds.settingsSendKey).locator('[data-value="mod-enter"]')).toHaveAttribute('data-state', 'on')

    // In the composer, Enter now starts a new line and Mod+Enter sends.
    await openNewChat(page)
    await selectModel(page, 'mock:echo')
    const input = page.getByTestId(testIds.composerInput)
    // `fill` leaves the caret at the end on every host (no End: macOS scrolls with it, other hosts move the caret).
    await input.fill('First line')
    await input.press('Enter')
    await input.pressSequentially('Second line')
    await expect(input).toHaveValue('First line\nSecond line')
    await expect(page).not.toHaveURL(CHAT_URL_PATTERN)
    await pressShortcut(page, 'Mod+Enter')
    await expect(page).toHaveURL(CHAT_URL_PATTERN)
    const chatId = chatIdFromUrl(page)
    cleanup(api => api.removeChat(chatId))
    await expect(userMessages(page).last()).toContainText('First line')
    await expect(userMessages(page).last()).toContainText('Second line')

    // Back to Enter in the settings.
    await page.goto('/settings/general')
    await page.getByTestId(testIds.settingsSendKey).locator('[data-value="enter"]').click()
    await expect.poll(async () => (await api.getSettings()).sendKey).toBe('enter')
  })

  test('appearance: theme, reading font, text size, density and thinking apply at once and persist @smoke', async ({ page, api, cleanup }) => {
    const before = await api.getSettings()
    cleanup(api => api.updateSettings(appearanceOf(before)))
    // Always a change, whatever the server holds.
    const next: AppearanceKeys = {
      readingFont: before.readingFont === 'serif' ? 'sans' : 'serif',
      textSize: before.textSize === 'lg' ? 'sm' : 'lg',
      density: before.density === 'compact' ? 'comfortable' : 'compact',
      showThinking: !before.showThinking,
    }
    const { chatId } = await api.sendChat({ modelRef: 'mock:reasoning', text: `Appearance check ${uniqueId('appearance')}` })
    cleanup(api => api.removeChat(chatId))

    await page.goto('/settings/appearance')
    const html = page.locator('html')
    await expect(html).toContainClass('dark')

    await byTestId(page, testIds.appearanceThemeCard, { 'data-value': 'light' }).click()
    await expect(html).toContainClass('light')
    await expect(html).not.toContainClass('dark')
    await expect(byTestId(page, testIds.appearanceThemeCard, { 'data-value': 'light' })).toHaveAttribute('data-state', 'on')

    await page.getByTestId(testIds.appearanceReadingFont).locator(`[data-value="${next.readingFont}"]`).click()
    await expect(html).toHaveAttribute('data-reading-font', next.readingFont)
    await page.getByTestId(testIds.appearanceTextSize).locator(`[data-value="${next.textSize}"]`).click()
    await expect(html).toHaveAttribute('data-text-size', next.textSize)
    await page.getByTestId(testIds.appearanceDensity).locator(`[data-value="${next.density}"]`).click()
    await expect(html).toHaveAttribute('data-density', next.density)
    const showThinking = page.getByTestId(testIds.appearanceShowThinking)
    await expect(showThinking).toHaveAttribute('data-state', before.showThinking ? 'checked' : 'unchecked')
    await showThinking.click()
    await expect(showThinking).toHaveAttribute('data-state', next.showThinking ? 'checked' : 'unchecked')
    await expect.poll(async () => appearanceOf(await api.getSettings())).toEqual(next)

    // A reload applies everything again (the theme from local storage, the rest from the server).
    await page.reload()
    await expect(html).toContainClass('light')
    await expect(html).toHaveAttribute('data-reading-font', next.readingFont)
    await expect(html).toHaveAttribute('data-text-size', next.textSize)
    await expect(html).toHaveAttribute('data-density', next.density)

    // "Expand thinking by default" decides how a reasoning row opens.
    await page.goto(`/chat/${chatId}`)
    const row = page.getByTestId(testIds.messageAssistant).last().getByTestId(testIds.reasoningRow)
    await expect(row).toHaveAttribute('data-expanded', String(next.showThinking))
  })

  test('models: the default model, a favorite, a hidden and a custom model reach the composer @smoke', async ({ page, api, cleanup }) => {
    const before = await api.getSettings()
    cleanup(api => api.updateSettings({ defaultModelRef: before.defaultModelRef }))
    const modelId = uniqueId('e2e-custom')
    const modelRef = `mock:${modelId}`
    cleanup(api => api.client.models.removeCustom({ query: { providerId: 'mock', modelId } }).catch(() => {}))
    const defaultRef = before.defaultModelRef === 'mock:reasoning' ? 'mock:echo' : 'mock:reasoning'
    const defaultName = defaultRef === 'mock:reasoning' ? 'Mock Reasoning' : 'Mock Echo'

    await page.goto('/settings/models')
    await expect(page.getByTestId(testIds.settingsNavModels)).toHaveAttribute('data-state', 'active')

    // Default model: its field is a searchable list of the visible models.
    const defaultPicker = page.getByTestId(testIds.modelsDefaultPicker)
    await defaultPicker.click()
    await page.getByRole('option', { name: defaultName }).click()
    await expect(defaultPicker).toHaveAttribute('data-value', defaultRef)
    await expect.poll(async () => (await api.getSettings()).defaultModelRef).toBe(defaultRef)

    // A custom model of the mock provider, then a favorite.
    const section = byTestId(page, testIds.modelsSection, { 'data-provider-id': 'mock' })
    await section.getByTestId(testIds.customModelAdd).click()
    const dialog = page.getByTestId(testIds.customModelDialog)
    await expect(dialog).toBeVisible()
    await dialog.getByTestId(testIds.customModelId).fill(modelId)
    await dialog.getByTestId(testIds.customModelSave).click()
    await expect(dialog).toBeHidden()
    const row = byTestId(section, testIds.modelRow, { 'data-model-ref': modelRef })
    await expect(row).toContainText('Custom')
    await expect(row).toContainText(modelId)
    const favorite = row.getByTestId(testIds.modelFavorite)
    await favorite.click()
    await expect(favorite).toHaveAttribute('data-state', 'on')

    // A new chat starts with the default model, and the picker lists the custom model among the favorites.
    await openNewChat(page)
    const trigger = composer(page).getByTestId(testIds.modelPickerTrigger)
    await expect(trigger).toHaveAttribute('data-model-ref', defaultRef)
    await trigger.click()
    const picker = page.getByTestId(testIds.modelPicker)
    const favorites = byTestId(picker, testIds.modelPickerGroup, { 'data-value': 'favorites' })
    await expect(byTestId(favorites, testIds.modelPickerItem, { 'data-model-ref': modelRef })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(picker).toBeHidden()

    // Hidden models never appear in the picker.
    await page.goto('/settings/models')
    await row.getByTestId(testIds.modelVisible).click()
    await expect(row).toHaveAttribute('data-hidden', 'true')
    await openNewChat(page)
    await trigger.click()
    await expect(byTestId(picker, testIds.modelPickerItem, { 'data-model-ref': defaultRef }).first()).toBeVisible()
    await expect(byTestId(picker, testIds.modelPickerItem, { 'data-model-ref': modelRef })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(picker).toBeHidden()

    // Custom models can be removed from their row menu.
    await page.goto('/settings/models')
    await row.getByRole('button', { name: `Actions for ${modelId}` }).click()
    await page.getByTestId(testIds.modelRemove).click()
    await expect(row).toHaveCount(0)
    await expect.poll(async () => (await api.client.models.list({ query: { providerId: 'mock' } })).items.map(model => model.ref))
      .not
      .toContain(modelRef)
  })

  test('about: copy diagnostics puts a report without secrets on the clipboard @smoke', async ({ page, context, baseURL, api }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(baseURL!).origin })
    const health = await api.client.health.get()

    await page.goto('/settings/about')
    await expect(page.getByTestId(testIds.settingsNavAbout)).toHaveAttribute('data-state', 'active')
    await expect(page.getByTestId(testIds.pageHeader)).toContainText('About')
    await expect(page.getByRole('main')).toContainText(health.node)

    const copy = page.getByTestId(testIds.aboutCopyDiagnostics)
    await expect(copy).toHaveText('Copy diagnostics')
    await copy.click()
    await expect(copy).toHaveAttribute('data-state', 'copied')
    await expect(copy).toHaveText('Copied')

    const text = await page.evaluate<string>('navigator.clipboard.readText()')
    const report = JSON.parse(text) as { app: Record<string, unknown>, providers: unknown[], plugins: unknown[] }
    expect(report.app).toMatchObject({ version: health.version, node: health.node, pluginApiVersion: health.pluginApiVersion })
    expect(report.providers).toContainEqual(expect.objectContaining({ id: 'mock', enabled: true, status: 'connected' }))
    expect(report.plugins).toContainEqual(expect.objectContaining({ id: 'mock', builtin: true, state: 'active' }))
    // An allow-list report: no credential entries or hints, and no chat content.
    const keys = jsonKeys(report)
    for (const forbidden of ['credentials', 'hint', 'value', 'messages', 'title'])
      expect(keys, `the report has no "${forbidden}" field`).not.toContain(forbidden)
  })
})
