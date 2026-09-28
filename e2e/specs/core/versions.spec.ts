// Version management (docs/UI.md 7.5, 14.1; docs/API.md 5.9; ADR-030, amends ADR-023) with `mock:echo`, on chats seeded
// through the API: "Delete this version" asks in a ConfirmDialog ("Delete this version?", "Delete version"), then shows
// the previous version, announces "Version deleted" and moves focus to the switcher (or to Copy when one version is
// left); each message remembers the version last shown under it, so switching away from a deep path and back shows that
// path again rather than the newest one; and a switch or a deletion in one tab moves every other open tab of the chat.
import type { Locator, Page } from '@playwright/test'
import type { HarnessApi } from '../../helpers/index.ts'
import {
  assistantMessages,
  expect,
  expectMessageStatus,
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
  messageId: string
}

/** The version switcher of a message (absent when the message has one version). */
function switcherOf(message: Locator): Locator {
  return message.getByTestId(testIds.messageBranch)
}

/** The switcher of `message` shows version `index + 1` of `count` and the message is that version. */
async function expectVersion(message: Locator, { index, count, messageId }: ShownVersion): Promise<void> {
  const switcher = switcherOf(message)
  await expect(message).toHaveAttribute('data-message-id', messageId)
  await expect(switcher).toHaveAttribute('data-message-id', messageId)
  await expect(switcher).toHaveAttribute('data-index', String(index))
  await expect(switcher).toHaveAttribute('data-count', String(count))
  await expect(switcher.getByTestId(testIds.messageBranchCounter)).toHaveText(`${index + 1}/${count}`)
}

/** The ids of the chat's active path on the server. */
async function serverPath(api: HarnessApi, chatId: string): Promise<string[]> {
  return (await api.getChat(chatId)).messages.map(message => message.id)
}

/** The id of the last message of the server's active path. */
async function activeLeaf(api: HarnessApi, chatId: string): Promise<string> {
  return (await serverPath(api, chatId)).at(-1)!
}

/** The confirmation dialog of "Delete this version" (a ConfirmDialog: its confirm button carries the test id). */
function deleteDialog(page: Page): Locator {
  return page.getByRole('alertdialog').filter({ has: page.getByTestId(testIds.messageDeleteVersionConfirm) })
}

/** The polite live region of the chat view (announcements such as "Version deleted"). */
function announcements(page: Page): Locator {
  return page.getByRole('status').filter({ hasText: 'Version deleted' })
}

/** A chat with one turn whose reply has three versions (the newest shown). */
async function seedThreeReplies(api: HarnessApi, text: string): Promise<{ chatId: string, userId: string, replies: string[] }> {
  const { chatId, userMessageId } = await api.sendChat({ text })
  const replies = [await activeLeaf(api, chatId)]
  for (let version = 2; version <= 3; version++) {
    await api.regenerateChat({ chatId })
    replies.push(await activeLeaf(api, chatId))
  }
  return { chatId, userId: userMessageId, replies }
}

test.describe('versions', () => {
  test('deleting a version asks first, shows the previous one, announces it and moves focus @smoke', async ({ page, api, cleanup }) => {
    const text = `Delete versions ${uniqueId('delete')}`
    const { chatId, replies } = await seedThreeReplies(api, text)
    cleanup(api => api.removeChat(chatId))
    const [firstReply, secondReply, thirdReply] = replies as [string, string, string]

    await page.goto(`/chat/${chatId}`)
    const reply = assistantMessages(page).last()
    await expectMessageStatus(reply)
    await expectVersion(reply, { index: 2, count: 3, messageId: thirdReply })

    // Cancel keeps every version and puts focus back on "Delete this version".
    const deleteButton = reply.getByTestId(testIds.messageDeleteVersion)
    await expect(deleteButton).toHaveAccessibleName('Delete this version')
    await deleteButton.click()
    const dialog = deleteDialog(page)
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('Delete this version?')
    await expect(dialog).toContainText('This version and every message after it are deleted. Other versions stay.')
    await expect(dialog.getByTestId(testIds.messageDeleteVersionConfirm)).toHaveText('Delete version')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
    await expect(deleteButton).toBeFocused()
    await expectVersion(reply, { index: 2, count: 3, messageId: thirdReply })
    expect(await serverPath(api, chatId)).toContain(thirdReply)

    // "Delete version": the previous version with the path under it, one version fewer, the announcement, focus on
    // the switcher of the version now shown (its first usable button).
    await deleteButton.click()
    await dialog.getByTestId(testIds.messageDeleteVersionConfirm).click()
    await expect(dialog).toBeHidden()
    await expectVersion(reply, { index: 1, count: 2, messageId: secondReply })
    await expect(announcements(page)).toHaveText('Version deleted')
    await expect(switcherOf(reply).getByTestId(testIds.messageBranchPrevious)).toBeFocused()
    const detail = await api.getChat(chatId)
    expect(detail.messages.at(-1)?.id).toBe(secondReply)
    expect(Object.values(detail.branches)).toEqual([{ siblings: [firstReply, secondReply], index: 1 }])

    // Deleting down to one version: no switcher and no Delete this version any more; focus goes to Copy.
    await reply.getByTestId(testIds.messageDeleteVersion).click()
    await deleteDialog(page).getByTestId(testIds.messageDeleteVersionConfirm).click()
    await expect(deleteDialog(page)).toBeHidden()
    await expect(reply).toHaveAttribute('data-message-id', firstReply)
    await expect(switcherOf(reply)).toHaveCount(0)
    await expect(reply.getByTestId(testIds.messageDeleteVersion)).toHaveCount(0)
    await expect(reply.getByTestId(testIds.messageCopy)).toBeFocused()
    await expect(reply).toContainText(text)
    expect((await api.getChat(chatId)).branches).toEqual({})

    // A reload shows the same single version.
    await page.reload()
    await expect(assistantMessages(page)).toHaveCount(1)
    await expect(assistantMessages(page).last()).toHaveAttribute('data-message-id', firstReply)
    await expect(page.getByTestId(testIds.messageBranch)).toHaveCount(0)
  })

  test('each message remembers the version shown under it: a deep path comes back after switching away @smoke', async ({ page, api, cleanup }) => {
    const token = uniqueId('remember')
    const first = `Remember first ${token}`
    const second = `Remember second ${token}`
    const edited = `Remember edited ${token}`
    // A, A', B, B'1; B'2 (regenerated, shown); then A2 and its reply (an edit of A, shown).
    const { chatId, userMessageId: firstId } = await api.sendChat({ text: first })
    cleanup(api => api.removeChat(chatId))
    const { userMessageId: secondId } = await api.sendChat({ chatId, text: second })
    const secondReplyV1 = await activeLeaf(api, chatId)
    await api.regenerateChat({ chatId })
    const secondReplyV2 = await activeLeaf(api, chatId)
    const { userMessageId: editedId } = await api.sendChat({ chatId, parentId: null, text: edited })

    await page.goto(`/chat/${chatId}`)
    await expect(userMessages(page)).toHaveCount(1)
    await expectVersion(userMessages(page).first(), { index: 1, count: 2, messageId: editedId })

    // Back to A: the path last shown under it, which ends at B'2.
    await switcherOf(userMessages(page).first()).getByTestId(testIds.messageBranchPrevious).click()
    await expect(userMessages(page)).toHaveCount(2)
    await expectVersion(userMessages(page).first(), { index: 0, count: 2, messageId: firstId })
    await expect(userMessages(page).nth(1)).toHaveAttribute('data-message-id', secondId)
    const secondReply = assistantMessages(page).nth(1)
    await expectVersion(secondReply, { index: 1, count: 2, messageId: secondReplyV2 })

    // Deep inside that path, show B'1; then A2; then A again: B'1 is back (remembered), not the newest B'2.
    await switcherOf(secondReply).getByTestId(testIds.messageBranchPrevious).click()
    await expectVersion(secondReply, { index: 0, count: 2, messageId: secondReplyV1 })
    await switcherOf(userMessages(page).first()).getByTestId(testIds.messageBranchNext).click()
    await expect(userMessages(page)).toHaveCount(1)
    await expectVersion(userMessages(page).first(), { index: 1, count: 2, messageId: editedId })
    await switcherOf(userMessages(page).first()).getByTestId(testIds.messageBranchPrevious).click()
    await expect(userMessages(page)).toHaveCount(2)
    await expectVersion(secondReply, { index: 0, count: 2, messageId: secondReplyV1 })
    expect(await activeLeaf(api, chatId)).toBe(secondReplyV1)

    // A reload keeps it.
    await page.reload()
    await expect(userMessages(page)).toHaveCount(2)
    await expectVersion(assistantMessages(page).nth(1), { index: 0, count: 2, messageId: secondReplyV1 })

    // Deleting the edit A2 (shown again first) returns to A with its remembered path.
    await switcherOf(userMessages(page).first()).getByTestId(testIds.messageBranchNext).click()
    await expectVersion(userMessages(page).first(), { index: 1, count: 2, messageId: editedId })
    await userMessages(page).first().getByTestId(testIds.messageDeleteVersion).click()
    await deleteDialog(page).getByTestId(testIds.messageDeleteVersionConfirm).click()
    await expect(deleteDialog(page)).toBeHidden()
    await expect(userMessages(page)).toHaveCount(2)
    await expect(userMessages(page).first()).toHaveAttribute('data-message-id', firstId)
    await expect(switcherOf(userMessages(page).first())).toHaveCount(0)
    await expectVersion(assistantMessages(page).nth(1), { index: 0, count: 2, messageId: secondReplyV1 })
    await expect(announcements(page)).toHaveText('Version deleted')
    expect(await serverPath(api, chatId)).not.toContain(editedId)
  })

  test('a switch or a deletion in one tab moves the other tab @smoke', async ({ page, context, api, cleanup }) => {
    const text = `Two tabs ${uniqueId('tabs')}`
    const { chatId, replies } = await seedThreeReplies(api, text)
    cleanup(api => api.removeChat(chatId))
    const [firstReply, secondReply, thirdReply] = replies as [string, string, string]

    await page.goto(`/chat/${chatId}`)
    const other = await context.newPage()
    try {
      await other.goto(`/chat/${chatId}`)
      const here = assistantMessages(page).last()
      const there = assistantMessages(other).last()
      await expectVersion(here, { index: 2, count: 3, messageId: thirdReply })
      await expectVersion(there, { index: 2, count: 3, messageId: thirdReply })

      // A switch here shows up there without a reload.
      await switcherOf(here).getByTestId(testIds.messageBranchPrevious).click()
      await expectVersion(here, { index: 1, count: 3, messageId: secondReply })
      await expectVersion(there, { index: 1, count: 3, messageId: secondReply })

      // And the other way round.
      await switcherOf(there).getByTestId(testIds.messageBranchPrevious).click()
      await expectVersion(there, { index: 0, count: 3, messageId: firstReply })
      await expectVersion(here, { index: 0, count: 3, messageId: firstReply })

      // Deleting the shown version here moves the other tab to the version shown now.
      await here.getByTestId(testIds.messageDeleteVersion).click()
      await deleteDialog(page).getByTestId(testIds.messageDeleteVersionConfirm).click()
      await expect(deleteDialog(page)).toBeHidden()
      await expectVersion(here, { index: 0, count: 2, messageId: secondReply })
      await expectVersion(there, { index: 0, count: 2, messageId: secondReply })
      expect(await activeLeaf(api, chatId)).toBe(secondReply)
    }
    finally {
      await other.close()
    }
  })
})
