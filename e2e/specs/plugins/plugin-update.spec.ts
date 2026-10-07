// Plugin updates from a marketplace (Phase 12, ADR-054; docs/UI.md 8.1, 8.7, 8.13). A local-folder marketplace (a
// temporary folder outside the repository) lists a Claude Code plugin with commands only (`claudeNotesTree`: no trust),
// installed from it through the API at 1.0.0. The spec then bumps the version in the folder (the entry's `version` and
// the plugin's `plugin.json`) and:
// - the marketplace's Refresh (row menu) turns the entry into "Installed · Update to 1.1.0" with Update… and the chip
//   into "· 1 update";
// - the plugin card shows the badge "Update 1.1.0" (`plugin-update-available`, `data-version`);
// - the plugin page shows the banner "Version 1.1.0 is available from {marketplace}." whose Update… opens the review
//   ("Update {name}", "Review what changed before you update it.", the preview at 1.1.0); Install updates it ("Updated
//   {name} to 1.1.0"), the banner goes away and the page shows 1.1.0; the entry reads "Installed" again.
// The plugin and the marketplace are removed through `cleanup` (unique names: the shared server keeps both lists).
import {
  byTestId,
  expect,
  seedTempTree,
  test,
  testIds,
  toastWith,
  uniqueId,
} from '../../helpers/index.ts'
import {
  addFolderMarketplace,
  claudeNotesTree,
  installMarketplaceEntry,
  marketplaceChip,
  marketplaceEntry,
  marketplaceTree,
  openMarketplaces,
  rewriteMarketplaceJson,
  rewriteMarketplacePluginFile,
  useCleanMarketplace,
  useCleanPlugin,
} from './_support/claude.ts'
import { pluginCard } from './_support/ui.ts'

test.describe('Plugin updates @plugins', () => {
  test('a bumped version in the marketplace folder: Refresh, the update badge and banner, Update… reviews and updates @smoke', async ({ page, api, cleanup }) => {
    const marketplace = uniqueId('e2e-upd')
    const plugin = uniqueId('e2e-upd-notes')
    await useCleanMarketplace(api, cleanup, marketplace)
    await useCleanPlugin(api, cleanup, plugin)
    const entry = (version: string) => ({ name: plugin, tree: claudeNotesTree(plugin, version), version, description: 'Two note commands.', category: 'productivity' })
    const folder = await seedTempTree(cleanup, 'plugin-update', marketplaceTree(marketplace, [entry('1.0.0')]))
    const added = await addFolderMarketplace(api, folder.path)
    await installMarketplaceEntry(api, added.id, plugin)

    const view = await openMarketplaces(page, `?m=${added.id}`)
    const row = marketplaceEntry(view, plugin)
    await expect(row).toHaveAttribute('data-state', 'installed')

    // A new version in the folder: nothing changes until the marketplace is refreshed.
    await rewriteMarketplaceJson(folder.path, marketplace, [entry('1.1.0')])
    await rewriteMarketplacePluginFile(folder.path, plugin, '.claude-plugin/plugin.json', claudeNotesTree(plugin, '1.1.0')['.claude-plugin/plugin.json'] as string)
    await view.getByTestId(testIds.marketplaceRowMenu).click()
    await page.getByTestId(testIds.marketplaceRefresh).click()
    await expect(row).toHaveAttribute('data-state', 'update')
    await expect(row.locator('[data-slot="marketplace-entry-status"]')).toHaveText('Installed · Update to 1.1.0')
    await expect(row.getByTestId(testIds.marketplaceEntryUpdate)).toHaveAccessibleName(`Update ${plugin}`)
    await expect(marketplaceChip(view, added.id)).toContainText('· 1 update')
    await expect(marketplaceChip(view, added.id)).toHaveAccessibleName(`${marketplace}, 3 plugins, 1 update`)

    // The card badge.
    await page.goto('/plugins')
    const badge = pluginCard(page, plugin).getByTestId(testIds.pluginUpdateAvailable)
    await expect(badge).toHaveAttribute('data-version', '1.1.0')
    await expect(badge).toHaveText('Update 1.1.0')

    // The banner and the review.
    await page.goto(`/plugins/${plugin}`)
    const banner = page.locator('[data-slot="plugin-update-banner"]')
    await expect(banner).toHaveAttribute('data-version', '1.1.0')
    await expect(banner).toContainText(`Version 1.1.0 is available from ${marketplace}.`)
    await banner.getByTestId(testIds.pluginUpdate).click()
    const dialog = page.getByTestId(testIds.marketplaceInstallDialog)
    await expect(dialog).toHaveAttribute('data-mode', 'update')
    await expect(dialog.getByRole('heading', { name: `Update ${plugin}` })).toBeVisible()
    await expect(dialog).toContainText('Review what changed before you update it.')
    const preview = dialog.getByTestId(testIds.installPreview)
    await expect(preview).toHaveAttribute('data-plugin-id', plugin)
    await expect(preview).toContainText('1.1.0')
    await dialog.getByTestId(testIds.installSubmit).click()
    await expect(toastWith(page, `Updated ${plugin} to 1.1.0`)).toBeVisible()
    await expect(dialog).toBeHidden()
    await expect(banner).toHaveCount(0)
    await expect(page.getByTestId(testIds.pluginDetail).locator('[data-slot="plugin-claude-version"]')).toHaveText('1.1.0')
    expect((await api.client.plugins.get({ params: { id: plugin } })).version).toBe('1.1.0')

    // The marketplace agrees.
    await openMarketplaces(page, `?m=${added.id}`)
    await expect(row).toHaveAttribute('data-state', 'installed')
    await expect(byTestId(view, testIds.marketplaceEntryUpdate)).toHaveCount(0)
    await expect(marketplaceChip(view, added.id)).not.toContainText('update')
  })
})
