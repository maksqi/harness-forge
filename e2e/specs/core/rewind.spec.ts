// "Rewind files to here" (docs/UI.md 2.15, 7.22, 14.1; docs/API.md `changes.rewind*`; ADR-036) with `mock:checkpoint`,
// which writes `checkpoint.txt` ("Turn <n>") and runs `mkdir -p mock-dir && cd mock-dir`, then `ls` (docs/PROVIDERS.md
// 8). The turns run through the API; the page opens on finished chats.
// - The action shows on a user message only when an edit of the agent follows it; the preview lists the file and the
//   shell commands (newest first, "their effects on files stay"); Restore files writes the file back, the toast's Undo
//   brings the agent's version again, and focus returns to the button.
// - Restore files and edit deletes a file the chat created and opens the editor on the message.
// - A file changed by hand after the agent's edit is a conflict: skipped unless "Also restore files changed outside this
//   chat" is checked.
// - While a chat of the same project runs, the rewind is refused (409): a toast, the dialog closes, nothing changes.
import type { Locator, Page } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  assistantMessages,
  byTestId,
  expect,
  MOCK_CHECKPOINT_DONE,
  MOCK_CHECKPOINT_FILE,
  MOCK_CHECKPOINT_LS,
  MOCK_CHECKPOINT_MKDIR,
  mockCheckpointContent,
  openRewind,
  seedProject,
  test,
  testIds,
  toastWith,
  uniqueId,
  userMessages,
  wordList,
} from '../../helpers/index.ts'

const MODEL = 'mock:checkpoint'
const ORIGINAL = 'Original line.\n'
const FIRST_TEXT = 'Write the checkpoint.'

async function fileText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  }
  catch {
    return null
  }
}

/** Opens a chat page whose last reply is done. */
async function openChat(page: Page, chatId: string, lastReply: string): Promise<void> {
  await page.goto(`/chat/${chatId}`)
  const reply = assistantMessages(page).last()
  await expect(reply).toContainText(lastReply)
  await expect(reply).toHaveAttribute('data-status', 'done')
}

/** The toast of a rewind or of its undo, with or without Undo. */
function rewindToast(page: Page, title: string, options: { undo: boolean }): Locator {
  const toast = toastWith(page, title)
  const undo = page.getByTestId(testIds.toastUndo)
  return options.undo ? toast.filter({ has: undo }) : toast.filter({ hasNot: undo })
}

test.describe('rewind files', () => {
  test('the button follows edits; the preview lists the file and the commands; Restore and Undo @smoke', async ({ page, api, cleanup }) => {
    const { project, folder } = await seedProject(api, cleanup, { name: `Rewind ${uniqueId('rewind')}`, files: { [MOCK_CHECKPOINT_FILE]: ORIGINAL } })
    const chat = await api.createChat({ title: `Rewind ${uniqueId('chat')}`, projectId: project.id, modelRef: MODEL })
    cleanup(api => api.removeChat(chat.id))
    expect((await api.sendChat({ chatId: chat.id, modelRef: MODEL, toolMode: 'auto', text: FIRST_TEXT })).text).toBe(MOCK_CHECKPOINT_DONE)
    // A second turn without edits: no rewind on its message.
    const talk = `Just talk ${uniqueId('talk')}`
    await api.sendChat({ chatId: chat.id, modelRef: 'mock:echo', toolMode: 'off', text: talk })
    const file = join(folder.path, MOCK_CHECKPOINT_FILE)
    expect(await fileText(file)).toBe(mockCheckpointContent(1))

    await openChat(page, chat.id, talk)
    const [first, second] = [userMessages(page).nth(0), userMessages(page).nth(1)]
    await expect(userMessages(page)).toHaveCount(2)
    await expect(first.getByTestId(testIds.messageRewind)).toHaveCount(1)
    await expect(first.getByTestId(testIds.messageRewind)).toHaveAccessibleName('Rewind files to here')
    await expect(second.getByTestId(testIds.messageRewind)).toHaveCount(0)
    await expect(assistantMessages(page).getByTestId(testIds.messageRewind)).toHaveCount(0)

    // The preview: the file goes back, the shell commands stay (newest first), no conflict option.
    const dialog = await openRewind(page, first)
    await expect(dialog).toHaveAttribute('data-state', 'ready')
    await expect(dialog).toContainText('Rewind files to here?')
    await expect(dialog).toContainText('The conversation stays as it is.')
    const files = dialog.getByTestId(testIds.rewindFile)
    await expect(files).toHaveCount(1)
    await expect(files.first()).toHaveAttribute('data-path', MOCK_CHECKPOINT_FILE)
    await expect(files.first()).toHaveAttribute('data-action', 'restore')
    await expect(files.first()).not.toHaveAttribute('data-conflict', /.*/)
    await expect(files.first()).toContainText('Restore')
    await expect(dialog.getByTestId(testIds.rewindForce)).toHaveCount(0)
    await expect(dialog).toContainText('Shell changes aren\'t tracked.')
    await expect(dialog).toContainText('These commands ran after this message; their effects on files stay:')
    await expect(dialog.getByTestId(testIds.rewindShellCommand)).toHaveText([MOCK_CHECKPOINT_LS, MOCK_CHECKPOINT_MKDIR])
    const restore = dialog.getByTestId(testIds.rewindRestore)
    await expect(restore).toBeFocused()

    // Restore files: the file is back, the toast offers Undo, focus returns to the button.
    await restore.click()
    await expect(dialog).toBeHidden()
    const restored = rewindToast(page, 'Restored 1 file', { undo: true })
    await expect(restored).toBeVisible()
    await expect.poll(() => fileText(file), { message: 'the file is back to its version before the message' }).toBe(ORIGINAL)
    await expect(first.getByTestId(testIds.messageRewind)).toBeFocused()
    // The conversation stays.
    await expect(userMessages(page)).toHaveCount(2)

    // Undo restores the agent's version (its own toast has no Undo).
    await restored.getByTestId(testIds.toastUndo).click()
    await expect(rewindToast(page, 'Restored 1 file', { undo: false })).toBeVisible()
    await expect.poll(() => fileText(file), { message: 'Undo brings the agent\'s version back' }).toBe(mockCheckpointContent(1))
  })

  test('Restore files and edit deletes a file the chat created and opens the editor @smoke', async ({ page, api, cleanup }) => {
    const { project, folder } = await seedProject(api, cleanup, { name: `Rewind edit ${uniqueId('edit')}` })
    const chat = await api.createChat({ title: `Rewind edit ${uniqueId('chat')}`, projectId: project.id, modelRef: MODEL })
    cleanup(api => api.removeChat(chat.id))
    expect((await api.sendChat({ chatId: chat.id, modelRef: MODEL, toolMode: 'auto', text: FIRST_TEXT })).text).toBe(MOCK_CHECKPOINT_DONE)
    const file = join(folder.path, MOCK_CHECKPOINT_FILE)
    expect(await fileText(file)).toBe(mockCheckpointContent(1))

    await openChat(page, chat.id, MOCK_CHECKPOINT_DONE)
    const message = userMessages(page).first()
    const dialog = await openRewind(page, message)
    const row = byTestId(dialog, testIds.rewindFile, { 'data-path': MOCK_CHECKPOINT_FILE })
    await expect(row).toHaveAttribute('data-action', 'delete')
    await expect(row).toContainText('Delete')

    await dialog.getByTestId(testIds.rewindRestoreEdit).click()
    await expect(dialog).toBeHidden()
    await expect(rewindToast(page, 'Restored 1 file', { undo: true })).toBeVisible()
    await expect.poll(() => fileText(file), { message: 'the file the chat created is gone' }).toBeNull()
    const editor = page.getByTestId(testIds.messageEditInput)
    await expect(editor).toBeVisible()
    await expect(editor).toBeFocused()
    await expect(editor).toHaveValue(FIRST_TEXT)
    await page.getByTestId(testIds.messageEditCancel).click()
    await expect(editor).toBeHidden()
  })

  test('a file changed outside the chat is skipped unless the rewind is forced @smoke', async ({ page, api, cleanup }) => {
    const { project, folder } = await seedProject(api, cleanup, { name: `Rewind conflict ${uniqueId('conflict')}`, files: { [MOCK_CHECKPOINT_FILE]: ORIGINAL } })
    const chat = await api.createChat({ title: `Rewind conflict ${uniqueId('chat')}`, projectId: project.id, modelRef: MODEL })
    cleanup(api => api.removeChat(chat.id))
    expect((await api.sendChat({ chatId: chat.id, modelRef: MODEL, toolMode: 'auto', text: FIRST_TEXT })).text).toBe(MOCK_CHECKPOINT_DONE)
    const file = join(folder.path, MOCK_CHECKPOINT_FILE)
    const byHand = 'Changed by hand.\n'
    await writeFile(file, byHand)

    await openChat(page, chat.id, MOCK_CHECKPOINT_DONE)
    const message = userMessages(page).first()
    let dialog = await openRewind(page, message)
    const row = byTestId(dialog, testIds.rewindFile, { 'data-path': MOCK_CHECKPOINT_FILE })
    await expect(row).toHaveAttribute('data-conflict', 'true')
    await expect(row).toContainText('changed outside this chat')
    const force = dialog.getByTestId(testIds.rewindForce)
    await expect(force).toHaveAttribute('data-state', 'unchecked')
    await expect(dialog).toContainText('Also restore files changed outside this chat')

    // Unchecked: the file is skipped, nothing is written (no Undo).
    await dialog.getByTestId(testIds.rewindRestore).click()
    await expect(dialog).toBeHidden()
    const skipped = rewindToast(page, 'Nothing was restored.', { undo: false })
    await expect(skipped).toBeVisible()
    await expect(skipped).toContainText('Skipped 1 file changed outside this chat')
    expect(await fileText(file)).toBe(byHand)

    // Forced: the hand-made change goes too.
    dialog = await openRewind(page, message)
    await dialog.getByTestId(testIds.rewindForce).click()
    await expect(dialog.getByTestId(testIds.rewindForce)).toHaveAttribute('data-state', 'checked')
    await dialog.getByTestId(testIds.rewindRestore).click()
    await expect(dialog).toBeHidden()
    await expect(rewindToast(page, 'Restored 1 file', { undo: true })).toBeVisible()
    await expect.poll(() => fileText(file), { message: 'the forced rewind restores the file' }).toBe(ORIGINAL)
  })

  test('a rewind while another chat of the project runs is refused @smoke', async ({ page, api, cleanup }) => {
    const { project, folder } = await seedProject(api, cleanup, { name: `Rewind busy ${uniqueId('busy')}`, files: { [MOCK_CHECKPOINT_FILE]: ORIGINAL } })
    const chat = await api.createChat({ title: `Rewind busy ${uniqueId('chat')}`, projectId: project.id, modelRef: MODEL })
    cleanup(api => api.removeChat(chat.id))
    expect((await api.sendChat({ chatId: chat.id, modelRef: MODEL, toolMode: 'auto', text: FIRST_TEXT })).text).toBe(MOCK_CHECKPOINT_DONE)
    const file = join(folder.path, MOCK_CHECKPOINT_FILE)

    await openChat(page, chat.id, MOCK_CHECKPOINT_DONE)
    const message = userMessages(page).first()
    const dialog = await openRewind(page, message)
    await expect(dialog).toHaveAttribute('data-state', 'ready')

    // Another chat of the same project starts a long reply (400 words stream for about 10 s).
    const other = await api.createChat({ title: `Rewind runner ${uniqueId('chat')}`, projectId: project.id, modelRef: 'mock:echo' })
    cleanup(api => api.removeChat(other.id))
    const running = api.sendChat({ chatId: other.id, modelRef: 'mock:echo', toolMode: 'off', text: wordList(400, 'busy').join(' ') })
    try {
      await expect.poll(async () => (await api.getChat(other.id)).running, { message: 'the other chat runs' }).toBe(true)

      await dialog.getByTestId(testIds.rewindRestore).click()
      await expect(toastWith(page, 'Wait for the responses in this project to finish before rewinding files.')).toBeVisible()
      await expect(dialog).toBeHidden()
      await expect(message.getByTestId(testIds.messageRewind)).toBeFocused()
      expect(await fileText(file)).toBe(mockCheckpointContent(1))
    }
    finally {
      await api.stopChat(other.id)
      await running.catch(() => undefined)
    }
  })
})
