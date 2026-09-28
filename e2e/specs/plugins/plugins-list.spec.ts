// The Plugins tab (docs/UI.md 5.4, 8.1, 8.2, 8.7): the builtin plugins are listed as Core cards, the Browse filters
// count and show exactly the plugins the API reports for them (other specs may have installed more, so the expected
// numbers come from `GET /api/plugins`), search narrows the list, and builtins cannot be uninstalled.
import type { PluginSummary } from './_support/api.ts'
import type { PluginFilter } from './_support/ui.ts'
import { expect, test } from '@playwright/test'
import { listPlugins } from './_support/api.ts'
import { testIds } from './_support/testids.ts'
import { browseFilter, browseFilterCount, BUILTIN_PLUGIN_IDS, PLUGIN_FILTERS, pluginCard } from './_support/ui.ts'

/** The filter rule of the web store (`pluginMatchesFilter`, docs/UI.md 8.2). */
function inFilter(plugin: PluginSummary, filter: PluginFilter): boolean {
  switch (filter) {
    case 'providers':
      return plugin.contributions.providers.length > 0
    case 'tools':
      return plugin.contributions.tools.length > 0
    case 'mcp':
      return plugin.contributions.mcpServers.length > 0
    case 'commands':
      return plugin.contributions.commands.length > 0
    case 'disabled':
      return !plugin.enabled
    case 'all':
      return true
  }
}

function matchesSearch(plugin: PluginSummary, needle: string): boolean {
  return [plugin.name, plugin.id, plugin.description ?? ''].some(text => text.toLowerCase().includes(needle))
}

test.describe('Plugins tab @plugins', () => {
  // The OS prefers light; the app stays dark by default (ADR-006).
  test.use({ colorScheme: 'light' })

  test('lists the builtin plugins with filters and counts @smoke', async ({ page, request }) => {
    const plugins = await listPlugins(request)
    for (const id of BUILTIN_PLUGIN_IDS)
      expect(plugins.find(plugin => plugin.id === id), `builtin ${id}`).toMatchObject({ builtin: true, removable: false, state: 'active' })

    await page.goto('/plugins')
    await expect(page.locator('html')).toHaveClass(/\bdark\b/)
    await expect(page.getByTestId(testIds.modeTabPlugins)).toHaveAttribute('data-state', 'active')
    await expect(page.getByTestId(testIds.pluginCard)).toHaveCount(plugins.length)
    for (const id of BUILTIN_PLUGIN_IDS) {
      const card = pluginCard(page, id)
      await expect(card).toHaveAttribute('data-state', 'active')
      await expect(card).toContainText('Core')
      await expect(card.getByTestId(testIds.pluginCardSwitch)).toHaveAttribute('data-state', 'checked')
    }
    const coreProviders = plugins.find(plugin => plugin.id === 'core-providers')?.contributions.providers.length
    await expect(pluginCard(page, 'core-providers')).toContainText(`${coreProviders} providers`)
    await expect(pluginCard(page, 'core-tools')).toContainText('2 tools')

    for (const filter of PLUGIN_FILTERS) {
      const expected = plugins.filter(plugin => inFilter(plugin, filter)).length
      await expect(browseFilterCount(page, filter), `count of ${filter}`).toHaveText(String(expected))
    }

    for (const filter of PLUGIN_FILTERS) {
      const expected = plugins.filter(plugin => inFilter(plugin, filter))
      await browseFilter(page, filter).click()
      await expect(browseFilter(page, filter)).toHaveAttribute('data-active', 'true')
      if (filter !== 'all')
        await expect(page).toHaveURL(new RegExp(`[?&]filter=${filter}(?:&|$)`))
      await expect(page.getByTestId(testIds.pluginCard), `cards of ${filter}`).toHaveCount(expected.length)
      for (const plugin of expected)
        await expect(pluginCard(page, plugin.id)).toBeVisible()
      if (expected.length === 0)
        await expect(page.getByText('No plugins match')).toBeVisible()
    }
  })

  test('searches by name, id and description', async ({ page, request }) => {
    const plugins = await listPlugins(request)
    await page.goto('/plugins')
    const search = page.getByTestId(testIds.pageHeader).getByTestId(testIds.pluginsSearch)

    await search.fill('mock')
    await expect(page).toHaveURL(/[?&]q=mock(?:&|$)/)
    const expected = plugins.filter(plugin => matchesSearch(plugin, 'mock'))
    await expect(page.getByTestId(testIds.pluginCard)).toHaveCount(expected.length)
    await expect(pluginCard(page, 'mock')).toBeVisible()
    await expect(pluginCard(page, 'core-tools')).toHaveCount(0)

    await search.fill('no-such-plugin-anywhere')
    await expect(page.getByText('No plugins match')).toBeVisible()
    await page.getByRole('button', { name: 'Clear filters' }).first().click()
    await expect(search).toHaveValue('')
    await expect(page.getByTestId(testIds.pluginCard)).toHaveCount(plugins.length)
  })

  test('opens a builtin plugin without an Uninstall action', async ({ page }) => {
    await page.goto('/plugins')
    await pluginCard(page, 'core-tools').getByText('Core tools').click()
    await expect(page).toHaveURL(/\/plugins\/core-tools/)
    const detail = page.getByTestId(testIds.pluginDetail)
    await expect(detail).toHaveAttribute('data-plugin-id', 'core-tools')
    await expect(page.getByTestId(testIds.pluginState)).toHaveText('Active')
    await expect(page.getByTestId(testIds.pluginTabSource)).toHaveCount(0)
    const tools = page.getByTestId(testIds.pluginToolRow)
    await expect(tools).toHaveCount(2)
    await expect(tools.and(page.locator('[data-tool-name="current_time"]'))).toBeVisible()
    await expect(tools.and(page.locator('[data-tool-name="web_fetch"]'))).toBeVisible()

    const menu = page.getByTestId(testIds.pluginMenu)
    if (await menu.count() > 0)
      await menu.click()
    await expect(page.getByTestId(testIds.pluginUninstall)).toHaveCount(0)
  })
})
