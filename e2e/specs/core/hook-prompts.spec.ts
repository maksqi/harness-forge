// Prompt hooks (docs/UI.md 7.31; ADR-048; docs/PROVIDERS.md 8 "Hook mocks (Phase 11)") with approved project hooks
// (`.harness/settings.json` of the spec's own project, scripts of `apps/server/src/testing/hook-scripts.ts`):
// - A UserPromptSubmit hook that blocks (`prompt-block`: exit 2, stderr "Prompt blocked by hook.") refuses the message
//   with 409 `hook-blocked` before anything streams: the composer keeps the text and the attachment chip and shows the
//   refusal ("A hook blocked this message", the reason, "UserPromptSubmit · Project hook"), the textarea is described by
//   it, nothing reaches the transcript or the server; typing clears it, × dismisses it. On `/` (a new chat in that
//   project, picked through the new-chat project pill) the page stays on `/` and no chat is created.
// - The same hook refuses a message queued while a reply runs (it runs at enqueue): the text comes back with the refusal,
//   nothing is queued, the running reply ends without a steer.
// - Context hooks: `mock:hooks` `context?` lists a SessionStart and a UserPromptSubmit `additionalContext`; the second
//   message runs no SessionStart. The stored user messages show them as inline notes below the bubble ("Hook added
//   context · {event} · Project hook", "Show context" opens the text and the source line), also while the turn is live
//   (the session reloads the chat once when the accepted answer reports prompt hook records).
// - The refusal shows the hook's reason once, under its title.
import type { Locator, Page } from '@playwright/test'
import type { CleanupTask, HarnessApi, HookProjectChat } from '../../helpers/index.ts'
import { Buffer } from 'node:buffer'
import {
  byTestId,
  CHAT_URL_PATTERN,
  composer,
  composerRefusal,
  expect,
  expectMessageStatus,
  HOOK_SCRIPT_TEXT,
  hookGroup,
  hookNote,
  lastAssistantMessage,
  mockSteerFinished,
  openNewChat,
  pendingTrustItems,
  seedHookProjectChat,
  selectModel,
  sendMessage,
  test,
  testIds,
  uniqueId,
  userMessages,
  waitForTestId,
} from '../../helpers/index.ts'

function composerInput(page: Page): Locator {
  return page.getByTestId(testIds.composerInput)
}

/** Checks the refusal of a blocking UserPromptSubmit hook (docs/UI.md 7.31). */
async function expectPromptRefusal(page: Page): Promise<Locator> {
  const refusal = composerRefusal(page)
  await expect(refusal).toBeVisible()
  await expect(refusal).toHaveAttribute('data-code', 'hook-blocked')
  await expect(refusal).toHaveAttribute('data-event', 'UserPromptSubmit')
  await expect(refusal).toHaveAttribute('role', 'alert')
  await expect(refusal).toContainText('A hook blocked this message')
  // The reason line is the error's message ("A hook blocked this message: {reason}", docs/UI.md 7.31).
  await expect(refusal.locator('[data-slot="composer-refusal-reason"]')).toContainText(HOOK_SCRIPT_TEXT.promptBlock)
  await expect(refusal.locator('[data-slot="composer-refusal-source"]')).toHaveText('UserPromptSubmit · Project hook')
  return refusal
}

/** A project chat with a SessionStart (`branch main`) and a UserPromptSubmit (`ticket HF-12`) context hook. */
async function seedContextProjectChat(api: HarnessApi, cleanup: (task: CleanupTask) => void): Promise<HookProjectChat> {
  return seedHookProjectChat(api, cleanup, {
    prefix: 'hook-context',
    scripts: [['context', { file: 'session', text: 'branch main' }], ['context', { file: 'prompt', text: 'ticket HF-12' }]],
    hooks: commands => ({
      SessionStart: [hookGroup(commands.session!)],
      UserPromptSubmit: [hookGroup(commands.prompt!)],
    }),
  })
}

test.describe('prompt hooks', () => {
  test('a blocking UserPromptSubmit hook keeps the text and the file and shows the refusal; on / no chat is created @smoke', async ({ page, api, cleanup }) => {
    const { chatId, project } = await seedHookProjectChat(api, cleanup, {
      prefix: 'hook-prompts',
      scripts: ['prompt-block'],
      hooks: commands => ({ UserPromptSubmit: [hookGroup(commands['prompt-block']!)] }),
    })
    const text = `Here is my key ${uniqueId('key')}`

    await page.goto(`/chat/${chatId}`)
    await expect(composerInput(page)).toBeEditable()
    await page.getByTestId(testIds.composerFileInput).setInputFiles({ name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Notes\n') })
    const chip = composer(page).getByTestId(testIds.composerAttachment)
    await expect(chip).toHaveAttribute('data-state', 'done')
    await sendMessage(page, text)

    const refusal = await expectPromptRefusal(page)
    // The composer keeps what was typed and attached; focus stays in the textarea, which the refusal describes.
    await expect(composerInput(page)).toHaveValue(text)
    await expect(chip).toHaveCount(1)
    await expect(chip).toHaveAttribute('data-state', 'done')
    await expect(chip).toContainText('notes.md')
    await expect(composerInput(page)).toBeFocused()
    await expect(composerInput(page)).toHaveAccessibleDescription(/A hook blocked this message/)
    // Nothing in the transcript, nothing stored.
    await expect(userMessages(page)).toHaveCount(0)
    expect((await api.getChat(chatId)).messages).toEqual([])
    // Esc keeps the refusal (it keeps its composer meaning); typing clears it.
    await composerInput(page).press('Escape')
    await expect(refusal).toBeVisible()
    await composerInput(page).pressSequentially('!')
    await expect(refusal).toHaveCount(0)
    // × dismisses it.
    await page.getByTestId(testIds.composerSend).click()
    await expectPromptRefusal(page)
    await refusal.getByTestId(testIds.composerRefusalDismiss).click()
    await expect(refusal).toHaveCount(0)
    await expect(composerInput(page)).toHaveValue(`${text}!`)
    await composerInput(page).fill('')

    // On `/`: a new chat in the project is refused before it exists, so the page stays.
    await openNewChat(page)
    const pill = page.getByTestId(testIds.newChatProject)
    await pill.click()
    await byTestId(page, testIds.projectOption, { 'data-value': project.id }).click()
    await expect(pill).toHaveAttribute('data-value', project.id)
    await selectModel(page, 'mock:hooks')
    const first = `A first message ${uniqueId('first')}`
    await sendMessage(page, first)
    await expectPromptRefusal(page)
    await expect(composerInput(page)).toHaveValue(first)
    await expect(page).not.toHaveURL(CHAT_URL_PATTERN)
    await expect(page.getByTestId(testIds.emptyGreeting)).toBeVisible()
    const chats = (await api.client.chats.list({ query: { projectId: project.id } })).items
    expect(chats.map(chat => chat.id), 'only the seeded chat is in the project').toEqual([chatId])
    expect(await api.searchChats(first)).toEqual([])
    await composerInput(page).fill('')
  })

  test('a message queued while a reply runs is refused at enqueue and comes back to the composer @smoke', async ({ page, api, cleanup }) => {
    // The hook is not approved yet, so the first message passes; it is approved while the reply runs.
    const { chatId, project } = await seedHookProjectChat(api, cleanup, {
      prefix: 'hook-queue',
      modelRef: 'mock:steer',
      scripts: ['prompt-block'],
      hooks: commands => ({ UserPromptSubmit: [hookGroup(commands['prompt-block']!)] }),
      approve: false,
    })
    await page.goto(`/chat/${chatId}`)
    await sendMessage(page, 'steps 8')
    await waitForTestId(page, testIds.toolRow, { 'data-tool-name': 'current_time' })
    const pending = await pendingTrustItems(api, project.id)
    expect(pending.map(item => item.kind)).toEqual(['hook'])
    await api.client.projectTrust.approve({ params: { id: project.id }, body: { items: pending.map(item => ({ kind: item.kind, sha256: item.sha256 })) } })

    const queued = `Queue this ${uniqueId('queued')}`
    await composerInput(page).fill(queued)
    await composerInput(page).press('Enter')
    await expectPromptRefusal(page)
    await expect(composerInput(page)).toHaveValue(queued)
    await expect(page.getByTestId(testIds.queuedMessages)).toHaveCount(0)
    expect((await api.client.chatQueue.list({ params: { id: chatId } })).items).toEqual([])
    // The running reply is not steered.
    const reply = lastAssistantMessage(page)
    await expect(reply).toContainText(mockSteerFinished(8, []), { timeout: 20_000 })
    await expectMessageStatus(reply, 'done')
    await expect(reply.getByTestId(testIds.steerNote)).toHaveCount(0)
    await expect(userMessages(page)).toHaveCount(1)
    await composerInput(page).fill('')
  })

  test('SessionStart and UserPromptSubmit context reaches the model and shows as notes below the user messages @smoke', async ({ page, api, cleanup }) => {
    const { chatId } = await seedContextProjectChat(api, cleanup)
    await page.goto(`/chat/${chatId}`)
    await sendMessage(page, 'context?')
    await expectMessageStatus(lastAssistantMessage(page), 'done')
    await expect(lastAssistantMessage(page)).toContainText('Context: SessionStart:branch main; UserPromptSubmit:ticket HF-12')
    // The next message: no SessionStart (the chat already started), the UserPromptSubmit context again.
    await sendMessage(page, 'context?')
    await expect(userMessages(page)).toHaveCount(2)
    await expectMessageStatus(lastAssistantMessage(page), 'done')
    await expect(lastAssistantMessage(page)).toContainText('Context: SessionStart:branch main; UserPromptSubmit:ticket HF-12; UserPromptSubmit:ticket HF-12')

    // The stored messages carry the records (`data-hook` parts), shown below the bubbles after a reload.
    await page.reload()
    const user = userMessages(page).first()
    const notes = user.locator('[data-slot="user-hook-notes"]')
    const session = hookNote(notes, { 'data-event': 'SessionStart', 'data-outcome': 'context', 'data-variant': 'inline', 'data-source': 'project' })
    const prompt = hookNote(notes, { 'data-event': 'UserPromptSubmit', 'data-outcome': 'context', 'data-variant': 'inline', 'data-source': 'project' })
    await expect(session).toHaveText(/Hook added context · SessionStart · Project hook/)
    await expect(prompt).toHaveText(/Hook added context · UserPromptSubmit · Project hook/)
    await expect(session).toHaveAccessibleName('Hook SessionStart: Hook added context · SessionStart')
    await expect(hookNote(user)).toHaveCount(2)
    const second = userMessages(page).last()
    await expect(hookNote(second, { 'data-event': 'UserPromptSubmit', 'data-outcome': 'context' })).toBeVisible()
    await expect(hookNote(second)).toHaveCount(1)
    // "Show context" opens the text the model got and the hook's source line.
    const toggle = session.getByTestId(testIds.hookNoteToggle)
    await expect(toggle).toHaveText('Show context')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(toggle).toHaveText('Hide context')
    const details = session.getByTestId(testIds.hookNoteDetails)
    await expect(details.locator('[data-slot="hook-context"]')).toHaveText('branch main')
    await expect(details.locator('[data-slot="hook-source"]')).toContainText('Project hook')
    await expect(details.locator('[data-slot="hook-source"]')).toContainText('exit 0')
  })

  // The context notes of a user message show while the turn is live (fixed in P11-B, W11.19).
  test('the context notes show below the user message without a reload', async ({ page, api, cleanup }) => {
    const { chatId } = await seedContextProjectChat(api, cleanup)
    await page.goto(`/chat/${chatId}`)
    await sendMessage(page, 'context?')
    await expectMessageStatus(lastAssistantMessage(page), 'done')
    await expect(hookNote(userMessages(page).first(), { 'data-outcome': 'context' })).toHaveCount(2)
  })

  // The refusal shows the hook's reason once (fixed in P11-B, W11.19).
  test('the refusal shows the hook\'s reason once, under the title', async ({ page, api, cleanup }) => {
    const { chatId } = await seedHookProjectChat(api, cleanup, {
      prefix: 'hook-prompts',
      scripts: ['prompt-block'],
      hooks: commands => ({ UserPromptSubmit: [hookGroup(commands['prompt-block']!)] }),
    })
    await page.goto(`/chat/${chatId}`)
    await sendMessage(page, 'Blocked once.')
    await expect(composerRefusal(page).locator('[data-slot="composer-refusal-reason"]')).toHaveText(HOOK_SCRIPT_TEXT.promptBlock)
  })
})
