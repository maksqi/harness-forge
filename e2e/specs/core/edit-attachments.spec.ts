// Editing the attachments of a message (docs/UI.md 7.5 "Attachments on edit", S8) with `mock:echo`: text files reach the
// model inlined as `Attached file "<name>": <contents>`, so the echo names every file the message carries. The editor
// lists the message's attachments as removable
// chips (`message-edit-attachment`) and adds files through its paperclip (`message-edit-attach`, a file chooser); a new
// file uploads at once and Send (`message-edit-save`) stays disabled while it uploads; the new version carries exactly
// the chips left in the editor, and the old version keeps its own files.
import type { Page } from '@playwright/test'
import { Buffer } from 'node:buffer'
import {
  assistantMessages,
  byTestId,
  CHAT_URL_PATTERN,
  chatIdFromUrl,
  expect,
  expectMessageStatus,
  lastAssistantMessage,
  looseQuotes,
  openNewChat,
  selectModel,
  test,
  testIds,
  uniqueId,
  userMessages,
} from '../../helpers/index.ts'

interface TextFile {
  name: string
  mimeType: string
  buffer: Buffer
}

function textFile(name: string): TextFile {
  return { name, mimeType: 'text/plain', buffer: Buffer.from(`Contents of ${name}\n`, 'utf8') }
}

/** How the echo of `mock:echo` names an attached text file (quotes may render typographic). */
function attachedLine(file: TextFile): RegExp {
  return looseQuotes(`Attached file "${file.name}"`)
}

/**
 * Holds every upload (`POST /api/files`) until `release()`: the editor's chip stays `uploading` meanwhile. Other
 * requests (and file downloads, `GET /api/files/<id>`) go through.
 */
async function holdUploads(page: Page): Promise<{ release: () => void, held: () => number }> {
  let release: () => void = () => {}
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  let held = 0
  await page.route(url => url.pathname === '/api/files', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback()
      return
    }
    held += 1
    await released
    await route.fallback()
  })
  return { release, held: () => held }
}

test.describe('edit attachments', () => {
  test('an edit removes one attachment and adds another; Send waits for the upload; the new version has the new set @smoke', async ({ page, api, cleanup }) => {
    const token = uniqueId('attach')
    const keep = textFile(`keep-${token}.txt`)
    const drop = textFile(`drop-${token}.txt`)
    const added = textFile(`added-${token}.txt`)
    const text = `Attachment check ${token}`
    const editedText = `Attachment edit ${token}`

    // A message with two attachments.
    await openNewChat(page)
    await selectModel(page, 'mock:echo')
    await page.getByTestId(testIds.composerFileInput).setInputFiles([keep, drop])
    const composerChips = page.getByTestId(testIds.composerAttachment)
    await expect(composerChips).toHaveCount(2)
    for (const chip of await composerChips.all())
      await expect(chip).toHaveAttribute('data-state', 'done')
    await page.getByTestId(testIds.composerInput).fill(text)
    await expect(page.getByTestId(testIds.composerSend)).toHaveAttribute('data-state', 'ready')
    await page.getByTestId(testIds.composerSend).click()
    await expect(page).toHaveURL(CHAT_URL_PATTERN)
    const chatId = chatIdFromUrl(page)
    cleanup(api => api.removeChat(chatId))
    await expectMessageStatus(lastAssistantMessage(page))
    await expect(lastAssistantMessage(page)).toContainText(attachedLine(keep))
    await expect(lastAssistantMessage(page)).toContainText(attachedLine(drop))
    const question = userMessages(page).first()
    await expect(question.getByTestId(testIds.fileChip)).toHaveText([keep.name, drop.name])
    const originalId = await question.getAttribute('data-message-id')

    // The editor shows both attachments as chips; removing one leaves the other.
    await question.getByTestId(testIds.messageEdit).click()
    const editor = page.getByTestId(testIds.messageEditInput)
    await expect(editor).toBeFocused()
    const chips = page.getByTestId(testIds.messageEditAttachment)
    await expect(chips).toHaveCount(2)
    await expect(chips).toHaveText([keep.name, drop.name])
    await chips.filter({ hasText: drop.name }).getByRole('button', { name: `Remove ${drop.name}` }).click()
    await expect(chips).toHaveText([keep.name])
    await expect(editor).toBeFocused()

    // The paperclip opens a file chooser; while the new file uploads, Send is disabled.
    const uploads = await holdUploads(page)
    const save = page.getByTestId(testIds.messageEditSave)
    await expect(save).toBeEnabled()
    const choosing = page.waitForEvent('filechooser')
    await page.getByTestId(testIds.messageEditAttach).click()
    const chooser = await choosing
    expect(chooser.isMultiple()).toBe(true)
    await chooser.setFiles(added)
    const addedChip = chips.filter({ hasText: added.name })
    await expect(addedChip).toHaveAttribute('data-state', 'uploading')
    await expect.poll(uploads.held).toBe(1)
    await expect(save).toBeDisabled()
    await expect(save).toHaveAttribute('aria-busy', 'true')
    await editor.fill(editedText)
    await expect(save).toBeDisabled()
    uploads.release()
    await expect(addedChip).toHaveAttribute('data-state', 'done')
    await expect(save).toBeEnabled()

    // Send: a new version of the message with the kept file and the new one, answered with both.
    await save.click()
    await expect(editor).toBeHidden()
    await expect(userMessages(page)).toHaveCount(1)
    const edited = userMessages(page).first()
    await expect(edited).toContainText(editedText)
    await expect(edited.getByTestId(testIds.fileChip)).toHaveText([keep.name, added.name])
    await expect(byTestId(edited, testIds.messageBranch, { 'data-count': '2', 'data-index': '1' })).toBeVisible()
    await expectMessageStatus(lastAssistantMessage(page))
    await expect(lastAssistantMessage(page)).toContainText(editedText)
    await expect(lastAssistantMessage(page)).toContainText(attachedLine(keep))
    await expect(lastAssistantMessage(page)).toContainText(attachedLine(added))
    await expect(lastAssistantMessage(page)).not.toContainText(drop.name)

    // The server stored exactly that set on the new version; the old version keeps its own files.
    const editedId = await edited.getAttribute('data-message-id')
    expect(editedId).not.toBe(originalId)
    const detail = await api.getChat(chatId)
    const stored = detail.messages.find(message => message.id === editedId)!
    expect(stored.parts.flatMap(part => (part.type === 'file' ? [part.filename] : []))).toEqual([keep.name, added.name])
    await edited.getByTestId(testIds.messageBranch).getByTestId(testIds.messageBranchPrevious).click()
    await expect(userMessages(page).first()).toHaveAttribute('data-message-id', originalId!)
    await expect(userMessages(page).first().getByTestId(testIds.fileChip)).toHaveText([keep.name, drop.name])
    await expect(assistantMessages(page)).toHaveCount(1)
    await expect(lastAssistantMessage(page)).toContainText(text)
  })

  test('Cancel discards the editor, its removals and its uploads @smoke', async ({ page, api, cleanup }) => {
    const token = uniqueId('attachcancel')
    const keep = textFile(`keep-${token}.txt`)
    const added = textFile(`added-${token}.txt`)
    const text = `Attachment cancel ${token}`

    await openNewChat(page)
    await selectModel(page, 'mock:echo')
    await page.getByTestId(testIds.composerFileInput).setInputFiles([keep])
    await expect(page.getByTestId(testIds.composerAttachment)).toHaveAttribute('data-state', 'done')
    await page.getByTestId(testIds.composerInput).fill(text)
    await page.getByTestId(testIds.composerSend).click()
    await expect(page).toHaveURL(CHAT_URL_PATTERN)
    const chatId = chatIdFromUrl(page)
    cleanup(api => api.removeChat(chatId))
    await expectMessageStatus(lastAssistantMessage(page))

    // Remove the attachment and start an upload that never finishes, then Cancel.
    const question = userMessages(page).first()
    await question.getByTestId(testIds.messageEdit).click()
    const chips = page.getByTestId(testIds.messageEditAttachment)
    await chips.getByRole('button', { name: `Remove ${keep.name}` }).click()
    await expect(chips).toHaveCount(0)
    const uploads = await holdUploads(page)
    const choosing = page.waitForEvent('filechooser')
    await page.getByTestId(testIds.messageEditAttach).click()
    await (await choosing).setFiles(added)
    await expect(chips.filter({ hasText: added.name })).toHaveAttribute('data-state', 'uploading')
    await page.getByTestId(testIds.messageEditCancel).click()
    await expect(page.getByTestId(testIds.messageEditInput)).toBeHidden()
    uploads.release()

    // Nothing changed: the same message, its file, no second version.
    await expect(userMessages(page)).toHaveCount(1)
    await expect(question.getByTestId(testIds.fileChip)).toHaveText([keep.name])
    await expect(page.getByTestId(testIds.messageBranch)).toHaveCount(0)
    const detail = await api.getChat(chatId)
    expect(detail.messages).toHaveLength(2)
    expect(detail.branches).toEqual({})
  })
})
