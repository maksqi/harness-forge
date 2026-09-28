// Read-only share links (docs/UI.md 2.8, 2.9, 7.14, 7.15; docs/API.md 4.17, 5.20; ADR-025) on a password-protected
// server (`startPasswordServer`): "Share…" in the chat header menu opens the Share dialog, "Create link" adds a link,
// and a browser context without cookies (no session) opens its URL as the read-only transcript of the snapshot: the
// title and the messages, no sidebar, composer, message actions or version switchers. Revoking the link in the dialog
// makes a reload of that page show "This link is unavailable".
import type { PasswordServer } from '../../helpers/index.ts'
import {
  assistantMessages,
  byTestId,
  expect,
  HarnessApi,
  startPasswordServer,
  test,
  testIds,
  uniqueId,
} from '../../helpers/index.ts'

/** `<origin>/share/<token>` with the token format of DECISIONS.md (`^[0-9A-Za-z]{16}[\w-]{22}$`). */
function shareUrlPattern(baseURL: string): RegExp {
  const origin = new URL(baseURL).origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${origin}/share/[0-9A-Za-z]{16}[\\w-]{22}$`)
}

test.describe('share', () => {
  let server: PasswordServer | undefined
  let owner: HarnessApi | undefined
  let chat: { id: string, title: string, turns: string[] } | undefined

  test.beforeAll(async () => {
    server = await startPasswordServer()
    owner = await HarnessApi.create(server.baseURL)
    await owner.client.auth.login({ body: { password: server.password } })
    const token = uniqueId('share')
    const created = await owner.createChat({ title: `Shared chat ${token}` })
    chat = { id: created.id, title: created.title ?? '', turns: [`Share first ${token}`, `Share second ${token}`] }
    for (const text of chat.turns)
      await owner.sendChat({ chatId: chat.id, text, modelRef: 'mock:echo' })
  })

  test.afterAll(async () => {
    // Deleting the chat also deletes its links (a server from E2E_AUTH_BASE_URL keeps running).
    if (owner && chat)
      await owner.removeChat(chat.id)
    await owner?.dispose()
    await server?.stop()
  })

  test('a link from the Share dialog opens the read-only transcript without a session until it is revoked @smoke', async ({ page, browser }) => {
    const { baseURL, password } = server!
    const { id: chatId, title, turns } = chat!
    await new HarnessApi(page.request, baseURL).client.auth.login({ body: { password } })
    await page.goto(`${baseURL}/chat/${chatId}`)
    await expect(page.getByTestId(testIds.chatTitle)).toHaveText(title)
    await expect(assistantMessages(page)).toHaveCount(turns.length)

    // "Share…" in the chat header menu opens the dialog of this chat. It has no link yet, so "Create link" has focus;
    // a password is set, so there is no "No password set" warning.
    await page.getByTestId(testIds.chatMenuTrigger).click()
    await page.getByTestId(testIds.chatMenuShare).click()
    const dialog = page.getByTestId(testIds.shareDialog)
    await expect(dialog).toBeVisible()
    await expect(dialog).toHaveAttribute('data-chat-id', chatId)
    const create = dialog.getByTestId(testIds.shareCreate)
    await expect(create).toBeFocused()
    await expect(dialog.getByTestId(testIds.shareLink)).toHaveCount(0)
    await expect(dialog.getByTestId(testIds.sharePasswordlessWarning)).toHaveCount(0)
    // A new link includes attachments, but neither reasoning nor tool details.
    const form = dialog.getByTestId(testIds.shareCreateForm)
    await expect(byTestId(form, testIds.shareOption, { 'data-value': 'attachments' })).toBeChecked()
    await expect(byTestId(form, testIds.shareOption, { 'data-value': 'reasoning' })).not.toBeChecked()
    await expect(byTestId(form, testIds.shareOption, { 'data-value': 'tool-details' })).not.toBeChecked()

    // "Create link": the new card shows the absolute URL, focused, for the snapshot of the whole chat.
    await create.click()
    const card = dialog.getByTestId(testIds.shareLink)
    await expect(card).toHaveCount(1)
    await expect(card).toHaveAttribute('data-share-id', /^shr_[0-9A-Za-z]{16}$/)
    await expect(card).toHaveAttribute('data-outdated', 'false')
    await expect(card).toHaveAttribute('data-expired', 'false')
    await expect(card).toContainText(`${turns.length * 2} messages`)
    const urlField = card.getByTestId(testIds.shareUrl)
    await expect(urlField).toBeFocused()
    await expect(urlField).toHaveValue(shareUrlPattern(baseURL))
    const url = await urlField.inputValue()

    // A browser without cookies opens the link: the read-only transcript of the snapshot, and nothing else of the app.
    const visitor = await browser.newContext()
    try {
      const guest = await visitor.newPage()
      await guest.goto(url)
      const sharePage = guest.getByTestId(testIds.sharePage)
      await expect(sharePage).toHaveAttribute('data-state', 'ready')
      await expect(guest.getByTestId(testIds.shareTitle)).toHaveText(title)
      await expect(guest.getByTestId(testIds.shareMeta)).toContainText('Read-only snapshot')
      const messages = guest.getByTestId(testIds.shareTranscript).getByTestId(testIds.shareMessage)
      await expect(messages).toHaveCount(turns.length * 2)
      for (const [index, text] of turns.entries()) {
        await expect(messages.nth(index * 2)).toHaveAttribute('data-role', 'user')
        await expect(messages.nth(index * 2)).toContainText(text)
        await expect(messages.nth(index * 2 + 1)).toHaveAttribute('data-role', 'assistant')
        await expect(messages.nth(index * 2 + 1)).toHaveAttribute('data-status', 'done')
        await expect(messages.nth(index * 2 + 1)).toContainText(text)
      }
      for (const id of [testIds.sidebar, testIds.composer, testIds.messageUser, testIds.messageAssistant, testIds.messageCopy, testIds.messageEdit, testIds.messageRegenerate, testIds.messageBranch])
        await expect(guest.getByTestId(id), `no ${id} on the share page`).toHaveCount(0)
      // The visitor has no session: the rest of the app still asks for the password.
      expect(await new HarnessApi(guest.request, baseURL).client.auth.status()).toMatchObject({ enabled: true, authenticated: false })

      // "Revoke…" in the dialog, then "Revoke": the card goes away.
      await card.getByTestId(testIds.shareRevoke).click()
      const confirm = page.getByTestId(testIds.shareRevokeConfirm)
      await expect(confirm).toBeVisible()
      await confirm.click()
      await expect(confirm).toBeHidden()
      await expect(dialog.getByTestId(testIds.shareLink)).toHaveCount(0)
      await expect(create).toBeFocused()

      // The visitor reloads: the link is unavailable, the transcript is gone.
      await guest.reload()
      await expect(sharePage).toHaveAttribute('data-state', 'unavailable')
      await expect(guest.getByTestId(testIds.shareUnavailable)).toContainText('This link is unavailable')
      await expect(guest.getByTestId(testIds.shareTranscript)).toHaveCount(0)
    }
    finally {
      await visitor.close()
    }
  })
})
