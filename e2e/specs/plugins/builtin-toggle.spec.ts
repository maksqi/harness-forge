// Disabling contributions (docs/UI.md 8.1, 9.1; docs/PLUGINS.md 11 "Disable"): turning off the builtin `mock`
// provider in Settings -> Providers removes its models from the composer's model picker, and turning off the `mock`
// builtin plugin on its card also removes its tool from `GET /api/tools`; turning them on brings both back. The picker
// is checked after in-app navigation, so the live store updates (SSE `provider.changed` / `catalog.changed`) are
// exercised, not a fresh page load. Everything is switched back on in `afterEach`, whatever happened.
import { expect, test } from '@playwright/test'
import { getProvider, setPluginEnabled, setProviderEnabled, toolNames } from './_support/api.ts'
import { testIds } from './_support/testids.ts'
import { browseFilterCount, byTestId, closeModelPicker, openModelPicker, pickerItems, pluginCard, startNewChat } from './_support/ui.ts'

const MOCK_MODELS = ['mock:echo', 'mock:reasoning', 'mock:tool-approval', 'mock:error']

test.describe('Builtin provider and plugin toggles @plugins', () => {
  test.afterEach(async ({ request }) => {
    await setPluginEnabled(request, 'mock', true)
    await setProviderEnabled(request, 'mock', true)
  })

  test('disabling a builtin provider hides its models in the picker @smoke', async ({ page, request }) => {
    await startNewChat(page)
    let picker = await openModelPicker(page)
    for (const ref of MOCK_MODELS)
      await expect(byTestId(picker, testIds.modelPickerItem, { 'data-model-ref': ref }).first()).toBeVisible()
    await closeModelPicker(page)

    await page.getByTestId(testIds.settingsLink).click()
    await expect(page).toHaveURL(/\/settings\/providers/)
    const row = byTestId(page, testIds.providerRow, { 'data-provider-id': 'mock' })
    await expect(row).toHaveAttribute('data-enabled', 'true')
    await row.getByTestId(testIds.providerEnabled).click()
    await expect(row).toHaveAttribute('data-enabled', 'false')
    await expect.poll(async () => (await getProvider(request, 'mock'))?.enabled).toBe(false)

    await page.getByTestId(testIds.backToApp).click()
    await expect(page.getByTestId(testIds.composer)).toBeVisible()
    picker = await openModelPicker(page)
    await expect(pickerItems(picker, 'mock:')).toHaveCount(0)
    await closeModelPicker(page)

    await page.getByTestId(testIds.settingsLink).click()
    await row.getByTestId(testIds.providerEnabled).click()
    await expect(row).toHaveAttribute('data-enabled', 'true')
    await page.getByTestId(testIds.backToApp).click()
    picker = await openModelPicker(page)
    for (const ref of MOCK_MODELS)
      await expect(byTestId(picker, testIds.modelPickerItem, { 'data-model-ref': ref }).first()).toBeVisible()
  })

  test('disabling a builtin plugin removes its provider and its tools @smoke', async ({ page, request }) => {
    expect(await toolNames(request)).toContain('mock_approval_tool')
    await page.goto('/plugins')
    const card = pluginCard(page, 'mock')
    const disabledCount = Number(await browseFilterCount(page, 'disabled').textContent())

    await card.getByTestId(testIds.pluginCardSwitch).click()
    await expect(card).toHaveAttribute('data-state', 'disabled')
    await expect(card.getByTestId(testIds.pluginCardSwitch)).toHaveAttribute('data-state', 'unchecked')
    await expect(browseFilterCount(page, 'disabled')).toHaveText(String(disabledCount + 1))
    await expect.poll(async () => toolNames(request)).not.toContain('mock_approval_tool')
    expect(await getProvider(request, 'mock')).toBeNull()

    await page.getByTestId(testIds.modeTabChat).click()
    await page.getByTestId(testIds.newChat).click()
    await expect(page.getByTestId(testIds.composer)).toBeVisible()
    const picker = await openModelPicker(page)
    await expect(pickerItems(picker, 'mock:')).toHaveCount(0)
    await closeModelPicker(page)

    await page.getByTestId(testIds.modeTabPlugins).click()
    await expect(page).toHaveURL(/\/plugins/)
    await card.getByTestId(testIds.pluginCardSwitch).click()
    await expect(card).toHaveAttribute('data-state', 'active')
    await expect(browseFilterCount(page, 'disabled')).toHaveText(String(disabledCount))
    await expect.poll(async () => toolNames(request)).toContain('mock_approval_tool')
    expect(await getProvider(request, 'mock')).toMatchObject({ enabled: true, status: 'connected' })
  })
})
