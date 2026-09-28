// Resuming a running reply (docs/API.md 6.6, docs/UI.md 7.6; ARCHITECTURE.md 6.3): the server keeps every run's stream
// and `GET /api/chat/:id/stream` replays it from the first chunk, then follows it live. A reload in the middle of a
// reply, a trip to another page of the app and a second tab all show the same reply streaming again from its first
// words until it ends with its last word, and the server stores it exactly once. `mock:echo` streams 600 words for
// about 15 s (50 ms, then 25 ms per word), long enough for a reload and the boot of the app.
import type { Page } from '@playwright/test'
import type { HarnessApi } from '../../helpers/index.ts'
import {
  assistantMessages,
  chatRow,
  chatStatusDot,
  expect,
  expectMessageStatus,
  expectStreamingWith,
  lastAssistantMessage,
  startChat,
  test,
  testIds,
  uniqueId,
  userMessages,
  wordList,
} from '../../helpers/index.ts'

/** Words of the resumed message: about 15 s of streaming. */
const WORDS = 600
/** Longest wait for the end of a reply (the stream itself takes about 15 s). */
const REPLY_TIMEOUT = 40_000

interface ResumeText {
  text: string
  /** The first words, shown right after a resume (the replay starts at the first chunk). */
  first: string
  /** The last word, streamed at the very end. */
  last: string
}

function resumeText(label: string): ResumeText {
  const token = uniqueId('resume')
  const first = `${label} ${token}`
  const last = `last-${token}`
  return { text: `${first} ${wordList(WORDS, 'r').join(' ')} ${last}`, first, last }
}

/** The run finished on the server and stored exactly one reply for the one turn of the chat (and no second version). */
async function expectStoredOnce(api: HarnessApi, chatId: string, { first, last }: ResumeText): Promise<void> {
  await expect.poll(async () => (await api.getChat(chatId)).running, { timeout: REPLY_TIMEOUT, message: 'the run finished' }).toBe(false)
  const detail = await api.getChat(chatId)
  expect(detail.messages.map(message => message.role)).toEqual(['user', 'assistant'])
  const reply = detail.messages[1]!
  const text = reply.parts.map(part => (part.type === 'text' ? part.text : '')).join('')
  expect(text.startsWith(first), 'the stored reply starts with the first words').toBe(true)
  expect(text.trimEnd().endsWith(last), 'the stored reply ends with the last word').toBe(true)
  expect(reply.metadata?.aborted ?? false).toBe(false)
  expect(detail.branches, 'no second version of any message').toEqual({})
}

/** After a reload the transcript shows the one turn: its user message and exactly one finished reply. */
async function expectOneReplyAfterReload(page: Page, { first, last }: ResumeText): Promise<void> {
  await page.reload()
  await expect(userMessages(page)).toHaveCount(1)
  await expect(userMessages(page).first()).toContainText(first)
  await expect(assistantMessages(page)).toHaveCount(1)
  const reply = lastAssistantMessage(page)
  await expectMessageStatus(reply, 'done')
  await expect(reply).toContainText(first)
  await expect(reply).toContainText(last)
  await expect(page.getByTestId(testIds.messageBranch)).toHaveCount(0)
}

test.describe('resume', () => {
  // Each test streams a 15 s reply and waits for its end.
  test.describe.configure({ timeout: 90_000 })

  test('a reload mid-stream resumes the reply, which is stored once @smoke', async ({ page, api, cleanup }) => {
    const reply = resumeText('Reload check')
    const chatId = await startChat(page, { modelRef: 'mock:echo', text: reply.text })
    cleanup(api => api.removeChat(chatId))
    await expectStreamingWith(lastAssistantMessage(page), reply.first)

    await page.reload()

    // Streaming again from the first chunk, while the end is still to come.
    const resumed = lastAssistantMessage(page)
    const partial = await expectStreamingWith(resumed, reply.first)
    expect(partial.text).not.toContain(reply.last)
    await expect(userMessages(page)).toHaveCount(1)
    await expect(assistantMessages(page)).toHaveCount(1)
    await expect(page.getByTestId(testIds.composerStop)).toBeVisible()

    await expectMessageStatus(resumed, 'done', REPLY_TIMEOUT)
    await expect(resumed).toContainText(reply.last)
    await expect(page.getByTestId(testIds.composerSend)).toBeVisible()
    await expect(assistantMessages(page)).toHaveCount(1)

    await expectStoredOnce(api, chatId, reply)
    await expectOneReplyAfterReload(page, reply)
  })

  test('leaving the chat and coming back shows the reply still streaming @smoke', async ({ page, api, cleanup }) => {
    const reply = resumeText('Return check')
    const chatId = await startChat(page, { modelRef: 'mock:echo', text: reply.text })
    cleanup(api => api.removeChat(chatId))
    await expectStreamingWith(lastAssistantMessage(page), reply.first)

    // Away from the chat (in the app, no reload): the sidebar marks it as running.
    await page.getByTestId(testIds.newChat).click()
    await expect(page.getByTestId(testIds.emptyGreeting)).toBeVisible()
    const running = chatStatusDot(page, chatId, { 'data-status': 'running' })
    await expect(running).toBeVisible()

    await chatRow(page, chatId).click()
    await expect(page).toHaveURL(new RegExp(`/chat/${chatId}$`))
    const resumed = lastAssistantMessage(page)
    const partial = await expectStreamingWith(resumed, reply.first)
    expect(partial.text).not.toContain(reply.last)
    await expect(assistantMessages(page)).toHaveCount(1)

    await expectMessageStatus(resumed, 'done', REPLY_TIMEOUT)
    await expect(resumed).toContainText(reply.last)
    await expect(running).toHaveCount(0)

    await expectStoredOnce(api, chatId, reply)
    await expectOneReplyAfterReload(page, reply)
  })

  test('a second tab follows the running reply from its first words @smoke', async ({ page, context, api, cleanup }) => {
    const reply = resumeText('Second tab check')
    const chatId = await startChat(page, { modelRef: 'mock:echo', text: reply.text })
    cleanup(api => api.removeChat(chatId))
    await expectStreamingWith(lastAssistantMessage(page), reply.first)

    const second = await context.newPage()
    try {
      await second.goto(`/chat/${chatId}`)
      const mirrored = lastAssistantMessage(second)
      const partial = await expectStreamingWith(mirrored, reply.first)
      expect(partial.text).not.toContain(reply.last)
      await expect(userMessages(second)).toHaveCount(1)
      await expect(assistantMessages(second)).toHaveCount(1)

      // Both tabs finish the same reply.
      await expectMessageStatus(mirrored, 'done', REPLY_TIMEOUT)
      await expect(mirrored).toContainText(reply.last)
      const original = lastAssistantMessage(page)
      await expectMessageStatus(original, 'done', REPLY_TIMEOUT)
      await expect(original).toContainText(reply.last)
      await expect(assistantMessages(page)).toHaveCount(1)
      await expect(assistantMessages(second)).toHaveCount(1)

      await expectStoredOnce(api, chatId, reply)
      await expectOneReplyAfterReload(second, reply)
    }
    finally {
      await second.close()
    }
  })
})
