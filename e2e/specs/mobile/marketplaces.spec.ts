// Marketplaces on a phone (Phase 12; docs/UI.md 2.19, 8.13, 14.5, 14.6), project `mobile` (Pixel 7 at 390x844, touch),
// with a local-folder marketplace (a temporary folder outside the repository; long unique names, removed through
// `cleanup`):
// - The page never scrolls sideways; the marketplace chips become a `Select` named "Marketplace"
//   (`data-slot="marketplace-select"`, its options 40 px rows with `data-marketplace-id`; All drops `?m=`) next to the
//   40 px row menu; the header's Add marketplace… and Refresh all are icon-only (named by their text) and 40 px tall; the
//   suggestion card's Add and Dismiss are 40 px; an entry's Install… is 40 px on a line of its own.
// - Install… opens the review dialog inside the screen with its footer (Back, Install) on the screen, the Claude preview
//   and the trust warning in its body, nothing scrolling sideways; Back closes it without installing.
// - The two selects and the icon-only header buttons are 40x40 px touch targets (fixed by W12.19 at Gate P12-B).
import type { Locator, Page } from '@playwright/test'
import type { CleanupTask, HarnessApi } from '../../helpers/index.ts'
import {
  boxOf,
  documentWidths,
  expect,
  seedTempTree,
  test,
  testIds,
  touchTargetSize,
  uniqueId,
} from '../../helpers/index.ts'
import {
  addFolderMarketplace,
  claudeKitTree,
  claudeNotesTree,
  marketplaceEntry,
  marketplaceTree,
  openMarketplaces,
  useCleanMarketplace,
} from '../plugins/_support/claude.ts'

const VIEWPORT = { width: 390, height: 844 }

async function expectTouchTarget(target: Locator, name: string): Promise<void> {
  await expect(target, name).toBeVisible()
  await expect.poll(async () => (await touchTargetSize(target)).height, { message: `${name} height` }).toBeGreaterThanOrEqual(40)
  expect((await touchTargetSize(target)).width, `${name} width`).toBeGreaterThanOrEqual(40)
}

async function expectNoSidewaysScroll(page: Page, where: string): Promise<void> {
  await expect.poll(async () => (await documentWidths(page)).scrollWidth, { message: `${where} fits 390 px` }).toBeLessThanOrEqual(VIEWPORT.width)
}

/** The element lies inside the screen (polled: dialogs zoom in). */
async function expectInsideViewport(target: Locator, name: string): Promise<void> {
  await expect.poll(async () => {
    const box = await boxOf(target)
    return box.x >= -0.5 && box.y >= -0.5 && box.x + box.width <= VIEWPORT.width + 0.5 && box.y + box.height <= VIEWPORT.height + 0.5
  }, { message: `${name} fits the screen` }).toBe(true)
}

/** A local-folder marketplace with long names: a plugin that needs trust and one with commands only (removed after). */
async function seedMarketplace(api: HarnessApi, cleanup: (task: CleanupTask) => void) {
  const marketplace = uniqueId('e2e-mobile-marketplace-with-a-long-name')
  const kit = uniqueId('e2e-mobile-kit')
  const notes = uniqueId('e2e-mobile-notes')
  await useCleanMarketplace(api, cleanup, marketplace)
  const folder = await seedTempTree(cleanup, 'mobile-marketplace', marketplaceTree(marketplace, [
    { name: kit, tree: claudeKitTree(kit), version: '1.0.0', description: 'Review commands, a reviewer agent, a notes skill and a format hook that never runs.', category: 'development', tags: ['review', 'testing'] },
    { name: notes, tree: claudeNotesTree(notes), version: '0.3.0', category: 'productivity' },
  ]))
  const added = await addFolderMarketplace(api, folder.path)
  return { marketplace, kit, notes, added }
}

test.describe('mobile marketplaces', () => {
  test('the strip is a select, 40 px targets, no sideways scroll; the install review fits the screen', async ({ page, api, cleanup }) => {
    const { marketplace, kit, added } = await seedMarketplace(api, cleanup)
    const view = await openMarketplaces(page, `?m=${added.id}`)
    await expect(marketplaceEntry(view, kit)).toBeVisible()
    await expectNoSidewaysScroll(page, 'the Marketplaces page')

    // The suggestion card (a new browser context never dismissed it; the offline server never adds the official
    // marketplace): 40 px Add and Dismiss, never clicked here.
    const suggestion = page.getByTestId(testIds.marketplaceSuggestion)
    await expectTouchTarget(suggestion.getByTestId(testIds.marketplaceSuggestionAdd), 'the suggestion\'s Add')
    await expectTouchTarget(suggestion.getByTestId(testIds.marketplaceSuggestionDismiss), 'the suggestion\'s Dismiss')

    // The header buttons are icon-only and 40 px tall (their width: the test below).
    for (const [id, name] of [[testIds.marketplaceAdd, 'Add marketplace…'], [testIds.marketplaceRefreshAll, 'Refresh all']] as const) {
      const button = page.getByTestId(id)
      await expect(button).toHaveAccessibleName(name)
      expect((await touchTargetSize(button)).height, `${name} height`).toBeGreaterThanOrEqual(40)
    }

    // The strip is a select.
    await expect(view.getByRole('group', { name: 'Marketplace' })).toHaveCount(0)
    await expect(view.getByTestId(testIds.marketplaceRow)).toHaveCount(0)
    const select = view.locator('[data-slot="marketplace-select"]')
    await expect(select).toBeVisible()
    await expect(select).toHaveAccessibleName('Marketplace')
    await expect(select).toContainText(marketplace)
    await expectTouchTarget(view.getByTestId(testIds.marketplaceRowMenu), 'the marketplace menu')
    await select.click()
    const option = page.getByRole('option').and(page.locator(`[data-marketplace-id="${added.id}"]`))
    await expect(option).toBeVisible()
    await expect.poll(async () => (await touchTargetSize(option)).height, { message: 'an option row' }).toBeGreaterThanOrEqual(40)
    const all = page.getByRole('option').and(page.locator('[data-marketplace-id=""]'))
    await expect.poll(async () => (await touchTargetSize(all)).height, { message: 'the All option' }).toBeGreaterThanOrEqual(40)
    await all.click()
    await expect(page).not.toHaveURL(/[?&]m=/)
    await select.click()
    await option.click()
    await expect(page).toHaveURL(new RegExp(`[?&]m=${added.id}`))
    await expectNoSidewaysScroll(page, 'the page after a pick')

    // An entry: Install… on a 40 px line of its own.
    const install = marketplaceEntry(view, kit).getByTestId(testIds.marketplaceEntryInstall)
    await expectTouchTarget(install, 'Install…')
    const installBox = await boxOf(install)
    const entryBox = await boxOf(marketplaceEntry(view, kit))
    expect(installBox.y, 'Install… sits below the text of the entry').toBeGreaterThan(entryBox.y + 20)

    // The review dialog fits the screen; its footer stays visible.
    await install.click()
    const dialog = page.getByTestId(testIds.marketplaceInstallDialog)
    await expect(dialog.getByTestId(testIds.installPreview)).toHaveAttribute('data-format', 'claude')
    await expectInsideViewport(dialog, 'the install dialog')
    await expectInsideViewport(dialog.getByTestId(testIds.installSubmit), 'Install')
    await expectInsideViewport(dialog.getByTestId(testIds.installBack), 'Back')
    await expect(dialog.getByTestId(testIds.trustWarning)).toBeVisible()
    await expect(dialog.getByTestId(testIds.installSubmit)).toBeDisabled()
    await expectNoSidewaysScroll(page, 'the install dialog')
    await dialog.getByTestId(testIds.installBack).click()
    await expect(dialog).toBeHidden()
    await expect(marketplaceEntry(view, kit)).toHaveAttribute('data-state', 'available')
  })

  // Product bug (W12.14, P12-B): on a phone the marketplace and category selects are 36 px tall (the shadcn
  // SelectTrigger's `data-[size=default]:h-9` beats their `h-10` / `max-sm:h-10`) and the icon-only header buttons are
  // 34 px wide (`pointer-coarse:h-10` sets only the height); docs/UI.md 8.13 / 14.5 ask for 40 px.
  test('the selects and the icon-only header buttons are 40x40 px touch targets', async ({ page, api, cleanup }) => {
    const { added } = await seedMarketplace(api, cleanup)
    const view = await openMarketplaces(page, `?m=${added.id}`)
    await expectTouchTarget(view.locator('[data-slot="marketplace-select"]'), 'the marketplace select')
    await expectTouchTarget(view.getByTestId(testIds.marketplaceCategory), 'the category select')
    await expectTouchTarget(page.getByTestId(testIds.marketplaceAdd), 'Add marketplace…')
    await expectTouchTarget(page.getByTestId(testIds.marketplaceRefreshAll), 'Refresh all')
  })
})
