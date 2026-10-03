// The changes panel of a project chat (docs/UI.md 2.15, 7.21, 12, 14.1; docs/API.md `changes`; ADR-036, ADR-037) with
// `mock:checkpoint`, which writes `checkpoint.txt` ("Turn <n>"), runs `mkdir -p mock-dir && cd mock-dir` and then `ls`
// in `mock-dir`, and answers "Checkpoint done." (docs/PROVIDERS.md 8). The runs go through the API in `auto`, so the
// page opens on a finished chat.
// - The toggle counts the files the chat changed; This chat lists the file (+1 −1, the untracked shell note), expands
//   to its diff, reverts it on disk after the confirmation, and the toast's Undo brings the agent's version back.
// - Git: a repository (seedGitProject) shows "On main · 1 file changed", reverts to the last commit and is then clean;
//   a project folder that is not a repository reads "This project isn't a Git repository.".
// - The open state and the pane width (arrow keys on the handle) survive a reload; Alt+C and the palette item open the
//   panel and focus its active view tab, Close returns focus to the toggle.
import type { Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  boxOf,
  byTestId,
  CHANGES_STORAGE_KEYS,
  changesFile,
  changesFileButton,
  changesFileDiff,
  changesPane,
  changesPanel,
  changesToggle,
  changesUntrackedNote,
  changesViewTab,
  expect,
  gitAvailable,
  MOCK_CHECKPOINT_DONE,
  MOCK_CHECKPOINT_FILE,
  mockCheckpointContent,
  pressShortcut,
  seedGitProject,
  seedProject,
  storageItem,
  test,
  testIds,
  toastWith,
  uniqueId,
} from '../../helpers/index.ts'

const MODEL = 'mock:checkpoint'
/** U+2212, the minus sign of the summaries (docs/UI.md 7.19). */
const MINUS = '−'
const ORIGINAL = 'Original line.\n'

/** Opens a chat page and waits for its header toggle (the chat has a project). */
async function openChat(page: Page, chatId: string): Promise<void> {
  await page.goto(`/chat/${chatId}`)
  await expect(page.getByTestId(testIds.messageAssistant).last()).toContainText(MOCK_CHECKPOINT_DONE)
  await expect(changesToggle(page)).toBeVisible()
}

/** Drags the pane's resize handle sideways by `dx` px (negative: wider pane) with the mouse. */
async function dragHandle(page: Page, dx: number): Promise<void> {
  const handle = page.getByTestId(testIds.changesResize)
  await expect(handle).toHaveAccessibleName('Resize changes')
  const box = await boxOf(handle)
  const x = box.x + box.width / 2
  const y = box.y + Math.min(200, box.height / 2)
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx, y, { steps: 8 })
  await page.mouse.up()
}

async function fileText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  }
  catch {
    return null
  }
}

test.describe('changes panel', () => {
  test('This chat counts, lists, expands and reverts a file; Undo brings it back @smoke', async ({ page, api, cleanup }) => {
    const { project, folder } = await seedProject(api, cleanup, { name: `Changes ${uniqueId('chat')}`, files: { [MOCK_CHECKPOINT_FILE]: ORIGINAL } })
    const chat = await api.createChat({ title: `Changes ${uniqueId('chat')}`, projectId: project.id, modelRef: MODEL })
    cleanup(api => api.removeChat(chat.id))
    const { text } = await api.sendChat({ chatId: chat.id, modelRef: MODEL, toolMode: 'auto', text: 'Write the checkpoint.' })
    expect(text).toBe(MOCK_CHECKPOINT_DONE)
    const file = join(folder.path, MOCK_CHECKPOINT_FILE)
    expect(await fileText(file)).toBe(mockCheckpointContent(1))

    await openChat(page, chat.id)
    const toggle = changesToggle(page)
    await expect(toggle).toHaveAttribute('data-count', '1')
    await expect(toggle).toHaveAttribute('data-state', 'closed')
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await expect(toggle).toHaveAccessibleName('Show changes, 1 file changed')
    await expect(changesPanel(page)).toHaveCount(0)

    // A click opens the pane; focus stays on the toggle.
    await toggle.click()
    await expect(toggle).toHaveAttribute('data-state', 'open')
    await expect(toggle).toHaveAccessibleName('Hide changes')
    await expect(toggle).toBeFocused()
    const panel = changesPanel(page)
    await expect(changesPane(page)).toBeVisible()
    await expect(changesPane(page)).toHaveAccessibleName('Changes')
    await expect(panel).toHaveAttribute('data-view', 'chat')
    await expect(panel).toHaveAttribute('data-state', 'ready')
    await expect(changesViewTab(page, 'chat')).toHaveAttribute('data-state', 'active')
    const summary = panel.getByTestId(testIds.changesSummary)
    await expect(summary).toHaveText(`1 file changed · +1 ${MINUS}1`)
    await expect(summary).toHaveAttribute('data-count', '1')
    await expect(changesUntrackedNote(page)).toHaveText('2 shell commands in this chat may have changed files too. They aren\'t listed here.')

    // The row: modified, with a spoken name (status, path, line counts), collapsed.
    const row = changesFile(page, MOCK_CHECKPOINT_FILE)
    await expect(row).toHaveAttribute('data-status', 'modified')
    await expect(row).toHaveAttribute('data-state', 'closed')
    await expect(row).not.toHaveAttribute('data-conflict', /.*/)
    const button = changesFileButton(row)
    await expect(button).toHaveAccessibleName(/^Modified .*checkpoint\.txt.*, 1 line added, 1 removed$/)

    // Expanded: the diff of the agent's edit against the version before the chat.
    await button.click()
    await expect(row).toHaveAttribute('data-state', 'open')
    await expect(button).toHaveAttribute('aria-expanded', 'true')
    await expect(changesFileDiff(row)).toHaveAttribute('data-state', 'ready')
    const diff = row.getByTestId(testIds.diffView)
    await expect(diff).toHaveAttribute('data-path', MOCK_CHECKPOINT_FILE)
    await expect(byTestId(diff, testIds.diffLine, { 'data-kind': 'del' })).toHaveText(/Original line\./)
    await expect(byTestId(diff, testIds.diffLine, { 'data-kind': 'add' })).toHaveText(/Turn 1/)

    // Revert asks first, then the file is back on disk and the row leaves the list.
    await row.hover()
    const revert = byTestId(row, testIds.changesFileRevert, { 'data-path': MOCK_CHECKPOINT_FILE })
    await expect(revert).toHaveAccessibleName(`Revert ${MOCK_CHECKPOINT_FILE}`)
    await revert.click()
    const confirmDialog = page.getByRole('alertdialog')
    await expect(confirmDialog).toContainText(`Revert ${MOCK_CHECKPOINT_FILE}?`)
    await expect(confirmDialog).toContainText(`${MOCK_CHECKPOINT_FILE} goes back to how it was before this chat changed it.`)
    await expect(confirmDialog).toContainText('The current version is saved first, so you can undo this.')
    await page.getByTestId(testIds.changesRevertConfirm).click()
    await expect(confirmDialog).toBeHidden()
    const reverted = toastWith(page, `Reverted ${MOCK_CHECKPOINT_FILE}`)
    await expect(reverted).toBeVisible()
    await expect.poll(() => fileText(file), { message: 'the file is back to its version before the chat' }).toBe(ORIGINAL)
    const empty = panel.getByTestId(testIds.changesEmpty)
    await expect(empty).toHaveAttribute('data-reason', 'none')
    await expect(empty).toHaveText('No file changes in this chat yet.')
    await expect(toggle).toHaveAttribute('data-count', '0')

    // Undo restores the agent's version.
    await reverted.getByTestId(testIds.toastUndo).click()
    await expect(toastWith(page, `Restored ${MOCK_CHECKPOINT_FILE}`)).toBeVisible()
    await expect.poll(() => fileText(file), { message: 'Undo brings the agent\'s version back' }).toBe(mockCheckpointContent(1))
    await expect(changesFile(page, MOCK_CHECKPOINT_FILE)).toHaveAttribute('data-status', 'modified')
    await expect(toggle).toHaveAttribute('data-count', '1')
  })

  test('the Git view shows a repository, reverts to the last commit and tells a folder outside git apart @smoke', async ({ page, api, cleanup }) => {
    test.skip(!(await gitAvailable()), 'git is not installed')
    const { project, folder } = await seedGitProject(api, cleanup, {
      name: `Git ${uniqueId('git')}`,
      files: { [MOCK_CHECKPOINT_FILE]: ORIGINAL, 'README.md': '# Demo\n' },
    })
    const chat = await api.createChat({ title: `Git changes ${uniqueId('chat')}`, projectId: project.id, modelRef: MODEL })
    cleanup(api => api.removeChat(chat.id))
    expect((await api.sendChat({ chatId: chat.id, modelRef: MODEL, toolMode: 'auto', text: 'Write the checkpoint.' })).text).toBe(MOCK_CHECKPOINT_DONE)

    await openChat(page, chat.id)
    await changesToggle(page).click()
    const panel = changesPanel(page)
    await expect(panel).toHaveAttribute('data-state', 'ready')
    await changesViewTab(page, 'git').click()
    await expect(panel).toHaveAttribute('data-view', 'git')
    await expect(changesViewTab(page, 'git')).toHaveAttribute('data-state', 'active')
    expect(await storageItem(page, CHANGES_STORAGE_KEYS.view)).toBe('git')

    // The work tree against HEAD: the agent's edit (the empty mock-dir is not listed by git).
    const summary = panel.getByTestId(testIds.changesSummary)
    await expect(summary).toHaveText('On main · 1 file changed')
    await expect(panel.getByTestId(testIds.changesFile)).toHaveCount(1)
    const row = changesFile(page, MOCK_CHECKPOINT_FILE)
    await expect(row).toHaveAttribute('data-status', 'modified')
    await changesFileButton(row).click()
    await expect(changesFileDiff(row)).toHaveAttribute('data-state', 'ready')
    await expect(byTestId(row.getByTestId(testIds.diffView), testIds.diffLine, { 'data-kind': 'add' })).toHaveText(/Turn 1/)

    // Revert to the last commit: the tree is clean afterwards.
    await row.hover()
    await byTestId(row, testIds.changesFileRevert, { 'data-path': MOCK_CHECKPOINT_FILE }).click()
    await expect(page.getByRole('alertdialog')).toContainText(`${MOCK_CHECKPOINT_FILE} goes back to the last commit.`)
    await page.getByTestId(testIds.changesRevertConfirm).click()
    await expect(toastWith(page, `Reverted ${MOCK_CHECKPOINT_FILE}`)).toBeVisible()
    await expect.poll(() => fileText(join(folder.path, MOCK_CHECKPOINT_FILE))).toBe(ORIGINAL)
    const empty = panel.getByTestId(testIds.changesEmpty)
    await expect(empty).toHaveAttribute('data-reason', 'clean')
    await expect(empty).toHaveText('No changes since the last commit.')
    await expect(summary).toHaveText('On main')

    // Another project whose folder is not a repository: the open panel keeps the Git view.
    const plain = await seedProject(api, cleanup, { name: `Plain ${uniqueId('plain')}` })
    const other = await api.createChat({ title: `Plain changes ${uniqueId('chat')}`, projectId: plain.project.id, modelRef: MODEL })
    cleanup(api => api.removeChat(other.id))
    expect((await api.sendChat({ chatId: other.id, modelRef: MODEL, toolMode: 'auto', text: 'Write the checkpoint.' })).text).toBe(MOCK_CHECKPOINT_DONE)
    await openChat(page, other.id)
    await expect(panel).toHaveAttribute('data-view', 'git')
    const notRepo = panel.getByTestId(testIds.changesEmpty)
    await expect(notRepo).toHaveAttribute('data-reason', 'not-a-repo')
    await expect(notRepo).toHaveText('This project isn\'t a Git repository.')
    await expect(panel).toHaveAttribute('data-state', 'unavailable')
    // This chat still works without git.
    await changesViewTab(page, 'chat').click()
    await expect(changesFile(page, MOCK_CHECKPOINT_FILE)).toHaveAttribute('data-status', 'added')
  })

  test('Alt+C and the palette open the panel; the open state and the width survive a reload @smoke', async ({ page, api, cleanup }) => {
    const { project } = await seedProject(api, cleanup, { name: `Panel ${uniqueId('panel')}` })
    const chat = await api.createChat({ title: `Panel state ${uniqueId('chat')}`, projectId: project.id, modelRef: MODEL })
    cleanup(api => api.removeChat(chat.id))
    expect((await api.sendChat({ chatId: chat.id, modelRef: MODEL, toolMode: 'auto', text: 'Write the checkpoint.' })).text).toBe(MOCK_CHECKPOINT_DONE)

    await openChat(page, chat.id)
    const toggle = changesToggle(page)
    const chatTab = changesViewTab(page, 'chat')

    // Alt+C opens the panel and focuses the active view tab; Alt+C again closes it and focus goes to the toggle.
    await page.getByTestId(testIds.composerInput).focus()
    await page.keyboard.press('Alt+KeyC')
    await expect(changesPane(page)).toBeVisible()
    await expect(chatTab).toBeFocused()
    await page.keyboard.press('Alt+KeyC')
    await expect(changesPanel(page)).toHaveCount(0)
    await expect(toggle).toHaveAttribute('data-state', 'closed')
    await expect(toggle).toBeFocused()

    // The palette's "Show changes" does the same.
    await pressShortcut(page, 'Mod+K')
    const palette = page.getByTestId(testIds.commandPalette)
    await expect(palette).toBeVisible()
    await page.keyboard.type('changes')
    const item = byTestId(palette, testIds.commandPaletteItem, { 'data-value': 'toggle-changes' })
    await expect(item).toContainText('Show changes')
    await item.click()
    await expect(palette).toBeHidden()
    await expect(changesPane(page)).toBeVisible()
    await expect(chatTab).toBeFocused()
    expect(await storageItem(page, CHANGES_STORAGE_KEYS.open)).toBe('1')

    // Dragging the handle widens the pane; the width in px is stored.
    const before = Math.round((await boxOf(changesPane(page))).width)
    expect(before, 'the default width').toBeGreaterThanOrEqual(430)
    expect(before, 'the default width').toBeLessThanOrEqual(450)
    await dragHandle(page, -80)
    await expect.poll(async () => Math.round((await boxOf(changesPane(page))).width), { message: 'the pane is wider' }).toBeGreaterThan(before + 40)
    await expect.poll(async () => Number(await storageItem(page, CHANGES_STORAGE_KEYS.width)), { message: 'the stored width' })
      .toBeGreaterThan(before + 40)
    const stored = Number(await storageItem(page, CHANGES_STORAGE_KEYS.width))
    expect(Math.abs(Math.round((await boxOf(changesPane(page))).width) - stored), 'the stored width is the pane width').toBeLessThanOrEqual(2)

    // A reload keeps the pane open at that width.
    await page.reload()
    await expect(changesPane(page)).toBeVisible()
    await expect(toggle).toHaveAttribute('data-state', 'open')
    await expect.poll(async () => Math.abs(Math.round((await boxOf(changesPane(page))).width) - stored), { message: 'the width after the reload' })
      .toBeLessThanOrEqual(2)

    // Close returns focus to the toggle; a reload keeps it closed.
    await changesPanel(page).getByTestId(testIds.changesClose).click()
    await expect(changesPanel(page)).toHaveCount(0)
    await expect(toggle).toBeFocused()
    expect(await storageItem(page, CHANGES_STORAGE_KEYS.open)).toBe('0')
    await page.reload()
    await expect(toggle).toHaveAttribute('data-state', 'closed')
    await expect(changesPanel(page)).toHaveCount(0)
  })

  // Regression test (found by W8.12, fixed at the final gate): reka-ui's keyboard behavior of SplitterResizeHandle
  // looks the handle up in the DOM once during setup; the handle is mounted by a v-if after the panel group, so
  // ChatWorkspace mounts it disabled and enables it on the next tick, which re-runs that lookup.
  test('the arrow keys on the resize handle change the pane width @smoke', async ({ page, api, cleanup }) => {
    const { project } = await seedProject(api, cleanup, { name: `Keys ${uniqueId('keys')}` })
    const chat = await api.createChat({ title: `Panel keys ${uniqueId('chat')}`, projectId: project.id, modelRef: MODEL })
    cleanup(api => api.removeChat(chat.id))
    expect((await api.sendChat({ chatId: chat.id, modelRef: MODEL, toolMode: 'auto', text: 'Write the checkpoint.' })).text).toBe(MOCK_CHECKPOINT_DONE)

    await openChat(page, chat.id)
    await changesToggle(page).click()
    const before = Math.round((await boxOf(changesPane(page))).width)
    await page.getByTestId(testIds.changesResize).focus()
    for (let presses = 0; presses < 4; presses++)
      await page.keyboard.press('ArrowLeft')
    await expect.poll(async () => Math.round((await boxOf(changesPane(page))).width), { message: 'the pane is wider' }).toBeGreaterThan(before + 40)
    await expect.poll(async () => Number(await storageItem(page, CHANGES_STORAGE_KEYS.width)), { message: 'the stored width' }).toBeGreaterThan(before + 40)
  })
})
