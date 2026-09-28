// The core chat flow (docs/UI.md 2.1, 2.2, 5.3, 7.5, 7.6) with `mock:echo`: a new chat streams its reply word by
// word, gets an automatic title in the sidebar, keeps its transcript across reloads, and Stop ends a running reply
// while keeping (and persisting) the partial message.
import type { Locator } from '@playwright/test'
import {
  chatRow,
  expect,
  expectMessageStatus,
  firstWords,
  lastAssistantMessage,
  startChat,
  test,
  testIds,
  uniqueId,
  userMessages,
  wordList,
} from '../../helpers/index.ts'

/** Reads the text, then the status: a `streaming` status proves the text was read mid-stream. */
async function snapshot(message: Locator): Promise<{ text: string, status: string | null }> {
  const text = await message.textContent() ?? ''
  return { text, status: await message.getAttribute('data-status') }
}

test.describe('chat', () => {
  test('a new chat streams the mock:echo reply, gets a title and survives a reload @smoke', async ({ page }) => {
    const token = uniqueId('echo')
    // 120 words stream for about 3 s (25 ms per word).
    const text = `Streaming check ${token} ${wordList(120, 'w').join(' ')} last-${token}`
    const title = firstWords(text, 8)

    const chatId = await startChat(page, { modelRef: 'mock:echo', text })
    await expect(userMessages(page)).toHaveCount(1)
    await expect(userMessages(page).first()).toContainText(`Streaming check ${token}`)

    // The reply grows while it streams: caught mid-stream, the first words are there but not the last one.
    const reply = lastAssistantMessage(page)
    let partial = { text: '', status: null as string | null }
    await expect(async () => {
      partial = await snapshot(reply)
      expect(partial.status).toBe('streaming')
      expect(partial.text).toContain(`Streaming check ${token}`)
    }).toPass({ timeout: 10_000 })
    expect(partial.text).not.toContain(`last-${token}`)

    await expectMessageStatus(reply, 'done', 20_000)
    await expect(reply).toContainText(`last-${token}`)
    await expect(reply.getByTestId(testIds.messageMeta)).toContainText('Mock Echo')

    // The automatic title (the first words of the message, from mock:echo) shows in the sidebar and the header.
    await expect(chatRow(page, chatId)).toHaveText(title, { timeout: 15_000 })
    await expect(page.getByTestId(testIds.chatTitle)).toHaveText(title)

    // The server owns the history: a reload shows the same transcript.
    await page.reload()
    await expect(userMessages(page)).toHaveCount(1)
    await expect(userMessages(page).first()).toContainText(`Streaming check ${token}`)
    const reloaded = lastAssistantMessage(page)
    await expectMessageStatus(reloaded, 'done')
    await expect(reloaded).toContainText(`Streaming check ${token}`)
    await expect(reloaded).toContainText(`last-${token}`)
    await expect(page.getByTestId(testIds.messageAssistant)).toHaveCount(1)
    await expect(page.getByTestId(testIds.chatTitle)).toHaveText(title)
    await expect(chatRow(page, chatId)).toHaveText(title)
  })

  test('stop ends a running reply and keeps the partial message @smoke', async ({ page, api }) => {
    const token = uniqueId('stop')
    // 400 words stream for about 10 s.
    const text = `Stop check ${token} ${wordList(400, 's').join(' ')} end-${token}`

    const chatId = await startChat(page, { modelRef: 'mock:echo', text })
    const reply = lastAssistantMessage(page)
    await expectMessageStatus(reply, 'streaming')
    await expect(reply).toContainText(`Stop check ${token}`)

    await page.getByTestId(testIds.composerStop).click()
    await expectMessageStatus(reply, 'aborted')
    await expect(page.getByTestId(testIds.composerSend)).toBeVisible()
    await expect(page.getByTestId(testIds.composerStop)).toBeHidden()
    await expect(reply.getByTestId(testIds.messageMeta)).toContainText('Stopped')
    await expect(reply).toContainText(`Stop check ${token}`)
    await expect(reply).not.toContainText(`end-${token}`)

    // The server persisted the partial reply as aborted, and the reload shows it that way.
    await expect.poll(async () => {
      const detail = await api.getChat(chatId)
      return detail.running ? 'running' : detail.messages.at(-1)?.metadata?.aborted
    }).toBe(true)
    await page.reload()
    const reloaded = lastAssistantMessage(page)
    await expectMessageStatus(reloaded, 'aborted')
    await expect(reloaded).toContainText(`Stop check ${token}`)
    await expect(reloaded).not.toContainText(`end-${token}`)
    await expect(reloaded.getByTestId(testIds.messageMeta)).toContainText('Stopped')
  })
})
