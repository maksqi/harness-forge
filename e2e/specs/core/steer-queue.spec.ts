// The steer queue (docs/UI.md 2.16, 7.6, 7.26; ADR-042) with `mock:steer` (docs/PROVIDERS.md 8): `steps <n>` runs n
// steps 400 ms apart (each calls `current_time`), streams `Steered: <text>.` for every message it received between two
// steps and ends with `Finished <n> steps. Steers: <list>`; any other turn echoes the user text.
// - A message sent while the reply runs (Enter or "Queue message") is queued ("Message queued") and reaches the model
//   at the next step: a `steer-note` inside the reply, listed by the final text, still in place after a reload.
// - A server command (`/compact`) never steers: it waits in the list ("Runs after this response"); Cancel removes a
//   row (focus moves to the next row's Cancel), Edit moves it back into the composer; nothing starts afterwards.
// - A message queued after the last step becomes the next turn, started by the server; the tab follows it.
// - Stop empties the queue and moves the queued messages back into the composer (text and file chip, a toast).
// - A second page of the chat sees the queue and its changes (`queue.changed`).
import type { Page } from '@playwright/test'
import { Buffer } from 'node:buffer'
import {
  assistantMessages,
  byTestId,
  CHAT_URL_PATTERN,
  chatIdFromUrl,
  composer,
  expect,
  expectAnnounced,
  expectMessageStatus,
  lastAssistantMessage,
  mockSteerFinished,
  openNewChat,
  recordAnnouncements,
  recordRequests,
  selectModel,
  sendMessage,
  test,
  testIds,
  toastWith,
  userMessages,
  waitForTestId,
} from '../../helpers/index.ts'

const MODEL = 'mock:steer'
/** A `steps 12` turn takes about 5 s (400 ms per step), longer than the default assertion timeout. */
const RUN_TIMEOUT = 20_000

function composerInput(page: Page) {
  return page.getByTestId(testIds.composerInput)
}

/** A new `mock:steer` chat whose `steps <n>` turn is running; resolves to the chat id. */
async function startSteps(page: Page, steps: number): Promise<string> {
  await openNewChat(page)
  await selectModel(page, MODEL)
  await sendMessage(page, `steps ${steps}`)
  await expect(page).toHaveURL(CHAT_URL_PATTERN)
  await expect(page.getByTestId(testIds.composerStop)).toBeVisible()
  await expectMessageStatus(lastAssistantMessage(page), 'streaming')
  return chatIdFromUrl(page)
}

/** Queues a server command through the "Queue message" button (Enter would pick the slash menu's item first). */
async function queueCommand(page: Page, text: string): Promise<void> {
  await composerInput(page).fill(text)
  await page.getByTestId(testIds.composerQueue).click()
  await expect(composerInput(page)).toHaveValue('')
}

test.describe('steer queue', () => {
  test('messages sent while the reply runs are queued and steer it at the next step @smoke', async ({ page, cleanup }) => {
    const chatId = await startSteps(page, 10)
    cleanup(api => api.removeChat(chatId))
    // After the first step: a message queued before it would open the turn instead of steering it.
    await waitForTestId(page, testIds.toolRow, { 'data-tool-name': 'current_time' })
    const input = composerInput(page)
    await expect(input).toHaveAttribute('placeholder', 'Queue a message…')
    const announced = await recordAnnouncements(page)

    // Enter queues; so does "Queue message" left of Stop.
    const first = 'Use the vitest filter instead'
    const second = 'Also check the lexer'
    await input.fill(first)
    await page.keyboard.press('Enter')
    await expect(input).toHaveValue('')
    await expectAnnounced(announced, 'Message queued')
    const reply = lastAssistantMessage(page)
    const notes = reply.getByTestId(testIds.steerNote)
    await expect(notes).toHaveCount(1)
    await input.fill(second)
    await page.getByTestId(testIds.composerQueue).click()
    await expect(notes).toHaveCount(2)

    // Each steer is a note inside the reply ("You · while it worked"), the model read it, the final text lists both.
    await expectMessageStatus(reply, 'done', RUN_TIMEOUT)
    await expect(reply).toContainText(mockSteerFinished(10, [first, second]))
    await expect(notes.nth(0)).toContainText(first)
    await expect(notes.nth(1)).toContainText(second)
    await expect(notes.nth(0)).toContainText('You · while it worked')
    await expect(notes.nth(0)).toHaveAttribute('data-message-id', /^msg_/)
    await expect(reply).toContainText(`Steered: ${first}.`)
    await expect(userMessages(page)).toHaveCount(1)
    await expect(page.getByTestId(testIds.queuedMessages)).toHaveCount(0)

    // A reload keeps the notes where they were delivered.
    await page.reload()
    await expectMessageStatus(lastAssistantMessage(page), 'done')
    await expect(lastAssistantMessage(page).getByTestId(testIds.steerNote)).toHaveCount(2)
    await expect(userMessages(page)).toHaveCount(1)
  })

  test('a server command waits in the list; Cancel and Edit take queued messages back before the next turn @smoke', async ({ page, api, cleanup }) => {
    const chatId = await startSteps(page, 12)
    cleanup(api => api.removeChat(chatId))
    await queueCommand(page, '/compact')
    await queueCommand(page, '/compact keep it short')

    const list = page.getByTestId(testIds.queuedMessages)
    await expect(list).toHaveAttribute('data-count', '2')
    await expect(list).toHaveAttribute('data-state', 'queued')
    await expect(list).toContainText('Queued · 2 · sent at the next step')
    const rows = list.getByTestId(testIds.queuedMessage)
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0)).toContainText('/compact')
    await expect(rows.nth(0)).toContainText('Runs after this response')
    await expect(rows.nth(1)).toContainText('/compact keep it short')
    const kept = await rows.nth(1).getAttribute('data-message-id')

    // Cancel: the row leaves, focus moves to the next row's Cancel.
    await rows.nth(0).getByTestId(testIds.queuedMessageCancel).click()
    await expect(rows).toHaveCount(1)
    await expect(list).toHaveAttribute('data-count', '1')
    await expect(byTestId(list, testIds.queuedMessage, { 'data-message-id': kept! }).getByTestId(testIds.queuedMessageCancel)).toBeFocused()

    // Edit: the message goes back into the composer, the list is empty.
    await rows.nth(0).getByTestId(testIds.queuedMessageEdit).click()
    await expect(list).toHaveCount(0)
    await expect(composerInput(page)).toHaveValue('/compact keep it short')
    await expect(toastWith(page, 'Queued messages moved back to the composer.')).toBeVisible()

    // The reply ends without steers and nothing starts after it.
    const reply = lastAssistantMessage(page)
    await expectMessageStatus(reply, 'done', RUN_TIMEOUT)
    await expect(reply).toContainText(mockSteerFinished(12, []))
    expect((await api.client.chatQueue.list({ params: { id: chatId } })).items).toEqual([])
    await expect(userMessages(page)).toHaveCount(1)
    await composerInput(page).fill('')
  })

  test('a message queued after the last step becomes the next turn and the tab follows it @smoke', async ({ page, cleanup }) => {
    const chatId = await startSteps(page, 2)
    cleanup(api => api.removeChat(chatId))
    const next = 'Next turn please'
    await composerInput(page).fill(next)
    // After the second tool result the run is in its last step: a message queued now can no longer steer it.
    await waitForTestId(page, testIds.toolRow, { 'data-tool-name': 'current_time', 'data-state': 'output-available' }, { count: 2 })
    const queued = await recordRequests(page, 'POST', `/api/chat/${chatId}/queue`)
    const sent = await recordRequests(page, 'POST', '/api/chat')
    await composerInput(page).press('Enter')

    await expect(userMessages(page)).toHaveCount(2)
    await expect(userMessages(page).last()).toContainText(next)
    await expect(assistantMessages(page)).toHaveCount(2)
    await expect(assistantMessages(page).first()).toContainText(mockSteerFinished(2, []))
    await expect(assistantMessages(page).first().getByTestId(testIds.steerNote)).toHaveCount(0)
    const reply = lastAssistantMessage(page)
    await expect(reply).toContainText(next)
    await expectMessageStatus(reply, 'done')
    await expect(page.getByTestId(testIds.composerSend)).toBeVisible()
    // The page queued the message and never sent it itself: the server started the turn and the page followed it.
    expect(queued.requests, 'the message was queued').toHaveLength(1)
    expect(sent.requests, 'the page sent no chat request of its own').toHaveLength(0)
  })

  test('Stop empties the queue and moves the queued messages back into the composer @smoke', async ({ page, api, cleanup }) => {
    const chatId = await startSteps(page, 12)
    cleanup(api => api.removeChat(chatId))
    await page.getByTestId(testIds.composerFileInput).setInputFiles({ name: 'queue-notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Queue notes\n') })
    const chip = composer(page).getByTestId(testIds.composerAttachment)
    await expect(chip).toHaveAttribute('data-state', 'done')
    await queueCommand(page, '/compact keep the notes')
    await expect(chip).toHaveCount(0)
    const list = page.getByTestId(testIds.queuedMessages)
    await expect(list).toHaveAttribute('data-count', '1')
    await expect(list.getByTestId(testIds.queuedMessage)).toContainText('/compact keep the notes')

    await page.getByTestId(testIds.composerStop).click()
    await expectMessageStatus(lastAssistantMessage(page), 'aborted')
    await expect(list).toHaveCount(0)
    await expect(composerInput(page)).toHaveValue('/compact keep the notes')
    await expect(chip).toHaveCount(1)
    await expect(chip).toHaveAttribute('data-kind', 'upload')
    await expect(chip).toContainText('queue-notes.md')
    await expect(toastWith(page, 'Queued messages moved back to the composer.')).toBeVisible()
    expect((await api.client.chatQueue.list({ params: { id: chatId } })).items).toEqual([])
    await expect(userMessages(page)).toHaveCount(1)
    await composerInput(page).fill('')
  })

  test('a second page of the chat sees the queue and its changes @smoke', async ({ page, context, cleanup }) => {
    const chatId = await startSteps(page, 12)
    cleanup(api => api.removeChat(chatId))
    const other = await context.newPage()
    await other.goto(`/chat/${chatId}`)
    await expect(other.getByTestId(testIds.composerStop)).toBeVisible()

    await queueCommand(page, '/compact')
    const row = page.getByTestId(testIds.queuedMessage)
    await expect(row).toHaveCount(1)
    const id = await row.getAttribute('data-message-id')
    const otherList = other.getByTestId(testIds.queuedMessages)
    await expect(otherList).toHaveAttribute('data-count', '1')
    await expect(byTestId(otherList, testIds.queuedMessage, { 'data-message-id': id! })).toContainText('/compact')

    // A cancel in the second page empties the list in the first.
    await other.getByTestId(testIds.queuedMessageCancel).click()
    await expect(otherList).toHaveCount(0)
    await expect(page.getByTestId(testIds.queuedMessages)).toHaveCount(0)
    await other.close()
    await page.getByTestId(testIds.composerStop).click()
    await expectMessageStatus(lastAssistantMessage(page), 'aborted')
    await expect(composerInput(page)).toHaveValue('')
  })
})
