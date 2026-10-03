// The changes panel and rewind on a phone (docs/UI.md 2.15, 7.21, 7.22, 14.5, 14.6), project `mobile` (Pixel 7 at
// 390x844, touch): below 1024 px the panel is a right sheet, full width below `sm`, with its own 40 px Close; the
// toggle, the rows and Revert are 40 px targets (Revert always shows on a coarse pointer); an open diff with a long
// line scrolls inside its own block, so the page never scrolls sideways; Esc closes the sheet and returns focus to the
// toggle; the revert confirmation and the rewind dialog fit the screen with 40 px buttons.
import type { Locator, Page } from '@playwright/test'
import type { CleanupTask, HarnessApi } from '../../helpers/index.ts'
import {
  boxOf,
  byTestId,
  changesFile,
  changesFileButton,
  changesFileDiff,
  changesPanel,
  changesToggle,
  documentWidths,
  expect,
  MOCK_CHECKPOINT_DONE,
  MOCK_CHECKPOINT_FILE,
  openRewind,
  seedProject,
  test,
  testIds,
  touchTargetSize,
  uniqueId,
  userMessages,
  wordList,
} from '../../helpers/index.ts'

const VIEWPORT = { width: 390, height: 844 }
const MODEL = 'mock:checkpoint'

async function expectTouchTarget(target: Locator, name: string): Promise<void> {
  await expect(target, name).toBeVisible()
  // Sizes are polled: sheets slide and dialogs zoom in.
  await expect.poll(async () => (await touchTargetSize(target)).height, { message: `${name} height` }).toBeGreaterThanOrEqual(40)
  expect((await touchTargetSize(target)).width, `${name} width`).toBeGreaterThanOrEqual(40)
}

async function expectNoSidewaysScroll(page: Page, where: string): Promise<void> {
  await expect.poll(async () => (await documentWidths(page)).scrollWidth, { message: `${where} fits 390 px` }).toBeLessThanOrEqual(VIEWPORT.width)
}

/** The box of a dialog once its zoom-in animation ended, checked to lie inside the viewport. */
async function expectInsideViewport(target: Locator, name: string): Promise<void> {
  await expect.poll(async () => {
    const box = await boxOf(target)
    return box.x >= 0 && box.y >= 0 && box.x + box.width <= VIEWPORT.width && box.y + box.height <= VIEWPORT.height
  }, { message: `${name} fits the screen` }).toBe(true)
}

/** A project chat whose `mock:checkpoint` run replaced a long line of `checkpoint.txt` (a wide diff). */
async function seedChangesChat(api: HarnessApi, cleanup: (task: CleanupTask) => void): Promise<string> {
  const longLine = `const wide = ${JSON.stringify(wordList(60, 'segment').join('_'))}`
  const { project } = await seedProject(api, cleanup, { name: `Phone changes ${uniqueId('phone')}`, files: { [MOCK_CHECKPOINT_FILE]: `${longLine}\n` } })
  const chat = await api.createChat({ title: `Phone changes ${uniqueId('chat')}`, projectId: project.id, modelRef: MODEL })
  cleanup(api => api.removeChat(chat.id))
  const { text } = await api.sendChat({ chatId: chat.id, modelRef: MODEL, toolMode: 'auto', text: 'Write the checkpoint.' })
  expect(text).toBe(MOCK_CHECKPOINT_DONE)
  return chat.id
}

async function openChat(page: Page, chatId: string): Promise<void> {
  await page.goto(`/chat/${chatId}`)
  await expect(page.getByTestId(testIds.messageAssistant).last()).toContainText(MOCK_CHECKPOINT_DONE)
}

test.describe('mobile changes', () => {
  test('the panel is a full-width right sheet; a wide diff scrolls inside it; Esc returns focus to the toggle', async ({ page, api, cleanup }) => {
    const chatId = await seedChangesChat(api, cleanup)
    await openChat(page, chatId)

    const toggle = changesToggle(page)
    await expect(toggle).toHaveAttribute('data-count', '1')
    await expectTouchTarget(toggle, 'the changes toggle')
    await toggle.tap()

    // A sheet on the right edge, as wide as the screen, labelled "Changes".
    const sheet = page.getByRole('dialog').filter({ has: changesPanel(page) })
    await expect(sheet).toBeVisible()
    await expect(sheet).toHaveAccessibleName('Changes')
    const panel = changesPanel(page)
    await expect(panel).toHaveAttribute('data-variant', 'sheet')
    await expect(panel).toHaveAttribute('data-state', 'ready')
    await expect.poll(async () => Math.round((await boxOf(sheet)).x), { message: 'the sheet slid in' }).toBe(0)
    expect(Math.round((await boxOf(sheet)).width), 'the sheet is full width').toBe(VIEWPORT.width)
    await expectTouchTarget(panel.getByTestId(testIds.changesClose), 'Close changes')
    await expectTouchTarget(panel.getByTestId(testIds.changesRefresh), 'Refresh changes')

    // The row and its Revert are 40 px targets (Revert shows without hover on touch).
    const row = changesFile(page, MOCK_CHECKPOINT_FILE)
    const button = changesFileButton(row)
    expect((await touchTargetSize(button)).height, 'the row height').toBeGreaterThanOrEqual(40)
    await expectTouchTarget(byTestId(row, testIds.changesFileRevert, { 'data-path': MOCK_CHECKPOINT_FILE }), 'Revert file')
    expect(await byTestId(row, testIds.changesFileRevert, { 'data-path': MOCK_CHECKPOINT_FILE }).evaluate(element => element.ownerDocument.defaultView!.getComputedStyle(element).opacity), 'Revert shows on touch').toBe('1')

    // The diff of the long line scrolls inside its block.
    await button.tap()
    await expect(changesFileDiff(row)).toHaveAttribute('data-state', 'ready')
    const diff = row.getByTestId(testIds.diffView)
    await expect(byTestId(diff, testIds.diffLine, { 'data-kind': 'del' })).toContainText('segment1_segment2_segment3')
    const box = await boxOf(diff)
    expect(box.x, 'the diff starts on screen').toBeGreaterThanOrEqual(0)
    expect(box.x + box.width, 'the diff block fits the screen').toBeLessThanOrEqual(VIEWPORT.width)
    const scroller = await diff.evaluate((root) => {
      const block = [...root.querySelectorAll('*')].find(node => root.ownerDocument.defaultView!.getComputedStyle(node).overflowX === 'auto')
      return block ? { scrollWidth: block.scrollWidth, clientWidth: block.clientWidth } : null
    })
    expect(scroller, 'the diff has its own horizontal scroller').not.toBeNull()
    expect(scroller!.scrollWidth, 'the long line overflows the block, not the page').toBeGreaterThan(scroller!.clientWidth)
    await expectNoSidewaysScroll(page, 'the sheet with an open diff')

    // The revert confirmation fits the screen; Cancel keeps the file.
    await byTestId(row, testIds.changesFileRevert, { 'data-path': MOCK_CHECKPOINT_FILE }).tap()
    const confirm = page.getByRole('alertdialog')
    await expect(confirm).toContainText(`Revert ${MOCK_CHECKPOINT_FILE}?`)
    await expectInsideViewport(confirm, 'the revert confirmation')
    await expectTouchTarget(page.getByTestId(testIds.changesRevertConfirm), 'Revert file')
    await confirm.getByRole('button', { name: 'Cancel' }).tap()
    await expect(confirm).toBeHidden()
    await expect(sheet).toBeVisible()

    // Esc closes the sheet and focus returns to the toggle.
    await page.keyboard.press('Escape')
    await expect(sheet).toBeHidden()
    await expect(toggle).toHaveAttribute('data-state', 'closed')
    await expect(toggle).toBeFocused()
    await expectNoSidewaysScroll(page, 'the chat after the sheet')
  })

  test('the rewind action is a 40 px target and its dialog fits the screen', async ({ page, api, cleanup }) => {
    const chatId = await seedChangesChat(api, cleanup)
    await openChat(page, chatId)

    const message = userMessages(page).first()
    const rewind = message.getByTestId(testIds.messageRewind)
    // Touch shows the action row without hover.
    await expectTouchTarget(rewind, 'Rewind files to here')
    const dialog = await openRewind(page, message)
    await expect(dialog).toHaveAttribute('data-state', 'ready')
    const content = page.getByRole('dialog').filter({ has: dialog })
    await expectInsideViewport(content, 'the rewind dialog')
    await expect(byTestId(dialog, testIds.rewindFile, { 'data-path': MOCK_CHECKPOINT_FILE })).toBeVisible()
    await expect(dialog.getByTestId(testIds.rewindShellCommand)).toHaveCount(2)
    for (const id of [testIds.rewindRestore, testIds.rewindRestoreEdit]) {
      const target = dialog.getByTestId(id)
      await expect.poll(async () => (await touchTargetSize(target)).height, { message: `${id} height` }).toBeGreaterThanOrEqual(40)
      const box = await boxOf(target)
      expect(box.x + box.width, `${id} fits the screen`).toBeLessThanOrEqual(VIEWPORT.width)
    }
    await expectNoSidewaysScroll(page, 'the rewind dialog')
    await dialog.getByRole('button', { name: 'Cancel' }).tap()
    await expect(dialog).toBeHidden()
  })
})
