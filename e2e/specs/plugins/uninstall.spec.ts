// Uninstall (docs/UI.md 8.7, docs/PLUGINS.md 12 "Uninstall and export"): "Keep settings and stored data" keeps the
// provider key of an uninstalled plugin, so reinstalling the same zip finds it again (the provider is connected at
// once); without it the key is purged and the reinstalled provider is not configured. The zip is the
// `e2e-zip-provider` fixture renamed to its own plugin id; setup and reinstalls go through the API.
import type { MockOpenAIServer } from '../../fixtures/mock-openai-server.ts'
import type { FixtureManifest } from '../../fixtures/plugins.ts'
import { expect, test } from '@playwright/test'
import { startMockOpenAI } from '../../fixtures/mock-openai-server.ts'
import { fixtureZip, withBaseURL, withPluginId } from '../../fixtures/plugins.ts'
import { getPlugin, getProvider, installZip, removePlugin, setProviderCredentials } from './_support/api.ts'
import { testIds } from './_support/testids.ts'
import { openUninstall, pluginCard } from './_support/ui.ts'

const PLUGIN_ID = 'e2e-keep-data'
const PLUGIN_NAME = 'E2E Keep Data'
const API_KEY = 'sk-e2e-keep-5678'

test.describe('Uninstall @plugins', () => {
  let mock: MockOpenAIServer
  let zip: ReturnType<typeof fixtureZip>

  test.beforeAll(async ({ request }) => {
    mock = await startMockOpenAI()
    zip = fixtureZip('e2e-zip-provider', {
      manifest: (manifest: FixtureManifest) => {
        withPluginId(PLUGIN_ID, PLUGIN_NAME)(manifest)
        withBaseURL(mock.baseURL)(manifest)
      },
    })
    await removePlugin(request, PLUGIN_ID)
  })

  test.afterAll(async ({ request }) => {
    await removePlugin(request, PLUGIN_ID)
    await mock?.close()
  })

  test('keeps the provider key only with "Keep settings and stored data" @smoke', async ({ page, request }) => {
    const providerStatus = async () => (await getProvider(request, PLUGIN_ID))?.status ?? null
    await installZip(request, `${PLUGIN_ID}.zip`, zip)
    await setProviderCredentials(request, PLUGIN_ID, { apiKey: API_KEY })
    await expect.poll(providerStatus).toBe('connected')

    // Uninstall with keep data.
    await page.goto(`/plugins/${PLUGIN_ID}`)
    await expect(page.getByTestId(testIds.pluginDetail)).toHaveAttribute('data-state', 'active')
    let confirm = await openUninstall(page)
    await expect(page.getByRole('alertdialog')).toContainText(`Uninstall ${PLUGIN_NAME}?`)
    const keepData = page.getByTestId(testIds.pluginUninstallKeepData)
    await expect(keepData).toHaveAttribute('data-state', 'unchecked')
    await keepData.click()
    await expect(keepData).toHaveAttribute('data-state', 'checked')
    await confirm.click()
    await expect(page).toHaveURL(/\/plugins(?:\?|$)/)
    await expect(pluginCard(page, 'core-providers')).toBeVisible()
    await expect(pluginCard(page, PLUGIN_ID)).toHaveCount(0)
    expect(await getPlugin(request, PLUGIN_ID)).toBeNull()
    expect(await getProvider(request, PLUGIN_ID)).toBeNull()

    // Reinstalling finds the kept key.
    await installZip(request, `${PLUGIN_ID}.zip`, zip)
    await expect.poll(providerStatus).toBe('connected')

    // Uninstall without keep data purges it.
    await page.goto(`/plugins/${PLUGIN_ID}`)
    confirm = await openUninstall(page)
    await expect(page.getByTestId(testIds.pluginUninstallKeepData)).toHaveAttribute('data-state', 'unchecked')
    await confirm.click()
    await expect(page).toHaveURL(/\/plugins(?:\?|$)/)
    await expect(pluginCard(page, PLUGIN_ID)).toHaveCount(0)
    expect(await getPlugin(request, PLUGIN_ID)).toBeNull()

    await installZip(request, `${PLUGIN_ID}.zip`, zip)
    await expect.poll(providerStatus).toBe('not_configured')
  })
})
