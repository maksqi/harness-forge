// Marketplaces (Phase 12, ADR-054; docs/UI.md 2.19, 8.13, 13.13) on a password server of its own (`dedicated: true`:
// the marketplace list is global state, and the install needs the password field of the trust consent). The marketplace
// is a local folder (`marketplaceTree`, written into a temporary folder outside the repository; no network, the server
// runs with `HF_OFFLINE=1`).
// - With no marketplace the page shows the empty state and the official suggestion card; Dismiss hides it for good (a
//   reload keeps it hidden) and sends nothing: a `page.route` counter sees no `POST /api/marketplaces` before the add.
// - Add marketplace… → "Folder on this server" + the folder path → "Added {name}", the new chip is selected (`?m=`)
//   with its source line; the entries are sorted by name: the two plugins (Install…) and the unsupported ones
//   ("Unsupported source (command)" / "(url)" with the reason, no button). Search (`?q=`) and the category select
//   (`?category=`) filter the rows; Clear filters brings them back.
// - Install… of the plugin that runs a hook: the dialog "Install {name}" shows the Claude preview and the trust warning;
//   Install waits for "I trust …" and, with the browser clock 11 minutes past the login, for the password ("Confirm your
//   password"); then "Installed {name}" and the plugin page. Back on the page the entry reads "Installed" with Open.
// - Remove… → "Remove {name}?" ("Removing a marketplace keeps the plugins you installed from it.") → the empty state;
//   the plugin stays installed.
import {
  byTestId,
  expect,
  HarnessApi,
  seedTempTree,
  startPasswordServer,
  storageItem,
  test,
  testIds,
  toastWith,
} from '../../helpers/index.ts'
import {
  claudeKitTree,
  claudeNotesTree,
  countMarketplaceAdds,
  KIT_HOOK_COMMAND,
  marketplaceChip,
  marketplaceEntry,
  marketplaceTree,
  UNSUPPORTED_ENTRIES,
} from './_support/claude.ts'

const MARKETPLACE = 'e2e-market'
const KIT = 'e2e-market-kit'
const NOTES = 'e2e-market-notes'
const SUGGESTION_DISMISSED_KEY = 'hf-marketplace-suggestion-dismissed'

test.describe('Marketplaces @plugins', () => {
  test('the suggestion sends nothing; a folder marketplace: chips, search, category, unsupported rows; install with trust and the password; remove keeps the plugin @smoke', async ({ page, cleanup }) => {
    const server = await startPasswordServer({ dedicated: true, label: 'hf-e2e-marketplaces' })
    cleanup(() => server.stop())
    const folder = await seedTempTree(cleanup, 'marketplace', marketplaceTree(MARKETPLACE, [
      { name: KIT, tree: claudeKitTree(KIT), version: '1.0.0', description: 'Review commands and a format hook.', category: 'development', tags: ['review'] },
      { name: NOTES, tree: claudeNotesTree(NOTES), version: '0.3.0', description: 'Two note commands.', category: 'productivity', tags: ['notes'] },
    ]))
    // Fake timers from the first document on, so the browser clock can pass the 10-minute fresh-auth window.
    await page.clock.install()
    const session = new HarnessApi(page.request, server.baseURL)
    await session.client.auth.login({ body: { password: server.password } })
    const adds = await countMarketplaceAdds(page)

    // No marketplace yet: the empty state and the official suggestion; Dismiss sends nothing and sticks.
    await page.goto(`${server.baseURL}/plugins/marketplaces`)
    const view = page.getByTestId(testIds.marketplacesPage)
    await expect(byTestId(view, testIds.marketplaceEmpty, { 'data-value': 'none' })).toBeVisible()
    const suggestion = page.getByTestId(testIds.marketplaceSuggestion)
    await expect(suggestion).toContainText('Anthropic\'s official plugins')
    await expect(suggestion).toContainText('anthropics/claude-plugins-official')
    await suggestion.getByTestId(testIds.marketplaceSuggestionDismiss).click()
    await expect(suggestion).toBeHidden()
    expect(await storageItem(page, SUGGESTION_DISMISSED_KEY)).toBe('1')
    await page.reload()
    await expect(byTestId(view, testIds.marketplaceEmpty, { 'data-value': 'none' })).toBeVisible()
    await expect(page.getByTestId(testIds.marketplaceSuggestion)).toHaveCount(0)
    expect(adds(), 'requests from the suggestion card').toBe(0)

    // Add a folder marketplace.
    await page.getByTestId(testIds.marketplaceAdd).click()
    const add = page.getByTestId(testIds.marketplaceAddDialog)
    await expect(add).toContainText('Adding a marketplace reads its list of plugins. Nothing is installed or run.')
    await byTestId(add, testIds.marketplaceAddSource).locator('[data-value="folder"]').click()
    await expect(byTestId(add, testIds.marketplaceAddSource)).toHaveAttribute('data-value', 'folder')
    await add.getByTestId(testIds.marketplaceAddInput).fill(folder.path)
    await add.getByTestId(testIds.marketplaceAddSubmit).click()
    await expect(add).toBeHidden()
    await expect(toastWith(page, `Added ${MARKETPLACE}`)).toBeVisible()
    expect(adds()).toBe(1)
    const marketplaceId = (await session.client.marketplaces.list()).items[0]?.id ?? ''
    await expect(page).toHaveURL(new RegExp(`[?&]m=${marketplaceId}`))
    const chip = marketplaceChip(view, marketplaceId)
    await expect(chip).toHaveAttribute('aria-pressed', 'true')
    await expect(chip).toHaveAccessibleName(`${MARKETPLACE}, 4 plugins`)
    await expect(marketplaceChip(view, '')).toContainText('All 4')
    await expect(view.locator('[data-slot="marketplace-source"]')).toContainText(folder.path.slice(-20))

    // The entries, sorted by name: two plugins to install, two unsupported sources.
    const entries = view.getByTestId(testIds.marketplaceEntry)
    await expect(entries).toHaveCount(4)
    expect(await entries.evaluateAll(items => items.map(item => item.getAttribute('data-name')))).toEqual([UNSUPPORTED_ENTRIES.command, UNSUPPORTED_ENTRIES.gitlab, KIT, NOTES])
    const kit = marketplaceEntry(view, KIT)
    await expect(kit).toHaveAttribute('data-state', 'available')
    await expect(kit).toContainText('1.0.0 · development')
    await expect(kit).toContainText('In this marketplace')
    await expect(kit.getByTestId(testIds.marketplaceEntryInstall)).toHaveAccessibleName(`Install ${KIT}`)
    const command = marketplaceEntry(view, UNSUPPORTED_ENTRIES.command)
    await expect(command).toHaveAttribute('data-state', 'unsupported')
    await expect(command.locator('[data-slot="marketplace-entry-status"]')).toHaveText('Unsupported source (command)')
    await expect(command).toContainText('Command sources run a program to fetch the plugin; they are not supported.')
    await expect(command.getByRole('button')).toHaveCount(0)
    await expect(marketplaceEntry(view, UNSUPPORTED_ENTRIES.gitlab).locator('[data-slot="marketplace-entry-status"]')).toHaveText('Unsupported source (url)')

    // Search and category.
    await view.getByTestId(testIds.marketplaceSearch).fill('notes')
    await expect(entries).toHaveCount(1)
    await expect(marketplaceEntry(view, NOTES)).toBeVisible()
    await expect(page).toHaveURL(/[?&]q=notes/)
    await view.getByTestId(testIds.marketplaceSearch).fill('zzz-no-such-plugin')
    await expect(byTestId(view, testIds.marketplaceEmpty, { 'data-value': 'no-match' })).toContainText('Try another search or category.')
    await view.getByRole('button', { name: 'Clear filters' }).click()
    await expect(entries).toHaveCount(4)
    await view.getByTestId(testIds.marketplaceCategory).click()
    await page.getByRole('option', { name: 'development' }).click()
    await expect(view.getByTestId(testIds.marketplaceCategory)).toHaveAttribute('data-value', 'development')
    await expect(page).toHaveURL(/[?&]category=development/)
    await expect(entries).toHaveCount(1)
    await expect(marketplaceEntry(view, KIT)).toBeVisible()

    // Install with the trust consent and the password (the session is no longer fresh).
    await page.clock.fastForward('11:00')
    await kit.getByTestId(testIds.marketplaceEntryInstall).click()
    const dialog = page.getByTestId(testIds.marketplaceInstallDialog)
    await expect(dialog).toHaveAttribute('data-mode', 'install')
    await expect(dialog.getByRole('heading', { name: `Install ${KIT}` })).toBeVisible()
    await expect(dialog).toContainText('Review what this plugin adds before you install it.')
    const preview = dialog.getByTestId(testIds.installPreview)
    await expect(preview).toHaveAttribute('data-format', 'claude')
    await expect(preview.locator('[data-slot="install-user-config"]')).toContainText('API token (secret) (required)')
    await expect(dialog.getByTestId(testIds.trustWarning).locator('[data-slot="trust-run-commands"] code')).toHaveText([KIT_HOOK_COMMAND])
    const install = dialog.getByTestId(testIds.installSubmit)
    await expect(install).toBeDisabled()
    await dialog.getByTestId(testIds.trustCheckbox).click()
    const password = dialog.getByTestId(testIds.trustPassword)
    await expect(password).toBeVisible()
    await expect(install).toBeDisabled()
    await password.fill(server.password)
    // The browser clock goes back to the server's time first: the new fresh window the inline login opens (server time +
    // 10 minutes) must lie ahead of the browser clock, or the client would still ask (a skew artifact of the fake clock).
    await page.clock.setSystemTime(Date.now())
    await install.click()
    await expect(toastWith(page, `Installed ${KIT}`)).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`/plugins/${KIT}$`))
    await expect(page.getByTestId(testIds.pluginDetail)).toHaveAttribute('data-state', 'active')
    expect((await session.client.plugins.get({ params: { id: KIT } })).trust).toMatchObject({ required: true, trusted: true })

    // Back on the page: installed, with Open.
    await page.goto(`${server.baseURL}/plugins/marketplaces?m=${marketplaceId}`)
    await expect(marketplaceEntry(view, KIT)).toHaveAttribute('data-state', 'installed')
    await expect(marketplaceEntry(view, KIT).locator('[data-slot="marketplace-entry-status"]')).toHaveText('Installed')
    await expect(marketplaceEntry(view, KIT).locator('[data-action="open-plugin"]')).toHaveAccessibleName(`Open ${KIT}`)

    // Remove the marketplace: the plugin stays.
    await view.getByTestId(testIds.marketplaceRowMenu).click()
    await page.getByTestId(testIds.marketplaceRemove).click()
    const confirm = page.getByTestId(testIds.marketplaceRemoveConfirm)
    const alert = page.getByRole('alertdialog')
    await expect(alert).toContainText(`Remove ${MARKETPLACE}?`)
    await expect(alert).toContainText('Removing a marketplace keeps the plugins you installed from it.')
    await confirm.click()
    await expect(toastWith(page, `Removed ${MARKETPLACE}`)).toBeVisible()
    await expect(byTestId(view, testIds.marketplaceEmpty, { 'data-value': 'none' })).toBeVisible()
    expect((await session.client.marketplaces.list()).items).toEqual([])
    expect((await session.client.plugins.get({ params: { id: KIT } })).state).toBe('active')
  })
})
