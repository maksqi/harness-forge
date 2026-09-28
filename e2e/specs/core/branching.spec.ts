// Message versions (docs/UI.md 7.5, 13.6; docs/API.md 5.9 `chats.switchBranch`; ADR-023) with `mock:echo`: editing a
// user message and regenerating a reply add a version instead of deleting what followed. The BranchSwitcher ("‹ 2/2 ›")
// of a message with versions shows another one (the most recent path under it), focus stays on the control that was
// used, and the server keeps the choice as the chat's active leaf, so a reload shows the same versions. Asserted
// through the `message-branch*` test ids: `data-index` (0-based), `data-count`, `data-message-id` (the shown version)
// and `aria-disabled` on Previous / Next at the first / last version.
import type { Locator } from '@playwright/test'
import {
  assistantMessages,
  expect,
  expectMessageStatus,
  lastAssistantMessage,
  sendMessage,
  startChat,
  test,
  testIds,
  uniqueId,
  userMessages,
} from '../../helpers/index.ts'

interface ShownVersion {
  /** 0-based position of the shown version. */
  index: number
  count: number
  /** The id of the shown version. */
  messageId?: string
}

/** The version switcher of a message (absent when the message has one version). */
function switcherOf(message: Locator): Locator {
  return message.getByTestId(testIds.messageBranch)
}

/** The switcher shows version `index + 1` of `count` ("2/2"); Previous / Next are aria-disabled at the ends. */
async function expectVersion(switcher: Locator, { index, count, messageId }: ShownVersion): Promise<void> {
  await expect(switcher).toHaveAttribute('data-index', String(index))
  await expect(switcher).toHaveAttribute('data-count', String(count))
  await expect(switcher.getByTestId(testIds.messageBranchCounter)).toHaveText(`${index + 1}/${count}`)
  if (messageId !== undefined)
    await expect(switcher).toHaveAttribute('data-message-id', messageId)
  const previous = switcher.getByTestId(testIds.messageBranchPrevious)
  const next = switcher.getByTestId(testIds.messageBranchNext)
  if (index === 0)
    await expect(previous).toHaveAttribute('aria-disabled', 'true')
  else
    await expect(previous).not.toHaveAttribute('aria-disabled')
  if (index === count - 1)
    await expect(next).toHaveAttribute('aria-disabled', 'true')
  else
    await expect(next).not.toHaveAttribute('aria-disabled')
}

/** The `data-message-id` of a transcript message. */
async function idOf(message: Locator): Promise<string> {
  const id = await message.getAttribute('data-message-id')
  if (!id)
    throw new Error(`${message} has no data-message-id.`)
  return id
}

test.describe('branching', () => {
  test('an edit and a regenerate add versions, the switcher shows them and a reload keeps the choice @smoke', async ({ page, api, cleanup }) => {
    const token = uniqueId('branch')
    const first = `Branch first ${token}`
    const second = `Branch second ${token}`
    const edited = `Branch edited ${token}`

    // A, then B: two turns, no versions yet.
    const chatId = await startChat(page, { modelRef: 'mock:echo', text: first })
    cleanup(api => api.removeChat(chatId))
    await expectMessageStatus(lastAssistantMessage(page), 'done')
    await sendMessage(page, second)
    await expect(assistantMessages(page)).toHaveCount(2)
    await expectMessageStatus(lastAssistantMessage(page), 'done')
    await expect(lastAssistantMessage(page)).toContainText(second)
    await expect(page.getByTestId(testIds.messageBranch)).toHaveCount(0)
    const firstId = await idOf(userMessages(page).nth(0))
    const firstReplyId = await idOf(assistantMessages(page).nth(0))
    const secondId = await idOf(userMessages(page).nth(1))
    const secondReplyId = await idOf(assistantMessages(page).nth(1))

    // Editing A adds a second version of it: the transcript shows the new version and its reply, the user message
    // "2/2" (its reply has one version, so no switcher).
    await userMessages(page).nth(0).getByTestId(testIds.messageEdit).click()
    const editor = page.getByTestId(testIds.messageEditInput)
    await expect(editor).toBeFocused()
    await expect(editor).toHaveValue(first)
    await editor.fill(edited)
    await page.getByTestId(testIds.messageEditSave).click()
    await expect(editor).toBeHidden()
    await expect(userMessages(page)).toHaveCount(1)
    await expect(userMessages(page).first()).toContainText(edited)
    await expectMessageStatus(lastAssistantMessage(page), 'done')
    await expect(lastAssistantMessage(page)).toContainText(edited)
    const editedId = await idOf(userMessages(page).first())
    expect(editedId, 'an edit is a new message').not.toBe(firstId)
    await expectVersion(switcherOf(userMessages(page).first()), { index: 1, count: 2, messageId: editedId })
    await expect(switcherOf(lastAssistantMessage(page))).toHaveCount(0)

    // "Previous version" brings back A with everything after it: its reply, B and B's reply. Focus lands on the same
    // control of the switcher of the version now shown.
    await switcherOf(userMessages(page).first()).getByTestId(testIds.messageBranchPrevious).click()
    await expect(userMessages(page)).toHaveCount(2)
    await expect(assistantMessages(page)).toHaveCount(2)
    await expect(userMessages(page).nth(0)).toContainText(first)
    await expect(assistantMessages(page).nth(0)).toContainText(first)
    await expect(userMessages(page).nth(1)).toContainText(second)
    await expect(assistantMessages(page).nth(1)).toContainText(second)
    const firstSwitcher = switcherOf(userMessages(page).nth(0))
    await expectVersion(firstSwitcher, { index: 0, count: 2, messageId: firstId })
    await expect(firstSwitcher.getByTestId(testIds.messageBranchPrevious)).toBeFocused()
    await expect(assistantMessages(page).nth(1)).toHaveAttribute('data-message-id', secondReplyId)

    // Regenerating the last reply adds a second version of it: "2/2" on the assistant message.
    await assistantMessages(page).nth(1).getByTestId(testIds.messageRegenerate).click()
    const replySwitcher = switcherOf(assistantMessages(page).nth(1))
    await expectVersion(replySwitcher, { index: 1, count: 2 })
    await expectMessageStatus(assistantMessages(page).nth(1), 'done')
    await expect(assistantMessages(page).nth(1)).toContainText(second)
    const regeneratedId = await idOf(assistantMessages(page).nth(1))
    expect(regeneratedId, 'a regenerated reply is a new message').not.toBe(secondReplyId)
    await expect(replySwitcher).toHaveAttribute('data-message-id', regeneratedId)
    await expectVersion(firstSwitcher, { index: 0, count: 2, messageId: firstId })

    // The server keeps the shown versions: a reload shows the same path.
    await page.reload()
    await expect(userMessages(page)).toHaveCount(2)
    await expect(assistantMessages(page)).toHaveCount(2)
    await expectVersion(firstSwitcher, { index: 0, count: 2, messageId: firstId })
    await expectVersion(replySwitcher, { index: 1, count: 2, messageId: regeneratedId })

    // ArrowLeft inside a switcher shows the previous version (focus stays on the same control); a reload keeps it.
    await replySwitcher.getByTestId(testIds.messageBranchNext).focus()
    await page.keyboard.press('ArrowLeft')
    await expectVersion(replySwitcher, { index: 0, count: 2, messageId: secondReplyId })
    await expect(replySwitcher.getByTestId(testIds.messageBranchNext)).toBeFocused()
    await expect(assistantMessages(page).nth(1)).toHaveAttribute('data-message-id', secondReplyId)
    await page.reload()
    await expect(assistantMessages(page)).toHaveCount(2)
    await expectVersion(replySwitcher, { index: 0, count: 2, messageId: secondReplyId })
    await expectVersion(firstSwitcher, { index: 0, count: 2, messageId: firstId })

    // The server agrees: the active path, and the versions of its messages in `seq` order.
    const detail = await api.getChat(chatId)
    expect(detail.messages.map(message => message.id)).toEqual([firstId, firstReplyId, secondId, secondReplyId])
    expect(detail.branches).toEqual({
      [firstId]: { siblings: [firstId, editedId], index: 0 },
      [secondReplyId]: { siblings: [secondReplyId, regeneratedId], index: 0 },
    })
  })
})
