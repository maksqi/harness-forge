// Stop hook continuations (docs/UI.md 7.31; ADR-048; docs/PROVIDERS.md 8 "Hook mocks (Phase 11)") with approved project
// hooks:
// - A Stop hook that blocks once (`stop-once`: `{"decision":"block","reason":"run the tests"}` unless the payload says
//   `stop_hook_active`) ends the reply with the inline note "A Stop hook asked the agent to continue"; the server adds a
//   carrier message (only a turn note with the reason, "Sent to the agent", no bubble or actions) and starts a turn from
//   it without user action (`mock:hooks` answers `Hook continuation: run the tests`). The tab announces "A hook asked the
//   agent to continue", and a second page of the chat follows the hook turn live.
// - A Stop hook that always blocks (`exit2`) gets 5 continuations in a row, then the reply carries the notice
//   `hook-continuation-limit` ("Stopped after 5 hook continuations in a row.") and the chain ends.
import type { Locator, Page } from '@playwright/test'
import {
  assistantMessages,
  expect,
  expectAnnounced,
  expectMessageStatus,
  HOOK_SCRIPT_TEXT,
  hookGroup,
  hookNote,
  lastAssistantMessage,
  mockHooksEcho,
  noticeLine,
  recordAnnouncements,
  seedHookProjectChat,
  sendMessage,
  test,
  testIds,
  userMessages,
} from '../../helpers/index.ts'

/** `mock:hooks` answers a carrier with the first line of its feedback. */
function continuation(reason: string): string {
  return `Hook continuation: ${reason}`
}

/** The carrier messages of the transcript (user-role containers that hold a turn note). */
function carriers(page: Page): Locator {
  return userMessages(page).filter({ has: hookNote(page, { 'data-variant': 'turn' }) })
}

/** Checks the carrier of a Stop continuation: one turn note with the reason, the caption, no bubble or actions. */
async function expectCarrier(carrier: Locator, reason: string): Promise<void> {
  const note = hookNote(carrier, { 'data-event': 'Stop', 'data-outcome': 'continued', 'data-variant': 'turn', 'data-source': 'project' })
  await expect(note).toHaveCount(1)
  await expect(note.locator('[data-slot="hook-note-line"]')).toHaveText('A Stop hook asked the agent to continue')
  await expect(note.locator('[data-slot="hook-note-reason"]')).toHaveText(reason)
  // The details of a turn note are always open (no toggle): the source line.
  await expect(note.getByTestId(testIds.hookNoteToggle)).toHaveCount(0)
  await expect(note.getByTestId(testIds.hookNoteDetails).locator('[data-slot="hook-source"]')).toContainText('Project hook')
  await expect(carrier).toContainText('Sent to the agent')
  for (const id of [testIds.messageCopy, testIds.messageEdit, testIds.messageBranch])
    await expect(carrier.getByTestId(id), `no ${id} on a carrier`).toHaveCount(0)
}

test.describe('Stop hook continuations', () => {
  test('a Stop hook that blocks once starts a turn of its own; a second page follows it @smoke', async ({ page, context, api, cleanup }) => {
    const { chatId } = await seedHookProjectChat(api, cleanup, {
      prefix: 'hook-stop',
      scripts: ['stop-once'],
      hooks: commands => ({ Stop: [hookGroup(commands['stop-once']!)] }),
    })
    await page.goto(`/chat/${chatId}`)
    const other = await context.newPage()
    await other.goto(`/chat/${chatId}`)
    await expect(other.getByTestId(testIds.composerInput)).toBeEditable()
    const announcements = await recordAnnouncements(page)

    await sendMessage(page, 'finish the work')
    // The reply that ended: its text, then the inline note of the Stop hook.
    const first = assistantMessages(page).first()
    await expect(first).toContainText(mockHooksEcho('finish the work'))
    const inline = hookNote(first, { 'data-event': 'Stop', 'data-outcome': 'continued', 'data-variant': 'inline' })
    await expect(inline.locator('[data-slot="hook-note-line"]')).toHaveText('A Stop hook asked the agent to continue')
    await expect(inline.locator('[data-slot="hook-note-source"]')).toHaveText(' · Project hook')
    // The carrier and the reply the server started from it, without a message from the user.
    await expect(userMessages(page)).toHaveCount(2)
    await expectCarrier(carriers(page), HOOK_SCRIPT_TEXT.stop)
    await expect(assistantMessages(page)).toHaveCount(2)
    const reply = lastAssistantMessage(page)
    await expect(reply).toContainText(continuation(HOOK_SCRIPT_TEXT.stop))
    await expectMessageStatus(reply, 'done')
    await expectAnnounced(announcements, 'A hook asked the agent to continue')
    // `stop_hook_active` is set for the hook turn: the hook lets it end, so nothing follows.
    await expect(hookNote(reply)).toHaveCount(0)

    // The second page followed the hook turn without a reload.
    await expect(userMessages(other)).toHaveCount(2)
    await expectCarrier(carriers(other), HOOK_SCRIPT_TEXT.stop)
    await expect(assistantMessages(other)).toHaveCount(2)
    await expect(lastAssistantMessage(other)).toContainText(continuation(HOOK_SCRIPT_TEXT.stop))
    await expectMessageStatus(lastAssistantMessage(other), 'done')
    await other.close()

    // The server stored the carrier (only `data-hook` parts) and both replies.
    const messages = (await api.getChat(chatId)).messages
    expect(messages.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(messages[2]!.parts.map(part => part.type)).toEqual(['data-hook'])
    // A reload shows the same.
    await page.reload()
    await expectCarrier(carriers(page), HOOK_SCRIPT_TEXT.stop)
    await expect(hookNote(assistantMessages(page).first(), { 'data-outcome': 'continued', 'data-variant': 'inline' })).toHaveCount(1)
  })

  test('a Stop hook that always blocks stops after 5 continuations with a notice @smoke', async ({ page, api, cleanup }) => {
    const reason = 'keep going'
    const { chatId } = await seedHookProjectChat(api, cleanup, {
      prefix: 'hook-stop-loop',
      scripts: [['exit2', { file: 'always', text: reason }]],
      hooks: commands => ({ Stop: [hookGroup(commands.always!)] }),
    })
    await page.goto(`/chat/${chatId}`)
    await sendMessage(page, 'loop')

    // 1 reply to the user, then 5 carriers with 5 replies; the last reply ends with the notice.
    const notice = noticeLine(page, 'hook-continuation-limit')
    await expect(notice).toBeVisible({ timeout: 20_000 })
    await expect(notice).toContainText('Stopped after 5 hook continuations in a row.')
    await expect(carriers(page)).toHaveCount(5)
    await expect(assistantMessages(page)).toHaveCount(6)
    await expect(assistantMessages(page).last().locator(`[data-slot="notice-part"][data-code="hook-continuation-limit"]`)).toHaveCount(1)
    await expectMessageStatus(lastAssistantMessage(page), 'done')
    for (const index of [1, 5])
      await expect(assistantMessages(page).nth(index)).toContainText(continuation(reason))
    await expectCarrier(carriers(page).first(), reason)
    // The chain ended: nothing else follows.
    const messages = (await api.getChat(chatId)).messages
    expect(messages).toHaveLength(12)
    expect(messages.at(-1)!.role).toBe('assistant')
  })
})
